import * as vscode from "vscode";

export class DuckStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  public constructor() {
    this.item.command = "duckgraph.reindexWorkspace";
    this.setStarting();
    this.item.show();
  }

  public setStarting(): void {
    this.item.text = "$(sync~spin) DuckGraph starting";
    this.item.tooltip = "DuckGraph daemon is starting";
  }

  public setIndexing(): void {
    this.item.text = "$(sync~spin) DuckGraph indexing";
    this.item.tooltip = "DuckGraph is indexing supported workspace files";
  }

  public setReady(indexedNodes?: number): void {
    this.item.text = "$(check) DuckGraph ready";
    this.item.tooltip = indexedNodes === undefined ? "DuckGraph is ready" : `DuckGraph is ready (${indexedNodes} indexed nodes)`;
  }

  public setBlocked(message: string): void {
    this.item.text = "$(warning) DuckGraph blocked";
    this.item.tooltip = message;
  }

  public setError(message: string): void {
    this.item.text = "$(error) DuckGraph error";
    this.item.tooltip = message;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
