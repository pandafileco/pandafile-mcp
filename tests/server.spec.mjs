import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, text, data, apiError, LIVE_KEY, TEST_KEY } from './helpers.mjs';
import { sdkBaseUrl, humanBytes } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'pf-mcp-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
mkdirSync(path.join(TMP, 'shoot', 'day1'), { recursive: true });
writeFileSync(path.join(TMP, 'shoot', 'cover.jpg'), Buffer.alloc(1000, 1));
writeFileSync(path.join(TMP, 'shoot', 'day1', 'clip.mov'), Buffer.alloc(200_000, 2));
writeFileSync(path.join(TMP, 'notes.txt'), 'hello\n');

const TOOLS = ['send_files', 'send_from_urls', 'get_import_status', 'list_transfers', 'get_transfer', 'add_recipients', 'remind_recipient',
  'update_transfer', 'delete_transfer', 'create_file_request', 'list_file_requests', 'close_file_request', 'get_account'];

test('lists every tool with a description, input schema and correct annotations', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of tools) {
    assert.ok(t.description.length > 60, `${t.name} description`);
    assert.equal(t.inputSchema.type, 'object');
    for (const [k, v] of Object.entries(t.inputSchema.properties || {})) assert.ok(v.description || v.items, `${t.name}.${k} described`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
  }
  for (const n of ['get_import_status', 'list_transfers', 'get_transfer', 'list_file_requests', 'get_account']) {
    assert.equal(by[n].annotations.readOnlyHint, true, n);
    assert.equal(by[n].annotations.destructiveHint, false, n);
  }
  for (const n of ['send_files', 'send_from_urls', 'add_recipients', 'remind_recipient', 'update_transfer', 'delete_transfer', 'create_file_request', 'close_file_request']) {
    assert.equal(by[n].annotations.readOnlyHint, false, n);
  }
  assert.equal(by.delete_transfer.annotations.destructiveHint, true);
  assert.equal(by.delete_transfer.annotations.idempotentHint, true);
  assert.equal(by.send_files.annotations.idempotentHint, false);
  assert.equal(by.remind_recipient.annotations.idempotentHint, false);
  assert.deepEqual(by.send_files.inputSchema.required, ['paths']);
  await close();
});

test('missing API key: every tool answers with setup instructions (isError), the server keeps running', async () => {
  const { client, api, close } = await connect({ apiKey: '' });
  for (const [name, args] of [['get_account', {}], ['list_transfers', {}], ['send_files', { paths: [path.join(TMP, 'notes.txt')] }]]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(text(r), /PANDAFILE_API_KEY is not set/);
    assert.match(text(r), /pandafile\.co\/dashboard/);
  }
  assert.equal(api.calls.length, 0, 'no request without a key');
  await close();
});

