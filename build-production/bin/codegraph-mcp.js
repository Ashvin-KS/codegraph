#!/usr/bin/env node
// CodeGraph standalone MCP server — no VS Code, no daemon, no monorepo.
// Opens <workspace>/.codegraph/graph.db (migrates legacy .duckgraph/graph.db)
// and answers all tools in-process over stdio.
import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../src/db.js";
import { GraphRepository } from "../src/repository.js";
import { parseFile, readNodeBody } from "../src/parser.js";
import { languageIdForFile } from "../src/protocol.js";
import { assertInsideWorkspace, normalizeWorkspaceFile } from "../src/fs.js";

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

import { existsSync, mkdirSync, copyFileSync } from "node:fs";

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

async function boundedSource(file, line, budget = 2500) {
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

function fallbackSummary(subgraph, source, hoveredFile) {
  if (!subgraph.target) {
    return "CodeGraph has not indexed this symbol yet. Call codegraph_index_workspace first, then retry.";
  }
  const t = subgraph.target;
  const outgoing = subgraph.edges.filter((e) => e.from_id === t.id && e.confidence === "syntactic");
  const rel = outgoing.length === 0
    ? "no verified outgoing relationships yet"
    : `verified relationships: ${outgoing.slice(0, 3).map((e) => `${e.type} ${e.target_name}`).join(", ")}${outgoing.length > 3 ? ` and ${outgoing.length - 3} more` : ""}`;
  const src = source ? ` Source was read from lines ${source.line_start}-${source.line_end}.` : "";
  const stale = t.freshness === "STALE" ? `\nWarning: this context is stale${t.stale_reason ? ` (${t.stale_reason})` : ""}.` : "";
  const where = hoveredFile && normalizeWorkspaceFile(root ?? workspaceRoot(), hoveredFile) === t.file
    ? "locally in this file" : `in ${t.file}`;
  return `${t.name} is a ${t.kind} defined ${where}; CodeGraph found ${rel}.${src}${stale}`;
}

function guidanceFor(subgraph) {
  if (subgraph.freshness === "UNINDEXED") return "UNINDEXED: call codegraph_index_workspace first, then retry.";
  if (subgraph.freshness === "STALE") {
    return `STALE${subgraph.target?.stale_reason ? `: ${subgraph.target.stale_reason}` : ""} — hedge structural claims and prefer re-reading source.`;
  }
  if (subgraph.edges.length === 0) return "No verified edges yet — use bounded_source_excerpt for implementation detail only; do not invent callers/callees.";
  return "Use verified_edges for ALL structural claims (what calls what). Never state a relationship not in verified_edges.";
}

async function collectFiles(maxFiles) {
  const r = ensureRepo();
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
  const files = await collectFiles(maxFiles);
  let nodes = 0, edges = 0;
  for (const f of files) {
    const parsed = parseFile(f.file, f.content);
    if (!parsed || (parsed.nodes.length === 0 && f.content.trim().length > 0)) continue;
    try {
      const res = r.upsertFileIndex(f.file, parsed.nodes, parsed.edges, "unknown");
      nodes += res.nodes;
      edges += res.edges;
    } catch { /* skip bad files, keep going */ }
  }
  return { workspace_root: r.workspaceRoot, indexed_files: files.length, nodes, edges, max_files: maxFiles, truncated: files.length > maxFiles };
}

function textResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

function symbolSchema() {
  return {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name (optional; falls back to containing node, then global search)." },
      file: { type: "string", description: "Workspace-relative path preferred; absolute also accepted." },
      line: { type: "integer", minimum: 1, description: "1-based line. Out-of-range lines are clamped." },
      depth: { type: "integer", minimum: 0, maximum: 2, description: "Traversal depth 0-2, default 2." },
      max_edges: { type: "integer", minimum: 1, maximum: 60, description: "Max edges, default 20." },
      source_budget: { type: "integer", minimum: 1, maximum: 8000, description: "Max source excerpt chars." }
    },
    required: ["file", "line"],
    additionalProperties: false
  };
}

