#!/usr/bin/env node
// pandafile-mcp: the Pandafile MCP server over stdio.
//   PANDAFILE_API_KEY=pf_live_… npx -y @pandafile/mcp
// stdout carries only MCP messages; everything else goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from '../src/server.js';

const log = (msg) => process.stderr.write(`[pandafile-mcp] ${msg}\n`);
const arg = process.argv[2];
if (arg === '--version' || arg === '-v') { process.stderr.write(`${VERSION}\n`); process.exit(0); }
if (arg === '--help' || arg === '-h') {
  process.stderr.write(`pandafile-mcp ${VERSION} – Pandafile MCP server (stdio)

Environment:
  PANDAFILE_API_KEY    required: pf_live_… or pf_test_… (create one at https://pandafile.co/dashboard#domain)
  PANDAFILE_BASE_URL   optional, default https://pandafile.co/api/v1

Docs: https://pandafile.co/developers/mcp
`);
  process.exit(0);
}

const key = (process.env.PANDAFILE_API_KEY || '').trim();
if (!key) {
  log('PANDAFILE_API_KEY is not set: every tool will answer with setup instructions. Create a key at https://pandafile.co/dashboard#domain (Pro or Team) and add it to the "env" of this MCP server.');
} else if (!/^pf_(live|test)_/.test(key)) {
  log('PANDAFILE_API_KEY does not look like a Pandafile key (pf_live_… or pf_test_…).');
}

process.on('uncaughtException', (e) => log(`unexpected error: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => log(`unexpected error: ${e?.stack || e}`));

const server = createServer({ apiKey: key, log });
await server.connect(new StdioServerTransport());
log(`ready (v${VERSION}, ${key.startsWith('pf_test_') ? 'test key' : key ? 'live key' : 'no key'})`);
