import { runTests } from "@vscode/test-electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(__dirname, "..");
const extensionTestsPath = resolve(__dirname, "../dist/extensionTest/suite/index.js");
const workspacePath = resolve(__dirname, "../test/fixtures/workspace");

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [workspacePath, "--disable-extensions"]
});
