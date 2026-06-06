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
  const output = vscode.window.createOutputChannel("DuckGraph");
  const status = new DuckStatus();
  context.subscriptions.push(output, status);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    status.setBlocked("Open a workspace folder to use DuckGraph.");
    return;
  }

  registerCommands(context, workspaceRoot, status);

  if (!vscode.workspace.isTrusted) {
    status.setBlocked("DuckGraph waits for Workspace Trust before indexing.");
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
        void indexer?.indexSavedDocument(document);
      })
    );

    if (config.indexOnStartup) {
      status.setIndexing();
      await indexer.indexWorkspace();
    }
    const health = await client.health();
    status.setReady(health.indexedNodes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.setError(message);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`DuckGraph failed to start: ${message}`);
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
  // Register specifically for markdown to support grounding inside markdown documents (like project-idea.md)
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: "markdown", scheme: "file" }, provider));
}

function registerCommands(context: vscode.ExtensionContext, workspaceRoot: string, status: DuckStatus): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("duckgraph.reindexWorkspace", async () => {
      if (!indexer || !daemon?.getClient()) {
        return;
      }
      status.setIndexing();
      await indexer.indexWorkspace();
      const health = await daemon.getClient()?.health();
      status.setReady(health?.indexedNodes);
    }),
    vscode.commands.registerCommand("duckgraph.explainAtCursor", async () => {
      const editor = vscode.window.activeTextEditor;
      const client = daemon?.getClient();
      if (!editor || !client) {
        return;
      }
      const config = readDuckConfig();
      const position = editor.selection.active;
      const range = editor.document.getWordRangeAtPosition(position);
      const symbol = range ? editor.document.getText(range) : undefined;
      if (!symbol) {
        return;
      }
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
    }),
    vscode.commands.registerCommand("duckgraph.showOrbitGraph", async () => {
      const client = daemon?.getClient();
      if (client) {
        await showOrbitGraph(context, client);
      }
    }),
    vscode.commands.registerCommand("duckgraph.clearCache", async () => {
      const client = daemon?.getClient();
      if (!client) {
        return;
      }
      await client.clearCache();
      await vscode.window.showInformationMessage("DuckGraph explanation cache cleared.");
    }),
    vscode.commands.registerCommand("duckgraph.confirmInferredEdge", async (request: EdgeDecisionRequest) => {
      await daemon?.getClient()?.confirmEdge(request);
    }),
    vscode.commands.registerCommand("duckgraph.dismissInferredEdge", async (request: EdgeDecisionRequest) => {
      await daemon?.getClient()?.dismissEdge(request);
    })
  );
}