const primaryTools = [
  {
    name: "codegraph_index_workspace",
    description: "Index or re-index the workspace code graph. Call FIRST when query/explain returns UNINDEXED, 0 edges, or stale results. Defaults to 1000 files; force_reindex=true rebuilds from scratch (stable ids preserved otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        max_files: { type: "integer", minimum: 1, maximum: 5000 },
        force_reindex: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "codegraph_query_subgraph",
    description: "Return a bounded relationship subgraph (verified_edges with id/type/target_name). If stale_state is UNINDEXED or edges are empty, call codegraph_index_workspace first, then retry. Freshness: FRESH trusted, NEW never explained, STALE hedge, UNINDEXED must index.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_read_source_node",
    description: "Return ONLY the AST-bounded source excerpt for the symbol at file+line. Falls back to a 21-line window. If target_symbol is null, call codegraph_index_workspace first.",
    inputSchema: symbolSchema()
  },
  {
    name: "codegraph_explain_symbol",
    description: "Explain a symbol with deterministic graph facts + bounded source + usage guidance. Returns target_symbol, verified_edges, inferred_edges, stale_state, bounded_source_excerpt, summary, usage_guidance. Use verified_edges for ALL structural claims.",
    inputSchema: symbolSchema()
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
  },
  {
    name: "codegraph_health",
    description: "Check index stats. Returns ok, workspace_root, indexedFiles, indexedNodes, dbPath.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const legacyTools = primaryTools
  .filter((t) => t.name.startsWith("codegraph_") && t.name !== "codegraph_health")
  .map((t) => ({ ...t, name: t.name.replace(/^codegraph_/, "duckgraph_"), description: `${t.description} (Legacy alias; prefer ${t.name}.)` }));

const tools = [...primaryTools, ...legacyTools];

const server = new Server({ name: "codegraph", version: "0.2.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (msg) => {
  const args = msg.params.arguments ?? {};
  try {
    const r = ensureRepo();
    const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
    switch (msg.params.name) {
      case "codegraph_health": {
        const s = r.stats();
        return textResult({ ok: true, workspace_root: r.workspaceRoot, indexedFiles: s.indexedFiles, indexedNodes: s.indexedNodes, dbPath: resolveDbPath(r.workspaceRoot) });
      }
      case "codegraph_index_workspace":
      case "duckgraph_index_workspace":
        return textResult(await indexWorkspace(args));
      case "codegraph_query_subgraph":
      case "duckgraph_query_subgraph": {
        const file = String(args.file);
        const content = await readWorkspaceFile(file).catch(() => "");
        const line = clampLine(content || "x\n".repeat(2), num(args.line, 1));
        const sub = r.querySubgraph(args.symbol, file, line, Math.min(num(args.depth, 2), 2), Math.min(num(args.max_edges, 20), 60));
        return textResult(sub);
      }
      case "codegraph_read_source_node":
      case "duckgraph_read_source_node": {
        const file = String(args.file);
        const content = await readWorkspaceFile(file).catch(() => "");
        const line = clampLine(content || "x\n", num(args.line, 1));
        const sub = r.querySubgraph(args.symbol, file, line, 0, 1);
        if (!sub.target) return textResult({ target_symbol: null, bounded_source_excerpt: null, stale_state: sub.freshness });
        const src = await boundedSource(file, line, num(args.source_budget, 2500));
        const t = sub.target;
        return textResult({
          target_symbol: { name: t.name, kind: t.kind, file: t.file, line_start: t.line_start, line_end: t.line_end, freshness: t.freshness, stale_reason: t.stale_reason },
          bounded_source_excerpt: src,
          stale_state: sub.freshness
        });
      }
      case "codegraph_explain_symbol":
      case "duckgraph_explain_symbol": {
        const file = String(args.file);
        const content = await readWorkspaceFile(file).catch(() => "");
        const line = clampLine(content || "x\n", num(args.line, 1));
        const sub = r.querySubgraph(args.symbol, file, line, Math.min(num(args.depth, 2), 2), Math.min(num(args.max_edges, 20), 60));
        const src = await boundedSource(file, line, num(args.source_budget, 2500));
        const summary = fallbackSummary(sub, src, file);
        const guidance = guidanceFor(sub);
        return textResult({
          target_symbol: sub.target,
          verified_edges: sub.edges.filter((e) => e.confidence === "syntactic"),
          inferred_edges: sub.edges.filter((e) => e.confidence === "inferred"),
          stale_state: sub.freshness,
          bounded_source_excerpt: src,
          summary,
          usage_guidance: guidance,
          compact_json: JSON.stringify({
            target_symbol: sub.target ? {
              name: sub.target.name, kind: sub.target.kind, file: sub.target.file,
              line_start: sub.target.line_start, line_end: sub.target.line_end,
              freshness: sub.target.freshness, stale_reason: sub.target.stale_reason
            } : null,
            verified_edges: sub.edges.filter((e) => e.confidence === "syntactic").map((e) => ({ id: e.id, type: e.type, target_name: e.target_name })),
            inferred_edges: [],
            stale_state: sub.freshness,
            summary,
            usage_guidance: guidance,
            bounded_source_excerpt: src
          })
        });
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
