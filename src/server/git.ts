import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import type { GraphRepository } from "./repository";
import type { Logger } from "./logger";

const execFileAsync = promisify(execFile);

export async function currentCommitHash(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      windowsHide: true
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export class GitWatcher {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly repository: GraphRepository,
    private readonly logger: Logger
  ) {}

  public start(): void {
    const gitDir = resolveGitDir(this.workspaceRoot);
    if (!gitDir) {
      this.logger.info("no git dir found; git rationale watcher disabled");
      return;
    }
    // Watch HEAD + logs/HEAD in both normal repos and linked worktrees.
    // Worktrees keep their own HEAD under $GITDIR/worktrees/<name>/.
    const watchTargets = [
      path.join(gitDir, "logs", "HEAD"),
      path.join(gitDir, "HEAD"),
      path.join(this.workspaceRoot, ".git", "HEAD")
    ].filter((p, i, arr) => arr.indexOf(p) === i && fs.existsSync(p));
    if (watchTargets.length === 0) {
      // Fall back to watching the git dir itself (bare repos, odd layouts).
      if (fs.existsSync(gitDir)) watchTargets.push(gitDir);
      else {
        this.logger.info("no git HEAD log found; git rationale watcher disabled");
        return;
      }
    }

    this.watcher = chokidar.watch(watchTargets, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 }
    });
    this.watcher.on("change", () => {
      if (this.debounce) {
        clearTimeout(this.debounce);
      }
      this.debounce = setTimeout(() => {
        this.handleHeadChange().catch((error: unknown) => {
          this.logger.warn("failed to process git HEAD change", error instanceof Error ? error.message : String(error));
        });
      }, 100);
    });
  }

  public async dispose(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    await this.watcher?.close();
  }

  private async handleHeadChange(): Promise<void> {
    const commit = await currentCommitHash(this.workspaceRoot);
    if (commit === "unknown") {
      return;
    }

    const [log, files] = await Promise.all([
      execGit(this.workspaceRoot, ["log", "-1", "--format=%H%n%an%n%ai%n%B"]),
      // Branch switches / merges: diff-tree -r on a merge is empty without
      // -m/--cc, and a checkout jumping N commits only shows the tip.
      // Prefer the reflog range HEAD@{1}..HEAD, fall back to tip diff.
      touchedFilesForHeadChange(this.workspaceRoot, commit)
    ]);
    const lines = log.split(/\r?\n/);
    const commitHash = lines[0]?.trim() || commit;
    const author = lines[1]?.trim() || null;
    const committedAt = lines[2]?.trim() || null;
    const message = lines.slice(3).join("\n").trim();
    const touched = files
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);

    if (touched.length > 0) {
      this.repository.recordGitRationale(touched, commitHash, message, author ?? "unknown", committedAt ?? new Date().toISOString());
      this.logger.info("recorded git rationale", { commit: commitHash, files: touched.length });
    }
  }
}

export function resolveGitDir(workspaceRoot: string): string | null {
  try {
    const dotGit = path.join(workspaceRoot, ".git");
    if (!fs.existsSync(dotGit)) return null;
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    // Worktree: .git is a file containing "gitdir: <path>"
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (match?.[1]) {
        const gitdir = path.resolve(workspaceRoot, match[1].trim());
        if (fs.existsSync(gitdir)) return gitdir;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function touchedFilesForHeadChange(workspaceRoot: string, commit: string): Promise<string> {
  // 1) reflog range covers branch switches / multi-commit jumps
  try {
    const range = await execGit(workspaceRoot, ["diff", "--name-only", "HEAD@{1}", "HEAD"]);
    if (range.trim()) return range;
  } catch {
    // no reflog (fresh clone, bare) — fall through
  }
  // 2) merge-aware tip diff
  try {
    const merge = await execGit(workspaceRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", commit]);
    if (merge.trim()) return merge;
  } catch {
    // fall through
  }
  return execGit(workspaceRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]);
}

async function execGit(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}
