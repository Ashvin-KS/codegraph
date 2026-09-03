#!/usr/bin/env node
// CodeGraph MCP (formerly DuckGraph). Exposes codegraph_* tools (primary)
// plus duckgraph_* aliases so existing Claude configs keep working.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const AUTH_HEADER = "X-CodeGraph-Auth";
const AUTH_HEADER_LEGACY = "X-DuckGraph-Auth";
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".codegraph",
  ".duckgraph",
  "node_modules",
  "dist",
  "out",
  "build",
  "build-production",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "bin",
  "obj",
  ".idea",
  ".vscode",
]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function workspaceHashes(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot);
  const hashes = new Set([sha256(resolved)]);
  if (process.platform === "win32" && resolved.length >= 2 && resolved[1] === ":") {
    const drive = resolved.charAt(0);
    const rest = resolved.slice(1);
    hashes.add(sha256(drive.toLowerCase() + rest));
    hashes.add(sha256(drive.toUpperCase() + rest));
  }
  return [...hashes];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultGlobalStorage() {
  if (process.env.CODEGRAPH_GLOBAL_STORAGE) return process.env.CODEGRAPH_GLOBAL_STORAGE;
  if (process.env.DUCKGRAPH_GLOBAL_STORAGE) return process.env.DUCKGRAPH_GLOBAL_STORAGE;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Code", "User", "globalStorage");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage");
  }
  return path.join(os.homedir(), ".config", "Code", "User", "globalStorage");
}

function workspaceRoots() {
  const roots = new Set([
    path.resolve(arg("workspace") ?? arg("workspaceRoot") ?? process.env.CODEGRAPH_WORKSPACE ?? process.env.DUCKGRAPH_WORKSPACE ?? process.cwd()),
    path.resolve(process.cwd()),
  ]);
  return [...roots];
}

async function readLockfile() {
  let file = arg("lockfile") ?? process.env.CODEGRAPH_LOCKFILE ?? process.env.DUCKGRAPH_LOCKFILE;
  const roots = workspaceRoots();
  if (!file) {
    // 1) Workspace-local lockfiles (new .codegraph first, legacy .duckgraph).
    for (const root of roots) {
      for (const name of [".codegraph", ".duckgraph"]) {
        const candidate = path.join(root, name, "lockfile.json");
        if (await exists(candidate)) {
          file = candidate;
          break;
        }
      }
      if (file) break;
    }
  }
  if (!file) {
    const hashes = new Set();
    for (const root of roots) for (const h of workspaceHashes(root)) hashes.add(h);
    const publisherRoots = [
      "kilocode.kilo-code",
      "kilocode-x.codegraph",
      "local-codegraph",
      "local-duckgraph",
      "kairos.kairos",
    ];
    const stateNames = ["codegraph", "duckgraph"];
    for (const hash of hashes) {
      for (const publisher of publisherRoots) {
        for (const state of stateNames) {
          const candidate = path.join(defaultGlobalStorage(), publisher, "state", state, hash, "lockfile.json");
          if (await exists(candidate)) {
            file = candidate;
            break;
          }
        }
        if (file) break;
      }
      if (file) break;
    }
  }
  if (!file) {
    throw new Error(
      "CodeGraph lockfile was not found. Start CodeGraph (formerly DuckGraph) for this workspace, or pass --lockfile <path>, --workspace <path>, CODEGRAPH_LOCKFILE, or CODEGRAPH_WORKSPACE (legacy DUCKGRAPH_* also accepted).",
    );
  }
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.port !== "number" || typeof parsed.token !== "string" || !parsed.workspaceRoot) {
    throw new Error(`CodeGraph lockfile is invalid: ${file}. Delete it and restart the extension.`);
  }
  return parsed;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function request(endpoint, init = {}, timeoutMs = 30000) {
  const lockfile = await readLockfile();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    };
    headers[AUTH_HEADER] = lockfile.token;
    const response = await fetch(`http://127.0.0.1:${lockfile.port}${endpoint}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new Error(`CodeGraph daemon rejected auth (stale lockfile?). Delete the lockfile and restart the extension. Detail: ${text}`);
      }
      throw new Error(`CodeGraph daemon ${response.status}: ${text || response.statusText}`);
    }
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`CodeGraph daemon timed out after ${timeoutMs}ms on ${endpoint}. It may be indexing; retry or check codegraph_health.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function indexWorkspace(args) {
  const lockfile = await readLockfile();
  const maxFiles = numberArg(args.max_files, 1000);
  const forceReindex = args.force_reindex === true;
  const files = await collectWorkspaceFiles(lockfile.workspaceRoot, maxFiles);
  let indexed = 0;
  for (let index = 0; index < files.length; index += 40) {
    const batch = files.slice(index, index + 40);
    await request("/index_batch", {
      method: "POST",
      body: JSON.stringify({
        workspace_root: lockfile.workspaceRoot,
        files: batch,
        clear_graph_cache: index === 0 ? forceReindex : false,
      }),
    });
    indexed += batch.length;
  }
  return {
    workspace_root: lockfile.workspaceRoot,
    indexed_files: indexed,
    max_files: maxFiles,
    truncated: files.length > maxFiles,
  };
}

async function collectWorkspaceFiles(root, maxFiles) {
  const results = [];
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) stack.push(fullPath);
      } else if (entry.isFile() && languageIdForFile(fullPath)) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat || stat.size > 1_000_000) continue;
        const content = await fs.readFile(fullPath, "utf8").catch(() => null);
        if (content !== null) results.push({ file: fullPath, content, workspace_root: root });
      }
    }
  }
  return results;
}

