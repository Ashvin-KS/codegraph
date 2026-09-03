import * as vscode from "vscode";
import type { EdgeDecisionRequest, SupportedLanguageId } from "../shared/protocol";
import { SUPPORTED_LANGUAGE_IDS } from "../shared/protocol";
import { readDuckConfig } from "./config";
import { DaemonManager } from "./daemon";
import { DuckHoverProvider } from "./hover";
import { WorkspaceIndexer } from "./indexing";
import { showOrbitGraph } from "./orbit";
import { DuckStatus } from "./status";

let daemon: DaemonManager | null = null;
let indexer: WorkspaceIndexer | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("CodeGraph");
  const status = new DuckStatus();
  context.subscriptions.push(output, status);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    status.setBlocked("Open a workspace folder to use CodeGraph.");
    return;
  }

  registerCommands(context, workspaceRoot, status, output);

  if (!vscode.workspace.isTrusted) {
    status.setBlocked("CodeGraph waits for Workspace Trust before indexing.");
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void startTrusted(context, workspaceRoot, output, status);
      })
    );
    return;
  }

  void startTrusted(context, workspaceRoot, output, status);
}

export async function deactivate(): Promise<void> {
  await daemon?.stop();
}

async function startTrusted(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  output: vscode.OutputChannel,
  status: DuckStatus
): Promise<void> {
  try {
    const config = readDuckConfig();
    status.setStarting();
    daemon = new DaemonManager(context, workspaceRoot, output);
    context.subscriptions.push(daemon);
    const client = await daemon.start(config.llamaUrl);
    indexer = new WorkspaceIndexer(workspaceRoot, client, config.enabledLanguages, output);

    registerHoverProviders(context, workspaceRoot, config.enabledLanguages);
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void indexer?.indexSavedDocument(document).catch((error: unknown) => {
          output.appendLine(`CodeGraph save-index failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      })
    );

    if (config.indexOnStartup) {
      status.setIndexing();
      try {
        await indexer.indexWorkspace();
      } catch (error) {
        output.appendLine(`CodeGraph startup index failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const health = await client.health();
    status.setReady(health.indexedNodes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.setError(message);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`CodeGraph failed to start: ${message}`);
  }
}

function registerHoverProviders(context: vscode.ExtensionContext, workspaceRoot: string, enabledLanguages: SupportedLanguageId[]): void {
  const provider = new DuckHoverProvider(
    () => daemon?.getClient() ?? null,
    workspaceRoot,
    () => {
      const config = readDuckConfig();
      return {
        hoverMode: config.hoverMode,
        userLevel: config.userLevel,
        llamaUrl: config.llamaUrl,
        maxEdges: config.maxEdges,
        debugGraphJson: config.debugGraphJson
      };
    }
  );
  for (const language of SUPPORTED_LANGUAGE_IDS) {
    if (enabledLanguages.includes(language)) {
      context.subscriptions.push(vscode.languages.registerHoverProvider({ language, scheme: "file" }, provider));
    }
  }
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: "markdown", scheme: "file" }, provider));
}

function registerCommands(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  status: DuckStatus,
  output: vscode.OutputChannel
): void {
  const reindex = async () => {
    if (!indexer || !daemon?.getClient()) return;
    status.setIndexing();
    try {
      await indexer.indexWorkspace();
      const health = await daemon.getClient()?.health();
      status.setReady(health?.indexedNodes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.setError(message);
      output.appendLine(`CodeGraph reindex failed: ${message}`);
      void vscode.window.showErrorMessage(`CodeGraph reindex failed: ${message}`);
    }
  };
  const explainAtCursor = async () => {
    const editor = vscode.window.activeTextEditor;
    const client = daemon?.getClient();
    if (!editor || !client) return;
    try {
      const config = readDuckConfig();
      const position = editor.selection.active;
      const range = editor.document.getWordRangeAtPosition(position);
      const symbol = range ? editor.document.getText(range) : undefined;
      if (!symbol) return;
      const response = await client.explain({
        symbol,
        file: editor.document.uri.fsPath,
        line: position.line + 1,
        depth: 2,
        user_level: config.userLevel,
        workspace_root: workspaceRoot,
        llama_url: config.llamaUrl,
        max_edges: config.maxEdges,
        debug_graph_json: config.debugGraphJson
      });
      await vscode.window.showInformationMessage(response.explanation.replace(/\s+/g, " "));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`CodeGraph explain failed: ${message}`);
      void vscode.window.showErrorMessage(`CodeGraph explain failed: ${message}`);
    }
  };
  const showOrbit = async () => {
    const client = daemon?.getClient();
    if (!client) return;
    try {
      await showOrbitGraph(context, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`CodeGraph orbit failed: ${message}`);
      void vscode.window.showErrorMessage(`CodeGraph orbit failed: ${message}`);
    }
  };
  const clearCache = async () => {
    const client = daemon?.getClient();
    if (!client) return;
    try {
      await client.clearCache();
      await vscode.window.showInformationMessage("CodeGraph explanation cache cleared.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`CodeGraph clear cache failed: ${message}`);
    }
  };
  const confirmEdge = async (request: EdgeDecisionRequest) => {
    try {
      await daemon?.getClient()?.confirmEdge(request);
    } catch (error) {
      output.appendLine(`CodeGraph confirm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const dismissEdge = async (request: EdgeDecisionRequest) => {
    try {
      await daemon?.getClient()?.dismissEdge(request);
    } catch (error) {
      output.appendLine(`CodeGraph dismiss failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // New codegraph.* commands + legacy duckgraph.* aliases so the rename
  // never breaks existing keybindings, hover buttons, or user configs.
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.reindexWorkspace", reindex),
    vscode.commands.registerCommand("duckgraph.reindexWorkspace", reindex),
    vscode.commands.registerCommand("codegraph.explainAtCursor", explainAtCursor),
    vscode.commands.registerCommand("duckgraph.explainAtCursor", explainAtCursor),
    vscode.commands.registerCommand("codegraph.showOrbitGraph", showOrbit),
    vscode.commands.registerCommand("duckgraph.showOrbitGraph", showOrbit),
    vscode.commands.registerCommand("codegraph.clearCache", clearCache),
    vscode.commands.registerCommand("duckgraph.clearCache", clearCache),
    vscode.commands.registerCommand("codegraph.confirmInferredEdge", confirmEdge),
    vscode.commands.registerCommand("duckgraph.confirmInferredEdge", confirmEdge),
    vscode.commands.registerCommand("codegraph.dismissInferredEdge", dismissEdge),
    vscode.commands.registerCommand("duckgraph.dismissInferredEdge", dismissEdge)
  );
}
