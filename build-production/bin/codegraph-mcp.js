#!/usr/bin/env node
// CodeGraph standalone MCP server — no VS Code, no daemon, no monorepo.
// Opens <workspace>/.codegraph/graph.db (migrates legacy .duckgraph/graph.db)
// and answers all tools in-process over stdio.
import fs from "node:fs/promises";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../src/db.js";
import { GraphRepository } from "../src/repository.js";
import { parseFile, readNodeBody } from "../src/parser.js";
import { languageIdForFile } from "../src/protocol.js";
import { assertInsideWorkspace, normalizeWorkspaceFile } from "../src/fs.js";

const execFileAsync = promisify(execFile);

const SKIP = new Set([
  ".git", ".codegraph", ".duckgraph", "node_modules", "dist", "out",
  "build", "build-production", "target", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", "bin", "obj", ".idea", ".vscode", "coverage"
]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function workspaceRoot() {
  return path.resolve(
    arg("workspace") ?? arg("workspaceRoot") ??
    process.env.CODEGRAPH_WORKSPACE ?? process.env.DUCKGRAPH_WORKSPACE ??
    process.cwd()
  );
}

function resolveDbPath(root) {
  const custom = arg("db") ?? process.env.CODEGRAPH_DB ?? process.env.DUCKGRAPH_DB;
  if (custom) return path.resolve(custom);
  const next = path.join(root, ".codegraph", "graph.db");
  const legacy = path.join(root, ".duckgraph", "graph.db");
  if (!existsSync(next) && existsSync(legacy)) {
    try {
      mkdirSync(path.dirname(next), { recursive: true });
      copyFileSync(legacy, next);
      console.error(`[codegraph] migrated legacy DB ${legacy} -> ${next}`);
    } catch (e) {
      console.error(`[codegraph] legacy DB migrate failed: ${e?.message ?? e}`);
      return legacy;
    }
  }
  return next;
}

let repo = null;
let db = null;
let root = null;

function ensureRepo() {
  if (repo) return repo;
  root = workspaceRoot();
  db = openDatabase(resolveDbPath(root));
  repo = new GraphRepository(db, root);
  return repo;
}

async function getCommitHash(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, windowsHide: true });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function getDirtyFiles(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir, windowsHide: true });
    const files = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const filePath = trimmed.slice(2).trim();
      if (filePath) files.push(filePath);
    }
    return files;
  } catch {
    return [];
  }
}

function clampLine(content, line) {
  const total = content.split(/\r?\n/).length;
  return Math.max(1, Math.min(line, Math.max(1, total)));
}

async function readWorkspaceFile(file) {
  const r = ensureRepo();
  const abs = assertInsideWorkspace(r.workspaceRoot, file);
  return fs.readFile(abs, "utf8");
}

function slidingWindow(content, line) {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const c = Math.max(1, Math.min(total, line));
  const s = Math.max(0, c - 1 - 10);
  const e = Math.min(total - 1, c - 1 + 10);
  return { lineStart: s + 1, lineEnd: e + 1, text: lines.slice(s, e + 1).join("\n") };
}

async function boundedSource(file, line, budget = 1500) {
  try {
    const content = await readWorkspaceFile(file);
    const clamped = clampLine(content, line);
    const snippet = readNodeBody(file, content, clamped);
    let ls, le, text;
    if (snippet) ({ lineStart: ls, lineEnd: le, text } = snippet);
    else ({ lineStart: ls, lineEnd: le, text } = slidingWindow(content, clamped));
    return { file, line_start: ls, line_end: le, text: text.length > budget ? `${text.slice(0, budget)}\n...[truncated]` : text };
  } catch {
    return null;
  }
}