function languageIdForFile(file) {
  const lower = file.toLowerCase();
  return /\.(rs|tsx|jsx|ts|mts|cts|js|mjs|cjs|py|go|c|h|cpp|cc|cxx|hpp|hh|cs|java|rb|php|zig|sh|bash|zsh|html|htm|css|json|kt|kts|lua|sol|swift|ya?ml)$/.test(lower);
}

function numberArg(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function textResult(data) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
  };
}

function symbolSchema() {
  return {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name (optional; falls back to containing node, then global search)." },
      file: { type: "string", description: "Workspace-relative path preferred; absolute also accepted. Must be inside the workspace." },
      line: { type: "integer", minimum: 1, description: "1-based line. Out-of-range lines are clamped." },
      depth: { type: "integer", minimum: 0, maximum: 2, description: "Traversal depth 0-2, default 2." },
      max_edges: { type: "integer", minimum: 1, maximum: 60, description: "Max edges, default 20." },
      source_budget: { type: "integer", minimum: 1, maximum: 8000, description: "Max source excerpt chars (explain/read_source)." },
    },
    required: ["file", "line"],
    additionalProperties: false,
  };
}

function edgeSchema() {
  return {
    type: "object",
    properties: {
      edge_id: { type: "integer", minimum: 1, description: "Edge id from verified_edges/inferred_edges[].id." },
    },
    required: ["edge_id"],
    additionalProperties: false,
  };
}

const primaryTools = [
  {
    name: "codegraph_index_workspace",
    description: "Index or re-index the workspace code graph. Call FIRST when query/explain returns UNINDEXED, 0 edges, or stale results. Defaults to 1000 files; force_reindex=true rebuilds from scratch.",
    inputSchema: {
      type: "object",
      properties: {
        max_files: { type: "integer", minimum: 1, maximum: 5000 },
        force_reindex: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codegraph_query_subgraph",
    description: "Return a bounded relationship subgraph (verified_edges with id/type/target_name). If stale_state is UNINDEXED or edges are empty, call codegraph_index_workspace first, then retry. Freshness: FRESH trusted, NEW never explained, STALE hedge, UNINDEXED must index.",
    inputSchema: symbolSchema(),
  },
  {
    name: "codegraph_read_source_node",
    description: "Return ONLY the AST-bounded source excerpt for the symbol at file+line. Falls back to a 21-line window. If target_symbol is null, call codegraph_index_workspace first.",
    inputSchema: symbolSchema(),
  },
  {
    name: "codegraph_explain_symbol",
    description: "Explain a symbol with deterministic graph facts + bounded source + usage guidance. Returns target_symbol, verified_edges, inferred_edges, stale_state, bounded_source_excerpt, summary, usage_guidance. Use verified_edges for ALL structural claims.",
    inputSchema: symbolSchema(),
  },
  {
    name: "codegraph_confirm_edge",
    description: "Confirm an edge id from query/explain so future answers treat it as verified. Get edge_id from verified_edges/inferred_edges[].id.",
    inputSchema: edgeSchema(),
  },
  {
    name: "codegraph_dismiss_edge",
    description: "Dismiss an edge id so future answers exclude it. Get edge_id from verified_edges/inferred_edges[].id.",
    inputSchema: edgeSchema(),
  },
  {
    name: "codegraph_health",
    description: "Check daemon status and index stats. Returns ok, status (indexing|ready), indexedFiles, indexedNodes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const legacyTools = primaryTools
  .filter((t) => t.name.startsWith("codegraph_") && t.name !== "codegraph_health")
  .map((t) => ({
    ...t,
    name: t.name.replace(/^codegraph_/, "duckgraph_"),
    description: `${t.description} (Legacy alias; prefer ${t.name}.)`,
  }));

const tools = [...primaryTools, ...legacyTools];

const server = new Server(
  { name: "codegraph", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (requestMessage) => {
  const args = requestMessage.params.arguments ?? {};
  try {
    const lockfile = await readLockfile();
    switch (requestMessage.params.name) {
      case "codegraph_index_workspace":
      case "duckgraph_index_workspace":
        return textResult(await indexWorkspace(args));
      case "codegraph_query_subgraph":
      case "duckgraph_query_subgraph":
        return textResult(await request("/agent/subgraph", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "codegraph_read_source_node":
      case "duckgraph_read_source_node":
        return textResult(await request("/agent/read_source", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "codegraph_explain_symbol":
      case "duckgraph_explain_symbol":
        return textResult(await request("/agent/context", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "codegraph_confirm_edge":
      case "duckgraph_confirm_edge":
        return textResult(await request("/edge/confirm", { method: "POST", body: JSON.stringify(args) }));
      case "codegraph_dismiss_edge":
      case "duckgraph_dismiss_edge":
        return textResult(await request("/edge/dismiss", { method: "POST", body: JSON.stringify(args) }));
      case "codegraph_health":
        return textResult(await request("/health", { method: "GET" }));
      default:
        throw new Error(`Unknown CodeGraph tool: ${requestMessage.params.name}`);
    }
  } catch (error) {
    return {
      ...textResult({
        error: error instanceof Error ? error.message : String(error),
        hint: "If UNINDEXED or lockfile not found: start the CodeGraph VS Code extension for the workspace, or pass --workspace/CODEGRAPH_WORKSPACE, then call codegraph_index_workspace.",
      }),
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
