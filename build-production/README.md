# CodeGraph — standalone local MCP server

> Local-first codebase graph for Claude Desktop / Claude Code. No VS Code required.
> Formerly DuckGraph — `duckgraph_*` tool names still work as aliases.

Maintained by **Ashvin K S**.

## What this folder is

`build-production/` is **independent of everything else in the repo**:

- No `../../kilocode/...` imports, no VS Code APIs, no daemon, no lockfiles.
- Only runtime deps: `@modelcontextprotocol/sdk` + `better-sqlite3`.
- Copy this folder alone to any machine and it runs.

```
build-production/
  package.json
  README.md            (this file)
  bin/codegraph-mcp.js (stdio MCP server — the entrypoint)
  src/                 (hash, fs, protocol, parser, schema, db, repository)
  examples/            (Claude Desktop / generic MCP configs)
```

## Quick start (ship to friends)

```powershell
npm install -g ./build-production
codegraph-setup --workspace C:/path/to/your-project
# restart Claude Desktop — done, no hand-editing
```

`codegraph-setup` writes the entry into `claude_desktop_config.json` for you
(uses the short global `codegraph-mcp` command when it's on PATH, otherwise
falls back to `node` + the absolute server path). Flags:
`--workspace <path>` (default: current dir), `--name <server-name>`,
`--uninstall`, `--config-path <file>`.

Manual alternative — global install, then this entry:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "args": ["--workspace", "C:/path/to/your-project"]
    }
  }
}
```

## Claude Desktop config

`codegraph-setup` handles this (see above). The entry it writes looks like
`examples/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "args": ["--workspace", "C:/path/to/your-project"]
    }
  }
}
```

Env alternatives (no `--workspace` needed if Claude launches from the project root):

- `CODEGRAPH_WORKSPACE=C:/path/to/your-project` (legacy `DUCKGRAPH_WORKSPACE` also works)
- `CODEGRAPH_DB=C:/custom/graph.db` (default `<workspace>/.codegraph/graph.db`; legacy `.duckgraph/graph.db` is auto-migrated by copy)

## Workflow for the AI (important)

1. `codegraph_health` — check `indexedNodes`. If 0, index first.
2. `codegraph_index_workspace` — call when `stale_state` is `UNINDEXED`, edges are empty, or after a branch switch. `force_reindex=true` rebuilds (stable ids preserved for unchanged symbols).
3. `codegraph_query_subgraph` — architecture facts (`verified_edges[].id/type/target_name`). Use these for ALL structural claims.
4. `codegraph_read_source_node` — implementation detail only.
5. `codegraph_explain_symbol` — facts + `summary` + `usage_guidance` in one call.
6. `codegraph_confirm_edge` / `codegraph_dismiss_edge` — curate edges with ids from step 3/5.

Freshness: `FRESH` trusted · `NEW` never explained · `STALE` hedge + prefer source · `UNINDEXED` must index.

## Stability guarantees (fixed bugs)

- **Stable ids**: keys are `file + kind + name` (never line numbers). Editing above a symbol updates lines silently without a new tree, without touching `updated_at`, without spurious `STALE`.
- **No wipe on empty parse**: files the parser can't handle keep their old graph rows instead of tombstoning everything.
- **Branch-safe**: out-of-range lines are clamped (not 400); legacy `.duckgraph/graph.db` is migrated to `.codegraph/graph.db` on first run.
- **Path-safe**: files outside the workspace are rejected; Windows/Unix separators normalized.

## Tools

| Tool | Returns |
|---|---|
| `codegraph_index_workspace` | `{workspace_root, indexed_files, nodes, edges, truncated}` |
| `codegraph_query_subgraph` | `{target, nodes, edges, freshness}` |
| `codegraph_read_source_node` | `{target_symbol, bounded_source_excerpt, stale_state}` |
| `codegraph_explain_symbol` | `{target_symbol, verified_edges, inferred_edges, stale_state, bounded_source_excerpt, summary, usage_guidance, compact_json}` |
| `codegraph_confirm_edge` / `codegraph_dismiss_edge` | `{ok, result}` |
| `codegraph_health` | `{ok, workspace_root, indexedFiles, indexedNodes, dbPath}` |

Legacy `duckgraph_*` aliases for the first six tools are also listed.

## VS Code extension (separate artifact)

The extension ships separately as a `.vsix`:

```powershell
# from the repo root (needs the kilocode/ checkout at build time; the .vsix itself is self-contained)
npm install
npm run build
npm run package
```

That produces `kilocode-x.codegraph-0.2.0.vsix`. Install with
`code --install-extension kilocode-x.codegraph-0.2.0.vsix`.
Extension commands `codegraph.*` are primary; `duckgraph.*` remain as aliases, as do `codegraph.*` / `duckgraph.*` settings and `.codegraph/` / `.duckgraph/` storage.

## Credits

- Author/maintainer: **Ashvin K S**
- Built on: Model Context Protocol SDK, SQLite (`better-sqlite3`), tree-sitter patterns (regex fallback vendored here)
- Sibling projects: Kilo Code, OpenCode, VS Code Extension API, D3 (orbit view in the extension only)