function diagnoseMissingSymbol(r, symbol, file, line) {
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.join(r.workspaceRoot, file);
    if (!existsSync(abs)) {
      return {
        target_symbol: null,
        stale_state: "FILE_NOT_FOUND",
        error_code: "FILE_NOT_FOUND",
        summary: `File does not exist on disk: ${file}. Tip: verify path or use codegraph_search_symbols to find files.`
      };
    }
    const ext = path.extname(file).toLowerCase();
    const nonAstExts = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".png", ".jpg", ".svg", ".lock"]);
    if (nonAstExts.has(ext)) {
      return {
        target_symbol: null,
        stale_state: "NON_AST_LANGUAGE",
        error_code: "NON_AST_LANGUAGE",
        summary: `File "${file}" (${ext}) is not an AST-parsed source language. CodeGraph parses TypeScript, JavaScript, Rust, Python, Go, C++, etc.`
      };
    }
  }
  if (symbol) {
    const similar = r.searchSymbols(symbol.slice(0, Math.min(4, symbol.length)), undefined, 5);
    const suggestions = similar.map((s) => `${s.name} (${s.file})`).join(", ");
    return {
      target_symbol: null,
      stale_state: "SYMBOL_NOT_FOUND",
      error_code: "SYMBOL_NOT_FOUND",
      summary: `Symbol "${symbol}" was not found in indexed files.` + (suggestions ? ` Did you mean: ${suggestions}?` : " Try codegraph_search_symbols or run codegraph_index_workspace.")
    };
  }
  return {
    target_symbol: null,
    stale_state: "UNINDEXED",
    error_code: "UNINDEXED",
    summary: "CodeGraph has not indexed this target. Run codegraph_index_workspace first, then retry."
  };
}

function fallbackSummary(subgraph, source, hoveredFile) {
  if (!subgraph.target) {
    return "CodeGraph has not indexed this symbol yet. Call codegraph_index_workspace first, then retry.";
  }
  const t = subgraph.target;
  const calls = subgraph.directional?.calls ?? [];
  const calledBy = subgraph.directional?.called_by ?? [];

  const callList = calls.length === 0
    ? "no outgoing calls"
    : `calls ${calls.slice(0, 3).map((e) => e.target_name).join(", ")}${calls.length > 3 ? ` (+${calls.length - 3} more)` : ""}`;
  const callerList = calledBy.length === 0
    ? ""
    : `; called by ${calledBy.slice(0, 3).map((e) => e.source_name).join(", ")}${calledBy.length > 3 ? ` (+${calledBy.length - 3} more)` : ""}`;

  const src = source ? ` Source was read from lines ${source.line_start}-${source.line_end}.` : "";
  const stale = t.freshness === "STALE" ? `\nWarning: this context is stale${t.stale_reason ? ` (${t.stale_reason})` : ""}.` : "";
  const where = hoveredFile && normalizeWorkspaceFile(root ?? workspaceRoot(), hoveredFile) === t.file
    ? "locally in this file" : `in ${t.file}`;
  return `${t.name} is a ${t.kind} defined ${where}; ${callList}${callerList}.${src}${stale}`;
}

function guidanceFor(subgraph) {
  if (subgraph.freshness === "UNINDEXED") return "UNINDEXED: call codegraph_index_workspace first, then retry.";
  if (subgraph.freshness === "STALE") {
    return `STALE${subgraph.target?.stale_reason ? `: ${subgraph.target.stale_reason}` : ""} — hedge structural claims and prefer re-reading source.`;
  }
  const totalEdges = (subgraph.directional?.calls?.length ?? 0) + (subgraph.directional?.called_by?.length ?? 0);
  if (totalEdges === 0) return "No verified edges yet — use bounded_source_excerpt for implementation detail only; do not invent callers/callees.";
  return "Use calls and called_by for ALL structural claims (what calls what). Never state a relationship not in the graph.";
}

