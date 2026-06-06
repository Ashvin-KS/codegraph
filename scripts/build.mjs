import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external: ["vscode", "better-sqlite3"]
};

const builds = [
  {
    ...common,
    entryPoints: ["src/extension/extension.ts"],
    outfile: "dist/extension.js"
  },
  {
    ...common,
    entryPoints: ["src/server/main.ts"],
    outfile: "dist/server.js"
  },
  {
    ...common,
    entryPoints: ["src/extension/test/suite/index.ts"],
    outfile: "dist/extensionTest/suite/index.js"
  }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("DuckGraph build watcher is running.");
} else {
  await Promise.all(builds.map((options) => build(options)));
}
