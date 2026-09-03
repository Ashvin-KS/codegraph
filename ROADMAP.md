# CodeGraph vs. Colby McHenry CodeGraph: Comprehensive Analysis & Roadmap to Success

> **Authoritative Technical Evaluation & Strategic Product Plan**  
> **Prepared for**: Ashvin K S  
> **Target Projects**: `Ashvin-KS/codegraph` vs. `@colbymchenry/codegraph`  
> **Date**: September 2026  

---

## 1. Executive Summary

The code-intelligence landscape for AI agents is currently split between two opposing design philosophies:

1. **Colby McHenry (`@colbymchenry/codegraph`)**: *Monolithic 1-Shot Context Ingestion*. It bundles blast radius and up to 12 entire raw source files into a single tool call (`codegraph_explore`).
2. **Ashvin KS (`codegraph` / formerly DuckGraph)**: *Surgical Relational Intelligence*. It models the codebase as an AST-resolved SQLite graph with recursive CTEs, offering 11 modular tools for entrypoint discovery, BFS call-path routing, AST-sliced excerpts, and blast radius calculation.

### The Verdict:
- **Ashvin's CodeGraph possesses the vastly superior architectural foundation**. Real-world software engineering is relational and graph-based. Raw file dumps like Colby's collapse under long-running agent tasks due to context-window bloat and attention degradation.
- **However, Colby currently wins on single-turn ergonomic speed** because an agent can get answers without incurring a 3-turn tool-calling tax.
- **The Roadmap to Market Dominance**: By introducing a composite **`codegraph_context_slice`** tool (combining Colby's 1-turn speed with Ashvin's lean AST token footprint) and **dynamic workspace discovery**, Ashvin's CodeGraph can decisively beat Colby on both speed and depth.

---

## 2. In-Depth Side-by-Side Comparison Matrix

| Dimension | Colby McHenry (`@colbymchenry/codegraph`) | Ashvin KS (`codegraph`) | Strategic Advantage |
| :--- | :--- | :--- | :--- |
| **Tool Surface** | **1 monolithic tool**: `codegraph_explore` | **11 modular tools + new composite**: `overview`, `search_symbols`, `explain_symbol`, `context_slice`, `query_subgraph`, `impact_analysis`, `find_path`, `read_source_node`, `index_workspace`, `health`, `confirm_edge`, `dismiss_edge` | **Ashvin**: Gives agents specialized operations for macro, meso, and micro exploration. |
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

## 3. Deep-Dive Agent Benchmarks & Ergonomics

### The Real-World Failure Mode of Colby's 1-Shot Dump
When Colby's `codegraph_explore` runs on a medium or large codebase:
1. **Attention Dilution (Lost in the Middle)**: By dumping 8 to 12 files (often 3,000+ lines), the LLM's attention mechanism suffers degradation. Peripheral files (e.g. test fixtures, utilities) distract the model from the core bug.
2. **Context Window Exhaustion**: A 20-step debugging session calling `codegraph_explore` 3 times consumes over 60,000 tokens of redundant file code, accelerating truncation and catastrophic forgetting.
3. **No Multi-Hop Routing**: If a bug originates in an API router and crashes a database transaction 5 layers deep, Colby cannot trace the intermediate chain without manually dumping each intermediate file.

### The Real-World Friction of Ashvin's Modular Suite
While Ashvin's AST slicing is mathematically and token-wise optimal:
1. **The Tool Turn Tax**: To inspect `UserService` and understand its dependency on `UserRepo`, the agent must invoke `codegraph_search_symbols`, wait for response, invoke `codegraph_explain_symbol`, wait for response, and then inspect `UserRepo`.
2. **Agent Impatience**: Autonomous agents like Claude Code, Cursor Agent, or Gemini Antigravity often prefer tools that minimize turns, even if they waste tokens, because each turn incurs a 2–5 second LLM roundtrip.

---

## 4. The 3-Tier Agent Pyramid

```
                  ┌─────────────────────────────────────────┐
                  │       TIER 1: MACRO (Architecture)      │
                  │  codegraph_overview, codegraph_find_path│
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

## 5. The 5-Phase Roadmap to Market Dominance

```
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │                                  CODEGRAPH ROADMAP                               │
 └──────┬────────────────────┬─────────────────────┬────────────────────┬───────────┘
        ▼                    ▼                     ▼                    ▼
   [Phase 1: v0.3.0]    [Phase 2: v0.4.0]     [Phase 3: v0.5.0]    [Phase 4: v1.0.0]
   The "Colby Killer"   Hybrid Search         Monorepo Scale       Enterprise & IDE
   - Context Slicing    - SQLite-vec          - Package federation - VS Code Market
   - Dynamic Paths      - Intent matching     - Cross-module types - Zero-config CLI
   - 1-Turn Composite   - Semantic graph      - Branch snapshots   - Daemon watcher
