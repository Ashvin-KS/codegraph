import assert from "node:assert";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("local-duckgraph.duckgraph");
  assert.ok(extension, "DuckGraph extension should be discoverable in the extension host");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("duckgraph.reindexWorkspace"), "DuckGraph reindex command should be registered");
  assert.ok(commands.includes("duckgraph.explainAtCursor"), "DuckGraph explain command should be registered");
}