function formatExplainResult(result, format = "compact") {
  if (!result || !result.target_symbol) {
    return JSON.stringify(result, null, 2);
  }
  const sym = result.target_symbol;
  const calls = result.calls ?? [];
  const calledBy = result.called_by ?? [];

  if (format === "mermaid") {
    const lines = [
      "```mermaid",
      "graph LR",
      `  classDef curr fill:#2563eb,color:#fff,stroke:#1d4ed8,stroke-width:2px;`,
      `  CURR["${sym.name} (${sym.kind})"]:::curr`
    ];
    for (const c of calls.slice(0, 10)) {
      const safe = c.target_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  CURR -->|calls| ${safe}["${c.target_name}"]`);
    }
    for (const cb of calledBy.slice(0, 10)) {
      const safe = cb.source_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${safe}["${cb.source_name}"] -->|calls| CURR`);
    }
    lines.push("```");
    if (result.bounded_source_excerpt) {
      lines.push(`\n**Source excerpt** (${sym.file}:${result.bounded_source_excerpt.line_start}-${result.bounded_source_excerpt.line_end}):\n\`\`\`\n${result.bounded_source_excerpt.text}\n\`\`\``);
    }
    lines.push(`\n> **Summary**: ${result.summary}`);
    return lines.join("\n");
  }

  if (format === "compact") {
    let text = `${sym.name}() [${sym.kind}] ${sym.file}:${sym.line_start}-${sym.line_end}\n`;
    if (calls.length) {
      text += `  -> calls: ${calls.map((c) => c.target_name).join(", ")}\n`;
    }
    if (calledBy.length) {
      text += `  <- called_by: ${calledBy.map((c) => `${c.source_name} (${c.source_file}:${c.line_start})`).join(", ")}\n`;
    }
    if (result.bounded_source_excerpt) {
      text += `\n--- Source (${result.bounded_source_excerpt.line_start}-${result.bounded_source_excerpt.line_end}) ---\n${result.bounded_source_excerpt.text}\n`;
    }
    text += `\nSummary: ${result.summary}`;
    return text;
  }

  return JSON.stringify({
    target_symbol: sym,
    calls: calls.map((c) => ({ target_name: c.target_name, file: c.target_file, line: c.line_start, type: c.type })),
    called_by: calledBy.map((c) => ({ source_name: c.source_name, file: c.source_file, line: c.line_start, type: c.type })),
    stale_state: result.stale_state,
    summary: result.summary,
    usage_guidance: result.usage_guidance,
    bounded_source_excerpt: result.bounded_source_excerpt
  }, null, 2);
}

function formatSubgraphResult(sub, format = "compact") {
  if (!sub || !sub.target) return JSON.stringify(sub, null, 2);
  const t = sub.target;
  const calls = sub.directional?.calls ?? [];
  const calledBy = sub.directional?.called_by ?? [];

  if (format === "mermaid") {
    const lines = ["```mermaid", "graph LR", `  CURR["${t.name} (${t.kind})"]`];
    for (const c of calls.slice(0, 10)) {
      const safe = c.target_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  CURR -->|calls| ${safe}["${c.target_name}"]`);
    }
    for (const cb of calledBy.slice(0, 10)) {
      const safe = cb.source_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${safe}["${cb.source_name}"] -->|calls| CURR`);
    }
    lines.push("```");
    return lines.join("\n");
  }

  if (format === "compact") {
    let text = `Symbol: ${t.name} (${t.kind}) in ${t.file}:${t.line_start}-${t.line_end} [${t.freshness}]\n`;
    if (calls.length) text += `  -> calls (${calls.length}): ${calls.map((c) => c.target_name).join(", ")}\n`;
    if (calledBy.length) text += `  <- called_by (${calledBy.length}): ${calledBy.map((c) => c.source_name).join(", ")}\n`;
    text += `Total nodes: ${sub.nodes.length}, verified edges: ${sub.edges.length}`;
    return text;
  }

  return JSON.stringify(sub, null, 2);
}

async function collectFiles(maxFiles, fileFilter = null) {
  const r = ensureRepo();
  if (fileFilter && fileFilter.length > 0) {
    const results = [];
    for (const rel of fileFilter) {
      const full = path.isAbsolute(rel) ? rel : path.join(r.workspaceRoot, rel);
      if (existsSync(full) && languageIdForFile(full)) {
        const content = await fs.readFile(full, "utf8").catch(() => null);
        if (content !== null) results.push({ file: full, content });
      }
    }
    return results;
  }

  const results = [];
  const stack = [r.workspaceRoot];
  while (stack.length && results.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name.toLowerCase())) stack.push(full);
      } else if (entry.isFile() && languageIdForFile(full)) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 1_000_000) continue;
        const content = await fs.readFile(full, "utf8").catch(() => null);
        if (content !== null) results.push({ file: full, content });
      }
    }
  }
  return results;
}