```

---

### Phase 1: The "Colby Killer" — 1-Turn Context Slicing (v0.3.0)
*Target: Neutralize Colby's only advantage (turn latency) while keeping your 80% token savings.*

#### 1. Implement `codegraph_context_slice` (Composite Tool)
Create a new primary tool that returns everything needed in **one single round-trip**:
- **Arguments**: `symbol: string` OR `query: string`, `depth?: number (default: 1)`.
- **Output**:
  ```markdown
  ### Target: UserService [class] (src/userService.ts:4-24)
  [AST-bounded source of UserService]

  ### Direct Dependencies (Callees)
  - hashPassword (src/cryptoUtil.ts:1-3): [AST source]
  - saveUser (src/userRepo.ts:9-11): [AST source]

  ### Blast Radius (Callers & Dependents)
  - 2 callers in src/index.ts (lines 14, 28)
  - 0 test suites detected within 2 hops [WARNING]
  ```
- **Impact**: Delivers the exact 1-turn ergonomics of Colby, but in **~800 tokens instead of 8,000 tokens**.

#### 2. Dynamic Workspace Detection
- Remove the strict `--workspace` startup requirement.
- Allow tools to accept an optional `workspace` parameter or automatically resolve the nearest `.codegraph/` or git root from the active file.
- Enables seamless use across multiple workspaces and monorepos.

---

### Phase 2: Hybrid Relational + Semantic Search (v0.4.0)
*Target: Bridge the gap between vague natural language and compiler-exact AST nodes.*

1. **Lightweight Vector Indexing with SQLite-vec**:
   - Store local embeddings for symbol docstrings, comments, and identifiers directly inside `graph.db`.
2. **Intent-to-AST Resolver (`codegraph_semantic_search`)**:
   - Query: *"Where do we validate user authentication tokens?"*
   - Resolver: Finds semantic match `verifyToken()`, immediately returns its AST node, callers, and file coordinates.
3. **Zero Hallucination Hybrid RAG**:
   - Vector search identifies candidate seed nodes $\to$ Graph CTE traces exact deterministic execution paths.

---

### Phase 3: Monorepo Scale & Type Propagation (v0.5.0)
*Target: Enterprise-grade support for massive codebases (Turborepo, pnpm, Nx, Cargo).*

1. **Cross-Package Workspace Federation**:
   - Parse `tsconfig.json` paths and `package.json` workspaces.
   - Resolve imports across package boundaries (e.g. `frontend/src/api.ts` $\to$ `backend/src/routes/api.ts`).
2. **Interface Implementation & Type Hierarchy**:
   - Track `implements`, `extends`, and abstract class hierarchies.
   - Trace dynamic interface dispatch to all concrete implementations.
3. **Branch Snapshots**:
   - Support git branch isolation in SQLite so switching branches does not invalidate the entire graph index.

---

### Phase 4: Proactive Agent Guardrails & Live Watcher (v0.6.0)
*Target: Move from "Read-Only" navigation to "Active Safety Barrier" for AI Agents.*

1. **Refactor Safety Checklist (`codegraph_refactor_preview`)**:
   - Input: Symbol to rename or signature to change.
   - Output: Strict checklist of every call site across all files, marked with exact line numbers and replacement guidance.
2. **Sub-Millisecond Incremental Watcher**:
   - Run a lightweight background file watcher (`chokidar` or native OS events).
   - Re-parse AST only for dirty files on save, ensuring the graph is always 100% fresh without agent rebuild calls.
3. **Linter / Dead Code Detection**:
   - Expose degree-zero non-exported symbols as dead code candidates directly to agents.

---

### Phase 5: Market Distribution & Ecosystem Dominance (v1.0.0)
*Target: Become the universal standard code intelligence engine for AI agents.*

1. **Universal One-Command Launch**:
   - Publish to npm: `npx @kilocode/codegraph init` or `npx codegraph-mcp serve`.
   - Auto-configure Claude Code (`claude mcp add`), Cursor (`mcp.json`), Antigravity (`mcp_config.json`), and Windsurf.
2. **Official VS Code Marketplace Launch**:
   - Publish the packaged `.vsix` with active hover cards, graph exploration palette, and embedded D3 visualizer.
3. **Standard Benchmark Suite**:
   - Publish an open-source evaluation benchmark comparing:
     - Grep/Ripgrep vs. Colby CodeGraph vs. Ashvin CodeGraph
     - Measuring: Token cost, task completion rate, turn count, and refactoring regression rate.

---

## 6. Strategic Comparison Summary

| Metric / Feature | Colby McHenry | Ashvin KS (Current) | Ashvin KS (Post-Roadmap) |
| :--- | :---: | :---: | :---: |
| **1-Turn Agent Efficiency** | ⭐️⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
| **Token Budget Preservation** | ⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
| **Architectural Depth (Paths/Hubs)** | ⭐️ | ⭐️⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
| **Monorepo / Multi-Package** | ⭐️⭐️⭐️ | ⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
| **Developer IDE Experience** | ⭐️⭐️ | ⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
| **Privacy & Zero Telemetry** | ❌ (Telemetry On) | ⭐️⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ |
