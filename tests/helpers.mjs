// Test helpers: a fake Pandafile API behind a mocked fetch (REST + tus uploads), and an MCP client connected to the
// server in memory.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export const LIVE_KEY = 'pf_live_' + 'a'.repeat(40);
export const TEST_KEY = 'pf_test_' + 'b'.repeat(40);
export const BASE = 'https://api.test.invalid';

const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test123', ...headers } });
export const apiError = (status, code, message, type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'invalid_request_error') =>
  ({ status, body: { error: { type, code, message } } });

const transferDetail = (id, over = {}) => ({
  transfer: { id, title: 'Final cut', message: null, status: 'ready', file_count: 2, total_bytes: 3000, created_at: '2026-11-16T10:00:00.000Z',
    expires_at: '2026-12-16T10:00:00.000Z', download_count: 1, plan: 'pro', has_password: false, url: `https://pandafile.co/d/${id}`, request_id: null,
    encrypted: false, livemode: true, can_send_again: true, max_expires_at: '2027-02-14T10:00:00.000Z', ...over },
  files: [{ id: 'f1', name: 'shoot/a.jpg', size: 1000 }, { id: 'f2', name: 'notes.txt', size: 2000 }],
  recipients: [{ email: 'client@example.com', sent: '2026-11-16T10:00:01.000Z', downloaded: null, reminded: null, remindersOff: false }],
  log: [{ at: '2026-11-16T11:00:00.000Z', kind: 'zip', file: null, recipient: null }],
  approval: { enabled: true, status: 'approved', approved: 1, changes: 0, items: [{ decision: 'approved', name: 'Ada', email: null, comment: 'Lovely', at: '2026-11-16T12:00:00.000Z' }] },
  stats: { views: 3, firstView: null, lastView: null, downloads: 1, zip: 1, files: [], recipients: [], countries: { views: [], downloads: [{ key: 'FI', count: 1 }] }, devices: { views: [], downloads: [] } },
  features: { approval: true, stats: true },
});

/**
 * A fake API. `overrides` maps "METHOD /path" (path after /api/v1, ids as :id) to a function (req) => { status, body } that
 * replaces the default answer – used to make any endpoint fail.
 */
