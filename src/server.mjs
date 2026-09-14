import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { safeEqual } from './util.mjs';
import { ProxyError, invalid, publicError } from './errors.mjs';
import { abortable } from './lifecycle.mjs';
import { responsesToChatRequest, chatToResponse, responseShell } from './responses.mjs';
import { ollamaToChatRequest, chatToOllama, ollamaMessage, ollamaModels, ollamaShow } from './ollama.mjs';
import { resolveRoute, diagnosticPath } from './routes.mjs';

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ProxyError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  if (req.headers['content-encoding']) throw new ProxyError(415, 'unsupported_encoding', 'Compressed request bodies are not accepted.');
  if (Number(req.headers['content-length']) > maxBytes) throw new ProxyError(413, 'body_too_large', 'Request body exceeds the local limit.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ProxyError(413, 'body_too_large', 'Request body exceeds the local limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('Malformed JSON body.'); }
}

async function write(res, value, signal) {
  signal?.throwIfAborted();
  if (res.destroyed || res.writableEnded || !res.socket || res.socket.destroyed) {
    throw new DOMException('Client disconnected.', 'AbortError');
  }
  if (!res.write(value)) await once(res, 'drain', { signal });
}

function beginSse(res, extra = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extra,
  });
  res.flushHeaders();
}

async function responseEvent(res, type, payload, signal) {
  await write(res, `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`, signal);
}

async function writeChatStream(res, engine, request, { sessionId, signal, requestId, idempotencyKey }) {
  const id = 'chatcmpl-' + randomUUID().replaceAll('-', '');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created,
    model: request.requestedModel, choices: [{ index: 0, delta, finish_reason }] });
  let started = false;
  const start = async () => {
    if (started) return;
    signal.throwIfAborted(); started = true;
    beginSse(res, { 'X-Tool-Streaming': (request.activeTools.length || request.bufferOutput) ? 'buffered-until-validated' : 'text-deltas', 'x-should-retry': 'false' });
    await write(res, 'data: ' + JSON.stringify(chunk({ role: 'assistant', content: '' })) + '\n\n', signal);
  };
  // Delay 200/SSE headers until useful output exists. Missing auth, connection
  // errors and first-token timeouts then remain real HTTP JSON errors.
  const result = await abortable(() => engine.run(request, {
    sessionId, signal, requestId, idempotencyKey,
    onDelta: async (text) => { await start(); await write(res, 'data: ' + JSON.stringify(chunk({ content: text })) + '\n\n', signal); },
  }), signal);
  await start();
  const choice = result.choices[0];
  if ((request.activeTools.length || request.bufferOutput) && choice.message.content) await write(res, 'data: ' + JSON.stringify(chunk({ content: choice.message.content })) + '\n\n', signal);
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
    await write(res, 'data: ' + JSON.stringify(chunk({ tool_calls: [{ index, ...call }] })) + '\n\n', signal);
  }
  await write(res, 'data: ' + JSON.stringify({ ...chunk({}, choice.finish_reason), x_m365: result.x_m365 }) + '\n\ndata: [DONE]\n\n', signal);
  res.end();
}

