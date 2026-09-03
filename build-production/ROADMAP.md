# CodeGraph: Master Architecture, Comparative Evaluation, Implementation Plan & 5-Phase Strategic Roadmap

> **Authoritative Technical Evaluation, Implementation Plan & Product Strategy**  
> **Author & Maintainer**: Ashvin K S  
> **Target Projects**: `Ashvin-KS/codegraph` vs. `@colbymchenry/codegraph`  
> **Version Scope**: v0.2.0 (Delivered) $\to$ v0.3.0 (Immediate Execution) $\to$ v1.0.0 (Market Dominance)  

---

## 1. Executive Summary & Market Landscape

The code-intelligence landscape for AI coding agents is currently split between two opposing paradigms:

1. **Colby McHenry (`@colbymchenry/codegraph`)**: *Monolithic 1-Shot Context Ingestion*. Bundles blast radius and dumps up to 12 entire raw source files into a single tool call (`codegraph_explore`).
2. **Ashvin KS (`codegraph` / formerly DuckGraph)**: *Surgical Relational Intelligence*. Models the codebase as an AST-resolved SQLite graph with recursive CTEs, offering modular tools for entrypoint discovery, BFS call-path routing, AST-sliced excerpts, and blast radius calculation.

### The Strategic Verdict:
- **Ashvin's CodeGraph possesses the vastly superior architectural foundation**. Real-world software engineering is relational and graph-based. Raw file dumps like Colby's collapse under long-running agent tasks due to context-window bloat, attention dilution, and "lost in the middle" degradation.
- **However, Colby currently wins on single-turn ergonomic speed** because an agent can get answers without incurring a 3-turn tool-calling tax.
- **The Unified Plan**: By introducing a composite **`codegraph_context_slice`** tool (combining Colby's 1-turn speed with Ashvin's lean AST token footprint) and **dynamic workspace discovery**, Ashvin's CodeGraph decisively beats Colby on both speed and depth.

---

## 2. Side-by-Side Architectural Comparison Matrix

| Dimension | Colby McHenry (`@colbymchenry/codegraph`) | Ashvin KS (`codegraph`) | Strategic Advantage |
| :--- | :--- | :--- | :--- |
| **Tool Surface** | **1 monolithic tool**: `codegraph_explore` | **11 modular tools + new composite**: `overview`, `search_symbols`, `explain_symbol`, `context_slice`, `query_subgraph`, `impact_analysis`, `find_path`, `read_source_node`, `index_workspace`, `health`, `confirm_edge`, `dismiss_edge` | **Ashvin**: Specialized operations for macro, meso, and micro exploration. |
| **Engine Core** | Precompiled native Rust binary (`codegraph-win32-x64`) + SQLite FTS5 | Node.js + `web-tree-sitter` (AST queries) + SQLite WAL with Recursive CTEs | **Ashvin**: Cross-platform portability without native build friction. |
| **Token Consumption** | **Heavy**: 2,000 – 40,000 tokens per call. Dumps full files verbatim. | **Lean**: 100 – 1,200 tokens per call. Slices exact AST boundaries (functions/classes). | **Ashvin (75%–85% token savings)**: Prevents context exhaustion in long sessions. |
| **Turn Latency** | **1 Turn**: Single prompt $\to$ response. | **1 Turn (with `context_slice`)** or 2–4 turns for deep micro surgery. | **Parity on 1-turn speed; Ashvin wins on token budget.** |
| **Flow & Path Tracing** | **None**: Only inspects 1-hop callers. Cannot answer *"How does X reach Y?"* | **Built-in (`codegraph_find_path`)**: BFS shortest call-chain between any two symbols. | **Ashvin**: Critical for tracing architectural execution flows. |
| **Macro Orientation** | **None**: Agent must guess search terms blind. | **Built-in (`codegraph_overview`)**: Degree-centrality hubs + entrypoint auto-detection. | **Ashvin**: Essential when dropped into unfamiliar codebases. |
| **Graph Curation** | Static index. No agent feedback loop. | Human/Agent-in-the-loop: `confirm_edge` and `dismiss_edge` to refine inferred calls. | **Ashvin**: Self-improving graph accuracy. |
| **Workspace Routing** | **Dynamic**: Walks up from `projectPath` to find nearest `.codegraph/`. | **Dynamic (v0.3.0)**: Multi-repo connection pool + auto-discovers nearest `.codegraph/` or git root. | **Parity.** |
| **Telemetry & Privacy** | **Telemetry ON by default** (phones home anonymous telemetry). | **100% Offline & Private**: Zero network telemetry. | **Ashvin**: Essential for enterprise and confidential codebases. |
| **IDE Experience** | Standalone CLI + external browser visualizer (`localhost:4747`). | Native VS Code Extension (`.vsix`) with Alt+Hover preview & embedded D3 Orbit View. | **Ashvin**: Direct developer workflow integration. |

