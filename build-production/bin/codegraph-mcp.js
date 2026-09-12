#!/usr/bin/env node
// Standalone CodeGraph MCP server over stdio.
// Exposes the 3-Tier Code Intelligence Suite:
// - Tier 1: Macro (Architecture, Entrypoints, Hubs, Call-Paths)
// - Tier 2: Meso (1-Turn Composite Context Slicing: target + callers + callees)
// - Tier 3: Micro (Surgical inspections, blast radius, edge curation)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../src/db.js";
import { GraphRepository } from "../src/repository.js";
import { parseFile, readNodeBody } from "../src/parser.js";
import { languageIdForFile } from "../src/protocol.js";

const execFileAsync = promisify(execFile);

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

function defaultWorkspaceRoot() {
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

// Multi-Workspace Connection Pool: rootPath -> { repo, db, root }
const repoPool = new Map();

function findWorkspaceRoot(explicitWorkspace, fileHint) {
  if (explicitWorkspace) return path.resolve(explicitWorkspace);
  if (fileHint) {
    let current = path.resolve(fileHint);
    try {
      if (existsSync(current) && statSync(current).isFile()) {
        current = path.dirname(current);
      }
    } catch {}
    while (true) {
      if (existsSync(path.join(current, ".codegraph", "graph.db")) ||
          existsSync(path.join(current, ".duckgraph", "graph.db")) ||
          existsSync(path.join(current, ".git"))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return defaultWorkspaceRoot();
}

function ensureRepo(explicitWorkspace, fileHint) {
  const root = findWorkspaceRoot(explicitWorkspace, fileHint);
  let entry = repoPool.get(root);
  if (!entry) {
    const dbPath = resolveDbPath(root);
    const db = openDatabase(dbPath);
    const repo = new GraphRepository(db, root);
    entry = { repo, db, root };
    repoPool.set(root, entry);
  }
  return entry.repo;
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
    const lines = stdout.split(/\r?\n/);
    const files = [];
    for (const line of lines) {
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

async function readWorkspaceFile(file, r) {
  const repoInstance = r ?? ensureRepo();
  const abs = assertInsideWorkspace(repoInstance.workspaceRoot, file);
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

async function boundedSource(file, line, budget = 1500, r) {
  try {
    const content = await readWorkspaceFile(file, r);
    const clamped = clampLine(content, line);
    const snippet = await readNodeBody(file, content, clamped);
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
    const normalized = path.resolve(r.workspaceRoot, file);
    if (!existsSync(normalized)) {
      return `FILE_NOT_FOUND: The file "${file}" does not exist in workspace "${r.workspaceRoot}". Check the path or call codegraph_search_symbols to find where the symbol lives.`;
    }
    const lang = languageIdForFile(file);
    if (!lang) {
      return `NON_AST_LANGUAGE: The file "${file}" is not an AST-parseable source file (e.g. Markdown, JSON, configs). CodeGraph tracks structural code symbols.`;
    }
    const row = r.db.prepare("SELECT COUNT(*) AS c FROM code_nodes WHERE file = ? AND tombstoned = 0").get(file);
    if (!row || row.c === 0) {
      return `UNINDEXED: The file "${file}" is currently not indexed in graph.db. Run codegraph_index_workspace to index this file.`;
    }
  }
  if (symbol) {
    const suggestions = r.db.prepare("SELECT name, kind, file, line_start FROM code_nodes WHERE tombstoned = 0 AND name LIKE ? LIMIT 5").all(`%${symbol}%`);
    if (suggestions.length > 0) {
      const formatted = suggestions.map((s) => `  - ${s.name} (${s.kind}) in ${s.file}:${s.line_start}`).join("\n");
      return `SYMBOL_NOT_FOUND: Symbol "${symbol}" was not found${file ? ` in ${file}` : ""}. Did you mean one of these?\n${formatted}`;
    }
  }
  const stats = r.stats();
  if (stats.indexedFiles === 0) {
    return `UNINDEXED: The workspace "${r.workspaceRoot}" has 0 indexed files. Call codegraph_index_workspace first to build the structural code graph.`;
  }
  return `SYMBOL_NOT_FOUND: No symbol matching "${symbol || (file + ":" + line)}" was found in the indexed codebase (${stats.indexedFiles} files, ${stats.indexedNodes} nodes). Use codegraph_search_symbols to find available symbols.`;
}

function assertInsideWorkspace(root, file) {
  const resolved = path.resolve(root, file);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`File escapes workspace: ${file}`);
  }
  return resolved;
}

function fallbackSummary(sub, src, fileHint) {
  const t = sub.target;
  const calls = sub.directional?.calls ?? [];
  const calledBy = sub.directional?.called_by ?? [];
  const name = t.name ?? "Target";
  const kind = t.kind ?? "symbol";
  const file = t.file ?? fileHint ?? "file";
  const line = t.line_start ? `:${t.line_start}` : "";

  let s = `${name} is a ${kind} declared in ${file}${line}.`;
  if (calls.length > 0) {
    const list = calls.slice(0, 4).map((c) => c.target_name).join(", ");
    s += ` It calls ${list}${calls.length > 4 ? ` and ${calls.length - 4} others` : ""}.`;
  }
  if (calledBy.length > 0) {
    const list = calledBy.slice(0, 4).map((c) => c.source_name).join(", ");
    s += ` It is called by ${list}${calledBy.length > 4 ? ` and ${calledBy.length - 4} others` : ""}.`;
  }
  if (t.stale_reason) s += ` Note: ${t.stale_reason}.`;
  return s;
}

function guidanceFor(sub) {
  const t = sub.target;
  const calls = sub.directional?.calls ?? [];
  const calledBy = sub.directional?.called_by ?? [];
  const g = [];
  if (calledBy.length > 0) {
    g.push(`Before modifying ${t.name}, check downstream impact on: ${calledBy.slice(0, 3).map((c) => c.source_name).join(", ")}`);
  }
  if (calls.length > 0) {
    g.push(`Relies on: ${calls.slice(0, 3).map((c) => c.target_name).join(", ")}`);
  }
  return g;
}

function formatExplainResult(result, format) {
  const sym = result.target_symbol;
  const calls = result.calls || [];
  const calledBy = result.called_by || [];

  if (format === "mermaid") {
    const lines = ["```mermaid", "graph TD"];
    const currSafe = sym.name.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`  CURR["${sym.name} (${sym.kind})"]:::current`);
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
      text += `  <- called by: ${calledBy.map((c) => c.source_name).join(", ")}\n`;
    }
    if (result.bounded_source_excerpt) {
      text += `\n[SOURCE EXCERPT]\n${result.bounded_source_excerpt.text}\n`;
    }
    text += `\nSummary: ${result.summary}`;
    return text;
  }

  return result;
}

function formatSubgraphResult(sub, format) {
  const sym = sub.target;
  const calls = sub.directional?.calls || [];
  const calledBy = sub.directional?.called_by || [];

  if (format === "compact") {
    let text = `=== Subgraph for ${sym.name} (${sym.file}:${sym.line_start}) ===\n`;
    text += `Outgoing calls (${calls.length}): ${calls.map((c) => c.target_name).join(", ") || "none"}\n`;
    text += `Incoming callers (${calledBy.length}): ${calledBy.map((c) => c.source_name).join(", ") || "none"}\n`;
    return text;
  }

  if (format === "mermaid") {
    const lines = ["```mermaid", "graph LR"];
    const currSafe = sym.name.replace(/[^a-zA-Z0-9_]/g, "_");
    for (const c of calls) {
      const safe = c.target_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${currSafe} --> ${safe}`);
    }
    for (const cb of calledBy) {
      const safe = cb.source_name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${safe} --> ${currSafe}`);
    }
    lines.push("```");
    return lines.join("\n");
  }

  return sub;
}

const SKIP = new Set([
  "node_modules", ".git", ".codegraph", ".duckgraph", "dist", "build", "out",
  ".next", ".svelte-kit", "target", "vendor", "__pycache__", ".venv"
]);

async function collectFiles(maxFiles = 1000, fileFilter = null, r = ensureRepo()) {
  if (fileFilter && Array.isArray(fileFilter)) {
    const results = [];
    for (const rel of fileFilter) {
      if (results.length >= maxFiles) break;
      const full = path.resolve(r.workspaceRoot, rel);
      if (languageIdForFile(full)) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 1_000_000) continue;
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

async function indexWorkspace(args, r = ensureRepo(args.workspace)) {
  const maxFiles = typeof args.max_files === "number" && args.max_files > 0 ? Math.min(5000, Math.floor(args.max_files)) : 1000;
  if (args.force_reindex === true) r.clearGraphCache();

  let fileFilter = null;
  if (args.dirty_only === true) {
    fileFilter = await getDirtyFiles(r.workspaceRoot);
    if (fileFilter.length === 0) {
      return { workspace_root: r.workspaceRoot, indexed_files: 0, nodes: 0, edges: 0, message: "No git dirty files found; index is up to date." };
    }
  }

  const files = await collectFiles(maxFiles, fileFilter, r);
  const commitHash = await getCommitHash(r.workspaceRoot);
  let nodes = 0, edges = 0;
  for (const f of files) {
    const parsed = await parseFile(f.file, f.content);
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

const server = new Server(
  { name: "codegraph", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

function num(val, fallback) {
  return typeof val === "number" && !isNaN(val) ? val : fallback;
}

function symbolSchema() {
  return {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name to look up globally across the indexed codebase (e.g. 'createApp', 'CodeParser')." },
      file: { type: "string", description: "Path to file inside workspace. Optional if symbol is specified." },
      line: { type: "integer", minimum: 1, description: "1-based line number. Optional if symbol is specified." },
      workspace: { type: "string", description: "Optional workspace root directory override." },
      format: { type: "string", enum: ["compact", "mermaid", "json"], description: "Output format, default 'compact'." },
      source_budget: { type: "integer", minimum: 100, maximum: 8000, description: "Max characters of source code to return, default 1500." }
    },
    additionalProperties: false
  };
}

const primaryTools = [
  {
    name: "codegraph_overview",
    description: "[Tier 1: Macro - Start Here] High-level architectural map of the codebase. Detects entrypoints (main, activate, createApp), degree-centrality hub symbols with the most callers/callees, languages, and index stats. Call this FIRST when exploring any unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional workspace root directory override." },
        top_n: { type: "integer", minimum: 1, maximum: 50, description: "Number of top hub symbols to return, default 10." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format, default 'compact'." }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_search_symbols",
    description: "[Tier 3: Find Symbols] Fast degree-centrality ranked search for symbol names across the entire workspace. Returns symbol names, kinds (function/class/interface), files, and line numbers. Common keywords surface architectural hubs first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring or symbol name to search for." },
        kind: { type: "string", description: "Optional filter by kind ('function', 'class', 'interface', 'variable')." },
        workspace: { type: "string", description: "Optional workspace root directory override." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results, default 20." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format, default 'compact'." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_context_slice",
    description: "[Tier 2: Meso - Daily Driver / 1-Turn Answer] Returns the complete context cluster in 1 single turn: AST-bounded source of the target symbol + AST-bounded sources of its top callers and callees (just the functions, NOT entire files!) + blast radius impact summary + mini Mermaid diagram (~800-1200 tokens). Eliminates multi-turn tool calling.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Target symbol name to inspect." },
        file: { type: "string", description: "Optional file path if symbol name is ambiguous." },
        workspace: { type: "string", description: "Optional workspace root directory override." },
        max_callees: { type: "integer", minimum: 1, maximum: 10, description: "Max direct dependencies (callees) to excerpt, default 3." },
        max_callers: { type: "integer", minimum: 1, maximum: 10, description: "Max callers to excerpt, default 2." },
        format: { type: "string", enum: ["compact", "mermaid", "json"], description: "Output format, default 'compact'." }
      },
      required: ["symbol"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_explain_symbol",
    description: "[Tier 3: Understand Code] Deep symbol inspection. Returns verified calls (outgoing), callers (incoming), AST-bounded source excerpt, and grounded summary. Can be queried by symbol name alone, or file+line. Supports format='compact' (token-saving), 'mermaid' (diagram), or 'json'.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_query_subgraph",
    description: "[Tier 3: Relationship Graph] Return relationship graph for a symbol showing callers, callees, and type dependencies. Supports format='compact', 'mermaid', or 'json'.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_impact_analysis",
    description: "[Tier 3: Pre-Edit Safety] Blast radius analysis. Traces all direct and indirect downstream dependents and callers up to N hops away. Run this BEFORE editing or refactoring a function to know what might break.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name to analyze (e.g. 'WorkspaceIndexer')." },
        file: { type: "string", description: "Optional file path if symbol is ambiguous." },
        workspace: { type: "string", description: "Optional workspace root directory override." },
        max_depth: { type: "integer", minimum: 1, maximum: 5, description: "Traversal depth, default 3." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format, default 'compact'." }
      },
      required: ["symbol"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_find_path",
    description: "[Tier 1: Architecture Explorer] Shortest call-chain path connecting from_symbol to to_symbol. Explains how execution flows from one component to another (e.g., from 'activate' to 'createApp').",
    inputSchema: {
      type: "object",
      properties: {
        from_symbol: { type: "string", description: "Starting symbol name." },
        to_symbol: { type: "string", description: "Destination symbol name." },
        workspace: { type: "string", description: "Optional workspace root directory override." },
        max_depth: { type: "integer", minimum: 1, maximum: 8, description: "Maximum search hops, default 6." },
        format: { type: "string", enum: ["compact", "json"], description: "Output format, default 'compact'." }
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
    description: "Build or update the SQLite structural graph for the workspace using 100% pure Tree-Sitter WASM. Supports incremental indexing via dirty_only: true.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional workspace root directory override." },
        force_reindex: { type: "boolean", description: "Wipe graph.db and re-index all files from scratch, default false." },
        dirty_only: { type: "boolean", description: "Index only files modified in git (git status --porcelain), default false." },
        max_files: { type: "integer", minimum: 1, maximum: 5000, description: "Max files to process, default 1000." }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_health",
    description: "Check health of the CodeGraph database, indexed scope, and pooled workspaces.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional workspace root directory override." }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_confirm_edge",
    description: "Human/agent feedback loop: confirm an inferred code edge as ground-truth verified.",
    inputSchema: {
      type: "object",
      properties: {
        edge_id: { type: "integer", description: "ID of edge to confirm." },
        workspace: { type: "string", description: "Optional workspace root directory override." }
      },
      required: ["edge_id"],
      additionalProperties: false
    }
  },
  {
    name: "codegraph_dismiss_edge",
    description: "Human/agent feedback loop: dismiss a false-positive inferred code edge.",
    inputSchema: {
      type: "object",
      properties: {
        edge_id: { type: "integer", description: "ID of edge to dismiss." },
        workspace: { type: "string", description: "Optional workspace root directory override." }
      },
      required: ["edge_id"],
      additionalProperties: false
    }
  }
];

function tools() {
  return primaryTools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools()
}));

function textResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

server.setRequestHandler(CallToolRequestSchema, async (msg) => {
  const name = msg.params.name;
  const args = msg.params.arguments ?? {};
  const r = ensureRepo(args.workspace, args.file);
  const format = args.format ?? "compact";

  try {
    switch (name) {
      case "codegraph_health":
      case "duckgraph_health": {
        const stats = r.stats();
        const edges = r.db.prepare("SELECT COUNT(*) AS c FROM code_edges WHERE dismissed = 0").get()?.c ?? 0;
        return textResult({
          ok: true,
          workspace_root: r.workspaceRoot,
          active_pooled_workspaces: repoPool.size,
          indexedFiles: stats.indexedFiles,
          indexedNodes: stats.indexedNodes,
          totalEdges: edges,
          dbPath: resolveDbPath(r.workspaceRoot)
        });
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
          text += `  1. Call codegraph_context_slice(symbol: "<name>") to inspect target + callers + callees in 1 turn.\n`;
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
      case "codegraph_context_slice": {
        const symbol = String(args.symbol || "");
        const slice = r.getContextSlice(symbol, args.file, {
          maxCallees: typeof args.max_callees === "number" ? args.max_callees : 3,
          maxCallers: typeof args.max_callers === "number" ? args.max_callers : 2
        });
        if (!slice) {
          return textResult(diagnoseMissingSymbol(r, symbol, args.file));
        }

        const targetSrc = await boundedSource(slice.target.file, slice.target.line_start, 1500, r);

        const calleeExcerpts = [];
        for (const callee of slice.callees) {
          const src = await boundedSource(callee.file, callee.line_start, 800, r);
          if (src) {
            calleeExcerpts.push({
              name: callee.name,
              kind: callee.kind,
              file: callee.file,
              lines: `${src.line_start}-${src.line_end}`,
              text: src.text
            });
          }
        }

        const callerExcerpts = [];
        for (const caller of slice.callers) {
          const src = await boundedSource(caller.file, caller.line_start, 800, r);
          if (src) {
            callerExcerpts.push({
              name: caller.name,
              kind: caller.kind,
              file: caller.file,
              lines: `${src.line_start}-${src.line_end}`,
              text: src.text
            });
          }
        }

        if (format === "json") {
          return textResult({
            target: slice.target,
            target_source: targetSrc,
            callees: calleeExcerpts,
            callers: callerExcerpts,
            blast_radius_count: slice.blast_radius_count,
            has_test_coverage: slice.has_test_coverage,
            test_callers_count: slice.test_callers_count
          });
        }

        if (format === "mermaid") {
          const lines = ["graph TD"];
          const targetSafe = slice.target.name.replace(/[^a-zA-Z0-9_]/g, "_");
          lines.push(`  ${targetSafe}["${slice.target.name} (${slice.target.kind})"]:::target`);
          for (const caller of slice.callers) {
            const callerSafe = caller.name.replace(/[^a-zA-Z0-9_]/g, "_");
            lines.push(`  ${callerSafe}["${caller.name}"] -->|calls| ${targetSafe}`);
          }
          for (const callee of slice.callees) {
            const calleeSafe = callee.name.replace(/[^a-zA-Z0-9_]/g, "_");
            lines.push(`  ${targetSafe} -->|calls| ${calleeSafe}["${callee.name}"]`);
          }
          lines.push("  classDef target fill:#4a90e2,stroke:#2a5082,stroke-width:2px,color:#fff;");
          const mermaidChart = "```mermaid\n" + lines.join("\n") + "\n```";

          let out = `### 1-Turn Context Slice: \`${slice.target.name}\`\n\n${mermaidChart}\n\n`;
          out += `#### Target Source (\`${slice.target.file}:${targetSrc?.line_start}-${targetSrc?.line_end}\`)\n\`\`\`\n${targetSrc?.text ?? "(no source)"}\n\`\`\`\n\n`;
          if (calleeExcerpts.length) {
            out += `#### Direct Dependencies (${calleeExcerpts.length})\n`;
            for (const c of calleeExcerpts) {
              out += `**\`${c.name}\`** [${c.kind}] (\`${c.file}:${c.lines}\`):\n\`\`\`\n${c.text}\n\`\`\`\n\n`;
            }
          }
          if (callerExcerpts.length) {
            out += `#### Callers (${callerExcerpts.length})\n`;
            for (const c of callerExcerpts) {
              out += `**\`${c.name}\`** [${c.kind}] (\`${c.file}:${c.lines}\`):\n\`\`\`\n${c.text}\n\`\`\`\n\n`;
            }
          }
          out += `> **Blast Radius**: ${slice.blast_radius_count} downstream dependents | **Tests**: ${slice.has_test_coverage ? `YES (${slice.test_callers_count} test suites)` : "None detected"}`;
          return textResult(out);
        }

        // Default "compact"
        let out = `=== Context Slice: ${slice.target.name}() [${slice.target.kind}] ${slice.target.file}:${targetSrc?.line_start ?? slice.target.line_start}-${targetSrc?.line_end ?? slice.target.line_end} ===\n`;
        out += `\n[TARGET SOURCE]\n${targetSrc?.text ?? "(source unavailable)"}\n`;

        if (calleeExcerpts.length > 0) {
          out += `\n--- Direct Dependencies (${calleeExcerpts.length}) ---\n`;
          for (const c of calleeExcerpts) {
            out += `-> calls ${c.name} [${c.kind}] (${c.file}:${c.lines}):\n${c.text}\n\n`;
          }
        } else {
          out += `\n--- Direct Dependencies: None ---\n`;
        }

        if (callerExcerpts.length > 0) {
          out += `--- Immediate Callers (${callerExcerpts.length}) ---\n`;
          for (const c of callerExcerpts) {
            out += `<- called by ${c.name} [${c.kind}] (${c.file}:${c.lines}):\n${c.text}\n\n`;
          }
        } else {
          out += `--- Immediate Callers: None detected ---\n`;
        }

        out += `--- Blast Radius & Safety ---\n`;
        out += `Downstream dependents: ${slice.blast_radius_count} | Test coverage: ${slice.has_test_coverage ? `YES (${slice.test_callers_count} test suites)` : "WARNING: 0 test suites detected within 2 hops"}\n`;

        return textResult(out.trim());
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
        return textResult(await indexWorkspace(args, r));
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
        const src = await boundedSource(t.file, t.line_start, num(args.source_budget, 1500), r);
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
        const src = await boundedSource(t.file, t.line_start, num(args.source_budget, 1500), r);
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
