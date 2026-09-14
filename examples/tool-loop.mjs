import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const key = process.env.OPENAI_API_KEY ?? (await readFile(join(process.env.M365_LOCAL_STATE_DIR ?? join(homedir(), '.m365-copilot-local'), 'api-key'), 'utf8')).trim();
const base = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8787/v1';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('This example only sends credentials to a loopback endpoint.');
const model = process.env.M365_LOCAL_MODEL ?? 'm365-copilot';
const tools = [{ type: 'function', function: { name: 'echo', description: 'Echo text using the LOCAL client.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
const messages = [{ role: 'user', content: 'Call the local echo tool with the text HOLA_LOCAL. After receiving the result, report it. Do not simulate its execution.' }];
async function complete(tool_choice) {
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Session-Id': 'echo-demo-' + process.pid }, body: JSON.stringify({ model, messages, tools, tool_choice, parallel_tool_calls: false, stream: false }) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.choices[0].message;
}
const first = await complete({ type: 'function', function: { name: 'echo' } });
if (first.tool_calls?.length !== 1) throw new Error('No actual tool call was returned.');
messages.push(first);
const call = first.tool_calls[0];
if (call.function.name !== 'echo') throw new Error('Unexpected tool. This demo never executes shell commands.');
const args = JSON.parse(call.function.arguments);
if (typeof args.text !== 'string') throw new Error('Invalid echo arguments.');
console.log('Client executes echo:', args.text);
messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ echoed_by_local_client: args.text }) });
console.log('Final answer:', (await complete('none')).content);