---

## 3. Deep-Dive Agent Benchmarks & The Two Bottlenecks

```
                         THE AGENT TRADEOFF DILEMMA
                         
    Colby McHenry:                              Ashvin KS (Pre-v0.3.0):
    ┌───────────────────────────┐               ┌───────────────────────────┐
    │ Low Turn Count (1 turn)   │               │ Extreme Token Efficiency  │
    │ [BUT 20,000+ tokens lost] │               │ [BUT 3-4 turns round-trip]│
    └─────────────┬─────────────┘               └─────────────┬─────────────┘
                  │                                           │
                  └─────────────────────┬─────────────────────┘
                                        │
                                        ▼
                         [v0.3.0 SOLUTION: MESO-TIER]
                         ┌───────────────────────────┐
                         │   codegraph_context_slice │
                         │   1 Turn + ~1,000 Tokens  │
                         └───────────────────────────┘
```

### The Failure Mode of Colby's 1-Shot Dump
1. **Attention Dilution (Lost in the Middle)**: By dumping 8 to 12 files (often 3,000+ lines), the LLM's attention mechanism degrades. Peripheral code distracts the model from the core logic.
2. **Context Window Exhaustion**: A 20-step debugging session calling `codegraph_explore` 3 times consumes over 60,000 tokens of redundant code, causing early truncation and catastrophic forgetting.
3. **No Multi-Hop Routing**: If a bug originates in an API router and crashes a database transaction 5 layers deep, Colby cannot trace the intermediate chain without manually dumping each file.

### The Friction of Pre-v0.3.0 CodeGraph
1. **The Tool Turn Tax**: To inspect `UserService` and understand its dependency on `UserRepo`, the agent had to invoke `codegraph_search_symbols` $\to$ wait $\to$ `codegraph_explain_symbol` $\to$ wait $\to$ `codegraph_explain_symbol(UserRepo)`.
2. **Agent Impatience**: Autonomous agents (Claude Code, Cursor Agent, Gemini Antigravity) favor tools that minimize turns because each turn incurs a 2–5 second LLM round-trip.

---

## 4. The 3-Tier Agent Pyramid Architecture

```
                  ┌─────────────────────────────────────────┐
                  │       TIER 1: MACRO (Architecture)      │
                  │  codegraph_overview, codegraph_find_path│
                  │  (Entrypoints, Hubs, Flow Paths)        │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │       TIER 2: MESO (Daily Driver)       │
                  │  [NEW] codegraph_context_slice          │
                  │  (Target AST + Callee ASTs in 1 Turn)   │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │       TIER 3: MICRO (Surgical)          │
                  │  codegraph_impact_analysis, search,     │
                  │  explain_symbol, confirm/dismiss_edge   │
                  └─────────────────────────────────────────┘
```

---

## 5. Implementation Plan: Phase 1 (v0.3.0 — The "Colby Killer")

### User Review Required

