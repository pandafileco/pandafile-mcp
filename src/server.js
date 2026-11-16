// The Pandafile MCP server: tools that let an AI agent send big files with Pandafile (pandafile.co) and manage the
// transfers and file requests of the account the API key belongs to. Everything goes through the official
// @pandafile/sdk (retries, idempotency keys, resumable tus uploads); this file only maps tools to SDK calls and turns
// results and errors into text an LLM can act on.
//
// Rules: nothing is ever written to stdout here (stdout is the MCP channel), and the API key is never logged or echoed.
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Pandafile, PandafileError } from '@pandafile/sdk';
import { z } from 'zod';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_BASE_URL = 'https://pandafile.co/api/v1';

const INSTRUCTIONS = `Pandafile (https://pandafile.co) sends big files with a link. Use these tools to:
- send local files or whole folders (send_files) or files at https URLs (send_from_urls) and get a share link,
- look up, change, delete transfers and add or remind recipients,
- collect files from other people with file requests (an upload page),
- check the account's plan, limits and usage (get_account).
Recipients get an email with their own link (never with a test key: pf_test_ keys make test transfers that email nobody and expire after 24 hours).
Share links look like https://pandafile.co/d/<id>. Files are stored in Helsinki, Finland (EU).`;

/** Turns PANDAFILE_BASE_URL (https://pandafile.co/api/v1, or just the origin) into the origin the SDK expects. */
export function sdkBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

// ---------- results ----------

