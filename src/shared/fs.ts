import path from "node:path";

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function relativeWorkspaceFile(workspaceRoot: string, absoluteFile: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedFile = path.resolve(workspaceRoot, absoluteFile);
  // Case-insensitive prefix check only on case-insensitive platforms.
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const rootCmp = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
  const fileCmp = caseInsensitive ? resolvedFile.toLowerCase() : resolvedFile;
  if (fileCmp === rootCmp || fileCmp.startsWith(rootCmp + path.sep)) {
    const rel = resolvedFile.slice(resolvedRoot.length);
    const trimmed = rel.replace(/^[/\\]+/, "");
    return normalizePath(trimmed);
  }
  return normalizePath(path.relative(resolvedRoot, resolvedFile));
}

export function normalizeWorkspaceFile(workspaceRoot: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
  return relativeWorkspaceFile(workspaceRoot, absolute);
}

export function absoluteWorkspaceFile(workspaceRoot: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
