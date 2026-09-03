import path from "node:path";

export function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function relativeWorkspaceFile(workspaceRoot, absoluteFile) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedFile = path.resolve(workspaceRoot, absoluteFile);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const rootCmp = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
  const fileCmp = caseInsensitive ? resolvedFile.toLowerCase() : resolvedFile;
  if (fileCmp === rootCmp || fileCmp.startsWith(rootCmp + path.sep)) {
    const rel = resolvedFile.slice(resolvedRoot.length).replace(/^[/\\]+/, "");
    return normalizePath(rel);
  }
  return normalizePath(path.relative(resolvedRoot, resolvedFile));
}

export function normalizeWorkspaceFile(workspaceRoot, file) {
  const absolute = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
  return relativeWorkspaceFile(workspaceRoot, absolute);
}

export function absoluteWorkspaceFile(workspaceRoot, file) {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

export function assertInsideWorkspace(workspaceRoot, file) {
  const absolute = absoluteWorkspaceFile(workspaceRoot, file);
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(absolute);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const rootCmp = caseInsensitive ? root.toLowerCase() : root;
  const fileCmp = caseInsensitive ? resolved.toLowerCase() : resolved;
  if (fileCmp !== rootCmp && !fileCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`File escapes workspace: ${file}`);
  }
  return absolute;
}
