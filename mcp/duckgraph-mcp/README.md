# DuckGraph MCP

Standalone MCP server for DuckGraph structural code intelligence.

DuckGraph MCP lets any MCP-capable agent use the local DuckGraph daemon created by Kairos or the standalone DuckGraph VS Code extension. It provides deterministic, AST-bounded code graph tools for symbol lookup, source extraction, bounded subgraph queries, and inferred-edge decisions.

## Requirements

- Node.js 20+
- A running Kairos or DuckGraph extension for the same workspace
- An active DuckGraph lockfile, either auto-discovered or passed with `DUCKGRAPH_LOCKFILE`

The MCP server does not start the daemon in v1. Start Kairos/DuckGraph first, trust the workspace, and let it index once.

## Install

From this repo:

```bash
npm install -g ./mcp/duckgraph-mcp
```

After publishing:

```bash
npm install -g @kairos-ai/duckgraph-mcp
```

## Generic MCP Config

```json
{
  "mcpServers": {
    "duckgraph": {
      "command": "duckgraph-mcp",
      "args": [],
      "env": {
        "DUCKGRAPH_WORKSPACE": "/absolute/path/to/workspace"
      }
    }
  }
}
```

For an explicit lockfile:

```json
{
  "mcpServers": {
    "duckgraph": {
      "command": "duckgraph-mcp",
      "args": ["--lockfile", "/absolute/path/to/lockfile.json"]
    }
  }
}
```

## Cline / Continue / Agent Clients

Use the generic MCP config above. If the client launches from the workspace root, lockfile auto-discovery usually works. If not, set `DUCKGRAPH_WORKSPACE` or `DUCKGRAPH_LOCKFILE`.

## Codex

Add DuckGraph MCP as a stdio MCP server:

```json
{
  "mcpServers": {
    "duckgraph": {
      "command": "duckgraph-mcp",
      "args": [],
      "env": {
        "DUCKGRAPH_WORKSPACE": "C:/Developer/Code/your-project"
      }
    }
  }
}
```

## Tools

- `duckgraph_index_workspace`: index or force reindex supported source files
- `duckgraph_query_subgraph`: return bounded relationship graph for a symbol
- `duckgraph_read_source_node`: return AST-bounded source excerpt
- `duckgraph_explain_symbol`: return compact graph facts and deterministic local explanation context
- `duckgraph_confirm_edge`: confirm an inferred edge
- `duckgraph_dismiss_edge`: dismiss an inferred edge

## Agent Guidance

Use semantic/vector search for fuzzy discovery when you do not know the symbol name. Once you know a file, line, or symbol, use DuckGraph for exact structural facts. If a graph query returns unindexed, stale, or surprisingly empty results, call `duckgraph_index_workspace` with `force_reindex: true`, then retry.

## Current Limits

DuckGraph is already useful for definition lookup, import-chain resolution, exact line spans, bounded source reads, and stale-state detection. Reverse-import and all-caller impact analysis are still improving, so agents should combine DuckGraph with grep/semantic search when a subgraph returns zero edges.

## Credits

DuckGraph MCP is part of Kairos, a fork built on Kilo Code and OpenCode. It also relies on the Model Context Protocol SDK, VS Code, tree-sitter, SQLite/better-sqlite3, and D3.
