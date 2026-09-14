import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostScriptExecutor, parseExecutionRequest, executionInstruction } from '../src/experimental-exec.mjs';
import { ProxyEngine } from '../src/engine.mjs';
import { ProxyError } from '../src/errors.mjs';
import { fakeCore, fakeAuth, config, streamOf, toolRequest, basic } from './helpers.mjs';

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function block(language, script) {
  return '```m365-exec\n' + JSON.stringify({ format: 'm365proxy.exec.v1', language, script }) + '\n```';
}

test('execution contract is explicit and ordinary prose is not executed', () => {
  assert.equal(parseExecutionRequest('normal answer').action, null);
  const parsed = parseExecutionRequest(block('bash', 'printf ok'));
  assert.equal(parsed.action.language, 'bash');
  assert.equal(parsed.action.script, 'printf ok');
  assert.match(executionInstruction({ platform: 'linux' }), /NO sandbox/);
  assert.throws(() => parseExecutionRequest('```m365-exec\n{"format":"m365proxy.exec.v1"}\n```'), { code: 'exec_contract_error' });
  assert.throws(() => parseExecutionRequest(block('cmd', 'dir'), { platform: 'linux' }), { code: 'exec_contract_error' });
});

test('execution parser accepts safe schema aliases without broadening executable content', () => {
  const a = parseExecutionRequest('```m365-exec\n' + JSON.stringify({ command: 'pwd', shell: 'bash', description: 'inspect cwd' }) + '\n```');
  assert.equal(a.action.language, 'bash'); assert.equal(a.action.script, 'pwd');
  const b = parseExecutionRequest('```m365-exec\n' + JSON.stringify({ format: 'm365proxy.exec.v1', language: 'python3', code: 'print(1)', action: 'run' }) + '\n```');
  assert.equal(b.action.language, 'python'); assert.equal(b.action.script, 'print(1)');
  assert.throws(() => parseExecutionRequest('```m365-exec\n' + JSON.stringify({ command: 'pwd', unexpected: true }) + '\n```'), { code: 'exec_contract_error' });
});

test('executor creates an isolated workspace temp session, captures output, strips proxy secrets and cleans script', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux execution fixture');
  const dir = await root(t); await writeFile(join(dir, 'a.txt'), 'A');
  const project = { tree: { root: dir } };
  const executor = new HostScriptExecutor(project, { execTimeoutMs: 3000, execOutputBytes: 8192, execMaxSteps: 4 });
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'MUST_NOT_REACH_CHILD';
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  const result = await executor.execute({ language: 'bash', script: 'printf "cwd=%s\\n" "$PWD"; printf "secret=%s\\n" "${OPENAI_API_KEY-unset}"; mv a.txt b.txt; ls -1 b.txt' }, { step: 1 });
  assert.equal(result.exit_code, 0); assert.match(result.stdout, /secret=unset/); assert.match(result.stdout, /b\.txt/);
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'A');
  const tmp = join(dir, '.m365proxy-tmp'); assert.equal((await stat(tmp)).isDirectory(), true);
  await executor.close();
  await assert.rejects(stat(tmp), (e) => e.code === 'ENOENT');
});

test('executor bounds long-running scripts and returns a timeout result instead of hanging', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux execution fixture');
  const dir = await root(t), executor = new HostScriptExecutor({ tree: { root: dir } }, { execTimeoutMs: 100, execOutputBytes: 8192 });
  const started = Date.now();
  const result = await executor.execute({ language: 'bash', script: 'sleep 5' }, { step: 1 });
  assert.equal(result.timed_out, true); assert.ok(Date.now() - started < 2500);
  await executor.close();
});

