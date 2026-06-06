# 🌌 Kairos + DuckGraph

> **Local-First Codebase Graph, Bounded AST Explanations, and Grounded Cognitive Memory.**

Kairos is a premium agentic VS Code coding environment built on Kilo Code and OpenCode, supercharged with **DuckGraph** local-first structural code intelligence, interactive hovers, and a persistent mind graph cache.

DuckGraph keeps your cognitive model secure. It explains symbols from your codebase using a verified local graph, optional local LLM completions, and a Git-aware staleness tracker. It operates entirely offline — **no cloud services, zero telemetry, absolute privacy.**

---

## 🎨 Architectural Overview

```mermaid
flowchart TB
    subgraph IDE ["VS Code (Kairos / Kilo-vscode)"]
        UI["SolidJS Settings Webview Tab"]
        A["Alt+Hover / Alt+D Command"]
        E["LSP Reference Provider"]
        W["watchDuckGraphConfig (IPC)"]
    end

    subgraph Daemon ["Local DuckGraph Daemon (Node + Express + WASM)"]
        F["POST /explain (Lockfile Auth)"]
        G["Cache Match (mind_concepts)"]
        H["Recursive CTE Subgraph Query"]
        I["Hybrid Router (Source vs Graph)"]
        J["web-tree-sitter AST Body Extraction"]
        K["Prompt Assembly & Token Squeeze"]
    end

    subgraph DB ["SQLite WAL Database (.duckgraph/graph.db)"]
        N["code_nodes / code_edges"]
        O["mind_concepts (User memory)"]
        P["git_rationale & staleness_log"]
    end

    subgraph Providers ["Inference / Tooling"]
        L["Local llama.cpp / LM Studio"]
        MCP["Standalone Stdio MCP Server"]
    end

    UI -->|IPC Settings Sync| W
    W -->|Update State| F
    A -->|ALT+Hover Request| F
    E -->|LSP references| N
    F --> G
    G -->|Cache Hit| A
    G -->|Cache Miss| H
    H --> DB
    H --> I
    I -->|Needs Source| J
    J --> K
    K --> L
    L -->|Ground Explanation| O
    O --> A
    MCP -->|Tools API| F
```

---

## ⚡ Key Core Enhancements

DuckGraph has been upgraded with a series of structural, database, and UI enhancements designed for robust, crash-resilient monorepo operations:

### 1. 🛡️ Single Source of Truth (SSOT) Architecture
To prevent code drift between standalone extension builds and the integrated Kilo Code workspace, the standalone extension files (`src/server/` and `src/shared/`) have been rebuilt into clean TypeScript re-exports pointing directly to the monorepo package (`@kilocode/duckgraph`).

### ⚡ 2. Stable Diff-Based Edge Syncing
Syntactic edge wipes during file re-indexing have been upgraded to a stable, set-difference diffing sync mechanism. Instead of wiping and recreating all edges (which destroys primary autoincrement keys and dates), DuckGraph computes additions/deletions inside SQLite transactions to preserve stable IDs and timestamps.

### 🔍 3. Bounded AST & Bounded Regex Fallbacks
* **AST Parser Alignment**: Implemented strict line-boundary clamping and typescript variable declaration AST grammar matching to prevent parser over-scanning.
* **Regex Fallbacks**: When AST parsers fail or are unindexed, DuckGraph implements a precise, bounded 20-line sliding window fallback centered on the cursor and strictly clamped to file boundaries.

### 🗃️ 4. Cascade Database Purging & Safe Re-Indexing
* **DB Purge Protocol**: Supports a comprehensive cascade deletion across all tables (`code_nodes`, `code_edges`, `mind_concepts`, `staleness_log`, `index_runs`, etc.) to reset the database.
* **Safe Re-indexing**: Supports a clean `clearGraphCache` request that clears only workspace-derived edges/nodes while keeping your human descriptions (`mind_concepts` and sessions) pristine.

### 🚀 5. Robust Crash-Resilient Indexing Queue
Monorepo scale testing has been hardened. Background indexing runs skip corrupted files, parsing failures, and unsupported AST models gracefully without aborting the entire workspace index task.

### ⚙️ 6. Real-time Config Watchers & Settings UI
* **Dynamic Watchers**: Implemented `watchDuckGraphConfig` listeners in `KiloProvider.ts` to capture real-time settings adjustments and immediately configure running daemons.
* **SolidJS UI Tab**: Integrated a bespoke configuration view directly in the Kilo Code settings webview. Customize LM Studio base URLs, models, model route routing, and active-symbol attachment options.

