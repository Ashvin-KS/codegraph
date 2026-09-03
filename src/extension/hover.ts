import * as vscode from "vscode";
import type { ExplainResponse, UserLevel } from "../shared/protocol";
import type { DuckGraphClient } from "./client";

export interface DuckHoverConfig {
  hoverMode: string;
  userLevel: string;
  llamaUrl: string;
  maxEdges: number;
  debugGraphJson: boolean;
}

export class DuckHoverProvider implements vscode.HoverProvider {
  public constructor(
    private readonly clientProvider: () => DuckGraphClient | null,
    private readonly workspaceRoot: string,
    private readonly configProvider: () => DuckHoverConfig
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const config = this.configProvider();
    if (config.hoverMode === "commandOnly") {
      return undefined;
    }

    const client = this.clientProvider();
    if (!client) {
      return undefined;
    }

    const range = document.getWordRangeAtPosition(position);
    const symbol = range ? document.getText(range) : undefined;
    if (!symbol || token.isCancellationRequested) {
      return undefined;
    }

    const validLevels: UserLevel[] = ["beginner", "intermediate", "expert"];
    const userLevel: UserLevel = (validLevels as string[]).includes(config.userLevel)
      ? (config.userLevel as UserLevel)
      : "intermediate";
    let response: ExplainResponse;
    try {
      response = await client.explain({
        symbol,
        file: document.uri.fsPath,
        line: position.line + 1,
        depth: 1,
        user_level: userLevel,
        workspace_root: this.workspaceRoot,
        llama_url: config.llamaUrl,
        max_edges: config.maxEdges,
        debug_graph_json: config.debugGraphJson
      });
    } catch {
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }

    return new vscode.Hover(renderHover(response), range);
  }
}

export function renderHover(response: ExplainResponse): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = {
    enabledCommands: [
      "codegraph.confirmInferredEdge",
      "codegraph.dismissInferredEdge",
      "duckgraph.confirmInferredEdge",
      "duckgraph.dismissInferredEdge"
    ]
  };
  markdown.supportHtml = false;

  // Clean up any copy-pasted or escaped HTML entities in the explanation
  const cleanExplanation = response.explanation
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  markdown.appendMarkdown(cleanExplanation.replace(/\n/g, "\n\n"));

  if (response.target?.signature) {
    // Clean up spaces, HTML characters, and double-slashed curly braces
    const cleanSignature = response.target.signature
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\\\{/g, "{")
      .replace(/\\\}/g, "}");

    const ext = response.target.file.split(".").pop() ?? "";
    const language = ext === "rs" ? "rust" : ext === "py" ? "python" : "typescript";

    markdown.appendCodeblock(cleanSignature, language);
  }

  const badges = [];
  if (response.from_cache) {
    badges.push("cache");
  }
  if (response.stale) {
    badges.push(`stale${response.target?.stale_reason ? `: ${response.target.stale_reason}` : ""}`);
  }
  if (response.source_used) {
    badges.push("source-read");
  }
  if (badges.length > 0) {
    markdown.appendMarkdown(`\n\n_${badges.join(" | ")}_`);
  }

  for (const edge of response.inferred_edges) {
    const confirm = commandUri("codegraph.confirmInferredEdge", { edge_id: edge.id });
    const dismiss = commandUri("codegraph.dismissInferredEdge", { edge_id: edge.id });
    markdown.appendMarkdown(`\n\nInferred ${edge.type} ${edge.target_name}: [confirm](${confirm}) [dismiss](${dismiss})`);
  }

  if (response.debug_graph_json) {
    markdown.appendMarkdown("\n\n```json\n");
    markdown.appendText(response.debug_graph_json);
    markdown.appendMarkdown("\n```");
  }

  return markdown;
}

function commandUri(command: string, arg: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([arg]))}`;
}

export { DuckHoverProvider as CodeHoverProvider };
