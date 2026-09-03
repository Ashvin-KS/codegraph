import assert from "node:assert";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension =
    vscode.extensions.getExtension("kilocode-x.codegraph") ??
    vscode.extensions.getExtension("local-duckgraph.duckgraph");
  assert.ok(extension, "CodeGraph extension should be discoverable in the extension host");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("codegraph.reindexWorkspace"), "CodeGraph reindex command should be registered");
  assert.ok(commands.includes("codegraph.explainAtCursor"), "CodeGraph explain command should be registered");
  // Legacy aliases must keep working after the rename.
  assert.ok(commands.includes("duckgraph.reindexWorkspace"), "Legacy duckgraph alias should still be registered");
}