test('engine executes an experimental script result loop internally and suppresses client tool_calls', async () => {
  const calls = [];
  const executor = {
    instruction: () => '\nEXEC INSTRUCTION\n',
    parse(text) {
      if (text === 'ACTION') return { action: { language: 'bash', script: 'printf result' }, text: '' };
      return { action: null, text };
    },
    async execute(_action, { step }) { return { step, language: 'bash', exit_code: 0, timed_out: false, output_truncated: false, stdout: 'local-result', stderr: '', duration_ms: 2, script_retained: false }; },
    resultPrompt(result) { return 'LOCAL EXECUTION RESULT ' + result.stdout + '\nEXEC INSTRUCTION'; },
    status: () => ({ enabled: true }), close: async () => {},
  };
  const project = { id: 'default', writeMode: 'off', execMode: 'script', contextPolicy: 'adaptive', conversationMode: 'reuse', mode: 'read', executor, fingerprint: 'x' };
  const workspace = {
    select: () => project,
    bind(request) { request.localExec = true; request.autoWrite = false; request.workspaceProject = 'default'; request.uploadWorkspace = false; request.bufferOutput = true; request.contextIdentity = 'ctx'; return request; },
    async prepare() { return { id: 's', prompt: 'NO SOURCE', selected: [], allowEmpty: true, contextSkipped: true, summary: { project_id: 'default', context_decision: 'skipped_irrelevant' } }; },
    instruction: () => '\nNO SOURCE\n', finalize: async () => ({ context_decision: 'skipped_irrelevant' }),
    list: () => ({ experimental_exec: [{ project_id: 'default', enabled: true }] }), close: async () => {},
  };
  let turn = 0;
  const factory = () => ({ reset() {}, async run(prompt) { calls.push(prompt); return streamOf(++turn === 1 ? 'ACTION' : 'final answer'); } });
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, execMode: 'script', execMaxSteps: 4, execTimeoutMs: 1000, execOutputBytes: 8192 }, factory, workspace });
  const request = engine.validate(toolRequest());
  assert.equal(request.activeTools.length, 0);
  const result = await engine.run(request);
  assert.equal(result.choices[0].message.content, 'final answer');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.x_m365.local_exec.steps.length, 1);
  assert.match(calls[1], /local-result/);
  assert.equal(result.x_m365.tool_calls_emulated, false);
  engine.close();
});

test('hybrid EXEC with no selected source bypasses the browser composer and keeps the execution loop on direct Chathub', async () => {
  const calls = [];
  const executor = {
    instruction: () => '\nEXEC INSTRUCTION\n',
    parse(text) { return text === 'ACTION' ? { action: { language: 'bash', script: 'printf ok' }, text: '' } : { action: null, text }; },
    async execute(_action, { step }) { return { step, language: 'bash', exit_code: 0, timed_out: false, output_truncated: false, stdout: 'host-ok', stderr: '', duration_ms: 1, script_retained: false }; },
    resultPrompt(result) { return 'LOCAL EXECUTION RESULT ' + result.stdout + '\nEXEC INSTRUCTION'; },
    status: () => ({ enabled: true }), close: async () => {},
  };
  const project = { id: 'default', writeMode: 'off', execMode: 'script', contextPolicy: 'adaptive', conversationMode: 'reuse', mode: 'hybrid', executor, fingerprint: 'browser-exec' };
  const workspace = {
    select: () => project,
    bind(request) { request.localExec = true; request.autoWrite = false; request.workspaceProject = 'default'; request.uploadWorkspace = true; request.bufferOutput = true; request.contextIdentity = 'browser-exec'; request.forceFreshSession = false; return request; },
    async prepare() { return { id: 's', prompt: 'NO SOURCE', selected: [], allowEmpty: true, contextSkipped: true, summary: { project_id: 'default', context_decision: 'local_action_no_source' } }; },
    instruction: () => '\nNO SOURCE\n', finalize: async () => ({ context_decision: 'local_action_no_source' }),
    list: () => ({ experimental_exec: [{ project_id: 'default', enabled: true }] }), close: async () => {},
  };
  let turn = 0, uploadCalls = 0;
  const upload = { status: () => ({ enabled: true }), async run() { uploadCalls++; throw new Error('browser composer must not be used for a no-file EXEC turn'); } };
  const factory = () => ({ reset() {}, async run(prompt) { calls.push(prompt); return streamOf(++turn === 1 ? 'ACTION' : 'final direct answer'); } });
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, contextPolicy: 'adaptive', execMode: 'script', execMaxSteps: 4 }, workspace, upload, factory });
  const request = engine.validate(basic());
  const result = await engine.run(request);
  assert.equal(result.choices[0].message.content, 'final direct answer');
  assert.equal(calls.length, 2); assert.equal(uploadCalls, 0);
  assert.match(calls[1], /host-ok/);
  assert.equal(result.x_m365.exec_transport, 'direct_chathub');
  assert.equal(engine.sessions.size, 0); assert.equal(engine.execSessions.size, 1); assert.equal(engine.uploadSessions.size, 0);
  engine.close();
});

