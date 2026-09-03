# CodeGraph MCP (daemon-backed)

> Stdio MCP wrapper that forwards to the running CodeGraph/DuckGraph daemon.
> For a zero-dependency shippable server with no VS Code required, use `../build-production/` instead.

Maintained by **Ashvin K S**.

## Requirements

- Node.js 20+
- A running CodeGraph (or legacy DuckGraph/Kairos) extension for the same workspace
- An active lockfile, auto-discovered or passed explicitly

This wrapper does not start the daemon. Start the extension first, trust the workspace, and let it index once.

## Install

```bash
npm install -g ./mcp/duckgraph-mcp
```

## Config

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "args": [],
      "env": {
        "CODEGRAPH_WORKSPACE": "/absolute/path/to/workspace"
      }
    }
  }
}
```

Legacy env/args still work: `DUCKGRAPH_WORKSPACE`, `DUCKGRAPH_LOCKFILE`, `--lockfile`, `--workspace`.

Explicit lockfile:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "args": ["--lockfile", "/absolute/path/to/lockfile.json"]
    }
  }
}
```

## Tools

Primary `codegraph_*` tools plus legacy `duckgraph_*` aliases:

- `codegraph_index_workspace` — index or force reindex supported source files
- `codegraph_query_subgraph` — bounded relationship graph for a symbol
- `codegraph_read_source_node` — AST-bounded source excerpt only
- `codegraph_explain_symbol` — graph facts + deterministic summary + usage guidance
- `codegraph_confirm_edge` — confirm an inferred edge
- `codegraph_dismiss_edge` — dismiss an edge
- `codegraph_health` — daemon status + index stats

## Agent guidance

Use `codegraph_health` first. If a query returns `UNINDEXED`, stale, or empty edges, call `codegraph_index_workspace`, then retry. Use `verified_edges` for all structural claims; never invent relationships. Combine with grep/semantic search when a subgraph returns zero edges (reverse-import coverage is still improving).
