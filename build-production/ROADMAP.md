# CodeGraph: Strategic Market Notes & Future Upgrades Roadmap

> **Author**: Ashvin K S  
> **Repository**: [github.com/Ashvin-KS/codegraph](https://github.com/Ashvin-KS/codegraph)  
> **Status**: Living Reference Document for v0.2.0 and Future Milestones  

---

## 1. Market Analysis & The Strategic Advantage

### The Industry Blindspot
Modern AI coding tools (Claude Code, Cursor, Windsurf, GitHub Copilot) rely heavily on:
1. **Flat text search (`ripgrep`)**: High false-positive rate from comments, docs, tests, and markdown.
2. **Vector embeddings (RAG)**: Semantically fuzzy and structurally blind; incapable of deterministic call-path traversal or tracking return types.

### The Problem: "Relational Blindness"
LLMs excel at writing 20–50 lines of code in isolation, but fail in multi-file codebases:
* **Silent Refactoring Breakages**: Editing function `foo()` breaks 8 other files because the LLM is unaware of its callers.
* **Context & Token Exhaustion**: The model reads 500-line files simply to locate a 5-line signature.
* **Navigation Hallucinations**: Speculative guessing of imports and APIs.

### The Solution: Compiler-Grade Vision via MCP
CodeGraph provides **Tree-sitter AST parsing + SQLite Graph DB + Model Context Protocol (MCP)**. It gives AI models compiler-grade relational vision with deterministic certainty.

---

## 2. Quantified Productivity & Token Economics

| Metric | Flat Grep / Naive File Reads | With CodeGraph MCP | Real-World Impact |
| :--- | :--- | :--- | :--- |
| **Token Consumption** | High (reads entire 200–800 line files) | **60% – 80% Reduction** | Agents read only AST-bounded excerpts (20–40 lines). Saves massive context & API costs. |
| **Navigation Latency** | Slow (loop: `grep` $\to$ read file $\to$ trace caller $\to$ repeat 5x) | **3x – 5x Faster** | Direct graph traversal (`verified_edges`) connects functions in 1 query. |
| **Refactoring Accuracy** | Prone to breaking dependencies | **Near 0% Silent Breakages** | The agent inspects downstream blast radius (`codegraph_impact_analysis`) before editing. |
| **Agent Autonomy** | Needs human intervention when lost in spaghetti code | **High Autonomy** | Agents explore entrypoints and trace call chains independently. |

---

## 3. Milestones Achieved (v0.2.0)

The foundational friction points identified in agent testing have been fully resolved:

- [x] **Decoupled Symbol Search**: `file` and `line` are optional; queries by symbol name search globally across the database.
- [x] **AST-Bounded Excerpt Reader**: Source windows are read from the symbol's actual file and lines on disk (no dummy file trap).
- [x] **Distinct Error States**: `FILE_NOT_FOUND`, `NON_AST_LANGUAGE` (with guidance on Markdown/JSON), `SYMBOL_NOT_FOUND` (with "did you mean" suggestions), and `UNINDEXED`.
- [x] **Architecture Entrypoints & Centrality (`codegraph_overview`)**: Discovers `main`, `activate`, `createApp`, etc., and high-degree hub symbols.
- [x] **Search Symbols Tool (`codegraph_search_symbols`)**: Fast substring matching across workspace nodes.
- [x] **Impact Analysis (`codegraph_impact_analysis`)**: Multi-hop recursive CTE finding the blast radius / all downstream callers.
- [x] **Shortest Call Path Finder (`codegraph_find_path`)**: BFS path routing between two symbols.
- [x] **Token-Efficient Formats**: Supports `format: "compact"` (lean text), `"mermaid"` (flowchart), or `"json"`. Default budgets clamped to 1500 chars / 8 edges.
- [x] **Git-Aware Incremental Indexing**: Real commit SHA via `git rev-parse --short HEAD` and `dirty_only: true` indexing.
- [x] **Agent Playbook & Workflow Guidance**: Step-by-step numbers in tool schemas, `instructions.md`, and `README.md`.

---

## 4. Future Upgrades Roadmap

### Phase 3: Semantic + AST Hybrid Intelligence (v0.3.0)
- **Hybrid Semantic Search (`codegraph_semantic_search`)**:
  - Integrate a lightweight local vector store (or SQLite `vec`) alongside the AST.
  - Enables intent-based queries: *"Where is the auth session refreshed?"* $\to$ resolves directly to the exact AST node `refreshSession()` with its call graph.
- **Cross-File Type Propagation**:
  - Track interface implementations (`implements`, `extends`) and return types across module boundaries.
- **Speculative Edge Reasons (`inferred_reason`)**:
  - When AST parsing cannot guarantee a dynamic invocation (e.g. dynamic dispatch, reflection), attach an `inferred_reason` explanation (e.g. `"name match on DuckClient.get"`).

### Phase 4: Monorepo & Multi-Package Federation (v0.4.0)
- **Cross-Package Workspace Resolution**:
  - Resolve imports across `packages/*` and `pnpm`/`turborepo` workspaces.
  - Enable jumping from an API consumer in `frontend` to the endpoint handler in `backend`.
- **Git Worktree & Branch Graph Isolation**:
  - Separate database snapshots per branch so switching git branches instantly switches graph states without re-indexing.

### Phase 5: Agent Auto-Refactoring & Safety Previews (v0.5.0)
- **Refactor Preview (`codegraph_refactor_preview`)**:
  - Given a proposed function rename or parameter change:
    1. Returns a complete checklist of all files, line numbers, and call sites that must be updated.
    2. Flags any third-party external exports that cannot be automatically changed.
- **Live Incremental Watcher**:
  - Daemon-backed in-process file watcher automatically updates the graph on save (sub-millisecond updates).

### Phase 6: Visual Webview & Interactive Graph Explorer (v1.0.0)
- **Interactive D3/SolidJS Graph Webview**:
  - Visual diagram in the VS Code sidebar showing live call hierarchies as the user moves their cursor.
  - One-click "Export to Mermaid" or "Copy Context for AI".
- **MCP Resource Providers**:
  - Expose `codegraph://overview` and `codegraph://subgraph/{symbol}` as standard MCP Resources for IDEs supporting resource previews.
