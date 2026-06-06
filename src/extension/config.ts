import * as vscode from "vscode";
import { isSupportedLanguageId, type HoverMode, type SupportedLanguageId, type UserLevel } from "../shared/protocol";

export interface DuckConfig {
  llamaUrl: string;
  userLevel: UserLevel;
  enabledLanguages: SupportedLanguageId[];
  hoverMode: HoverMode;
  indexOnStartup: boolean;
  maxEdges: number;
  debugGraphJson: boolean;
}

export function readDuckConfig(): DuckConfig {
  const config = vscode.workspace.getConfiguration("duckgraph");
  const enabled = config.get<string[]>("enabledLanguages", ["rust", "typescript", "typescriptreact", "python"]);
  return {
    llamaUrl: config.get<string>("llamaUrl", "http://localhost:8080/completion"),
    userLevel: config.get<UserLevel>("userLevel", "intermediate"),
    enabledLanguages: enabled.filter(isSupportedLanguageId),
    hoverMode: config.get<HoverMode>("hoverMode", "always"),
    indexOnStartup: config.get<boolean>("indexOnStartup", true),
    maxEdges: config.get<number>("maxEdges", 15),
    debugGraphJson: config.get<boolean>("debugGraphJson", false)
  };
}
