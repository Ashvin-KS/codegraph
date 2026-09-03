// Assembles release/ — the minimal GitHub-postable set — from canonical sources.
// Re-run with `npm run release` after rebuilding the vsix or changing build-production/.
// Static files (install.ps1, install.sh, README.md) are author-maintained and left untouched.
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");

function fail(message) {
  console.error(`[release] FAIL: ${message}`);
  process.exit(1);
}

// 1) Refresh release/mcp from build-production/ (the shippable MCP, nothing else).
const mcpSrc = path.join(root, "build-production");
if (!existsSync(path.join(mcpSrc, "package.json"))) fail("build-production/ is missing; nothing to release");
rmSync(path.join(release, "mcp"), { recursive: true, force: true });
mkdirSync(path.join(release, "mcp"), { recursive: true });
for (const entry of ["package.json", "README.md", "bin", "src", "examples"]) {
  const from = path.join(mcpSrc, entry);
  if (!existsSync(from)) fail(`build-production/${entry} is missing`);
  cpSync(from, path.join(release, "mcp", entry), { recursive: true });
}
console.log("[release] mcp/ refreshed from build-production/");

// 2) Copy docs.
for (const doc of ["LICENSE.txt", "CHANGELOG.md"]) {
  copyFileSync(path.join(root, doc), path.join(release, doc));
}

// 3) Copy the newest codegraph-*.vsix (the installable extension, no source needed).
const vsix = readdirSync(root)
  .filter((f) => /^codegraph-.*\.vsix$/.test(f))
  .sort()
  .pop();
if (!vsix) fail("no codegraph-*.vsix found; run `npm run package` first");
for (const old of readdirSync(release).filter((f) => /^codegraph-.*\.vsix$/.test(f) && f !== vsix)) {
  rmSync(path.join(release, old));
}
copyFileSync(path.join(root, vsix), path.join(release, vsix));
console.log(`[release] extension: ${vsix}`);

// 4) Static installer files must exist.
for (const file of ["install.ps1", "install.sh", "README.md"]) {
  if (!existsSync(path.join(release, file))) fail(`release/${file} is missing`);
}

// 5) Manifest.
let bytes = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else bytes += statSync(full).size;
  }
}
walk(release);
console.log(`[release] ready: ${release} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