async function writeResponsesStream(res, engine, request, { sessionId, signal, requestId, idempotencyKey }) {
  const id = 'resp_' + randomUUID().replaceAll('-', '');
  const createdAt = Math.floor(Date.now() / 1000);
  const messageId = 'msg_' + randomUUID().replaceAll('-', '');
  let sequence = 0, started = false, textItemStarted = false, textSoFar = '';
  const emit = (type, payload) => responseEvent(res, type, { sequence_number: sequence++, ...payload }, signal);
  const start = async () => {
    if (started) return;
    signal.throwIfAborted(); started = true;
    beginSse(res, { 'X-M365-Responses-Streaming': (request.activeTools.length || request.bufferOutput) ? 'buffered-until-validated' : 'text-deltas', 'x-should-retry': 'false' });
    // Installed only after SSE starts. Use a proper terminal Responses event.
    res.m365ResponseFailure = (error) => {
      const response = responseShell({ id, createdAt, model: request.requestedModel, status: 'failed' });
      response.error = { code: error.code, message: error.message };
      if (textItemStarted) response.output = [{ id: messageId, type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: textSoFar, annotations: [] }] }];
      return 'event: response.failed\ndata: ' + JSON.stringify({ type: 'response.failed', sequence_number: sequence++, response }) + '\n\n';
    };
    await emit('response.created', { response: responseShell({ id, createdAt, model: request.requestedModel }) });
    await emit('response.in_progress', { response: responseShell({ id, createdAt, model: request.requestedModel }) });
  };
  const textDelta = async (text) => {
    await start();
    if (!textItemStarted) {
      textItemStarted = true;
      await emit('response.output_item.added', { output_index: 0, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      await emit('response.content_part.added', { item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    }
    textSoFar += text;
    await emit('response.output_text.delta', { item_id: messageId, output_index: 0, content_index: 0, delta: text });
  };
  const result = await abortable(() => engine.run(request, { sessionId, signal, requestId, idempotencyKey,
    onDelta: (request.activeTools.length || request.bufferOutput) ? undefined : textDelta }), signal);
  const final = chatToResponse(result, { id, createdAt });
  await start();
  for (const [outputIndex, item] of final.output.entries()) {
    if (item.type === 'message') {
      if (textItemStarted && outputIndex === 0) item.id = messageId;
      else {
        await emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
        await emit('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...item.content[0], text: '' } });
        if (item.content[0].text) await emit('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: item.content[0].text });
      }
      const part = item.content[0];
      await emit('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text });
      await emit('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part });
      await emit('response.output_item.done', { output_index: outputIndex, item });
    } else if (item.type === 'function_call') {
      await emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', arguments: '' } });
      if (item.arguments) await emit('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments });
      await emit('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
      await emit('response.output_item.done', { output_index: outputIndex, item });
    }
  }
  await emit('response.completed', { response: final });
  res.end();
}

async function writeOllamaStream(res, engine, request, { sessionId, signal, requestId, idempotencyKey }) {
  let started = false;
  const emit = async (data) => {
    if (!started) {
      signal.throwIfAborted(); started = true;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', 'x-should-retry': 'false' });
      res.flushHeaders();
    }
    await write(res, JSON.stringify({ model: request.requestedModel, created_at: new Date().toISOString(), ...data }) + '\n', signal);
  };
  const result = await abortable(() => engine.run(request, { sessionId, signal, requestId, idempotencyKey,
    onDelta: (request.activeTools.length || request.bufferOutput) ? undefined : async (text) => emit({ message: { role: 'assistant', content: text }, done: false }),
  }), signal);
  if (request.activeTools.length || request.bufferOutput) await emit({ message: ollamaMessage(result.choices[0].message), done: false });
  await emit({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
    x_m365: { ...result.x_m365, wire_format: 'ollama', token_usage: 'unavailable' } });
  res.end();
}

export function createProxyServer({ engine, apiKey, config, logger = () => {} }) {
  const server = createServer(async (req, res) => {
    req.socket?.setKeepAlive?.(true, 10000);
    req.socket?.setNoDelay?.(true);
    let heartbeat, timer, responseApi = false, ollamaApi = false;
    const requestId = randomUUID();
    const started = Date.now();
    res.setHeader('X-Request-Id', requestId);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new DOMException('Client disconnected.', 'AbortError')); };
    res.on('close', abort);
    try {
      const host = req.headers.host ?? '';
      const expectedPort = server.address()?.port;
      const allowedHosts = new Set([
        `${config.host}:${expectedPort}`,
        `127.0.0.1:${expectedPort}`,
        `localhost:${expectedPort}`,
        `[::1]:${expectedPort}`,
      ]);
      if (expectedPort === 80) {
        allowedHosts.add(config.host);
        allowedHosts.add('127.0.0.1');
        allowedHosts.add('localhost');
        allowedHosts.add('[::1]');
      }
      if (!allowedHosts.has(host)) throw new ProxyError(403, 'invalid_host', 'Only the local listener Host is accepted.');
      if (req.headers.origin !== undefined || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) throw new ProxyError(403, 'browser_origin_denied', 'Browser-origin calls are disabled. Use a local native client.');
      let path = new URL(req.url, `http://${host}`).pathname.replace(/\/+$/, '') || '/';
      const scoped = path.match(/^\/projects\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})(\/.*)$/);
      const headerProject = req.headers['x-m365-project'];
      if (scoped && headerProject !== undefined && scoped[1] !== headerProject) throw invalid('The project URL and X-M365-Project disagree.');
      const projectId = scoped?.[1] ?? headerProject;
      if (scoped) path = scoped[2];
      const route = resolveRoute(path, req.method, config.compatMode);
      ollamaApi = route.ollama;
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), apiKey)) throw new ProxyError(401, 'invalid_api_key', 'A valid local API key is required. Run m365proxy key.');

      logger('http_request', { request_id: requestId, route: route.name, method: req.method, path: diagnosticPath(path) });
      if (route.alias) {
        res.setHeader('X-M365-Route-Alias', path);
        logger('route_alias', { request_id: requestId, route: route.name, method: req.method, path: diagnosticPath(path) });
      }
      if (projectId !== undefined) {
        if (!engine.workspace) throw new ProxyError(404, 'unknown_project', 'Workspace context is not configured.');
        engine.workspace.select(projectId);
      }
      if (['changes', 'changes_undo'].includes(route.name)) {
        const project = engine.workspace?.select(projectId);
        if (!project) throw new ProxyError(400, 'workspace_disabled', 'Configure the same workspace to inspect or restore changes.');
        if (route.name === 'changes') return json(res, 200, { project_id: project.id, changes: await engine.workspace.writer.list(project) });
        const payload = await readBody(req, 4096);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((k) => k !== 'change_id')) throw invalid('Undo accepts only change_id.');
        const result = await engine.runExclusive(() => engine.workspace.writer.undo(project, payload.change_id, { signal: controller.signal }), { signal: controller.signal, requestId });
        return json(res, 200, result);
      }
      if (route.name === 'workspaces') return json(res, 200, engine.workspace?.list() ?? { enabled: false });
      if (['workspace_context', 'patch_check'].includes(route.name)) {
        if (!engine.workspace) throw new ProxyError(400, 'workspace_disabled', 'Configure --workspace or --workspaces first.');
        const payload = await readBody(req, config.maxBodyBytes);
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Expected a JSON object.');
        if (route.name === 'patch_check') {
          if (projectId !== undefined && payload.project_id !== projectId) throw invalid('The proposal and project URL disagree.');
          return json(res, 200, await engine.workspace.check(payload, { signal: controller.signal }));
        }
        if (Object.keys(payload).some((k) => !['project', 'query'].includes(k)) || (payload.query !== undefined && (typeof payload.query !== 'string' || payload.query.length > 12000))) throw invalid('Context accepts only project and a bounded query. Filesystem paths cannot be registered by HTTP.');
        if (projectId !== undefined && payload.project !== undefined && projectId !== payload.project) throw invalid('Project IDs disagree.');
        const snapshot = await engine.workspace.snapshot(projectId ?? payload.project, payload.query ?? '', { signal: controller.signal });
        return json(res, 200, { ...snapshot.summary, sent_to_microsoft: false });
      }
      if (route.name === 'health') return json(res, 200, engine.health());
      if (route.name === 'models') return json(res, 200, engine.modelList());
      if (route.name === 'ollama_tags') return json(res, 200, ollamaModels(engine));
      if (route.name === 'ollama_version') return json(res, 200, { version: '0.9.0-m365proxy', x_m365: { ollama_server: false, compatibility: 'text chat and emulated tools only' } });
      if (route.name === 'ollama_show') return json(res, 200, ollamaShow(await readBody(req, config.maxBodyBytes), engine));
      responseApi = route.name === 'responses';
      if (!['chat_completions', 'responses', 'ollama_chat'].includes(route.name)) {
        const status = route.name === 'wrong_method' ? 405 : 404;
        if (status === 405) res.setHeader('Allow', route.expected);
        throw new ProxyError(status, 'unsupported_route',
          `Unsupported ${['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'].includes(req.method) ? req.method : 'method'} ${diagnosticPath(path)}. Use OpenAI-compatible baseURL http://${config.host}:${expectedPort}/v1 (POST /v1/chat/completions or /v1/responses), or native Ollama POST /api/chat. An endpoint URL is not a baseURL; do not append /chat/completions twice. Anthropic /messages is not implemented. Request ID: ${requestId}`);
      }

      const body = await readBody(req, config.maxBodyBytes);
      let request;
      if (responseApi) {
        const adapted = responsesToChatRequest(body, config);
        request = engine.validate(adapted.body, projectId);
        request.ignoredParameters.push(...adapted.ignored);
      } else if (ollamaApi) {
        const adapted = ollamaToChatRequest(body, config);
        request = engine.validate(adapted.body, projectId);
        request.ignoredParameters.push(...adapted.ignored);
      } else {
        request = engine.validate(body, projectId);
      }

      engine.assertReady();
      timer = setTimeout(() => controller.abort(new ProxyError(504, 'request_timeout', 'The local request deadline expired. No automatic replay was made.')), config.requestTimeoutMs + (config.queueWaitMs ?? 240000) + 5000);
      const sessionId = req.headers['x-session-id'];
      const idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey))) throw invalid('Invalid Idempotency-Key header.');

      if (!request.stream) {
        const result = await abortable(() => engine.run(request, { sessionId, signal: controller.signal, requestId, idempotencyKey }), controller.signal);
        return json(res, 200, responseApi ? chatToResponse(result) : ollamaApi ? chatToOllama(result) : result);
      }

      if (!ollamaApi) heartbeat = setInterval(() => { if (res.headersSent && !res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': keepalive\n\n'); }, 10000);
      if (ollamaApi) await writeOllamaStream(res, engine, request, { sessionId, signal: controller.signal, requestId, idempotencyKey });
      else if (responseApi) await writeResponsesStream(res, engine, request, { sessionId, signal: controller.signal, requestId, idempotencyKey });
      else await writeChatStream(res, engine, request, { sessionId, signal: controller.signal, requestId, idempotencyKey });
    } catch (error) {
      const e = publicError(error);
      logger('http_error', { request_id: requestId, status: e.status, code: e.code, elapsed_ms: Date.now() - started });
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.setHeader('x-should-retry', 'false');
        if (e.status === 429) res.setHeader('Retry-After', '5');
        json(res, e.status, ollamaApi ? { error: e.message, code: e.code } : e.toJSON());
      } else if (ollamaApi) {
        res.end(JSON.stringify({ error: e.message, code: e.code }) + '\n');
      } else if (responseApi) {
        res.end(res.m365ResponseFailure ? res.m365ResponseFailure(e) : `event: error\ndata: ${JSON.stringify({ type: 'error', error: e.toJSON().error })}\n\n`);
      } else {
        res.end('data: ' + JSON.stringify(e.toJSON()) + '\n\ndata: [DONE]\n\n');
      }
    } finally {
      clearInterval(heartbeat); clearTimeout(timer); res.off('close', abort);
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return server;
}
