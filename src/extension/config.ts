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

export type CodeGraphConfig = DuckConfig;

function readSection(section: string): DuckConfig | null {
  try {
    const config = vscode.workspace.getConfiguration(section);
    if (!config) return null;
    const enabled = config.get<string[]>("enabledLanguages", ["rust", "typescript", "typescriptreact", "python"]);
    return {
      llamaUrl: config.get<string>("llamaUrl", "http://localhost:8080/completion"),
      userLevel: config.get<UserLevel>("userLevel", "intermediate"),
      enabledLanguages: (enabled ?? []).filter(isSupportedLanguageId),
      hoverMode: config.get<HoverMode>("hoverMode", "always"),
      indexOnStartup: config.get<boolean>("indexOnStartup", true),
      maxEdges: config.get<number>("maxEdges", 15),
      debugGraphJson: config.get<boolean>("debugGraphJson", false)
    };
  } catch {
    return null;
  }
}

export function readDuckConfig(): DuckConfig {
  // New namespace first, legacy duckgraph.* as fallback so the rename
  // doesn't silently reset existing user settings.
  return readSection("codegraph") ?? readSection("duckgraph") ?? {
    llamaUrl: "http://localhost:8080/completion",
    userLevel: "intermediate",
    enabledLanguages: ["rust", "typescript", "typescriptreact", "python"],
    hoverMode: "always",
    indexOnStartup: true,
    maxEdges: 15,
    debugGraphJson: false
  };
}

export { readDuckConfig as readCodeGraphConfig };
