import * as vscode from "vscode";
import { languageIdForFile, type SupportedLanguageId } from "../shared/protocol";
import type { DuckGraphClient } from "./client";
import { collectLspReferences } from "./lsp";

const EXCLUDE =
  "{**/node_modules/**,**/.git/**,**/.codegraph/**,**/.duckgraph/**,**/dist/**,**/out/**,**/target/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.next/**,**/kilocode/**,**/.vscode-test/**,**/.vscode/**}";

const MAX_FILE_BYTES = 1_000_000;

export class WorkspaceIndexer {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly client: DuckGraphClient,
    private readonly enabledLanguages: SupportedLanguageId[],
    private readonly output: vscode.OutputChannel
  ) {}

  public async indexWorkspace(): Promise<void> {
    const files = await vscode.workspace.findFiles(
      "**/*.{rs,ts,mts,cts,tsx,jsx,js,mjs,cjs,py,go,c,h,cpp,cc,cxx,hpp,hh,cs,java,rb,php,zig,sh,bash,zsh,html,htm,css,json,kt,kts,lua,sol,swift,yaml,yml}",
      EXCLUDE,
      5000
    );
    const supported = files.filter((uri) => {
      const language = languageIdForFile(uri.fsPath);
      return language ? this.enabledLanguages.includes(language) : false;
    });
    if (files.length >= 5000) {
      this.output.appendLine("CodeGraph: workspace file cap (5000) reached; some files were skipped.");
    }

    let indexed = 0;
    for (let index = 0; index < supported.length; index += 50) {
      const chunk = supported.slice(index, index + 50);
      const payload = [];
      for (const uri of chunk) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_FILE_BYTES) continue;
          const bytes = await vscode.workspace.fs.readFile(uri);
          payload.push({
            file: uri.fsPath,
            content: new TextDecoder().decode(bytes),
            workspace_root: this.workspaceRoot
          });
        } catch {
          this.output.appendLine(`CodeGraph: skipped unreadable file ${uri.fsPath}`);
        }
      }
      if (payload.length === 0) continue;
      try {
        await this.client.indexBatch({
          workspace_root: this.workspaceRoot,
          files: payload
        });
        indexed += payload.length;
      } catch (error) {
        this.output.appendLine(
          `CodeGraph: index batch failed (${payload.length} files): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.output.appendLine(`CodeGraph indexed ${indexed} workspace files.`);
  }

  public async indexSavedDocument(document: vscode.TextDocument): Promise<void> {
    const language = languageIdForFile(document.uri.fsPath);
    if (!language || !this.enabledLanguages.includes(language)) {
      return;
    }

    try {
      await this.client.indexFile({
        file: document.uri.fsPath,
        content: document.getText(),
        workspace_root: this.workspaceRoot
      });
    } catch (error) {
      this.output.appendLine(`CodeGraph save-index failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    setTimeout(() => {
      collectLspReferences(document)
        .then((references) => {
          if (references.length > 0) {
            return this.client.indexLsp({ workspace_root: this.workspaceRoot, references });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          this.output.appendLine(`CodeGraph LSP bridge failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, 50);
  }
}

export { WorkspaceIndexer as CodeGraphWorkspaceIndexer };