async function indexWorkspace(args) {
  const r = ensureRepo();
  const maxFiles = typeof args.max_files === "number" && args.max_files > 0 ? Math.min(5000, Math.floor(args.max_files)) : 1000;
  if (args.force_reindex === true) r.clearGraphCache();

  let fileFilter = null;
  if (args.dirty_only === true) {
    fileFilter = await getDirtyFiles(r.workspaceRoot);
    if (fileFilter.length === 0) {
      return { workspace_root: r.workspaceRoot, indexed_files: 0, nodes: 0, edges: 0, message: "No git dirty files found; index is up to date." };
    }
  }

  const files = await collectFiles(maxFiles, fileFilter);
  const commitHash = await getCommitHash(r.workspaceRoot);
  let nodes = 0, edges = 0;
  for (const f of files) {
    const parsed = parseFile(f.file, f.content);
    if (!parsed || (parsed.nodes.length === 0 && f.content.trim().length > 0)) continue;
    try {
      const res = r.upsertFileIndex(f.file, parsed.nodes, parsed.edges, commitHash);
      nodes += res.nodes;
      edges += res.edges;
    } catch { /* skip bad files, keep going */ }
  }
  return {
    workspace_root: r.workspaceRoot,
    commit_hash: commitHash,
    indexed_files: files.length,
    nodes,
    edges,
    max_files: maxFiles,
    truncated: files.length > maxFiles
  };
}

function textResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

function symbolSchema() {
  return {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name (e.g. 'activate', 'createApp'). When provided, CodeGraph searches across workspace automatically." },
      file: { type: "string", description: "Optional file path. Workspace-relative or absolute." },
      line: { type: "integer", minimum: 1, description: "Optional 1-based line number." },
      format: { type: "string", enum: ["compact", "mermaid", "json"], description: "Output format: 'compact' (token-saving text, default), 'mermaid' (diagram), or 'json' (clean JSON)." },
      depth: { type: "integer", minimum: 0, maximum: 2, description: "Traversal depth 0-2, default 1." },
      max_edges: { type: "integer", minimum: 1, maximum: 60, description: "Max edges, default 8." },
      source_budget: { type: "integer", minimum: 1, maximum: 8000, description: "Max source excerpt chars, default 1500." }
    },
    additionalProperties: false
  };
}

