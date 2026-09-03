import * as vscode from "vscode";

export class DuckStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  public constructor() {
    this.item.command = "codegraph.reindexWorkspace";
    this.setStarting();
    this.item.show();
  }

  public setStarting(): void {
    this.item.text = "$(sync~spin) CodeGraph starting";
    this.item.tooltip = "CodeGraph daemon is starting";
  }

  public setIndexing(): void {
    this.item.text = "$(sync~spin) CodeGraph indexing";
    this.item.tooltip = "CodeGraph is indexing supported workspace files";
  }

  public setReady(indexedNodes?: number): void {
    this.item.text = "$(check) CodeGraph ready";
    this.item.tooltip = indexedNodes === undefined ? "CodeGraph is ready" : `CodeGraph is ready (${indexedNodes} indexed nodes)`;
  }

  public setBlocked(message: string): void {
    this.item.text = "$(warning) CodeGraph blocked";
    this.item.tooltip = message;
  }

  public setError(message: string): void {
    this.item.text = "$(error) CodeGraph error";
    this.item.tooltip = message;
  }

  public dispose(): void {
    this.item.dispose();
  }
}

export { DuckStatus as CodeGraphStatus };
