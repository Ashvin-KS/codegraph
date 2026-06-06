#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const AUTH_HEADER = "X-DuckGraph-Auth";
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".duckgraph",
  "node_modules",
  "dist",
  "out",
  "build",
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
  if (process.env.DUCKGRAPH_GLOBAL_STORAGE) return process.env.DUCKGRAPH_GLOBAL_STORAGE;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Code", "User", "globalStorage");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage");
  }
  return path.join(os.homedir(), ".config", "Code", "User", "globalStorage");
}

async function readLockfile() {
  let file = arg("lockfile") ?? process.env.DUCKGRAPH_LOCKFILE;
  const workspaceRoot = arg("workspace") ?? process.env.DUCKGRAPH_WORKSPACE ?? process.cwd();
  if (!file) {
    const roots = [
      "kilocode.kilo-code",
      "local-duckgraph",
      "kairos.kairos",
    ];
    for (const hash of workspaceHashes(workspaceRoot)) {
      for (const root of roots) {
        const candidate = path.join(defaultGlobalStorage(), root, "state", "duckgraph", hash, "lockfile.json");
        if (await exists(candidate)) {
          file = candidate;
          break;
        }
      }
      if (file) break;
    }
  }
  if (!file) {
    throw new Error(
      "DuckGraph lockfile was not found. Start Kairos/DuckGraph for this workspace, or pass --lockfile <path>, DUCKGRAPH_LOCKFILE, or DUCKGRAPH_WORKSPACE.",
    );
  }
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function request(endpoint, init = {}) {
  const lockfile = await readLockfile();
  const response = await fetch(`http://127.0.0.1:${lockfile.port}${endpoint}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
      [AUTH_HEADER]: lockfile.token,
    },
  });
  if (!response.ok) {
    throw new Error(`DuckGraph daemon ${response.status}: ${await response.text()}`);
  }
  return response.json();
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
    truncated: files.length >= maxFiles,
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

const tools = [
  {
    name: "duckgraph_index_workspace",
    description: "Index or reindex the current workspace in the local DuckGraph daemon.",
    inputSchema: {
      type: "object",
      properties: {
        max_files: { type: "number" },
        force_reindex: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "duckgraph_query_subgraph",
    description: "Return a bounded code relationship subgraph for a symbol.",
    inputSchema: symbolSchema(),
  },
  {
    name: "duckgraph_read_source_node",
    description: "Return AST-bounded source text for the symbol at a file and line.",
    inputSchema: symbolSchema(),
  },
  {
    name: "duckgraph_explain_symbol",
    description: "Explain a symbol with deterministic DuckGraph graph facts.",
    inputSchema: symbolSchema(),
  },
  {
    name: "duckgraph_confirm_edge",
    description: "Confirm an inferred DuckGraph edge.",
    inputSchema: edgeSchema(),
  },
  {
    name: "duckgraph_dismiss_edge",
    description: "Dismiss a DuckGraph edge.",
    inputSchema: edgeSchema(),
  },
];

function symbolSchema() {
  return {
    type: "object",
    properties: {
      symbol: { type: "string" },
      file: { type: "string" },
      line: { type: "number" },
      depth: { type: "number" },
      max_edges: { type: "number" },
    },
    required: ["file", "line"],
    additionalProperties: false,
  };
}

function edgeSchema() {
  return {
    type: "object",
    properties: {
      edge_id: { type: "number" },
    },
    required: ["edge_id"],
    additionalProperties: false,
  };
}

const server = new Server(
  { name: "duckgraph", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (requestMessage) => {
  const args = requestMessage.params.arguments ?? {};
  try {
    const lockfile = await readLockfile();
    switch (requestMessage.params.name) {
      case "duckgraph_index_workspace":
        return textResult(await indexWorkspace(args));
      case "duckgraph_query_subgraph":
        return textResult(await request("/agent/subgraph", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "duckgraph_read_source_node":
        return textResult(await request("/agent/read_source", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "duckgraph_explain_symbol":
        return textResult(await request("/agent/context", {
          method: "POST",
          body: JSON.stringify({ ...args, workspace_root: lockfile.workspaceRoot }),
        }));
      case "duckgraph_confirm_edge":
        return textResult(await request("/edge/confirm", { method: "POST", body: JSON.stringify(args) }));
      case "duckgraph_dismiss_edge":
        return textResult(await request("/edge/dismiss", { method: "POST", body: JSON.stringify(args) }));
      default:
        throw new Error(`Unknown DuckGraph tool: ${requestMessage.params.name}`);
    }
  } catch (error) {
    return {
      ...textResult({ error: error instanceof Error ? error.message : String(error) }),
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
