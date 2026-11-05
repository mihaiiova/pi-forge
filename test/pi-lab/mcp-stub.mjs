// Minimal stdio MCP server: `<name>_ping` and `<name>_secret`, for load and exposure probes.
import { createInterface } from 'node:readline';
const name = process.argv[2] || 'stub';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const tool = (t) => ({ name: `${name}_${t}`, description: `${t} from ${name}`, inputSchema: { type: 'object', properties: {} } });
createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('ping'), tool('secret')] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `CALLED ${m.params.name}` }] } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } });
});
