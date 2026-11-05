#!/usr/bin/env node
/**
 * A minimal stdio MCP server for tests: newline-delimited JSON-RPC with the
 * tools named in MCP_TOOLS (comma-separated, default "get_report,run_audit,delete_all").
 * Each call is appended to the file named by MCP_LOG as "<tool>\n".
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const tools = (process.env.MCP_TOOLS ?? 'get_report,run_audit,delete_all').split(',').filter(Boolean);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'faur-test', version: '1.0.0' } });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: tools.map(name => ({ name, description: `Test tool ${name}`, inputSchema: { type: 'object', properties: {} } })) });
  if (method === 'tools/call') {
    if (!tools.includes(params?.name)) return fail(id, `Unknown tool ${params?.name}`);
    if (process.env.MCP_LOG) appendFileSync(process.env.MCP_LOG, `${params.name}\n`);
    return reply(id, { content: [{ type: 'text', text: `called ${params.name}` }] });
  }
  fail(id, `Unknown method ${method}`);
});
