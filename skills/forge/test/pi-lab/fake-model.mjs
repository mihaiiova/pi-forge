// Scripted OpenAI-compatible chat-completions server, so real Pi runs cost no
// tokens and replay exactly. FAKE_SCRIPT is a JSON file with one step per
// request: { "text": "..." } | { "tool": "name", "args": {...} } | { "status": 500 }.
// The last step repeats. Each request is logged to FAKE_LOG as one JSON line:
// the tool names offered, the last tool result, which lab markers the system
// prompt contains, and the start of the first user message.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';

const MARKERS = ['HOST-AGENTS', 'PARENT-AGENTS', 'PROJECT-AGENTS', 'PROJECT-APPEND', 'HOST-APPEND', 'You are the worker'];
const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
let n = 0;

const text = (content) => typeof content === 'string' ? content : JSON.stringify(content ?? '');

createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const r = JSON.parse(body || '{}');
    const messages = r.messages ?? [];
    const system = text(messages.filter(m => m.role === 'system' || m.role === 'developer'));
    const lastTool = messages.filter(m => m.role === 'tool').at(-1);
    const firstUser = messages.find(m => m.role === 'user');
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({
      n,
      tools: (r.tools ?? []).map(t => t.function?.name),
      lastToolResult: lastTool ? text(lastTool.content).slice(0, 300) : null,
      markers: MARKERS.filter(m => system.includes(m)),
      firstUser: text(firstUser?.content?.[0]?.text ?? firstUser?.content).slice(0, 160),
    }) + '\n');

    const step = script[Math.min(n++, script.length - 1)];
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'fake failure', type: 'server_error' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices, ...extra })}\n\n`);
    const chunk = (delta, finish = null) => send([{ index: 0, delta, finish_reason: finish }]);
    if (step.tool) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: step.text });
      chunk({}, 'stop');
    }
    send([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end('data: [DONE]\n\n');
  });
}).listen(Number(process.env.FAKE_PORT), '127.0.0.1');