> [!IMPORTANT]
> ### 1. Primary Composite Tool: `codegraph_context_slice`
> In **a single round-trip turn**, returns:
> 1. Target function's AST-bounded source code.
> 2. AST-bounded excerpts of its **2–3 most critical callers and callees** (only the function definitions, NOT entire files!).
> 3. Downstream impact / blast radius summary (how many dependents break if modified).
> 4. Micro Mermaid diagram showing the immediate call cluster.
> **Total payload**: ~800–1,200 tokens (vs. Colby's 10,000–30,000 tokens for full files), saving 3 sequential agent tool turns!

> [!IMPORTANT]
> ### 2. Dynamic Workspace Discovery & Multi-Repo Pooling
> - Add optional `workspace` parameter to all tools.
> - Auto-discovery: If querying a file outside the default workspace, walk UP the directory tree to find the nearest `.codegraph/` or `.git/` folder.
> - Multi-repo connection pool: Cache `GraphRepository` instances by workspace root so an agent working across multiple folders (e.g. `vscodeextension` and `Allentire-main`) can query both without restarting the MCP server.

---

### Proposed Code Changes

#### Component 1: Engine & Repository Core (`build-production/src/repository.js` & `src/server/repository.ts`)
- **Implement `getContextSlice(symbolName, file?, options)`**:
  - Resolve target node.
  - Query top $K$ callees and top $M$ callers.
  - Query blast radius count and downstream callers up to 3 hops via recursive CTE.
  - Return target metadata, callee references (`name`, `kind`, `file`, `line_start`, `line_end`), caller references, and blast radius.
- **Centrality-Ranked Search (`searchSymbols`)**:
  - Order search results by `(name = ?) DESC, (in_degree + out_degree) DESC, LENGTH(name) ASC` so architectural hubs appear before peripheral variables.

#### Component 2: Standalone MCP Server & Dynamic Workspace Manager (`build-production/bin/codegraph-mcp.js`)
- **Multi-Workspace Connection Pool**:
  - `repoPool`: Map of `workspaceRoot -> GraphRepository`.
  - Auto-discover nearest `.codegraph/` or git root from passed `workspace` or `file`.
  - Cache repositories in memory.
- **Register `codegraph_context_slice` Tool**:
  - Parameters: `symbol` (string), `file` (optional string), `workspace` (optional string), `max_callees` (default 3), `max_callers` (default 2), `format` (`"compact" | "mermaid" | "json"`).
  - Extract target AST and read AST excerpts for top callers and callees in parallel using `readNodeBody`.
  - Format unified 1-turn response.
- **Add optional `workspace` argument across all 11 existing tools**.

#### Component 3: Documentation & Playbook
- Update `README.md` and `ROADMAP.md` with the 3-tier pyramid and new tool reference.
- Update Antigravity schemas in `~/.gemini/antigravity/mcp/codegraph/`.

---

### Verification Plan for v0.3.0

1. **Automated Vitest Suite** (`npm test`):
   - Test `getContextSlice`: verifies target AST + caller ASTs + callee ASTs returned in single call.
   - Test dynamic workspace discovery and repo pool caching.
   - Test centrality-ranked search.
2. **Production Smoke Test** (`npm run build:production`):
   - Assert all 12 primary tools registered (0 duplicates).
   - Test `codegraph_context_slice` over stdio.
   - Test dynamic workspace override over stdio.
3. **Build & Typecheck**:
   - `npm run lint` && `npm run typecheck`.
4. **Live Dogfooding in this Repository**:
   - Run `codegraph_context_slice(symbol: "createApp")` and assert:
     - Contains `createApp` source excerpt.
     - Contains `assertWorkspace` and `auth` source excerpts.
     - Contains callers and blast radius count.
     - Response size is within 1,200 tokens.

---

## 6. The Complete 5-Phase Long-Term Roadmap

```
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │                                  CODEGRAPH ROADMAP                               │
 └──────┬────────────────────┬─────────────────────┬────────────────────┬───────────┘
        ▼                    ▼                     ▼                    ▼
   [Phase 1: v0.3.0]    [Phase 2: v0.4.0]     [Phase 3: v0.5.0]    [Phase 4: v0.6.0]
   The "Colby Killer"   Hybrid Search         Monorepo Scale       Agent Guardrails
   - Context Slicing    - SQLite-vec          - Package federation - Refactor checklist
   - Dynamic Paths      - Intent matching     - Cross-module types - Continuous watcher
   - 1-Turn Composite   - Semantic graph      - Branch snapshots   - Dead code detection
```

### Phase 1: v0.3.0 — The "Colby Killer" (Immediate Execution)
- 1-Turn Composite Tool (`codegraph_context_slice`).
- Dynamic Multi-Workspace Auto-Discovery & Pool.
- Centrality-Ranked Search.

### Phase 2: v0.4.0 — Hybrid Relational + Semantic Search
- **Lightweight Vector Indexing with SQLite-vec**: Local embeddings for symbol docstrings and identifiers stored directly in `graph.db`.
- **Intent-to-AST Resolver (`codegraph_semantic_search`)**: Natural language queries (*"Where do we validate user authentication tokens?"*) resolve directly to the exact AST node `verifyToken()` and its call graph.
- **Zero-Hallucination Hybrid RAG**: Vector search identifies candidate seed nodes $\to$ Graph CTE traces exact deterministic execution paths.

### Phase 3: v0.5.0 — Monorepo Scale & Type Propagation
- **Cross-Package Workspace Federation**: Parse `tsconfig.json` paths and `package.json` workspaces. Resolve imports across package boundaries (e.g. `frontend/src/api.ts` $\to$ `backend/src/routes/api.ts`).
- **Interface Implementation & Type Hierarchy**: Track `implements`, `extends`, and abstract class hierarchies. Trace dynamic interface dispatch to all concrete implementations.
- **Git Branch Snapshots**: SQLite branch isolation so switching git branches does not wipe or invalidate graph indexes.

### Phase 4: v0.6.0 — Proactive Agent Guardrails & Live Watcher
- **Refactor Safety Checklist (`codegraph_refactor_preview`)**: Input: Symbol to rename or signature to modify. Output: Strict checklist of every call site across all files, marked with exact line numbers and replacement guidance.
- **Sub-Millisecond Incremental Watcher**: Background file watcher re-parses AST only for dirty files on save, ensuring the graph is always 100% fresh without manual rebuild calls.
- **Dead Code Detection**: Expose degree-zero non-exported symbols as dead code candidates directly to agents.

### Phase 5: v1.0.0 — Universal Distribution & Ecosystem Standard
- **Universal One-Command Launch**:
  - `npx @kilocode/codegraph init` or `npx codegraph-mcp serve`.
  - Auto-configure Claude Code (`claude mcp add`), Cursor (`mcp.json`), Antigravity (`mcp_config.json`), and Windsurf.
- **Official VS Code Marketplace Launch**:
  - Packaged `.vsix` with active hover cards, graph exploration palette, and embedded D3 visualizer.
- **Open-Source Benchmark Suite**:
  - Benchmark Grep/Ripgrep vs. Colby CodeGraph vs. Ashvin CodeGraph measuring token cost, task completion rate, turn count, and refactoring regression rate.

---

## 7. Strategic ROI & Metrics Summary

| Metric | Flat Grep / Naive File Reads | Colby CodeGraph | Ashvin CodeGraph (v0.3.0) |
| :--- | :---: | :---: | :---: |
| **Token Consumption** | High (reads entire files) | Very High (10k–40k tokens) | **Minimal (100–1,200 tokens)** |
| **Turn Latency** | High (5+ turns) | **Low (1 turn)** | **Low (1 turn via `context_slice`)** |
| **Context Window Preservation** | Poor | Very Poor (exhausts context) | **Optimal (preserves 30+ turn memory)** |
| **Architectural Depth** | Zero | 1-hop only | **Multi-hop BFS paths & Hub Centrality** |
| **Pre-Edit Safety** | Manual | Caller list | **Recursive Blast Radius CTE** |
| **Enterprise Privacy** | Local | Telemetry ON | **100% Offline & Private** |
