# DuckGraph

DuckGraph is a local-first VS Code extension that explains symbols from your own codebase using a verified local graph, optional local llama.cpp completions, and a persistent mind graph cache. It does not call cloud services or ship telemetry.

## Features

- Native hover explanations for Rust, TypeScript, TSX, and Python.
- Local daemon bound to `127.0.0.1` with per-run lockfile auth.
- SQLite graph and mind cache stored in `.duckgraph/graph.db`.
- Tree-sitter-backed symbol indexing with a regex fallback for resilience.
- LSP reference ingestion for cross-file `used_by` relationships.
- Git HEAD watcher for rationale and stale explanation marking.
- Offline deterministic fallback when llama.cpp is unavailable.
- Command-opened Orbit graph WebView backed by local D3 assets.

## Development

```powershell
npm install
npm run build
npm run lint
npm run typecheck
npm test
npm run package
```

The generated VSIX is written to the repository root.

## Runtime

DuckGraph activates only in trusted workspaces. On activation, it starts the daemon, writes `.duckgraph/lockfile.json`, creates `.duckgraph/graph.db`, and indexes supported files if `duckgraph.indexOnStartup` is enabled.

Set `duckgraph.llamaUrl` to a local llama.cpp `/completion` endpoint. If the endpoint is missing or slow, DuckGraph falls back to a short graph-grounded explanation instead of blocking the editor.
