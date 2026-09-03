import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseServerConfig } from "./config";
import { openDuckDatabase } from "./db";
import { createLogger } from "./logger";
import { GraphRepository } from "./repository";
import { CodeParser } from "./parser";
import { Indexer } from "./indexer";
import { createApp } from "./routes";
import { GitWatcher } from "./git";
import type { Lockfile } from "../shared/protocol";

const logger = createLogger("server");

async function main(): Promise<void> {
  const config = parseServerConfig(process.argv.slice(2));
  const codeDir = path.join(config.workspaceRoot, ".codegraph");
  const legacyDuckDir = path.join(config.workspaceRoot, ".duckgraph");
  // Prefer explicit flags > new .codegraph dir > legacy .duckgraph (migrate).
  let defaultDir = codeDir;
  try {
    if (!config.dbPath && !config.lockfilePath && !fs.existsSync(codeDir) && fs.existsSync(path.join(legacyDuckDir, "graph.db"))) {
      defaultDir = legacyDuckDir;
    }
  } catch {
    defaultDir = codeDir;
  }
  const dbPath = config.dbPath ?? path.join(defaultDir, "graph.db");
  const lockfilePath = config.lockfilePath ?? path.join(defaultDir, "lockfile.json");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });

  const db = openDuckDatabase(dbPath);
  const repository = new GraphRepository(db, config.workspaceRoot);
  const parser = new CodeParser(config.extensionRoot, createLogger("parser"));
  const indexer = new Indexer(config.workspaceRoot, parser, repository);
  const gitWatcher = new GitWatcher(config.workspaceRoot, repository, createLogger("git"));
  let server: http.Server | null = null;

  const shutdown = (): void => {
    gitWatcher.dispose().catch((error: unknown) => logger.warn("git watcher dispose failed", error));
    server?.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };

  const app = createApp({
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    dbPath,
    llamaUrl: config.llamaUrl,
    indexer,
    parser,
    repository,
    logger,
    shutdown
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server?.listen(config.preferredPort, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine daemon port");
  }

  const lockfile: Lockfile = {
    port: address.port,
    token: config.token,
    pid: process.pid,
    workspaceRoot: config.workspaceRoot,
    dbPath,
    createdAt: new Date().toISOString()
  };
  const tmpLockfilePath = `${lockfilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpLockfilePath, JSON.stringify(lockfile, null, 2), "utf8");
  fs.renameSync(tmpLockfilePath, lockfilePath);
  gitWatcher.start();
  logger.info("daemon ready", { port: address.port, dbPath });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  logger.error("daemon failed", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
