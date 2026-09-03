#!/usr/bin/env node
// One-command Claude Desktop setup. Writes the codegraph entry into
// claude_desktop_config.json so you never hand-edit absolute paths.
//
//   node ./bin/codegraph-setup.js --workspace C:/path/to/your-project
//   node ./bin/codegraph-setup.js --workspace . --uninstall   (remove entry)
//
// After running: restart Claude Desktop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(here, "codegraph-mcp.js");
const workspace = path.resolve(arg("workspace", process.cwd()));
const serverName = arg("name", "codegraph");
const uninstall = process.argv.includes("--uninstall");

function defaultConfigPath() {
  const override = arg("config-path", null) || process.env.CLAUDE_CONFIG_PATH;
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

const configPath = defaultConfigPath();
let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`Existing config is not valid JSON: ${configPath}`);
    console.error(`Back it up, delete it, and re-run. Nothing was changed.`);
    process.exit(1);
  }
}
config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};

if (uninstall) {
  delete config.mcpServers[serverName];
  console.log(`Removed "${serverName}" from ${configPath}`);
} else {
  if (!fs.existsSync(binPath)) {
    console.error(`MCP server not found at ${binPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(workspace)) {
    console.error(`Workspace does not exist: ${workspace}`);
    process.exit(1);
  }
  const canUseGlobal = process.platform !== "win32" && globalBinAvailable();
  config.mcpServers[serverName] = canUseGlobal
    ? { command: "codegraph-mcp", args: ["--workspace", workspace] }
    : { command: "node", args: [binPath, "--workspace", workspace] };
  if (canUseGlobal) {
    console.log(`Added "${serverName}" -> ${workspace} (global codegraph-mcp)`);
  } else {
    console.log(`Added "${serverName}" -> ${workspace}`);
    console.log(`Server: ${binPath}`);
    if (process.platform !== "win32") {
      console.log(`Tip: run "npm install -g ./build-production" then re-run setup for the short global form.`);
    }
  }
}

function globalBinAvailable() {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(probe, ["codegraph-mcp"], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log(`Wrote ${configPath}`);
if (!uninstall) console.log("Restart Claude Desktop to pick it up.");