export function fakeApi(overrides = {}) {
  const calls = [];
  const uploads = new Map(); // tus upload url -> { length, offset, meta, bytes: [] }
  let n = 0;
  const route = (method, p) => {
    const norm = p === '/transfers/from-url' ? p : p.replace(/^\/transfers\/[^/]+/, '/transfers/:id').replace(/^\/requests\/[^/]+/, '/requests/:id');
    return `${method} ${norm}`;
  };
  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

    // tus
    if (url.pathname.startsWith('/upload')) {
      if (method === 'POST') {
        const loc = `${BASE}/upload/u${++n}`;
        uploads.set(loc, { length: Number(headers['upload-length']), offset: 0, meta: headers['upload-metadata'], size: 0 });
        calls.push({ method, path: '/upload', headers });
        return new Response(null, { status: 201, headers: { location: loc, 'tus-resumable': '1.0.0' } });
      }
      const u = uploads.get(url.toString());
      if (!u) return new Response(null, { status: 404 });
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': String(u.offset), 'upload-length': String(u.length) } });
      if (method === 'PATCH') {
        const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new Uint8Array(init.body);
        u.offset += body.byteLength;
        return new Response(null, { status: 204, headers: { 'upload-offset': String(u.offset), 'tus-resumable': '1.0.0' } });
      }
    }

    const p = url.pathname.replace(/^\/api\/v1/, '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const req = { method, path: p, query: Object.fromEntries(url.searchParams), body, headers };
    calls.push(req);
    const key = route(method, p);
    if (overrides[key]) { const r = overrides[key](req); return json(r.status, r.body); }
    if (headers.authorization !== `Bearer ${LIVE_KEY}` && headers.authorization !== `Bearer ${TEST_KEY}`) {
      return json(401, { error: { type: 'authentication_error', code: 'api_key_invalid', message: 'Invalid API key.' } });
    }
    const livemode = headers.authorization === `Bearer ${LIVE_KEY}`;
    const id = p.split('/')[2];
    switch (key) {
      case 'POST /transfers': return json(201, { id: 'tr1', ownerToken: 'owner-secret', url: 'https://pandafile.co/d/tr1', uploadEndpoint: `${BASE}/upload`, maxBytes: 1e12, expiresInDays: 30, encrypted: false, livemode });
      case 'POST /transfers/:id/complete': return json(200, { ok: true, url: `https://pandafile.co/d/${id}` });
      case 'GET /transfers/:id': return json(200, transferDetail(id, { livemode }));
      case 'PATCH /transfers/:id': return json(200, transferDetail(id, { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.expires_at ? { expires_at: body.expires_at } : {}), ...(body.password ? { has_password: true } : {}) }));
      case 'DELETE /transfers/:id': return json(200, { ok: true, id, deleted: true });
      case 'GET /transfers': return json(200, { object: 'list', data: [{ id: 'tr1', title: 'Final cut', status: 'ready', file_count: 2, total_bytes: 3000, created_at: '2026-11-16T10:00:00.000Z', expires_at: '2026-12-16T10:00:00.000Z', download_count: 1, plan: 'pro', has_password: false, encrypted: false, recipients: 1, downloaded_by: 0, url: 'https://pandafile.co/d/tr1', livemode }], has_more: true, next_cursor: 'tr1' });
      case 'POST /transfers/from-url': {
        const big = body.files.some((f) => f.url.includes('big'));
        return json(big ? 202 : 201, { id: 'url1', object: 'transfer', status: big ? 'uploading' : 'ready', url: 'https://pandafile.co/d/url1', title: body.title ?? null, expires_at: body.expires_at ?? null, recipients: body.recipients || [], livemode,
          import: { object: 'transfer_import', id: 'url1', status: big ? 'downloading' : 'ready', livemode, files: body.files.map((f) => ({ name: f.name || 'file', source_host: new URL(f.url).host, status: big ? 'downloading' : 'done', bytes_received: 10, bytes_total: big ? null : 10 })), bytes_received: 10, error: null, created_at: '2026-11-16T10:00:00.000Z', finished_at: null } });
      }
      case 'GET /transfers/:id/import': return json(200, { object: 'transfer_import', id, status: 'downloading', livemode, files: [{ name: 'big.mov', source_host: 'example.com', status: 'downloading', bytes_received: 500, bytes_total: 1000 }], bytes_received: 500, error: null, created_at: '2026-11-16T10:00:00.000Z', finished_at: null });
      case 'POST /transfers/:id/recipients': return json(200, { ok: true, added: body.emails.length - 1, emailed: livemode });
      case 'POST /transfers/:id/remind': return json(200, { ok: true, emailed: true });
      case 'GET /me': return json(200, { email: 'ada@example.com', name: 'Ada', plan: 'pro', own_plan: 'pro', team: null, maxTransferBytes: 1e12, expiryDays: 30,
        limits: { name: 'pro', max_transfer_bytes: 1e12, storage_bytes: 2e12, monthly_bytes: null, expiry_days: 30, max_expiry_days: 90, features: { password: true, requests: true, branding: true, extend: true, e2ee: true, api: true } },
        usage: { week_bytes: 5e9, month_bytes: 6e9, storage_bytes: 7e9, week_transfers: 3, month_transfers: 4 }, livemode, api_version: '2026-11-27',
        key: { id: 1, name: 'mcp', prefix: 'pf_live_aaaa', mode: livemode ? 'live' : 'test', scope: 'full' } });
      case 'POST /requests': return json(201, { id: 'rq1', title: body.title, message: body.message ?? null, open: true, url: 'https://pandafile.co/r/rq1', created_at: '2026-11-16T10:00:00.000Z', closed_at: null, upload_count: 0, last_upload: null });
      case 'GET /requests': return json(200, { object: 'list', data: [{ id: 'rq1', title: 'Photos', message: null, open: true, url: 'https://pandafile.co/r/rq1', created_at: '2026-11-16T10:00:00.000Z', closed_at: null, upload_count: 2, last_upload: null }], has_more: false, next_cursor: null });
      case 'POST /requests/:id/close': return json(200, { id, title: 'Photos', message: null, open: false, url: `https://pandafile.co/r/${id}`, created_at: '2026-11-16T10:00:00.000Z', closed_at: '2026-11-16T12:00:00.000Z', upload_count: 2, last_upload: null });
      default: return json(404, { error: { type: 'invalid_request_error', code: 'route_missing', message: `No route ${key}` } });
    }
  }
  return { fetch: fetchImpl, calls, uploads };
}

/** A connected MCP client. */
export async function connect({ apiKey = LIVE_KEY, overrides, logs } = {}) {
  const api = fakeApi(overrides);
  const server = createServer({ apiKey, baseUrl: `${BASE}/api/v1`, fetch: api.fetch, maxRetries: 0, log: (m) => logs?.push(m) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server, api, close: async () => { await client.close(); await server.close(); } };
}

export const text = (r) => r.content.map((c) => c.text).join('\n');
export const data = (r) => JSON.parse(text(r));
