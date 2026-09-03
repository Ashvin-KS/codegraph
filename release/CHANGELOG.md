# Changelog

## 0.2.0

- Rename DuckGraph → CodeGraph (`kilocode-x.codegraph`); all `duckgraph.*` commands, settings, storage, env vars, auth headers, and MCP tools kept as working aliases. DB auto-migrates `.duckgraph/graph.db` → `.codegraph/graph.db`.
- Fix re-index instability: stable node keys (`file + kind + name`, never lines), silent position-only updates, no wipe on empty parses, stable orbit ordering, deduped cycle-safe subgraph CTE.
- Fix branch errors: worktree-aware git watcher, reflog/merge-aware touched files, clamped stale lines, workspace-escape rejection, case-correct workspace comparison.
- Fix MCP for Claude Desktop/Terminal: workspace-aware lockfile discovery, timeouts, `integer` schemas with descriptions, `codegraph_health` tool, deterministic `summary` + `usage_guidance` in explain output.
- Add `build-production/` — independent standalone MCP server (no VS Code, no daemon, no `kilocode/`). Copy the folder alone to ship.
- Harden extension: dual lockfile paths with compat copies, singleflight daemon start, `CODEGRAPH_NODE_PATH`, full-language indexing glob with per-batch error isolation, guarded hover/reindex/orbit commands.

## 0.1.0

- Initial production build of DuckGraph: VS Code extension, daemon, local graph database, indexing, hovers, LSP references, git staleness, Orbit graph, tests, and packaging.
