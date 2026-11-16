# @pandafile/mcp

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Pandafile](https://pandafile.co).
It lets AI agents – Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and any other MCP client – send big files
and folders with a link, and manage your transfers and file requests.

> "Send the `renders/` folder to client@example.com with Pandafile, title it *Final renders*, keep it for 60 days."

The agent calls `send_files`, the files are uploaded with resumable, chunked uploads (any size your plan allows), and you
get the link back: `https://pandafile.co/d/k3x9q2m7ab`.

- Runs locally over stdio (`npx -y @pandafile/mcp`); Node 18 or newer.
- Built on the official [`@pandafile/sdk`](https://www.npmjs.com/package/@pandafile/sdk): retries, idempotency keys,
  resumable [tus](https://tus.io) uploads.
- Progress notifications while uploading, readable errors (the API's own message), no crashes on API errors.

## Requirements

- A Pandafile **Pro** or **Team** plan (the API is included) and an API key from
  [Dashboard → Domain & API](https://pandafile.co/dashboard#domain).
- Node.js 18+ (`npx` comes with it).

Use a **test key** (`pf_test_…`) while you try it out: transfers are real uploads, but nobody is emailed, they expire
after 24 hours and count toward no limit. File requests need a live key (`pf_live_…`).

## Install

Replace `pf_live_YOUR_KEY` with your key in each example.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pandafile": {
      "command": "npx",
      "args": ["-y", "@pandafile/mcp"],
      "env": { "PANDAFILE_API_KEY": "pf_live_YOUR_KEY" }
    }
  }
}
```

Restart Claude Desktop. The file is in `~/Library/Application Support/Claude/` on macOS and `%APPDATA%\Claude\` on Windows.

### Claude Code

```sh
claude mcp add pandafile --env PANDAFILE_API_KEY=pf_live_YOUR_KEY -- npx -y @pandafile/mcp
```

Add `--scope user` to have it in every project.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "pandafile": {
      "command": "npx",
      "args": ["-y", "@pandafile/mcp"],
      "env": { "PANDAFILE_API_KEY": "pf_live_YOUR_KEY" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` – VS Code asks for the key once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "pandafile-api-key", "description": "Pandafile API key (pf_live_… or pf_test_…)", "password": true }
  ],
  "servers": {
    "pandafile": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pandafile/mcp"],
      "env": { "PANDAFILE_API_KEY": "${input:pandafile-api-key}" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "pandafile": {
      "command": "npx",
      "args": ["-y", "@pandafile/mcp"],
      "env": { "PANDAFILE_API_KEY": "pf_live_YOUR_KEY" }
    }
  }
}
```

### Other clients (ChatGPT, Codex, Zed, …)

Any client that starts local (stdio) MCP servers works with the command `npx -y @pandafile/mcp` and the environment
variable `PANDAFILE_API_KEY`. For example the OpenAI Codex CLI:

```sh
codex mcp add pandafile --env PANDAFILE_API_KEY=pf_live_YOUR_KEY -- npx -y @pandafile/mcp
```

ChatGPT's connectors talk to remote (HTTPS) MCP servers; this package is a local server, so use it from a client that
runs local servers.

## Configuration

| Variable | |
| --- | --- |
| `PANDAFILE_API_KEY` | Required. `pf_live_…`, or `pf_test_…` for test mode. Without it the server still starts, and every tool answers with setup instructions. |
| `PANDAFILE_BASE_URL` | Optional. Default `https://pandafile.co/api/v1`. Only for testing against a local Pandafile server. |

## Tools

| Tool | What it does | |
| --- | --- | --- |
| `send_files` | Upload local files and folders (absolute paths; folders keep their structure) and get the link. Options: `title`, `message`, `recipients`, `expires_in_days` / `expires_at`, `password`. Sends MCP progress notifications when the client asks for them. | writes |
| `send_from_urls` | Make a transfer from public https URLs – Pandafile downloads them itself. Returns `ready`, or `uploading` with a hint to call `get_import_status`. | writes |
| `get_import_status` | Progress of a `send_from_urls` transfer. | read-only |
| `list_transfers` | Your transfers, newest first: search (`query`), `view` active/history, `limit`, `cursor`. | read-only |
| `get_transfer` | One transfer: files, recipients (who downloaded), latest downloads, approvals, link statistics. | read-only |
| `add_recipients` | Email the link to more people. | writes |
| `remind_recipient` | Email a recipient their link again. | writes |
| `update_transfer` | Title, message, later expiry, set or remove the password. | writes |
| `delete_transfer` | Delete a transfer and its files now. | **destructive** |
| `create_file_request` | An upload page others can send you files with. | writes |
| `list_file_requests` | Your file requests and their uploads. | read-only |
| `close_file_request` | Stop a file request from taking uploads. | writes |
| `get_account` | Plan, limits, usage and whether the key is a test key. | read-only |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients
can ask before anything that changes or deletes data. API errors come back as tool errors with Pandafile's message,
error code and request id.

## Privacy and security

- Files go only to Pandafile (`pandafile.co`, or `PANDAFILE_BASE_URL` if you set it). Pandafile's servers are in
  Helsinki, Finland (EU). See the [privacy policy](https://pandafile.co/privacy).
- The server reads only the paths the agent passes to `send_files`. It collects no telemetry.
- The API key is sent only to the Pandafile API, never logged and never included in tool results. Diagnostics go to
  stderr; stdout carries only MCP messages.
- Give the agent a key with the narrowest scope that works (keys can be `read`, `write` or `full`), or a test key while
  you experiment.

## Development

```sh
npm install
npm test                 # unit tests: mocked API, in-memory MCP client
npm run test:e2e         # end to end inside the Pandafile repository: real server + throwaway database, stdio
```

## Links

- MCP guide: https://pandafile.co/developers/mcp
- SDKs and CLI: https://pandafile.co/developers/sdks
- API reference: https://pandafile.co/developers/api

MIT © 3XAYA LTD
