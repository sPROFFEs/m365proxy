import { randomUUID } from 'node:crypto';
import { ProxyError, invalid, publicError } from './errors.mjs';
import { normalizeRequest } from './contracts.mjs';
import { createToolShim } from './tool-shim.mjs';
import { SessionStore } from './session-store.mjs';
import { WorkerModelSession } from './worker-session.mjs';
import { RequestQueue } from './request-queue.mjs';
import { sha256, stable } from './util.mjs';
import { localWriteMessage } from './auto-edits.mjs';
import { abortable, detachCleanup } from './lifecycle.mjs';

function currentUserText(messages) {
  const users = (messages ?? []).filter((m) => m?.role === 'user' && typeof m.content === 'string');
  return users.at(-1)?.content ?? '';
}

function compactBrowserExecMessages(messages) {
  // OpenAI-compatible coding CLIs can attach very large system/developer prompts
  // even when client tools are suppressed. In EXEC browser mode those prompts
  // describe the *client* agent, not the local host-action bridge, and sending
  // them into Copilot makes the browser composer huge. Keep conversational
  // user/assistant context but drop client-side system boilerplate; the proxy's
  // own workspace/EXEC contracts are appended separately below.
  const compact = messages.filter((message) => !['system', 'developer'].includes(message?.role));
  return compact.length ? compact : messages.slice(-1);
}