test('direct hybrid EXEC strips large client system/developer boilerplate before sending to Chathub', async () => {
  const calls = [];
  const executor = {
    instruction: () => '\nEXEC CONTRACT\n',
    parse: (text) => ({ action: null, text }),
    status: () => ({ enabled: true }), close: async () => {},
  };
  const project = { id: 'default', writeMode: 'off', execMode: 'script', contextPolicy: 'adaptive', conversationMode: 'reuse', mode: 'hybrid', executor, fingerprint: 'compact-exec' };
  const workspace = {
    select: () => project,
    bind(request) { request.localExec = true; request.autoWrite = false; request.workspaceProject = 'default'; request.uploadWorkspace = true; request.bufferOutput = true; request.contextIdentity = 'compact-exec'; request.forceFreshSession = false; return request; },
    async prepare() { return { id: 's', prompt: 'NO SOURCE', selected: [], allowEmpty: true, contextSkipped: true, summary: { project_id: 'default', context_decision: 'local_action_no_source' } }; },
    instruction: () => '\nNO SOURCE\n', finalize: async () => ({ context_decision: 'local_action_no_source' }),
    list: () => ({ experimental_exec: [{ project_id: 'default', enabled: true }] }), close: async () => {},
  };
  const upload = { status: () => ({ enabled: true }), async run() { throw new Error('browser transport must not run'); } };
  const core = fakeCore();
  core.formatMessages = (messages) => JSON.stringify(messages);
  const factory = () => ({ reset() {}, async run(prompt) { calls.push(prompt); return streamOf('done'); } });
  const engine = new ProxyEngine({ core, auth: fakeAuth(), config: { ...config, contextPolicy: 'adaptive', execMode: 'script' }, workspace, upload, factory });
  const body = { model: 'm365-copilot', messages: [
    { role: 'system', content: 'SYSTEM-BOILERPLATE-' + 'x'.repeat(20000) },
    { role: 'developer', content: 'DEVELOPER-BOILERPLATE-' + 'y'.repeat(10000) },
    { role: 'user', content: 'ejecuta hostname -I' },
  ] };
  const result = await engine.run(engine.validate(body));
  assert.equal(result.choices[0].message.content, 'done');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /SYSTEM-BOILERPLATE|DEVELOPER-BOILERPLATE/);
  assert.match(calls[0], /ejecuta hostname -I/);
  assert.match(calls[0], /EXEC CONTRACT/);
  assert.ok(Buffer.byteLength(calls[0]) < 5000);
  assert.equal(result.x_m365.exec_transport, 'direct_chathub');
  engine.close();
});

