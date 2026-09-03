import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type * as vscode from "vscode";
import type { Lockfile } from "../shared/protocol";
import { sleep } from "../shared/fs";
import { DuckGraphClient } from "./client";

export class DaemonManager implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private client: DuckGraphClient | null = null;
  private starting: Promise<DuckGraphClient> | null = null;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel
  ) {}

  public getClient(): DuckGraphClient | null {
    return this.client;
  }

  public async start(llamaUrl: string): Promise<DuckGraphClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.doStart(llamaUrl);
    try {
      this.client = await this.starting;
      return this.client;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(llamaUrl: string): Promise<DuckGraphClient> {
    // Primary: globalStorage/state/codegraph/<hash> (shared with MCP + Kilo).
    // Compat: workspace .codegraph/ + legacy .duckgraph/ so older MCP configs
    // and workspace-local tooling keep working after the rename.
    let primaryDir: string;
    try {
      const stateRoot = path.join(this.context.globalStorageUri.fsPath, "state");
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(path.resolve(this.workspaceRoot)).digest("hex");
      primaryDir = path.join(stateRoot, "codegraph", hash);
    } catch {
      primaryDir = path.join(this.workspaceRoot, ".codegraph");
    }
    const lockfilePath = path.join(primaryDir, "lockfile.json");
    const dbPath = path.join(primaryDir, "graph.db");
    await fs.mkdir(primaryDir, { recursive: true });
    await fs.rm(lockfilePath, { force: true });

    const serverPath = path.join(this.context.extensionPath, "dist", "server.js");
    const token = crypto.randomBytes(32).toString("hex");
    const nodeBin =
      process.env.CODEGRAPH_NODE_PATH ?? process.env.DUCKGRAPH_NODE_PATH ?? "node";
    this.child = spawn(
      nodeBin,
      [
        serverPath,
        "--workspaceRoot",
        this.workspaceRoot,
        "--extensionRoot",
        this.context.extensionPath,
        "--dbPath",
        dbPath,
        "--lockfilePath",
        lockfilePath,
        "--token",
        token,
        "--llamaUrl",
        llamaUrl
      ],
      {
        cwd: this.workspaceRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    this.child.stdout?.on("data", (chunk: Buffer) => this.output.append(chunk.toString()));
    this.child.stderr?.on("data", (chunk: Buffer) => this.output.append(chunk.toString()));
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(`CodeGraph daemon exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.client = null;
    });

    const lockfile = await waitForLockfile(lockfilePath, token);
    const client = new DuckGraphClient(lockfile);
    try {
      await client.health();
    } catch (error) {
      this.output.appendLine(
        `CodeGraph daemon health check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
    // Compat copies for MCP clients that scan the workspace dir.
    for (const compat of [
      path.join(this.workspaceRoot, ".codegraph", "lockfile.json"),
      path.join(this.workspaceRoot, ".duckgraph", "lockfile.json")
    ]) {
      try {
        await fs.mkdir(path.dirname(compat), { recursive: true });
        await fs.writeFile(compat, JSON.stringify(lockfile, null, 2), "utf8");
      } catch {
        // Best effort.
      }
    }
    return client;
  }

  public async stop(): Promise<void> {
    const current = this.client;
    this.client = null;
    if (current) {
      try {
        await current.shutdown();
      } catch {
        // The process may already be gone.
      }
    }
    try {
      this.child?.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
    for (const compat of [
      path.join(this.workspaceRoot, ".codegraph", "lockfile.json"),
      path.join(this.workspaceRoot, ".duckgraph", "lockfile.json")
    ]) {
      try {
        await fs.rm(compat, { force: true });
      } catch {
        // Best effort.
      }
    }
  }

  public dispose(): void {
    void this.stop();
  }
}

export { DaemonManager as CodeGraphDaemonManager };

async function waitForLockfile(lockfilePath: string, expectedToken?: string): Promise<Lockfile> {
  const deadline = Date.now() + 15000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(lockfilePath, "utf8");
      const parsed = JSON.parse(raw) as Lockfile;
      if (typeof parsed.port !== "number" || typeof parsed.token !== "string" || !parsed.workspaceRoot) {
        throw new Error("lockfile is not ready yet");
      }
      if (expectedToken && parsed.token !== expectedToken) {
        throw new Error("stale lockfile from a previous daemon; waiting for the new one");
      }
      return parsed;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`CodeGraph daemon did not write lockfile: ${String(lastError)}`);
}
