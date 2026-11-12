import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, request, notify };
}

test('MCP server: handshake, tool list and tool calls over stdio', async (t) => {
  const { child, request, notify } = startServer();
  t.after(() => child.kill());

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'commit-vitals');
  notify('notifications/initialized');

  const list = await request('tools/list', {});
  const names = list.result.tools.map((x) => x.name);
  assert.deepEqual(names, ['vitals_status', 'vitals_init', 'vitals_measure', 'vitals_result', 'vitals_history', 'vitals_compare', 'vitals_setup_info']);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-mcp-'));
  const status = await request('tools/call', { name: 'vitals_status', arguments: { project_dir: dir } });
  assert.match(status.result.content[0].text, /not set up/);

  const bad = await request('tools/call', { name: 'vitals_init', arguments: { project_dir: dir, urls: [{ url: 'ftp://nope' }] } });
  assert.equal(bad.result.isError, true);

  const ok = await request('tools/call', {
    name: 'vitals_init',
    arguments: { project_dir: dir, urls: [{ name: 'home', url: 'https://example.com/' }], runs: 1 },
  });
  assert.ok(!ok.result.isError, ok.result.content[0].text);
  assert.ok(fs.existsSync(path.join(dir, '.vitals', 'config.json')));

  const unknown = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);

  const missing = await request('does/not/exist', {});
  assert.equal(missing.error.code, -32601);
});