test('direct EXEC keeps a sticky Chathub session when a coding client rewrites its system preamble', async () => {
  let factories = 0;
  const executor = {
    instruction: () => '\nEXEC CONTRACT\n',
    parse: (text) => ({ action: null, text }),
    status: () => ({ enabled: true }), close: async () => {},
  };
  const project = { id: 'default', writeMode: 'off', execMode: 'script', contextPolicy: 'adaptive', conversationMode: 'reuse', mode: 'hybrid', executor, fingerprint: 'sticky-exec' };
  const workspace = {
    select: () => project,
    bind(request) { request.localExec = true; request.autoWrite = false; request.workspaceProject = 'default'; request.uploadWorkspace = true; request.bufferOutput = true; request.contextIdentity = 'sticky-exec'; request.forceFreshSession = false; return request; },
    async prepare() { return { id: 's', prompt: 'NO SOURCE', selected: [], allowEmpty: true, contextSkipped: true, summary: { project_id: 'default', context_decision: 'local_action_no_source' } }; },
    instruction: () => '\nNO SOURCE\n', finalize: async () => ({ context_decision: 'local_action_no_source' }),
    list: () => ({ experimental_exec: [{ project_id: 'default', enabled: true }] }), close: async () => {},
  };
  const upload = { status: () => ({ enabled: true }), async run() { throw new Error('browser must not be used'); } };
  const factory = () => { factories++; return { reset() {}, reusable: () => true, async run() { return streamOf('ok-' + factories); } }; };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, conversationMode: 'reuse', contextPolicy: 'adaptive', execMode: 'script' }, workspace, upload, factory });
  const first = engine.validate({ model: 'm365-copilot', messages: [{ role: 'system', content: 'preamble A' }, { role: 'user', content: 'ejecuta hostname -I' }] });
  const a = await engine.run(first);
  assert.equal(a.x_m365.session_reused, false);
  const second = engine.validate({ model: 'm365-copilot', messages: [{ role: 'system', content: 'preamble B rewritten by client' }, { role: 'user', content: 'crea un script bash hello world' }] });
  const b = await engine.run(second);
  assert.equal(factories, 1);
  assert.equal(b.x_m365.session_reused, true);
  assert.equal(b.x_m365.session_reuse_reason, 'sticky');
  assert.equal(b.x_m365.exec_transport, 'direct_chathub');
  assert.equal(engine.execSessions.size, 1);
  assert.equal(engine.uploadSessions.size, 0);
  engine.close();
});

test('EXEC never switches to browser transport even if a legacy hybrid snapshot contains selected files', async () => {
  let directCalls = 0, uploadCalls = 0;
  const executor = { instruction: () => '\nEXEC CONTRACT\n', parse: (text) => ({ action: null, text }), status: () => ({ enabled: true }), close: async () => {} };
  const project = { id: 'default', writeMode: 'off', execMode: 'script', contextPolicy: 'adaptive', conversationMode: 'reuse', mode: 'hybrid', executor, fingerprint: 'with-source' };
  const workspace = {
    select: () => project,
    bind(request) { request.localExec = true; request.autoWrite = false; request.workspaceProject = 'default'; request.uploadWorkspace = true; request.bufferOutput = true; request.contextIdentity = 'with-source'; request.forceFreshSession = false; return request; },
    async prepare() { return { id: 's', prompt: 'CAPABILITY', selected: [{ path: 'src/app.js', sha256: 'a'.repeat(64), size: 5, content: 'hello' }], allowEmpty: true, contextSkipped: true, requiresAction: false, summary: { project_id: 'default', context_decision: 'exec_capability' } }; },
    instruction: () => '\nCAPABILITY\n', finalize: async () => ({ context_decision: 'exec_capability' }),
    list: () => ({ experimental_exec: [{ project_id: 'default', enabled: true }] }), close: async () => {},
  };
  const upload = { status: () => ({ enabled: true }), async run() { uploadCalls++; throw new Error('browser transport must never run for EXEC'); } };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, contextPolicy: 'adaptive', execMode: 'script' }, workspace, upload,
    factory: () => ({ reset() {}, async run() { directCalls++; return streamOf('direct answer'); } }) });
  const result = await engine.run(engine.validate(basic()));
  assert.equal(result.choices[0].message.content, 'direct answer');
  assert.equal(directCalls, 1); assert.equal(uploadCalls, 0);
  assert.equal(result.x_m365.exec_transport, 'direct_chathub');
  assert.equal(engine.execSessions.size, 1); assert.equal(engine.uploadSessions.size, 0);
  engine.close();
});


