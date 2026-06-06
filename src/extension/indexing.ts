import * as vscode from "vscode";
import { languageIdForFile, type SupportedLanguageId } from "../shared/protocol";
import type { DuckGraphClient } from "./client";
import { collectLspReferences } from "./lsp";

const EXCLUDE = "{**/node_modules/**,**/.git/**,**/.duckgraph/**,**/dist/**,**/out/**,**/target/**,**/.venv/**}";

export class WorkspaceIndexer {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly client: DuckGraphClient,
    private readonly enabledLanguages: SupportedLanguageId[],
    private readonly output: vscode.OutputChannel
  ) {}

  public async indexWorkspace(): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*.{rs,ts,tsx,py}", EXCLUDE, 5000);
    const supported = files.filter((uri) => {
      const language = languageIdForFile(uri.fsPath);
      return language ? this.enabledLanguages.includes(language) : false;
    });

    for (let index = 0; index < supported.length; index += 50) {
      const chunk = supported.slice(index, index + 50);
      const payload = [];
      for (const uri of chunk) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        payload.push({
          file: uri.fsPath,
          content: new TextDecoder().decode(bytes),
          workspace_root: this.workspaceRoot
        });
      }
      await this.client.indexBatch({
        workspace_root: this.workspaceRoot,
        files: payload
      });
    }
    this.output.appendLine(`DuckGraph indexed ${supported.length} workspace files.`);
  }

  public async indexSavedDocument(document: vscode.TextDocument): Promise<void> {
    const language = languageIdForFile(document.uri.fsPath);
    if (!language || !this.enabledLanguages.includes(language)) {
      return;
    }

    await this.client.indexFile({
      file: document.uri.fsPath,
      content: document.getText(),
      workspace_root: this.workspaceRoot
    });

    setTimeout(() => {
      collectLspReferences(document)
        .then((references) => {
          if (references.length > 0) {
            return this.client.indexLsp({ workspace_root: this.workspaceRoot, references });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          this.output.appendLine(`DuckGraph LSP bridge failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, 50);
  }
}