### 🤖 7. Agentic MCP Integration
* Bundled permissions let Kilo Code's `explore` agents invoke DuckGraph MCP tools natively.
* The Stdio MCP handler translates internal errors into structured `isError: true` JSON outputs, allowing calling LLMs to recognize unindexed files, run a reindex command automatically, and recover gracefully.

---

## 📂 Repository Directory Layout

* `src/` — Standing extension entrypoints serving as re-exports pointing to `@kilocode/duckgraph` for a zero-drift single source of truth.
* `kilocode/` — The main Kilo Code monorepo codebase.
  * `packages/duckgraph/` — The unified, core DuckGraph engine code (WASM parsers, Express daemon, database).
  * `packages/kilo-vscode/` — The Kairos VS Code extension integrating the SolidJS settings tab and config watchers.
  * `packages/opencode/` — Agent prompt mappings and tool registrations for the `explore` agent.
* `mcp/duckgraph-mcp/` — A standalone stdio Model Context Protocol (MCP) server wrapping the active daemon.

---

## 🛠️ Development & Packaging Pipelines

Depending on whether you want to deploy DuckGraph standalone or integrated inside the Kairos extension, use the corresponding commands:

### A. Standalone DuckGraph Extension (`duckgraph-0.1.0.vsix`)
Builds a standalone, lightweight version of DuckGraph directly into the repository root:
```powershell
npm install
npm run build
npm run lint
npm run typecheck
npm test
npm run package
```

### B. Integrated Kairos Extension VSIX (`kilo-code-7.3.0.vsix`)
Builds the full-featured, integrated Kairos extension with DuckGraph configuration settings, webview tabs, and agentic tools bundled in:
```powershell
cd kilocode/packages/kilo-vscode
bun run package
bunx vsce package -o kilo-code-7.3.0.vsix --no-dependencies --skip-license
```

### C. Developer Snapshots (Immediate Live-Testing)
Automatically compiles and installs the current code version directly into your active VS Code instance:
```powershell
cd kilocode/packages/kilo-vscode
bun run snapshot:install
```

---

## 🔌 Standalone DuckGraph MCP

The `mcp/duckgraph-mcp` subdirectory is a self-contained Node.js stdio MCP server package. It allows external MCP clients (such as Cline, Continue, Codex, or AG) to tap into the active local DuckGraph daemon.

### Installation
From the repository root:
```bash
npm install -g ./mcp/duckgraph-mcp
```

### Configuration
Add this entry to your client's MCP configuration settings file (e.g. `mcp_settings.json` or equivalent):
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

---

## ⚙️ Configuration Properties

The following configurations can be customized in VS Code Settings (`settings.json`):

| Property Name | Default Value | Description |
|---|---|---|
| `kilo-code.new.duckgraph.enabled` | `true` | Enable DuckGraph structural graph context, hovers, and MCP tool integration in Kairos. |
| `kilo-code.new.duckgraph.alwaysAttachActiveSymbol` | `false` | Attach DuckGraph graph facts for the active symbol to every Kairos chat request. |
| `kilo-code.new.duckgraph.modelRoute` | `"kilo-free"` | Route for chat completions (`kilo-free`, `lm-studio`, or `custom`). |
| `kilo-code.new.duckgraph.lmStudioBaseUrl` | `"http://127.0.0.1:1234/v1"` | OpenAI-compatible endpoint base URL for LM Studio route. |
| `kilo-code.new.duckgraph.lmStudioModel` | `"local-model"` | Model ID exposed by LM Studio. |
| `duckgraph.llamaUrl` | `"http://localhost:8080/completion"` | Local llama.cpp endpoint for standalone hover completions. |

---

## 🛠️ DuckGraph MCP Tools Reference

The daemon exposes the following suite of semantic tools, available to both internal Kairos agents and external MCP clients:

1. **`duckgraph_index_workspace`**: Indexes or forces a full re-index of the active workspace files.
2. **`duckgraph_query_subgraph`**: Returns a bounded relationship graph for a targeted symbol.
3. **`duckgraph_read_source_node`**: Extracts the AST-bounded source code block for a symbol.
4. **`duckgraph_explain_symbol`**: Yields a compact graph fact list and deterministic local explanation context.
5. **`duckgraph_confirm_edge`**: Confirms an uncertain/inferred structural edge in the SQLite database.
6. **`duckgraph_dismiss_edge`**: Dismisses/rejects an inferred edge to prevent it from polluting the active graph.

---

## 🌟 Credits & Acknowledgments

Kairos preserves structural compatibility with **Kilo Code** and **OpenCode**, crediting both projects as its foundation. DuckGraph relies on the VS Code Extension API, the Model Context Protocol (MCP) SDK, tree-sitter, web-tree-sitter, tree-sitter-wasms, SQLite (`better-sqlite3`), Express, and D3.