test('send_files: folder + file, tus upload, complete, progress notifications, expiry set afterwards', async () => {
  const { client, api, close } = await connect();
  const progress = [];
  const r = await client.callTool({ name: 'send_files', arguments: {
    paths: [path.join(TMP, 'shoot'), path.join(TMP, 'notes.txt')], title: 'Final cut', message: 'Enjoy', recipients: ['client@example.com'],
    expires_in_days: 60, password: 'blue-river-42',
  } }, undefined, { onprogress: (p) => progress.push(p) });
  assert.ok(!r.isError, text(r));
  const out = data(r);
  assert.equal(out.link, 'https://pandafile.co/d/tr1');
  assert.equal(out.id, 'tr1');
  assert.equal(out.files, 3);
  assert.equal(out.total_bytes, 1000 + 200_000 + 6);
  assert.deepEqual(out.file_list.map((f) => f.name), ['shoot/cover.jpg', 'shoot/day1/clip.mov', 'notes.txt']);
  assert.equal(out.recipients, '1 emailed');
  assert.ok(out.expires_at);
  const create = api.calls.find((c) => c.method === 'POST' && c.path === '/transfers');
  assert.deepEqual(create.body.recipients, ['client@example.com']);
  assert.equal(create.body.password, 'blue-river-42');
  assert.equal(create.body.title, 'Final cut');
  assert.equal(create.headers.authorization, `Bearer ${LIVE_KEY}`);
  assert.match(create.headers['user-agent'], /pandafile-mcp\/0\.1\.0/);
  assert.equal([...api.uploads.values()].reduce((s, u) => s + u.offset, 0), out.total_bytes, 'every byte uploaded');
  assert.ok(api.calls.some((c) => c.path === '/transfers/tr1/complete'));
  const patch = api.calls.find((c) => c.method === 'PATCH');
  const days = (new Date(patch.body.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 59.9 && days <= 60, `expiry ${days}`);
  assert.ok(progress.length >= 2, 'progress notifications');
  assert.equal(progress.at(-1).progress, out.total_bytes);
  assert.equal(progress.at(-1).total, out.total_bytes);
  assert.ok(!text(r).includes(LIVE_KEY));
  await close();
});

test('send_files: test key notes, refuses an expiry; bad paths are clear errors', async () => {
  const { client, api, close } = await connect({ apiKey: TEST_KEY });
  const r = await client.callTool({ name: 'send_files', arguments: { paths: [path.join(TMP, 'notes.txt')], recipients: ['a@example.com'] } });
  assert.ok(!r.isError, text(r));
  assert.equal(data(r).test, true);
  assert.match(data(r).note, /test key/i);
  const exp = await client.callTool({ name: 'send_files', arguments: { paths: [path.join(TMP, 'notes.txt')], expires_in_days: 3 } });
  assert.equal(exp.isError, true); assert.match(text(exp), /24 hours/);
  const rel = await client.callTool({ name: 'send_files', arguments: { paths: ['notes.txt'] } });
  assert.equal(rel.isError, true); assert.match(text(rel), /absolute path/);
  const missing = await client.callTool({ name: 'send_files', arguments: { paths: [path.join(TMP, 'nope.bin')] } });
  assert.equal(missing.isError, true); assert.match(text(missing), /No such file or folder/);
  const both = await client.callTool({ name: 'send_files', arguments: { paths: [path.join(TMP, 'notes.txt')], expires_in_days: 3, expires_at: '2026-12-31T00:00:00Z' } });
  assert.equal(both.isError, true);
  const bad = await client.callTool({ name: 'send_files', arguments: { paths: [] } });
  assert.equal(bad.isError, true, 'schema validation is a tool error');
  assert.equal(api.calls.filter((c) => c.path === '/transfers' && c.method === 'POST').length, 1, 'only the valid call created a transfer');
  await close();
});

test('send_files: expiry the plan refuses is a warning, the link is still returned', async () => {
  const { client, close } = await connect({ overrides: { 'PATCH /transfers/:id': () => apiError(403, 'plan_required', 'Extending needs Pro.') } });
  const r = await client.callTool({ name: 'send_files', arguments: { paths: [path.join(TMP, 'notes.txt')], expires_in_days: 10 } });
  assert.ok(!r.isError);
  assert.equal(data(r).link, 'https://pandafile.co/d/tr1');
  assert.match(data(r).warning, /Extending needs Pro/);
  await close();
});

test('send_from_urls: ready, and uploading tells the agent to poll get_import_status', async () => {
  const { client, api, close } = await connect();
  const r = await client.callTool({ name: 'send_from_urls', arguments: { files: [{ url: 'https://example.com/a.pdf', name: 'a.pdf' }], title: 'Docs', recipients: ['b@example.com'], expires_in_days: 5 } });
  assert.equal(data(r).status, 'ready');
  assert.match(data(r).next_step, /link works now/);
  const body = api.calls.find((c) => c.path === '/transfers/from-url').body;
  assert.ok(body.expires_at); assert.deepEqual(body.recipients, ['b@example.com']);
  const big = await client.callTool({ name: 'send_from_urls', arguments: { files: [{ url: 'https://example.com/big.mov' }] } });
  assert.equal(data(big).status, 'uploading');
  assert.match(data(big).next_step, /get_import_status.*url1/);
  const s = await client.callTool({ name: 'get_import_status', arguments: { id: 'url1' } });
  assert.equal(data(s).status, 'downloading');
  assert.equal(data(s).files[0].bytes_total, 1000);
  await close();
});

test('list_transfers maps query/view/limit/cursor; get_transfer summarises', async () => {
  const { client, api, close } = await connect();
  const l = await client.callTool({ name: 'list_transfers', arguments: { query: 'cut', view: 'history', limit: 5, cursor: 'abc' } });
  const q = api.calls.find((c) => c.path === '/transfers' && c.method === 'GET').query;
  assert.deepEqual(q, { q: 'cut', view: 'history', limit: '5', starting_after: 'abc' });
  assert.equal(data(l).transfers[0].id, 'tr1');
  assert.equal(data(l).next_cursor, 'tr1');
  assert.equal(data(l).has_more, true);
  const g = data(await client.callTool({ name: 'get_transfer', arguments: { id: 'tr1' } }));
  assert.equal(g.url, 'https://pandafile.co/d/tr1');
  assert.equal(g.files.length, 2);
  assert.equal(g.recipients[0].email, 'client@example.com');
  assert.equal(g.approvals.status, 'approved');
  assert.equal(g.stats.views, 3);
  assert.equal(g.latest_possible_expiry, '2027-02-14T10:00:00.000Z');
  await close();
});

test('recipients, update, delete', async () => {
  const { client, api, close } = await connect();
  const a = data(await client.callTool({ name: 'add_recipients', arguments: { id: 'tr1', emails: ['x@example.com', 'y@example.com'] } }));
  assert.equal(a.added, 1); assert.equal(a.skipped, 1); assert.equal(a.emailed, true);
  const m = data(await client.callTool({ name: 'remind_recipient', arguments: { id: 'tr1', email: 'x@example.com' } }));
  assert.equal(m.emailed, true);
  assert.deepEqual(api.calls.find((c) => c.path === '/transfers/tr1/remind').body, { email: 'x@example.com' });
  const u = data(await client.callTool({ name: 'update_transfer', arguments: { id: 'tr1', title: 'v2', expires_at: '2027-01-01T00:00:00Z', password: 'longenough' } }));
  assert.equal(u.title, 'v2'); assert.equal(u.has_password, true);
  assert.deepEqual(u.updated.sort(), ['expires_at', 'password', 'title']);
  await client.callTool({ name: 'update_transfer', arguments: { id: 'tr1', remove_password: true, message: null } });
  assert.deepEqual(api.calls.filter((c) => c.method === 'PATCH').at(-1).body, { message: null, password: null });
  const none = await client.callTool({ name: 'update_transfer', arguments: { id: 'tr1' } });
  assert.equal(none.isError, true); assert.match(text(none), /Nothing to change/);
  const d = data(await client.callTool({ name: 'delete_transfer', arguments: { id: 'tr1' } }));
  assert.deepEqual(d, { id: 'tr1', deleted: true });
  await close();
});

test('file requests and account', async () => {
  const { client, api, close } = await connect();
  const c = data(await client.callTool({ name: 'create_file_request', arguments: { title: 'Wedding photos', message: 'Drop them here' } }));
  assert.equal(c.upload_page, 'https://pandafile.co/r/rq1'); assert.equal(c.open, true);
  assert.deepEqual(api.calls.find((x) => x.path === '/requests' && x.method === 'POST').body, { title: 'Wedding photos', message: 'Drop them here' });
  const l = data(await client.callTool({ name: 'list_file_requests', arguments: {} }));
  assert.equal(l.file_requests[0].uploads, 2);
  const cl = data(await client.callTool({ name: 'close_file_request', arguments: { id: 'rq1' } }));
  assert.equal(cl.open, false);
  const me = data(await client.callTool({ name: 'get_account', arguments: {} }));
  assert.equal(me.plan, 'pro'); assert.equal(me.test_mode, false); assert.equal(me.key.mode, 'live');
  assert.equal(me.limits.max_expiry_days, 90); assert.equal(me.usage.week_transfers, 3);
  assert.ok(!JSON.stringify(me).includes(LIVE_KEY));
  await close();
});

test('every tool turns an API error into a readable isError result with the API message', async () => {
  const fails = (status, code, message) => () => apiError(status, code, message);
  const overrides = {
    'POST /transfers': fails(403, 'plan_required', 'The API needs Pro or Team.'),
    'POST /transfers/from-url': fails(400, 'parameter_invalid', 'only https:// URLs are accepted'),
    'GET /transfers/:id/import': fails(404, 'resource_missing', 'No such transfer.'),
    'GET /transfers': fails(400, 'parameter_invalid', 'starting_after is not a transfer id from this list.'),
    'GET /transfers/:id': fails(404, 'resource_missing', 'No such transfer.'),
    'POST /transfers/:id/recipients': fails(400, 'parameter_invalid', 'Too many recipients.'),
    'POST /transfers/:id/remind': fails(404, 'resource_missing', 'No such recipient.'),
    'PATCH /transfers/:id': fails(400, 'test_mode_expiry', 'Test transfers always expire 24 hours after they were created.'),
    'DELETE /transfers/:id': fails(404, 'resource_missing', 'No such transfer.'),
    'POST /requests': fails(403, 'test_mode_unsupported', 'File requests need a live key.'),
    'GET /requests': fails(403, 'test_mode_unsupported', 'File requests need a live key.'),
    'POST /requests/:id/close': fails(404, 'resource_missing', 'No such file request.'),
    'GET /me': fails(401, 'api_key_invalid', 'Invalid API key.'),
  };
  const logs = [];
  const { client, close } = await connect({ overrides, logs });
  const calls = {
    send_files: [{ paths: [path.join(TMP, 'notes.txt')] }, /needs Pro or Team[\s\S]*Pro and Team plans/],
    send_from_urls: [{ files: [{ url: 'https://example.com/a' }] }, /only https/],
    get_import_status: [{ id: 'zz' }, /No such transfer[\s\S]*list_transfers/],
    list_transfers: [{ cursor: 'zz' }, /starting_after/],
    get_transfer: [{ id: 'zz' }, /HTTP 404, resource_missing\): No such transfer/],
    add_recipients: [{ id: 'tr1', emails: ['a@example.com'] }, /Too many recipients/],
    remind_recipient: [{ id: 'tr1', email: 'a@example.com' }, /No such recipient/],
    update_transfer: [{ id: 'tr1', expires_in_days: 3 }, /24 hours/],
    delete_transfer: [{ id: 'zz' }, /No such transfer/],
    create_file_request: [{ title: 'x' }, /live key/],
    list_file_requests: [{}, /live key/],
    close_file_request: [{ id: 'zz' }, /No such file request/],
    get_account: [{}, /Invalid API key[\s\S]*PANDAFILE_API_KEY/],
  };
  assert.deepEqual(Object.keys(calls).sort(), [...TOOLS].sort());
  for (const [name, [args, re]] of Object.entries(calls)) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(text(r), re, name);
    assert.match(text(r), /req_test123/, `${name}: request id`);
    assert.ok(!text(r).includes(LIVE_KEY), `${name}: no key in the error`);
  }
  assert.ok(logs.length >= 13 && logs.every((l) => !l.includes(LIVE_KEY)), 'errors logged (stderr) without the key');
  // The server is still alive afterwards.
  assert.equal((await client.listTools()).tools.length, TOOLS.length);
  await close();
});