test('malformed m365-exec gets one bounded repair turn instead of immediate 422', async () => {
  let turn = 0;
  const executor = {
    instruction: () => '\nEXEC CONTRACT\n',
    parse(text) { if (text === 'BAD') { throw new ProxyError(422, 'exec_contract_error', 'bad'); } return { action: null, text }; },
    repairPrompt: () => 'REPAIR EXEC CONTRACT', requireActionPrompt: () => 'REQUIRE ACTION', status: () => ({ enabled: true }), close: async () => {},
  };
  const project = { id:'default', writeMode:'off', execMode:'script', contextPolicy:'adaptive', conversationMode:'reuse', mode:'read', executor, fingerprint:'repair' };
  const workspace = { select:()=>project, bind(r){r.localExec=true;r.workspaceProject='default';r.uploadWorkspace=false;r.bufferOutput=true;r.contextIdentity='repair';return r;},
    async prepare(){return {id:'s',prompt:'CAP',selected:[],contextSkipped:true,requiresAction:false,summary:{project_id:'default',context_decision:'exec_capability'}};}, instruction:()=> '\nCAP\n', finalize:async()=>({}), list:()=>({experimental_exec:[]}), close:async()=>{} };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config:{...config,execMode:'script'}, workspace,
    factory:()=>({reset(){}, async run(prompt){ turn++; return streamOf(turn===1?'BAD':'fixed'); }}) });
  const out=await engine.run(engine.validate(basic()));
  assert.equal(out.choices[0].message.content,'fixed');
  assert.equal(out.x_m365.exec_contract_repairs,1);
  engine.close();
});

test('Full Workspace enforces one host inspection when a project task is answered without an action', async () => {
  let turn=0, executed=0;
  const executor={ instruction:()=> '\nEXEC CONTRACT\n', parse(text){ if(text==='ACTION') return {action:{language:'bash',script:'pwd'},text:''}; return {action:null,text};},
    requireActionPrompt:()=> 'REQUIRE REAL INSPECTION', repairPrompt:()=> 'REPAIR', async execute(){executed++;return {language:'bash',exit_code:0,timed_out:false,output_truncated:false,stdout:'/workspace',stderr:'',duration_ms:1};}, resultPrompt:()=> 'RESULT /workspace', status:()=>({enabled:true}),close:async()=>{} };
  const project={id:'default',writeMode:'off',execMode:'script',contextPolicy:'adaptive',conversationMode:'reuse',mode:'read',executor,fingerprint:'enforce'};
  const workspace={select:()=>project,bind(r){r.localExec=true;r.workspaceProject='default';r.uploadWorkspace=false;r.bufferOutput=true;r.contextIdentity='enforce';return r;},
    async prepare(){return {id:'s',prompt:'CAP',selected:[],contextSkipped:true,requiresAction:true,summary:{project_id:'default',context_decision:'exec_capability'}};},instruction:()=> '\nCAP\n',finalize:async()=>({}),list:()=>({experimental_exec:[]}),close:async()=>{}};
  const engine=new ProxyEngine({core:fakeCore(),auth:fakeAuth(),config:{...config,execMode:'script'},workspace,
    factory:()=>({reset(){},async run(){turn++;return streamOf(turn===1?'I think it is fine':turn===2?'ACTION':'grounded final');}})});
  const out=await engine.run(engine.validate({model:'m365-copilot',messages:[{role:'user',content:'analyze the project and tell me what to fix'}]}));
  assert.equal(executed,1); assert.equal(out.choices[0].message.content,'grounded final'); assert.equal(out.x_m365.exec_action_enforcements,1);
  engine.close();
});
