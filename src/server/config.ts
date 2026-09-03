import crypto from "node:crypto";
import path from "node:path";

export interface ServerConfig {
  workspaceRoot: string;
  extensionRoot: string;
  dbPath?: string;
  lockfilePath?: string;
  token: string;
  preferredPort: number;
  llamaUrl: string;
}

export function parseServerConfig(argv: string[]): ServerConfig {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (key?.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      args.set(key.slice(2), next);
      index += 1;
    }
  }

  const workspaceRoot = args.get("workspaceRoot");
  const extensionRoot = args.get("extensionRoot") ?? process.cwd();
  if (!workspaceRoot) {
    throw new Error("Missing --workspaceRoot");
  }

  return {
    workspaceRoot: path.resolve(workspaceRoot),
    extensionRoot: path.resolve(extensionRoot),
    dbPath: args.get("dbPath") ? path.resolve(args.get("dbPath")!) : undefined,
    lockfilePath: args.get("lockfilePath") ? path.resolve(args.get("lockfilePath")!) : undefined,
    token: args.get("token") ?? crypto.randomBytes(32).toString("hex"),
    preferredPort: Number(args.get("port") ?? 0),
    llamaUrl: args.get("llamaUrl") ?? "http://localhost:8080/completion"
  };
}