export class ProxyEngine {
  constructor({ core, auth, config, factory, workspace, upload, logger = () => {} }) {
    this.core = core; this.auth = auth; this.config = config; this.logger = logger; this.workspace = workspace; this.upload = upload;
    this.queue = new RequestQueue({ maxPending: config.queueMaxPending ?? 4, waitMs: config.queueWaitMs ?? 240000 });
    this.busy = false; this.lastSuccessAt = null; this.lastError = null; this.active = null;
    const directFactory = factory ?? (() => new WorkerModelSession({
      getToken: () => auth.getTokenNow(), maxOutputChars: config.maxOutputChars,
    }));
    this.sessions = new SessionStore(directFactory, config);
    // EXEC gets its own direct-session pool with sticky reuse. Coding CLIs often
    // rewrite/omit system history between turns; exact-prefix matching alone can
    // otherwise rotate the Chathub conversation even though the user stayed in
    // the same local chat. Keeping this pool separate avoids changing normal chat.
    this.execSessions = new SessionStore(directFactory, { ...config, stickyFallback: (config.conversationMode ?? 'reuse') === 'reuse' });
    this.uploadSessions = upload ? new SessionStore(() => upload.createSession?.() ?? ({ reusable: () => true, run: (args) => upload.run(args), reset: async () => {} }), { ...config, stickyFallback: (config.conversationMode ?? 'reuse') === 'reuse' }) : null;
    this.models = core.getAvailableModels();
    this.authListener = () => {
      const state = this.auth.status().state;
      if (['account_changed', 'browser_closed'].includes(state)) {
        this.activeController?.abort(new ProxyError(428, state, 'The browser session changed or closed. Sign in again and explicitly retry.'));
        this.sessions.clear();
        this.execSessions.clear();
        this.uploadSessions?.clear();
      }
    };
    this.auth.on?.('state', this.authListener);
  }
  routeModel(requested) {
    if (this.models.includes(requested)) return requested;
    if (!this.config.compatMode) throw invalid('Unknown model. Select an ID from /v1/models; IDs are upstream routing labels, not verified model identities.', 'model');
    if (this.models.includes(this.config.defaultModel)) return this.config.defaultModel;
    if (this.models.length) return this.models[0];
    throw new ProxyError(503, 'no_models', 'The installed cramt core did not expose any model routes.');
  }
  validate(body, projectId) {
    const project = this.workspace?.select(projectId);
    const auto = project?.writeMode === 'auto';
    const localExec = project?.execMode === 'script';
    const suppressed = [];
    if ((auto || localExec) && body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body };
      const reason = auto ? 'proxy_owns_writes' : 'proxy_owns_host_actions';
      for (const field of ['tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call']) if (field in body) { suppressed.push(field + ':' + reason); delete body[field]; }
    }
    const request = normalizeRequest(body, this.config);
    request.ignoredParameters.push(...suppressed);
    request.requestedModel = request.model;
    request.upstreamModel = this.routeModel(request.model);
    request.forceFreshSession = this.config.conversationMode === 'fresh';
    if (request.upstreamModel !== request.requestedModel) request.ignoredParameters.push(`model_alias:${request.requestedModel}`);
    if (this.workspace) this.workspace.bind(request, projectId);
    else if (projectId !== undefined) throw new ProxyError(404, 'unknown_project', 'Workspace context is not configured on this proxy.');
    return request;
  }
  modelList() {
    const ids = [...new Set([this.config.defaultModel, ...this.models])];
    return { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'm365-web-proxy' })) };
  }
  assertReady() {
    if (this.auth.status().state !== 'ready') {
      if (this.auth.getTokenNow) this.auth.getTokenNow(); // Throws a specific, safe browser error.
      throw new ProxyError(428, 'authentication_required',
        'Microsoft browser authentication is not ready. Complete sign-in/MFA in the dedicated browser and send a short Copilot message there; then retry. No prompt was sent to Microsoft.');
    }
  }
  health() {
    const auth = this.auth.status();
    return {
      version: '0.9.0',
      status: auth.state === 'ready' ? this.busy ? 'busy' : 'ready' : 'authentication_required',
      auth,
      upload: this.upload?.status?.() ?? { enabled: false },
      workspace: this.workspace?.list() ?? { enabled: false },
      // A captured token does not prove that Microsoft accepts a backend request.
      upstream_status: this.active?.first_delta_received ? 'receiving_output' : this.busy ? 'waiting' : this.lastError ? 'error' : this.lastSuccessAt ? 'last_request_succeeded' : 'not_tested',
      busy: this.busy,
      queue: this.queue.status(),
      active_request: this.active ? { ...this.active, elapsed_ms: Date.now() - this.active.started_ms } : null,
      last_error: this.lastError,
      timeouts_ms: { total: this.config.requestTimeoutMs, first_token: this.config.firstTokenTimeoutMs ?? 45000, idle: this.config.idleTimeoutMs ?? 30000 },
      conversations_in_memory: this.sessions.size + this.execSessions.size + (this.uploadSessions?.size ?? 0),
      cramt_conversations_in_memory: this.sessions.size + this.execSessions.size,
      normal_cramt_conversations_in_memory: this.sessions.size,
      exec_cramt_conversations_in_memory: this.execSessions.size,
      browser_conversations_in_memory: this.uploadSessions?.size ?? 0,
      conversation_policy: { mode: this.config.conversationMode ?? 'reuse', ttl_ms: this.config.sessionTtlMs, max_turns: this.config.sessionMaxTurns, max_sessions: this.config.maxSessions },
      tool_mode: this.config.toolMode,
      experimental_exec: this.workspace?.list?.().experimental_exec ?? [],
      compatibility_mode: this.config.compatMode,
      default_model_route: this.models.includes(this.config.defaultModel) ? this.config.defaultModel : this.models[0] ?? null,
      studio_agent: false,
      last_success_at: this.lastSuccessAt,
    };
  }
  close() {
    this.queue.close();
    this.activeController?.abort(new DOMException('Proxy stopping.', 'AbortError'));
    this.sessions.clear();
    this.execSessions.clear();
    this.uploadSessions?.clear();
    // Do not remove an experimental script session while its in-flight child is
    // still unwinding. Service shutdown awaits drain() with its own bounded
    // deadline, so this remains bounded without racing workspace cleanup.
    if (!this.workspaceCleanup) this.workspaceCleanup = Promise.resolve(this.inFlight).catch(() => {}).then(() => this.workspace?.close?.()).catch(() => {});
    this.auth.off?.('state', this.authListener);
    return this.workspaceCleanup;
  }
  async drain() { await this.inFlight?.catch(() => {}); await this.workspaceCleanup?.catch(() => {}); }
  async runExclusive(task, { signal, requestId } = {}) {
    const release = await this.queue.acquire({ signal, onWait: (position) => this.logger('queued', { request_id: requestId, position, stage: 'queued' }) });
    const promise = Promise.resolve().then(() => { signal?.throwIfAborted(); if (this.queue.closed) throw new ProxyError(503, 'proxy_stopping', 'The proxy is stopping.'); return task(); }); this.inFlight = promise;
    try { return await promise; } finally { if (this.inFlight === promise) this.inFlight = null; release(); }
  }
  async run(request, options = {}) {
    options.signal?.throwIfAborted(); this.assertReady();
    return this.runExclusive(() => this.runActive(request, options), options);
  }
  async runActive(request, { sessionId, signal: parentSignal, onDelta, requestId, idempotencyKey } = {}) {
    parentSignal?.throwIfAborted();
    this.assertReady();
    this.busy = true;
    const controller = new AbortController();
    this.activeController = controller;
    const signal = controller.signal;
    const relayAbort = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener('abort', relayAbort, { once: true });
    if (parentSignal?.aborted) relayAbort();
    const started = Date.now();
    this.active = { request_id: requestId ?? randomUUID(), stage: 'checking_session', started_ms: started, first_delta_received: false, characters_received: 0 };
    const log = (event, extra = {}) => this.logger(event, { request_id: this.active?.request_id, stage: this.active?.stage, elapsed_ms: Date.now() - started, ...extra });
    const phase = (stage) => { if (this.active.stage !== stage) { this.active.stage = stage; log('stage'); } };
    const timeout = (code, detail) => controller.abort(new ProxyError(504, code,
      `${detail} Stage: ${this.active?.stage ?? 'unknown'}. The local request was stopped; no automatic replay was made.`));
    const totalTimer = setTimeout(() => timeout('request_timeout', 'The total request deadline expired.'), this.config.requestTimeoutMs ?? 90000);
    let progressTimer = setTimeout(() => timeout('first_token_timeout', 'Copilot did not return response text before the first-token deadline.'), this.config.firstTokenTimeoutMs ?? 45000);
    const ticker = setInterval(() => log('waiting'), 10000);
    let entry, sessionStore, iterator, stream, snapshot, completed = false;
    const requestFingerprint = request.autoWrite ? sha256(stable({ context: request.contextIdentity, model: request.requestedModel, messages: request.messages, session: sessionId ?? null, key: idempotencyKey ?? null })) : undefined;
    const idempotencyKeyHash = request.autoWrite && idempotencyKey ? sha256(request.contextIdentity + ':' + idempotencyKey) : undefined;
    log('started');
    const progress = (text) => {
      if (!text) return;
      clearTimeout(progressTimer);
      if (!this.active.first_delta_received) { this.active.first_delta_received = true; log('first_delta'); }
      this.active.characters_received += text.length;
      phase('receiving_output');
      progressTimer = setTimeout(() => timeout('upstream_idle_timeout', 'Copilot stopped sending response text before completion.'), this.config.idleTimeoutMs ?? 30000);
    };
    try {
      // No browser navigation / MFA wait inside inference, including callbacks
      // made from cramt's own ModelSession via the isolated worker.
      await abortable(() => this.auth.getTokenNow ? this.auth.getTokenNow() : this.auth.getToken({ signal, timeoutMs: 0, reload: false }), signal);
      if (request.autoWrite) {
        const write = await this.workspace.writer.replay(this.workspace.select(request.workspaceProject), requestFingerprint, { signal, idempotencyKeyHash });
        if (write) {
          this.lastSuccessAt = new Date().toISOString(); this.lastError = null; log('write_replayed');
          return { id: 'chatcmpl-' + randomUUID().replaceAll('-', ''), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.requestedModel,
            choices: [{ index: 0, message: { role: 'assistant', content: localWriteMessage(write) }, finish_reason: 'stop' }],
            x_m365: { workspace: { project_id: request.workspaceProject, write }, tool_calls_emulated: false, session_reused: false, ignored_parameters: request.ignoredParameters } };
        }
      }
      if (request.workspaceProject) {
        clearTimeout(progressTimer); phase('building_context');
        snapshot = await abortable(() => this.workspace.prepare(request, { signal }), signal);
        log('context_ready', { files: snapshot.selected.length, context_bytes: snapshot.summary.context_bytes });
        progressTimer = setTimeout(() => timeout('first_token_timeout', 'Copilot did not return response text before the first-token deadline.'), this.config.firstTokenTimeoutMs ?? 45000);
      }
      // Stable transport rule: a request never switches transport because of prompt heuristics.
      // EXEC owns workspace/host access through the local bridge and therefore always uses direct
      // Chathub. Browser upload remains isolated to non-EXEC upload/hybrid profiles. This restores
      // the pre-EXEC browser path and prevents one local chat from bouncing between unrelated
      // remote conversation implementations.
      const useBrowserTransport = Boolean(request.uploadWorkspace && !request.localExec);
      sessionStore = useBrowserTransport ? this.uploadSessions : request.localExec ? this.execSessions : this.sessions;
      if (!sessionStore) throw new ProxyError(503, 'upload_unavailable', 'Browser upload transport is not initialized. Restart with the current service.');
      log('route_plan', { mode: request.localExec ? 'full_workspace' : useBrowserTransport ? 'browser_context' : request.workspaceProject ? 'workspace_context' : 'chat', transport: useBrowserTransport ? 'browser_upload' : 'direct_chathub', selected_files: snapshot?.selected?.length ?? 0, context_decision: snapshot?.contextDecision ?? null });
      if (request.localExec) log('exec_transport_selected', { transport: 'direct_chathub', selected_files: 0 });
      let selected = sessionStore.checkout(request, sessionId);
      entry = selected.entry;
      // A retained browser session can disappear when its tab is manually closed.
      // Do not send only the delta into a fresh remote conversation. Drop it and
      // reconstruct from the complete client history in the same HTTP request.
      if (useBrowserTransport && selected.reused && !entry.backend.reusable?.()) {
        sessionStore.drop(entry);
        selected = sessionStore.checkout(request, sessionId);
        entry = selected.entry;
      }
      const shim = createToolShim(this.core, request, this.config.toolMode);
      const executor = request.localExec ? this.workspace?.select(request.workspaceProject)?.executor : null;
      if (request.localExec && !executor) throw new ProxyError(503, 'exec_unavailable', 'Experimental local execution was enabled but its workspace executor is unavailable. Restart the proxy.');
      const promptMessages = request.localExec ? compactBrowserExecMessages(selected.delta) : selected.delta;
      const strippedClientInstructions = selected.delta.length - promptMessages.length;
      let prompt = this.core.formatMessages(promptMessages, request.activeTools, request.toolChoice) + (this.workspace?.instruction(request, snapshot) ?? '') + (executor?.instruction() ?? '') + shim.instruction;
      if (useBrowserTransport) log('browser_prompt_ready', { prompt_bytes: Buffer.byteLength(prompt, 'utf8'), stripped_client_instructions: strippedClientInstructions });
      else if (request.localExec) log('exec_prompt_ready', { prompt_bytes: Buffer.byteLength(prompt, 'utf8'), stripped_client_instructions: strippedClientInstructions });
      let parsed, output = '', repairs = 0, uploadResult, execRepairs = 0, execEnforcements = 0;
      const execSteps = [];
      const userText = currentUserText(request.messages);
      for (;;) {
        signal.throwIfAborted();
        if (useBrowserTransport) {
          clearTimeout(progressTimer);
          uploadResult = await abortable(() => entry.backend.run({ snapshot, prompt, signal, reused: selected.reused || execSteps.length > 0, onText: progress, onPhase: (stage) => {
            phase(stage);
            // Browser preparation, upload and send-control recovery are not model
            // inference time. Keep the first-token deadline stopped until the UI
            // has actually submitted the owned turn.
            if (stage === 'locating_uploader' || stage === 'uploading_files' ||
                stage === 'typing_prompt_native' || stage === 'sending_browser_prompt' || /^send_/.test(stage) ||
                /_(?:locating_uploader|uploading_files|typing_prompt_native|sending_prompt|send_[a-z_]+)$/.test(stage)) clearTimeout(progressTimer);
            if (stage === 'waiting_browser_answer' || /_waiting_answer$/.test(stage)) {
              clearTimeout(progressTimer);
              progressTimer = setTimeout(() => timeout('first_token_timeout', 'The browser returned no answer text after sending.'), this.config.firstTokenTimeoutMs ?? 45000);
            }
          } }), signal);
          const text = uploadResult.text;
          stream = { fullText: text, async *[Symbol.asyncIterator]() { yield text; } };
        } else {
          phase('connecting_upstream');
          stream = await abortable(() => entry.backend.run(prompt, request.upstreamModel, signal, false), signal,
            (late) => detachCleanup(() => late?.return?.()));
        }
        iterator = stream[Symbol.asyncIterator]();
        completed = false; output = '';
        const canStreamText = request.activeTools.length === 0 && !request.bufferOutput;
        phase('waiting_first_delta');
        for (;;) {
          const step = await abortable(() => iterator.next(), signal);
          if (step.done) { completed = true; break; }
          const fragment = step.value;
          if (typeof fragment !== 'string') throw new ProxyError(502, 'upstream_protocol_error', 'Expected a text delta from cramt.');
          output += fragment;
          if (output.length > this.config.maxOutputChars) throw new ProxyError(502, 'output_limit', 'Copilot output exceeded the configured local size limit.');
          progress(fragment);
          if (canStreamText && fragment && onDelta) await abortable(() => onDelta(fragment), signal);
        }
        clearTimeout(progressTimer);
        const finalText = typeof stream.fullText === 'string' && stream.fullText ? stream.fullText : output;
        if (finalText.length > this.config.maxOutputChars) throw new ProxyError(502, 'output_limit', 'Copilot output exceeded the configured local size limit.');
        if (canStreamText && finalText !== output) {
          if (!finalText.startsWith(output)) throw new ProxyError(502, 'upstream_rewrite', 'The upstream rewrote text that was already streamed; it cannot be represented as append-only OpenAI deltas.');
          const tail = finalText.slice(output.length);
          progress(tail); clearTimeout(progressTimer);
          if (onDelta) await abortable(() => onDelta(tail), signal);
        }
        output = finalText;
        if (/disengaged|blocked|refusal|contentfilter/i.test(stream.messageType ?? '')) throw new ProxyError(502, 'copilot_refusal', 'Copilot refused or disengaged. The proxy does not retry around that response.');
        if (!output.trim()) {
          if (/thrott|rate.?limit/i.test(stream.messageType ?? '') || (stream.throttle && stream.throttle.current >= stream.throttle.max)) throw new ProxyError(429, 'copilot_throttled', 'Copilot quota or rate limit reached. No reauthentication or conversation rotation was attempted.');
          throw new ProxyError(502, 'empty_response', 'Copilot returned no text. No automatic replay was attempted by this adapter.');
        }
        phase('validating_output');
        if (executor) {
          let proposed;
          try { proposed = executor.parse(output); }
          catch (error) {
            if (!(error instanceof ProxyError) || error.code !== 'exec_contract_error' || execRepairs >= 1) throw error;
            execRepairs++; phase('exec_contract_repair');
            log('exec_contract_repair', { attempt: execRepairs });
            prompt = executor.repairPrompt(error);
            clearTimeout(progressTimer);
            progressTimer = setTimeout(() => timeout('first_token_timeout', 'Copilot did not answer the execution-contract repair request.'), this.config.firstTokenTimeoutMs ?? 45000);
            continue;
          }
          if (proposed.action) {
            if (execSteps.length >= (this.config.execMaxSteps ?? 4)) throw new ProxyError(422, 'exec_step_limit', 'The model requested more experimental local execution steps than this profile allows. No additional script was run.');
            const stepNo = execSteps.length + 1;
            phase('executing_local_script');
            const result = await executor.execute(proposed.action, { signal, step: stepNo });
            const receipt = { step: stepNo, language: result.language, exit_code: result.exit_code, timed_out: result.timed_out,
              output_truncated: result.output_truncated, duration_ms: result.duration_ms, script_retained: false };
            execSteps.push(receipt);
            log('local_exec_completed', { step: stepNo, language: result.language, exit_code: result.exit_code, timed_out: result.timed_out, output_truncated: result.output_truncated });
            phase('returning_local_exec_result');
            prompt = executor.resultPrompt(result, stepNo);
            clearTimeout(progressTimer);
            progressTimer = setTimeout(() => timeout('first_token_timeout', 'Copilot did not answer after receiving a local execution result.'), this.config.firstTokenTimeoutMs ?? 45000);
            continue;
          }
          // In Full Workspace mode, project/host tasks must be grounded in actual local state.
          // If Copilot answers from assumptions without using the bridge, enforce one inspection
          // turn before accepting the final answer. This is bounded and never loops indefinitely.
          if (snapshot?.requiresAction && execSteps.length === 0 && execEnforcements < 1) {
            execEnforcements++; phase('exec_action_required');
            log('exec_action_required', { attempt: execEnforcements });
            prompt = executor.requireActionPrompt(userText);
            clearTimeout(progressTimer);
            progressTimer = setTimeout(() => timeout('first_token_timeout', 'Copilot did not propose the required local inspection/action.'), this.config.firstTokenTimeoutMs ?? 45000);
            continue;
          }
          output = proposed.text;
        }
        try { parsed = shim.parse(output); break; }
        catch (error) {
          if (!(error instanceof ProxyError) || error.code !== 'tool_contract_error' || useBrowserTransport || repairs >= this.config.repairAttempts) throw error;
          repairs++; phase('format_repair');
          progressTimer = setTimeout(() => timeout('first_token_timeout', 'The explicit format-repair attempt produced no response.'), this.config.firstTokenTimeoutMs ?? 45000);
          prompt = 'The previous proposed tool call failed local format validation. No tool was executed.\n' + error.message + '\nReturn a corrected proposal or an ordinary answer when a tool is not required.\n' + this.core.formatMessages([], request.activeTools, request.toolChoice) + (this.workspace?.instruction(request, snapshot) ?? '') + shim.instruction;
        }
      }
      signal.throwIfAborted();
      const assistant = { role: 'assistant', content: parsed.content };
      if (parsed.calls.length) assistant.tool_calls = parsed.calls;
      // NEVER detach filesystem writes on abort. Keep admission held through
      // commit/rollback; HTTP may disconnect, but a second turn must not race it.
      const finishWorkspace = () => this.workspace?.finalize(output, request, snapshot, { signal, requestFingerprint, idempotencyKeyHash, onPhase: phase });
      const workspaceResult = request.autoWrite ? await finishWorkspace() : this.workspace ? await abortable(finishWorkspace, signal) : null;
      if (request.autoWrite && request.localAnswer !== undefined) assistant.content = request.localAnswer;
      if (workspaceResult?.write?.applied) log('write_saved', { change_id: workspaceResult.write.change_id, files: workspaceResult.write.files.length });
      signal.throwIfAborted();
      if (entry) sessionStore.commit(entry, request, assistant);
      if (entry && request.forceFreshSession) sessionStore.drop(entry);
      this.lastSuccessAt = new Date().toISOString(); this.lastError = null;
      log('completed');
      return {
        id: 'chatcmpl-' + randomUUID().replaceAll('-', ''), object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: request.requestedModel,
        choices: [{ index: 0, message: assistant, finish_reason: parsed.calls.length ? 'tool_calls' : 'stop' }],
        x_m365: {
          ...(workspaceResult ? { workspace: { ...workspaceResult, ...(uploadResult?.metadata ?? {}) } } : {}),
          tool_calls_emulated: Boolean(parsed.calls.length), tool_mode: this.config.toolMode,
          session_reused: selected.reused, session_reuse_reason: selected.reason, format_repairs: repairs, studio_agent: false,
          runtime_mode: request.localExec ? 'full_workspace' : useBrowserTransport ? 'browser_context_advanced' : request.workspaceProject ? 'workspace_context' : 'chat_only',
          transport: useBrowserTransport ? 'browser_upload' : 'direct_chathub',
          upstream_model_route: useBrowserTransport ? 'copilot_web_default' : request.upstreamModel, ignored_parameters: [...new Set(request.ignoredParameters)],
          ...(request.localExec ? { exec_transport: 'direct_chathub', exec_contract_repairs: execRepairs, exec_action_enforcements: execEnforcements } : {}),
          conversation_quota: stream?.throttle ?? null,
          ...(request.localExec ? { local_exec: { enabled: true, experimental: true, sandboxed: false, confirmations: false, steps: execSteps } } : {}),
        },
      };
    } catch (error) {
      const safe = publicError(signal.aborted ? signal.reason : error);
      this.lastError = { code: safe.code, stage: this.active.stage, at: new Date().toISOString(), request_id: this.active.request_id };
      log('failed', { code: safe.code, status: safe.status });
      // Abort first, then discard this worker/session. Never wait indefinitely
      // for iterator.return() or an upstream cleanup Promise.
      if (!signal.aborted) controller.abort(safe);
      if (!completed && iterator) detachCleanup(() => iterator.return?.());
      if (entry) sessionStore?.drop(entry);
      throw safe;
    } finally {
      clearTimeout(totalTimer); clearTimeout(progressTimer); clearInterval(ticker);
      parentSignal?.removeEventListener('abort', relayAbort);
      this.activeController = null; this.active = null; this.busy = false;
    }
  }
}
