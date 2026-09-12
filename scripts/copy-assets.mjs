import { cpSync, copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url);
const distWasm = new URL("../dist/wasm/", import.meta.url);
const media = new URL("../media/", import.meta.url);
mkdirSync(distWasm, { recursive: true });
mkdirSync(media, { recursive: true });

const treeSitterPackage = packageRoot(require.resolve("web-tree-sitter"));
for (const wasmName of ["tree-sitter.wasm", "web-tree-sitter.wasm"]) {
  const src = join(treeSitterPackage, wasmName);
  if (existsSync(src)) {
    copyFileSync(src, new URL(wasmName, distWasm));
  }
}

for (const name of ["rust", "typescript", "tsx", "python", "go", "c", "cpp", "c_sharp", "java", "ruby", "php", "bash", "html", "css", "json", "kotlin", "lua", "solidity", "swift", "yaml", "zig"]) {
  try {
    copyFileSync(
      require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`),
      new URL(`tree-sitter-${name}.wasm`, distWasm)
    );
  } catch {
    console.warn(`CodeGraph: optional wasm tree-sitter-${name}.wasm not found; regex fallback will be used.`);
  }
}

const d3Package = packageRoot(require.resolve("d3"));
copyFileSync(join(d3Package, "dist", "d3.min.js"), new URL("d3.min.js", media));

const distNodeModules = new URL("../dist/node_modules/", import.meta.url);
rmSync(distNodeModules, { recursive: true, force: true });
mkdirSync(distNodeModules, { recursive: true });
copyRuntimePackage("better-sqlite3", ["lib", "build/Release/better_sqlite3.node", "package.json"]);
copyRuntimePackage("bindings", ["bindings.js", "package.json"]);
copyRuntimePackage("file-uri-to-path", ["index.js", "package.json"]);

console.log(`Copied CodeGraph assets under ${root.pathname}`);

function packageRoot(resolvedEntry) {
  let current = dirname(resolvedEntry);
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find package root for ${resolvedEntry}`);
    }
    current = parent;
  }
  return current;
}

function copyRuntimePackage(packageName, entries) {
  const packageRootDir = packageRoot(require.resolve(packageName));
  const targetRoot = new URL(`../dist/node_modules/${packageName}/`, import.meta.url);
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of entries) {
    const source = join(packageRootDir, entry);
    const target = new URL(entry.replace(/\\/g, "/"), targetRoot);
    mkdirSync(new URL("./", target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}