const primaryTools = [
  {
    name: "codegraph_overview",
    description: "[Step 1 - Start Here] High-level architectural map of the codebase. Detects entrypoints (main, activate, createApp), degree-centrality hub symbols with the most callers/callees, languages, and index stats. Call this FIRST when exploring any unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: {
        top_n: { type: "integer", minimum: 1, maximum: 50, description: "Number of top hub symbols to return, default 10." }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_search_symbols",
    description: "[Step 2 - Find Symbols] Fast search for symbol names across the entire workspace. Returns symbol names, kinds (function/class/interface), files, and line numbers. Use when you need to find where something is defined without knowing the file.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring or symbol name to search for." },
        kind: { type: "string", description: "Optional filter by kind ('function', 'class', 'interface', 'variable')." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results, default 20." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_explain_symbol",
    description: "[Step 3 - Understand Code] Deep symbol inspection. Returns verified calls (outgoing), callers (incoming), AST-bounded source excerpt, and grounded summary. Can be queried by symbol name alone, or file+line. Supports format='compact' (token-saving), 'mermaid' (diagram), or 'json'.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_query_subgraph",
    description: "[Step 3b - Relationship Graph] Return relationship graph for a symbol showing callers, callees, and type dependencies. Supports format='compact', 'mermaid', or 'json'.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_impact_analysis",
    description: "[Step 4 - Pre-Edit Safety] Blast radius analysis. Traces all direct and indirect downstream dependents and callers up to N hops away. Run this BEFORE editing or refactoring a function to know what might break.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name to analyze (e.g. 'WorkspaceIndexer')." },
        file: { type: "string", description: "Optional file path if symbol is ambiguous." },
        max_depth: { type: "integer", minimum: 1, maximum: 5, description: "Traversal depth, default 3." }
      },
      required: ["symbol"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_find_path",
    description: "[Architecture Explorer] Shortest call-chain path connecting from_symbol to to_symbol. Explains how execution flows from one component to another (e.g., from 'activate' to 'createApp').",
    inputSchema: {
      type: "object",
      properties: {
        from_symbol: { type: "string", description: "Starting symbol name." },
        to_symbol: { type: "string", description: "Destination symbol name." },
        max_depth: { type: "integer", minimum: 1, maximum: 8, description: "Maximum search hops, default 6." }
      },
      required: ["from_symbol", "to_symbol"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_read_source_node",
    description: "Return ONLY the AST-bounded source excerpt for a symbol. Can query by symbol name alone, or file+line.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_index_workspace",
    description: "[Maintenance / Re-indexing] Index or update the code graph. Set dirty_only=true to quickly index only git-modified files after making code changes. force_reindex=true rebuilds from scratch.",
    inputSchema: {
      type: "object",
      properties: {
        max_files: { type: "integer", minimum: 1, maximum: 5000, description: "Max files to index, default 1000." },
        force_reindex: { type: "boolean", description: "Set true to wipe graph and rebuild from scratch." },
        dirty_only: { type: "boolean", description: "Set true to quickly index only git-modified/untracked files." }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_health",
    description: "Diagnostic check. Returns ok, workspace_root, indexedFiles, indexedNodes, and dbPath.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "codegraph_confirm_edge",
    description: "Confirm an edge id from query/explain so future answers treat it as verified.",
    inputSchema: { type: "object", properties: { edge_id: { type: "integer", minimum: 1 } }, required: ["edge_id"], additionalProperties: false }
  },
  {
    name: "codegraph_dismiss_edge",
    description: "Dismiss an edge id so future answers exclude it.",
    inputSchema: { type: "object", properties: { edge_id: { type: "integer", minimum: 1 } }, required: ["edge_id"], additionalProperties: false }
  }
];

const tools = primaryTools;

const server = new Server({ name: "codegraph", version: "0.2.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (msg) => {
  const args = msg.params.arguments ?? {};
  try {
    const r = ensureRepo();
    const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
    const format = args.format || "compact";

    switch (msg.params.name) {
      case "codegraph_health": {
        const s = r.stats();
        return textResult({ ok: true, workspace_root: r.workspaceRoot, indexedFiles: s.indexedFiles, indexedNodes: s.indexedNodes, dbPath: resolveDbPath(r.workspaceRoot) });
      }
      case "codegraph_overview": {
        const overview = r.getOverview(num(args.top_n, 10));
        if (format === "compact") {
          let text = `=== CodeGraph Overview for ${r.workspaceRoot} ===\n`;
          text += `Files: ${overview.stats.indexedFiles}, Nodes: ${overview.stats.indexedNodes}, Relationships: ${overview.stats.totalEdges}\n`;
          text += `Languages: ${Object.entries(overview.languages).map(([ext, count]) => `${ext} (${count})`).join(", ")}\n\n`;
          text += `Detected Entrypoints:\n`;
          for (const ep of overview.entrypoints) {
            text += `  - ${ep.name}() [${ep.kind}] in ${ep.file}:${ep.line_start}\n`;
          }
          text += `\nCentral Hubs (symbols with most callers/callees):\n`;
          for (const hub of overview.central_hubs) {
            text += `  - ${hub.name}() in ${hub.file}:${hub.line_start} (calls: ${hub.out_degree}, called_by: ${hub.in_degree})\n`;
          }
          text += `\nRecommended next steps:\n`;
          text += `  1. Call codegraph_explain_symbol(symbol: "<name>") to inspect any hub or entrypoint.\n`;
          text += `  2. Call codegraph_search_symbols(query: "<name>") to search specific functions.\n`;
          return textResult(text);
        }
        return textResult(overview);
      }
      case "codegraph_search_symbols": {
        const matches = r.searchSymbols(String(args.query), args.kind, num(args.limit, 20));
        if (format === "compact") {
          if (matches.length === 0) return textResult(`No symbols matching "${args.query}" found.`);
          let text = `Found ${matches.length} symbol(s) matching "${args.query}":\n`;
          for (const m of matches) {
            text += `  - ${m.name} (${m.kind}) in ${m.file}:${m.line_start}-${m.line_end}\n`;
          }
          return textResult(text);
        }
        return textResult(matches);
      }
      case "codegraph_impact_analysis": {
        const impact = r.getImpactAnalysis(String(args.symbol), args.file, num(args.max_depth, 3));
        if (!impact) {
          return textResult(diagnoseMissingSymbol(r, args.symbol, args.file));
        }
        if (format === "compact") {
          let text = `=== Impact Analysis (Blast Radius) for ${impact.target.name} ===\n`;
          text += `Location: ${impact.target.file}:${impact.target.line_start}-${impact.target.line_end}\n`;
          text += `Dependents found: ${impact.dependents_count}\n`;
          if (impact.dependents.length === 0) {
            text += `  (No incoming callers found; safe to refactor/edit without downstream breakages.)\n`;
          } else {
            text += `Downstream Callers / Dependents:\n`;
            for (const d of impact.dependents) {
              text += `  [depth ${d.depth}] ${d.chain} (${d.file}:${d.line_start})\n`;
            }
          }
          return textResult(text);
        }
        return textResult(impact);
      }
      case "codegraph_find_path": {
        const pathRes = r.findShortestPath(String(args.from_symbol), String(args.to_symbol), num(args.max_depth, 6));
        if (format === "compact") {
          if (!pathRes.found) {
            return textResult(`Path search failed: ${pathRes.reason}`);
          }
          let text = `=== Call Path: ${args.from_symbol} -> ${args.to_symbol} (hops: ${pathRes.depth}) ===\n`;
          text += `Path: ${pathRes.path_string}\n`;
          return textResult(text);
        }
        return textResult(pathRes);
      }
      case "codegraph_index_workspace":
      case "duckgraph_index_workspace":
        return textResult(await indexWorkspace(args));
      case "codegraph_query_subgraph":
      case "duckgraph_query_subgraph": {
        const line = args.line ? num(args.line, 1) : undefined;
        const sub = r.querySubgraph(args.symbol, args.file, line, Math.min(num(args.depth, 1), 2), Math.min(num(args.max_edges, 8), 60));
        if (!sub.target) {
          return textResult(diagnoseMissingSymbol(r, args.symbol, args.file, args.line));
        }
        return textResult(formatSubgraphResult(sub, format));
      }
      case "codegraph_read_source_node":
      case "duckgraph_read_source_node": {
        const line = args.line ? num(args.line, 1) : undefined;
        const sub = r.querySubgraph(args.symbol, args.file, line, 0, 1);
        if (!sub.target) {
          return textResult(diagnoseMissingSymbol(r, args.symbol, args.file, args.line));
        }
        const t = sub.target;
        const src = await boundedSource(t.file, t.line_start, num(args.source_budget, 1500));
        return textResult({
          target_symbol: { name: t.name, kind: t.kind, file: t.file, line_start: t.line_start, line_end: t.line_end, freshness: t.freshness, stale_reason: t.stale_reason },
          bounded_source_excerpt: src,
          stale_state: sub.freshness
        });
      }
      case "codegraph_explain_symbol":
      case "duckgraph_explain_symbol": {
        const line = args.line ? num(args.line, 1) : undefined;
        const sub = r.querySubgraph(args.symbol, args.file, line, Math.min(num(args.depth, 1), 2), Math.min(num(args.max_edges, 8), 60));
        if (!sub.target) {
          return textResult(diagnoseMissingSymbol(r, args.symbol, args.file, args.line));
        }
        const t = sub.target;
        const src = await boundedSource(t.file, t.line_start, num(args.source_budget, 1500));
        const summary = fallbackSummary(sub, src, args.file);
        const guidance = guidanceFor(sub);
        const result = {
          target_symbol: sub.target,
          calls: sub.directional?.calls ?? [],
          called_by: sub.directional?.called_by ?? [],
          stale_state: sub.freshness,
          bounded_source_excerpt: src,
          summary,
          usage_guidance: guidance
        };
        return textResult(formatExplainResult(result, format));
      }
      case "codegraph_confirm_edge":
      case "duckgraph_confirm_edge":
        r.confirmEdge(num(args.edge_id, 0));
        return textResult({ ok: true, result: "confirmed" });
      case "codegraph_dismiss_edge":
      case "duckgraph_dismiss_edge":
        r.dismissEdge(num(args.edge_id, 0));
        return textResult({ ok: true, result: "dismissed" });
      default:
        throw new Error(`Unknown CodeGraph tool: ${msg.params.name}`);
    }
  } catch (error) {
    return {
      ...textResult({
        error: error instanceof Error ? error.message : String(error),
        hint: "If UNINDEXED: call codegraph_index_workspace first, then retry. If file escapes workspace: pass a path inside CODEGRAPH_WORKSPACE."
      }),
      isError: true
    };
  }
});

await server.connect(new StdioServerTransport());