const json = (value) => JSON.stringify(value, null, 2);
const ok = (data) => ({ content: [{ type: 'text', text: json(data) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** An error as text for the model: the API's own message, its code, and what to do about the common ones. */
export function errorText(e, apiKey) {
  if (e instanceof PandafileError) {
    const bits = [`Pandafile API error${e.status ? ` (HTTP ${e.status}, ${e.code})` : ` (${e.code})`}: ${e.message}`];
    if (e.param) bits.push(`Parameter: ${e.param}`);
    const hint = {
      authentication_error: 'The API key is missing, unknown or revoked. The user can create a key at https://pandafile.co/dashboard#domain and set it as PANDAFILE_API_KEY in the MCP server configuration.',
      rate_limit_error: 'Too many requests right now. Wait a little and try again.',
    }[e.type] || {
      plan_required: 'The Pandafile API is included with the Pro and Team plans (https://pandafile.co/pricing).',
      test_mode_unsupported: 'This needs a live key (pf_live_…); test keys (pf_test_…) cannot do it.',
      test_mode_expiry: 'Test transfers always expire 24 hours after they were created; use a live key to set an expiry.',
      resource_missing: 'Check the id (list_transfers / list_file_requests show the ids). Test keys only see test transfers and live keys only live ones.',
      file_not_found: 'Use absolute paths to files or folders that exist on this computer.',
    }[e.code];
    if (hint) bits.push(hint);
    if (e.requestId) bits.push(`Request id (for Pandafile support): ${e.requestId}`);
    return redact(bits.join('\n'), apiKey);
  }
  if (e?.name === 'AbortError') return 'Cancelled.';
  return redact(`Error: ${e?.message || String(e)}`, apiKey);
}

const redact = (text, apiKey) => (apiKey ? text.split(apiKey).join('pf_***') : text);

// ---------- small helpers ----------

const MAX_LIST = 100;

function expandPath(p) {
  const s = String(p).trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir(), s.slice(2));
  return s;
}

function expiryFrom({ expires_in_days, expires_at }) {
  if (expires_at) return expires_at;
  if (expires_in_days) return new Date(Date.now() + expires_in_days * 86_400_000).toISOString();
  return undefined;
}

function transferSummary(t) {
  return {
    id: t.id, title: t.title, status: t.status, url: t.url,
    files: t.file_count, total_bytes: t.total_bytes, size: humanBytes(t.total_bytes),
    created_at: t.created_at, expires_at: t.expires_at,
    downloads: t.download_count, recipients: t.recipients, downloaded_by: t.downloaded_by,
    has_password: t.has_password, test: t.livemode === false ? true : undefined,
  };
}

export function humanBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${i ? v.toFixed(v < 10 ? 2 : 1) : v} ${u[i]}`;
}

function detailSummary(d, { maxFiles = 200 } = {}) {
  const t = d.transfer;
  const stats = d.stats || {};
  return {
    id: t.id, title: t.title, message: t.message, status: t.status, url: t.url,
    created_at: t.created_at, expires_at: t.expires_at, latest_possible_expiry: t.max_expires_at,
    total_bytes: t.total_bytes, size: humanBytes(t.total_bytes), file_count: t.file_count,
    has_password: t.has_password, encrypted: t.encrypted, test: t.livemode === false ? true : undefined,
    files: (d.files || []).slice(0, maxFiles).map((f) => ({ name: f.name, size: f.size })),
    files_truncated: (d.files || []).length > maxFiles ? `${d.files.length - maxFiles} more files not shown` : undefined,
    recipients: (d.recipients || []).map((r) => ({ email: r.email, emailed: r.sent, first_download: r.downloaded, reminded: r.reminded })),
    downloads: { total: t.download_count, latest: (d.log || []).slice(0, 20) },
    approvals: d.approval?.enabled ? { status: d.approval.status, approved: d.approval.approved, changes_requested: d.approval.changes,
      comments: (d.approval.items || []).slice(0, 20) } : undefined,
    stats: d.features?.stats === false ? undefined : {
      views: stats.views, downloads: stats.downloads, zip_downloads: stats.zip, first_view: stats.firstView, last_view: stats.lastView,
      top_files: (stats.files || []).slice(0, 10),
      countries: (stats.countries?.downloads || []).slice(0, 10),
    },
  };
}

function requestSummary(r) {
  return { id: r.id, title: r.title, message: r.message, open: r.open, upload_page: r.url, created_at: r.created_at,
    closed_at: r.closed_at, uploads: r.upload_count, last_upload: r.last_upload };
}

// ---------- schemas ----------

const transferId = z.string().trim().min(1).max(64).describe('Transfer id: the last part of the share link (https://pandafile.co/d/<id>), e.g. "k3x9q2m7ab".');
const emails = z.array(z.string().trim().email()).min(1).max(50);
const expiresInDays = z.number().int().min(1).max(90)
  .describe('Keep the files this many days from now (1–90). Pro/Team only, at most 90 days after sending; not for test keys. Leave out for the plan default.');
const expiresAt = z.string().datetime({ offset: true })
  .describe('Exact expiry as ISO 8601 (e.g. "2026-12-31T23:00:00Z"). Alternative to expires_in_days; same limits.');
const password = z.string().min(8).max(200).describe('Download password (8–200 characters). Recipients need it to download. Plus/Pro/Team only.');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ---------- the server ----------

/**
 * @param {object} [opts]
 * @param {string} [opts.apiKey]   pf_live_… or pf_test_… (default: PANDAFILE_API_KEY)
 * @param {string} [opts.baseUrl]  default PANDAFILE_BASE_URL or https://pandafile.co/api/v1
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.maxRetries]
 * @param {(msg: string) => void} [opts.log]  diagnostics (stderr in the CLI)
 */
export function createServer(opts = {}) {
  const env = typeof process !== 'undefined' ? process.env : {};
  const apiKey = (opts.apiKey ?? env.PANDAFILE_API_KEY ?? '').trim();
  const baseUrl = sdkBaseUrl(opts.baseUrl ?? env.PANDAFILE_BASE_URL);
  const log = opts.log || (() => {});
  const testMode = apiKey.startsWith('pf_test_');

  let client = null;
  const pf = () => {
    if (!apiKey) {
      throw Object.assign(new Error('PANDAFILE_API_KEY is not set. Create an API key at https://pandafile.co/dashboard#domain (Pro or Team plan) '
        + 'and add it to this MCP server\'s configuration as the environment variable PANDAFILE_API_KEY (pf_live_… or pf_test_… for test mode).'), { code: 'api_key_missing' });
    }
    client ||= new Pandafile({ apiKey, baseUrl, fetch: opts.fetch, maxRetries: opts.maxRetries, appInfo: `pandafile-mcp/${VERSION}` });
    return client;
  };

  const server = new McpServer({ name: 'pandafile', title: 'Pandafile', version: VERSION, websiteUrl: 'https://pandafile.co/developers/mcp' },
    { instructions: INSTRUCTIONS });

  // Every handler: errors become a readable isError result, never a crash.
  const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (e) {
      if (e?.code === 'api_key_missing') return fail(e.message);
      log(`${name} failed: ${redact(e?.message || String(e), apiKey)}`);
      return fail(errorText(e, apiKey));
    }
  });

  // ----- send_files -----
  tool('send_files', {
    title: 'Send files with Pandafile',
    description: 'Upload local files and/or folders to Pandafile and get a share link (https://pandafile.co/d/<id>). '
      + 'Folders are sent with their structure. Large files are fine (resumable, chunked uploads); the call returns when the upload is complete. '
      + 'If recipients are given, each gets an email with a personal download link. Returns the link, id, expiry and sizes. '
      + 'Only send files the user asked you to send.',
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(500)
        .describe('Absolute paths of files or folders on this computer (~ is expanded), e.g. ["/Users/ada/Desktop/final-cut.mov", "/Users/ada/Desktop/stills"].'),
      title: z.string().max(120).optional().describe('Title shown on the download page and in emails (up to 120 characters).'),
      message: z.string().max(1000).optional().describe('Message to the recipients (up to 1000 characters).'),
      recipients: emails.optional().describe('Email addresses to send the link to. Leave out to just get a link.'),
      expires_in_days: expiresInDays.optional(),
      expires_at: expiresAt.optional(),
      password: password.optional(),
    },
    annotations: { title: 'Send files', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a, extra) => {
    const paths = [];
    for (const raw of a.paths) {
      const p = expandPath(raw);
      if (!path.isAbsolute(p)) return fail(`"${raw}" is not an absolute path. Use full paths (e.g. /Users/name/Documents/file.pdf or C:\\Users\\name\\file.pdf); this server runs in ${process.cwd()}.`);
      try { await stat(p); } catch { return fail(`No such file or folder: ${p}`); }
      paths.push(p);
    }
    if (a.expires_in_days && a.expires_at) return fail('Give either expires_in_days or expires_at, not both.');
    const expiry = expiryFrom(a);
    if (expiry && testMode) return fail('Test keys (pf_test_…) cannot set an expiry: test transfers always expire after 24 hours. Send without expires_in_days / expires_at.');

    const token = extra?._meta?.progressToken;
    let last = 0, lastPhase = '';
    const onProgress = token === undefined ? undefined : (p) => {
      const now = Date.now();
      if (p.phase === lastPhase && p.phase === 'uploading' && now - last < 250 && p.bytesUploaded < p.bytesTotal) return;
      last = now; lastPhase = p.phase;
      const message = p.phase === 'uploading'
        ? `Uploading ${humanBytes(p.bytesUploaded)} of ${humanBytes(p.bytesTotal)} (${p.filesDone}/${p.filesTotal} files)`
        : { creating: 'Creating the transfer', completing: 'Finishing the transfer', done: 'Done' }[p.phase];
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: p.bytesUploaded, total: p.bytesTotal, message } })
        .catch(() => {});
    };

    const r = await pf().transfers.send({
      files: paths, title: a.title, message: a.message, recipients: a.recipients, password: a.password,
      onProgress, signal: extra?.signal,
    });

    const out = {
      link: r.url, id: r.id, files: r.files.length, total_bytes: r.bytes, size: humanBytes(r.bytes),
      file_list: r.files.slice(0, 50).map((f) => ({ name: f.name, size: f.size })),
      file_list_truncated: r.files.length > 50 ? `${r.files.length - 50} more files not shown` : undefined,
      recipients: a.recipients?.length ? (testMode ? `${a.recipients.length} recorded (test key: nobody is emailed)` : `${a.recipients.length} emailed`) : undefined,
      password_protected: a.password ? true : undefined,
      test: testMode || undefined,
    };
    let warning;
    if (expiry) {
      try { await pf().transfers.update(r.id, { expires_at: expiry }); }
      catch (e) { warning = `The files were sent, but the expiry could not be set: ${e?.message || e}. The plan's default expiry applies.`; }
    }
    try { out.expires_at = (await pf().transfers.retrieve(r.id)).transfer.expires_at; } catch { /* the link works anyway */ }
    if (testMode) out.note = 'Sent with a test key: nobody is emailed and the transfer expires after 24 hours.';
    if (warning) out.warning = warning;
    return ok(out);
  });

  // ----- send_from_urls -----
  tool('send_from_urls', {
    title: 'Send files from URLs',
    description: 'Create a Pandafile transfer from files at public https URLs: Pandafile downloads them itself (no local upload). '
      + 'Waits up to ~20 seconds. status "ready": the link works now. status "uploading": big files are still downloading – '
      + 'call get_import_status with the id until it is "ready" (or "failed"). Recipients are emailed when it is ready.',
    inputSchema: {
      files: z.array(z.object({
        url: z.string().url().describe('Public https URL of the file (at most 3 redirects).'),
        name: z.string().max(255).optional().describe('File name to use (default: from the server or the URL).'),
      })).min(1).max(20).describe('1–20 files.'),
      title: z.string().max(120).optional().describe('Title (up to 120 characters).'),
      message: z.string().max(1000).optional().describe('Message to the recipients (up to 1000 characters).'),
      recipients: emails.optional().describe('Email addresses to send the link to once the transfer is ready.'),
      expires_in_days: expiresInDays.optional(),
      expires_at: expiresAt.optional(),
      password: password.optional(),
    },
    annotations: { title: 'Send files from URLs', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    if (a.expires_in_days && a.expires_at) return fail('Give either expires_in_days or expires_at, not both.');
    const expiry = expiryFrom(a);
    if (expiry && testMode) return fail('Test keys (pf_test_…) cannot set an expiry: test transfers always expire after 24 hours.');
    const r = await pf().transfers.fromUrl({
      files: a.files, title: a.title, message: a.message, recipients: a.recipients, password: a.password, expires_at: expiry,
    });
    const out = {
      id: r.id, status: r.status, link: r.url, title: r.title, expires_at: r.expires_at, recipients: r.recipients,
      import: r.import ? { status: r.import.status, bytes_received: r.import.bytes_received,
        files: (r.import.files || []).map((f) => ({ name: f.name, status: f.status, bytes_received: f.bytes_received, bytes_total: f.bytes_total })) } : undefined,
      test: r.livemode === false ? true : undefined,
    };
    out.next_step = r.status === 'uploading'
      ? `Pandafile is still downloading the files. Call get_import_status with id "${r.id}" in a little while; the link works once the status is "ready".`
      : 'Ready: the link works now.';
    return ok(out);
  });

  // ----- get_import_status -----
  tool('get_import_status', {
    title: 'URL import status',
    description: 'Progress of a transfer created with send_from_urls: per file bytes received, then "ready" (the link works) or "failed" (with the error; the transfer is then deleted).',
    inputSchema: { id: transferId },
    annotations: { title: 'URL import status', ...READ },
  }, async ({ id }) => {
    const s = await pf().transfers.importStatus(id);
    const out = {
      id: s.id, status: s.status, bytes_received: s.bytes_received, received: humanBytes(s.bytes_received),
      files: (s.files || []).map((f) => ({ name: f.name, from: f.source_host, status: f.status, bytes_received: f.bytes_received, bytes_total: f.bytes_total })),
      error: s.error || undefined, created_at: s.created_at, finished_at: s.finished_at,
    };
    if (s.status === 'downloading') out.next_step = 'Still downloading. Check again in a little while.';
    if (s.status === 'ready') out.next_step = `Ready: the link works now (get_transfer with id "${s.id}" shows it).`;
    return ok(out);
  });

  // ----- list_transfers -----
  tool('list_transfers', {
    title: 'List transfers',
    description: 'The account\'s transfers, newest first, with link, size, expiry and download counts. '
      + 'view "active" (default: live and still uploading) or "history" (expired, deleted, blocked). Pass next_cursor as cursor for the next page.',
    inputSchema: {
      query: z.string().max(200).optional().describe('Search title, id, recipient email or file name.'),
      view: z.enum(['active', 'history']).optional().describe('"active" (default) or "history".'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe('How many (1–100, default 20).'),
      cursor: z.string().max(64).optional().describe('next_cursor from the previous call, for the next page.'),
    },
    annotations: { title: 'List transfers', ...READ },
  }, async (a) => {
    const page = await pf().transfers.list({ q: a.query, view: a.view, limit: a.limit ?? 20, starting_after: a.cursor });
    return ok({ transfers: page.data.map(transferSummary), count: page.data.length, has_more: page.has_more, next_cursor: page.next_cursor });
  });

  // ----- get_transfer -----
  tool('get_transfer', {
    title: 'Get a transfer',
    description: 'One transfer in detail: link, status, expiry (and the latest expiry possible), files, recipients (who was emailed, who downloaded), '
      + 'latest downloads, approvals/comments from recipients and link statistics (views, downloads, countries).',
    inputSchema: { id: transferId },
    annotations: { title: 'Get a transfer', ...READ },
  }, async ({ id }) => ok(detailSummary(await pf().transfers.retrieve(id))));

  // ----- add_recipients -----
  tool('add_recipients', {
    title: 'Add recipients',
    description: 'Email the transfer\'s link to more people: each new address gets an email with a personal download link. Addresses already on the transfer are skipped.',
    inputSchema: { id: transferId, emails: emails.describe('Email addresses to add (1–50).') },
    annotations: { title: 'Add recipients', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ id, emails: list }) => {
    const r = await pf().transfers.addRecipients(id, list);
    return ok({ id, added: r.added, skipped: list.length - (r.added ?? 0), emailed: r.emailed,
      note: r.emailed ? undefined : 'Test key: the recipients are recorded but nobody is emailed.' });
  });

  // ----- remind_recipient -----
  tool('remind_recipient', {
    title: 'Remind a recipient',
    description: 'Email a recipient of the transfer their personal link again (and turn their reminders back on). At most twice an hour per recipient.',
    inputSchema: { id: transferId, email: z.string().trim().email().describe('A recipient of this transfer.') },
    annotations: { title: 'Remind a recipient', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, email }) => {
    const r = await pf().transfers.remind(id, email);
    return ok({ id, email, emailed: r.emailed !== false && !testMode, note: testMode ? 'Test key: nobody is emailed.' : undefined });
  });

  // ----- update_transfer -----
  tool('update_transfer', {
    title: 'Update a transfer',
    description: 'Change a live transfer: title, message, expiry (later only, Pro/Team, at most 90 days after it was sent – get_transfer shows latest_possible_expiry) '
      + 'and the download password (set a new one, or remove it with remove_password). Only the fields you give change.',
    inputSchema: {
      id: transferId,
      title: z.string().max(120).nullable().optional().describe('New title (null clears it).'),
      message: z.string().max(1000).nullable().optional().describe('New message (null clears it).'),
      expires_in_days: expiresInDays.optional(),
      expires_at: expiresAt.optional(),
      password: password.optional(),
      remove_password: z.boolean().optional().describe('true removes the download password.'),
    },
    annotations: { title: 'Update a transfer', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    if (a.expires_in_days && a.expires_at) return fail('Give either expires_in_days or expires_at, not both.');
    if (a.password && a.remove_password) return fail('Give either password or remove_password, not both.');
    const body = {};
    if (a.title !== undefined) body.title = a.title;
    if (a.message !== undefined) body.message = a.message;
    const expiry = expiryFrom(a);
    if (expiry) body.expires_at = expiry;
    if (a.password) body.password = a.password;
    if (a.remove_password) body.password = null;
    if (!Object.keys(body).length) return fail('Nothing to change: give title, message, expires_in_days / expires_at, password or remove_password.');
    const d = await pf().transfers.update(a.id, body);
    const t = d.transfer;
    return ok({ id: t.id, updated: Object.keys(body), title: t.title, message: t.message, expires_at: t.expires_at,
      latest_possible_expiry: t.max_expires_at, has_password: t.has_password, link: t.url });
  });

  // ----- delete_transfer -----
  tool('delete_transfer', {
    title: 'Delete a transfer',
    description: 'Delete a transfer now: its files are removed for good and the link stops working for everyone. This cannot be undone – confirm with the user first.',
    inputSchema: { id: transferId },
    annotations: { title: 'Delete a transfer', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const r = await pf().transfers.delete(id);
    return ok({ id, deleted: r.deleted ?? r.ok ?? true });
  });

  // ----- file requests -----
  tool('create_file_request', {
    title: 'Create a file request',
    description: 'Create a file request: an upload page (link) anyone can use to send files to this account – e.g. to collect photos or documents from a client. '
      + 'Uploads show up as transfers. Needs a live key on Pro/Team.',
    inputSchema: {
      title: z.string().min(1).max(120).describe('What you are asking for, shown on the upload page (up to 120 characters).'),
      message: z.string().max(1000).optional().describe('Instructions shown on the upload page (up to 1000 characters).'),
    },
    annotations: { title: 'Create a file request', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => ok(requestSummary(await pf().requests.create({ title: a.title, ...(a.message ? { message: a.message } : {}) }))));

  tool('list_file_requests', {
    title: 'List file requests',
    description: 'The account\'s file requests (upload pages) with their links, whether they are open and how many uploads came in. Pass next_cursor as cursor for the next page.',
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe('How many (1–100, default 20).'),
      cursor: z.string().max(64).optional().describe('next_cursor from the previous call.'),
    },
    annotations: { title: 'List file requests', ...READ },
  }, async (a) => {
    const page = await pf().requests.list({ limit: a.limit ?? 20, starting_after: a.cursor });
    return ok({ file_requests: page.data.map(requestSummary), count: page.data.length, has_more: page.has_more, next_cursor: page.next_cursor });
  });

  tool('close_file_request', {
    title: 'Close a file request',
    description: 'Stop a file request from accepting uploads (its upload page then says it is closed). Files already uploaded stay. It can be reopened from the dashboard.',
    inputSchema: { id: z.string().trim().min(1).max(64).describe('File request id (from create_file_request or list_file_requests).') },
    annotations: { title: 'Close a file request', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => ok(requestSummary(await pf().requests.close(id))));

  // ----- get_account -----
  tool('get_account', {
    title: 'Account, plan and usage',
    description: 'The account behind the API key: plan, limits (max bytes per transfer, expiry days, features), usage (this week / month, storage) and whether the key is a test key.',
    inputSchema: {},
    annotations: { title: 'Account, plan and usage', ...READ },
  }, async () => {
    const me = await pf().me.retrieve();
    const l = me.limits || {};
    return ok({
      email: me.email, name: me.name, plan: me.plan, team: me.team || undefined,
      key: { name: me.key?.name, mode: me.key?.mode, scope: me.key?.scope },
      test_mode: me.livemode === false,
      limits: { ...l, max_transfer: humanBytes(l.max_transfer_bytes) },
      usage: me.usage ? { ...me.usage, week: humanBytes(me.usage.week_bytes), month: humanBytes(me.usage.month_bytes), storage: humanBytes(me.usage.storage_bytes) } : undefined,
    });
  });

  return server;
}
