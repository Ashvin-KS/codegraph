// Validates that build-production/ is independent of anything else:
// - no imports reaching outside the folder (no ../../kilocode, no ../src, no vscode)
// - all runtime files present
// - standalone MCP answers health + index + query over stdio (smoke test)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const prod = path.join(root, "build-production");
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[build-production] FAIL: ${message}`);
}

function ok(message) {
  console.log(`[build-production] ok: ${message}`);
}

// 1) Required files
for (const file of [
  "package.json",
  "README.md",
  "bin/codegraph-mcp.js",
  "src/hash.js",
  "src/fs.js",
  "src/protocol.js",
  "src/parser.js",
  "src/schema.js",
  "src/db.js",
  "src/repository.js"
]) {
  if (!fs.existsSync(path.join(prod, file))) fail(`missing ${file}`);
  else ok(`present ${file}`);
}

// 2) Independence: no imports escaping build-production/ and no VS Code APIs.
// Internal ../src imports are fine (bin/ -> src/ inside the folder).
const banned = ["../..", "kilocode/packages", ".duckgraph/src", "from \"vscode\"", "from 'vscode'", "require(\"vscode\")", "require('vscode')"];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      scan(full);
    } else if (/\.(js|mjs|cjs|json)$/.test(entry.name)) {
      const text = fs.readFileSync(full, "utf8");
      for (const needle of banned) {
        if (text.includes(needle)) fail(`${path.relative(prod, full)} contains banned import ${needle}`);
      }
      if (full.endsWith("package.json")) continue;
    }
  }
}
scan(prod);
ok("import independence scan done");

// 3) Smoke test: spin up the MCP over stdio in a temp workspace
async function smoke() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-prod-"));
  fs.writeFileSync(
    path.join(tmp, "sample.ts"),
    "export function add(a: number, b: number): number { return a + b; }\nexport function total(xs: number[]): number { return xs.reduce((s, v) => add(s, v), 0); }\n"
  );
  const child = spawn(process.execPath, [path.join(prod, "bin", "codegraph-mcp.js"), "--workspace", tmp], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  const send = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.id === id) {
              child.stdout.off("data", onData);
              resolve(message);
              return;
            }
          } catch {
            // partial line
          }
        }
      };
      child.stdout.on("data", onData);
      child.stdin.write(payload, (error) => {
        if (error) reject(error);
      });
      setTimeout(() => {
        child.stdout.off("data", onData);
        reject(new Error(`timeout waiting for ${method}`));
      }, 25000).unref?.();
    });

  try {
    const init = await send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "build-production-smoke", version: "0.0.0" }
    });
    if (!init.result) fail("initialize returned no result");
    else ok("initialize");

    const tools = await send(2, "tools/list", {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    for (const expected of [
      "codegraph_overview",
      "codegraph_search_symbols",
      "codegraph_index_workspace",
      "codegraph_query_subgraph",
      "codegraph_impact_analysis",
      "codegraph_find_path",
      "codegraph_read_source_node",
      "codegraph_explain_symbol",
      "codegraph_confirm_edge",
      "codegraph_dismiss_edge",
      "codegraph_health"
    ]) {
      if (!names.includes(expected)) fail(`missing tool ${expected}`);
    }
    if (names.some((n) => n.startsWith("duckgraph_"))) fail("duckgraph_* duplicate tools should not be advertised in tools/list");
    else ok(`tools/list clean (${names.length} primary tools, 0 duplicates)`);

    const indexed = await send(3, "tools/call", {
      name: "codegraph_index_workspace",
      arguments: { max_files: 10 }
    });
    const indexedText = indexed.result?.content?.[0]?.text ?? "";
    if (!indexedText.includes("indexed_files")) fail(`index_workspace unexpected: ${indexedText.slice(0, 200)}`);
    else ok("index_workspace");

    const legacyIndexed = await send(4, "tools/call", {
      name: "duckgraph_index_workspace",
      arguments: { max_files: 10 }
    });
    const legacyText = legacyIndexed.result?.content?.[0]?.text ?? "";
    if (!legacyText.includes("indexed_files")) fail(`duckgraph alias call unexpected: ${legacyText.slice(0, 200)}`);
    else ok("duckgraph_* backward compatibility call");

    const overview = await send(5, "tools/call", { name: "codegraph_overview", arguments: {} });
    const ovText = overview.result?.content?.[0]?.text ?? "";
    if (!ovText.includes("Overview") && !ovText.includes("stats")) fail(`overview unexpected: ${ovText}`);
    else ok("overview");

    const search = await send(6, "tools/call", { name: "codegraph_search_symbols", arguments: { query: "total" } });
    const searchText = search.result?.content?.[0]?.text ?? "";
    if (!searchText.includes("total")) fail(`search_symbols missing total: ${searchText}`);
    else ok("search_symbols");

    const explained = await send(7, "tools/call", {
      name: "codegraph_explain_symbol",
      arguments: { symbol: "total", format: "compact" }
    });
    const explainedText = explained.result?.content?.[0]?.text ?? "";
    if (!explainedText.includes("total")) fail(`explain_symbol missing symbol: ${explainedText.slice(0, 200)}`);
    else ok("explain_symbol (decoupled from file/line)");

    const impact = await send(8, "tools/call", { name: "codegraph_impact_analysis", arguments: { symbol: "add" } });
    const impactText = impact.result?.content?.[0]?.text ?? "";
    if (!impactText.includes("add")) fail(`impact_analysis unexpected: ${impactText}`);
    else ok("impact_analysis");

    const pathRes = await send(9, "tools/call", { name: "codegraph_find_path", arguments: { from_symbol: "total", to_symbol: "add" } });
    const pathText = pathRes.result?.content?.[0]?.text ?? "";
    if (!pathText.includes("total -> add") && !pathText.includes("add")) fail(`find_path unexpected: ${pathText}`);
    else ok("find_path");

    const health = await send(10, "tools/call", { name: "codegraph_health", arguments: {} });
    const healthText = health.result?.content?.[0]?.text ?? "";
    if (!healthText.includes("indexedNodes")) fail(`health unexpected: ${healthText.slice(0, 200)}`);
    else ok("health");
  } finally {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Windows often holds the SQLite file briefly after the child exits.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) console.error(`[build-production] warning: temp cleanup failed: ${error?.message ?? error}`);
        else await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

await smoke();

if (failures.length > 0) {
  console.error(`[build-production] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("[build-production] all checks passed");
