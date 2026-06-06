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

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel
  ) {}

  public getClient(): DuckGraphClient | null {
    return this.client;
  }

  public async start(llamaUrl: string): Promise<DuckGraphClient> {
    if (this.client) {
      return this.client;
    }

    const duckDir = path.join(this.workspaceRoot, ".duckgraph");
    const lockfilePath = path.join(duckDir, "lockfile.json");
    await fs.mkdir(duckDir, { recursive: true });
    await fs.rm(lockfilePath, { force: true });

    const serverPath = path.join(this.context.extensionPath, "dist", "server.js");
    const token = crypto.randomBytes(32).toString("hex");
    this.child = spawn(
      "node",
      [
        serverPath,
        "--workspaceRoot",
        this.workspaceRoot,
        "--extensionRoot",
        this.context.extensionPath,
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
      this.output.appendLine(`DuckGraph daemon exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.client = null;
    });

    const lockfile = await waitForLockfile(lockfilePath);
    this.client = new DuckGraphClient(lockfile);
    await this.client.health();
    return this.client;
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
    this.child?.kill();
    this.child = null;
  }

  public dispose(): void {
    void this.stop();
  }
}

async function waitForLockfile(lockfilePath: string): Promise<Lockfile> {
  const deadline = Date.now() + 15000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(lockfilePath, "utf8");
      return JSON.parse(raw) as Lockfile;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`DuckGraph daemon did not write lockfile: ${String(lastError)}`);
}
