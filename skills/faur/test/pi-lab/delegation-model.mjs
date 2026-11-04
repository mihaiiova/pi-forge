// Script both sides independently: asynchronous lead and child requests race.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
let lead = 0, child = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const input = JSON.parse(body);
    const messages = input.messages ?? [];
    const isChild = !(input.tools ?? []).some(t => t.function?.name === 'subagent');
    const last = messages.filter(m => m.role === 'tool').at(-1);
    appendFileSync(process.env.FAUR_DELEGATION_LOG, JSON.stringify({ child: isChild, tools: (input.tools ?? []).map(t => t.function?.name), result: last?.content ?? null }) + '\n');
    const step = isChild
      ? (child++ ? { text: 'child done' } : { tool: process.env.FAUR_DELEGATION_TOOL, args: {} })
      : (lead++ ? { text: 'lead done' } : { tool: 'subagent', args: { agent: 'worker', task: 'test', async: process.env.FAUR_DELEGATION_ASYNC === 'true' } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (step.tool) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: step.text }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
}).listen(Number(process.env.FAKE_PORT), '127.0.0.1');