test('a network failure is a tool error, not a crash', async () => {
  const { createServer } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer({ apiKey: LIVE_KEY, baseUrl: 'https://x.invalid/api/v1', maxRetries: 0, fetch: async () => { throw new TypeError('fetch failed'); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: 'get_account', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /connection_failed[\s\S]*fetch failed/);
  await client.close();
});

test('helpers: base URL accepts /api/v1 or the origin; human sizes', () => {
  assert.equal(sdkBaseUrl(undefined), 'https://pandafile.co');
  assert.equal(sdkBaseUrl('https://pandafile.co/api/v1/'), 'https://pandafile.co');
  assert.equal(sdkBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(humanBytes(1_500_000_000), '1.50 GB');
  assert.equal(humanBytes(999), '999 B');
});

test('stdio binary: stdout carries only JSON-RPC, the key is never printed', async () => {
  const bin = path.join(HERE, '..', 'bin', 'pandafile-mcp.js');
  const p = spawn(process.execPath, [bin], { env: { ...process.env, PANDAFILE_API_KEY: LIVE_KEY, PANDAFILE_BASE_URL: 'http://127.0.0.1:9/api/v1' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  for (let i = 0; i < 100 && !out.includes('"id":2'); i++) await new Promise((r) => setTimeout(r, 50));
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  const lines = out.trim().split('\n');
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0');
  assert.equal(JSON.parse(lines.find((l) => l.includes('"id":2'))).result.tools.length, TOOLS.length);
  assert.ok(!out.includes(LIVE_KEY) && !err.includes(LIVE_KEY));
  assert.match(err, /ready \(v0\.1\.0, live key\)/);
});

test('package.json and server.json agree (registry metadata)', () => {
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const srv = JSON.parse(readFileSync(path.join(HERE, '..', 'server.json'), 'utf8'));
  assert.equal(pkg.mcpName, srv.name);
  assert.equal(srv.version, pkg.version);
  const npm = srv.packages.find((x) => x.registryType === 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, 'stdio');
  const key = npm.environmentVariables.find((e) => e.name === 'PANDAFILE_API_KEY');
  assert.equal(key.isSecret, true); assert.equal(key.isRequired, true);
  assert.equal(pkg.bin['pandafile-mcp'], './bin/pandafile-mcp.js');
  assert.match(pkg.dependencies['@pandafile/sdk'], /^\^0\.2\.0$/, 'published dependency is the npm version');
});
