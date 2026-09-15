# MCP Lint

A GitHub Action that catches two MCP mistakes that fail **silently**.

1. **A broken MCP Server Card.** If your `.well-known/mcp/server-card.json` is missing a
   required object, has a non-semver `version`, or a `transport.url` that isn't a real
   http(s) URL, crawlers and registries discard the whole card — with no error, no log,
   no warning. You just quietly don't get indexed.
2. **A bloated MCP config.** Every tool definition you load costs context. Past roughly
   10–15 tools, tool-selection accuracy falls off a cliff independently of token usage.
   Nothing in your editor tells you this is happening.

This action runs both checks on every pull request and reports them as annotations plus a
job summary.

## Quick start

```yaml
name: MCP Lint

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cavan1977/mcp-lint@v1
```

No token, no API key, no setup. It auto-detects your files.

## What it looks at

| File | Check |
|---|---|
| `.well-known/mcp/server-card.json` | Validated against SEP-1649 — structure **and** format |
| `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/mcp.json` | Tool count and context-window cost, per server |

Missing files are **skipped, not failed** — a repo with no MCP config at all exits clean.

## Inputs

| Input | Default | Description |
|---|---|---|
| `card-path` | `.well-known/mcp/server-card.json` | Path to your server card |
| `config-path` | *(auto-detect)* | Path to your MCP config |
| `api-url` | `https://freetoolhub.org/api/mcp` | MCP endpoint used for the checks |
| `context-window` | `200000` | Model context window in tokens |
| `fail-on-error` | `true` | Set `false` to report card errors without failing the job |

## Outputs

| Output | Description |
|---|---|
| `card-valid` | `true` / `false`. Empty when no card was found |
| `tool-count` | Tools declared across the detected MCP config |
| `budget-verdict` | `healthy`, `moderate`, `heavy`, `severe` or `over_budget` |

## Example: fail only on severe bloat

```yaml
- id: lint
  uses: cavan1977/mcp-lint@v1
  with:
    fail-on-error: false

- if: steps.lint.outputs.budget-verdict == 'severe'
  run: |
    echo "MCP tool set is severely bloated — see the job summary."
    exit 1
```

## Behaviour when the endpoint is unreachable

The checks call a public MCP endpoint. If it's down or rate-limited, the action emits a
warning and **exits 0** rather than failing your build. A third-party outage should never
block your merge queue.

## Generate a card if you don't have one

The same server that validates cards can generate one. Ask your MCP client:

> Generate an MCP server card for `my-server` at `https://example.com/api/mcp`.

Or call the tool directly:

```bash
curl -s https://freetoolhub.org/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_mcp_server_card","arguments":{"name":"my-server","description":"What it does","version":"1.0.0","endpointUrl":"https://example.com/api/mcp"}}}'
```

## Design notes

- **Zero dependencies.** Uses only Node built-ins, so `src/index.js` is exactly what runs.
  There is no bundled `dist/` to audit and no transitive supply chain.
- **Fail-open on network errors, fail-closed on validation errors.** The distinction matters:
  a bad card is your bug, an unreachable endpoint is not.

## Licence

MIT

---

Checks powered by [FreeToolHub](https://freetoolhub.org) — the same tools are available to
your agent over MCP at `https://freetoolhub.org/api/mcp`. Related:
[context budget calculator](https://freetoolhub.org/mcp-context-budget-calculator) ·
[MCP server trust score](https://freetoolhub.org/mcp-server-trust-score) ·
[security audit](https://freetoolhub.org/mcp-server-security-audit)
