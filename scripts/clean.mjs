import { rmSync } from "node:fs";

for (const target of ["dist", "coverage", ".vscode-test"]) {
  rmSync(new URL(`../${target}`, import.meta.url), { force: true, recursive: true });
}
