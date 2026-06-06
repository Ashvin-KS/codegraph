import * as vscode from "vscode";
import type { LspReferenceLocation } from "../shared/protocol";

export async function collectLspReferences(document: vscode.TextDocument, limit = 50): Promise<LspReferenceLocation[]> {
  const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
    "vscode.executeDocumentSymbolProvider",
    document.uri
  );
  if (!symbols) {
    return [];
  }

  const flattened = flattenSymbols(symbols).slice(0, limit);
  const results: LspReferenceLocation[] = [];
  for (const symbol of flattened) {
    const position = symbol.selectionRange.start;
    const references = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
      "vscode.executeReferenceProvider",
      document.uri,
      position
    );
    if (!references || references.length === 0) {
      continue;
    }
    results.push({
      symbol: symbol.name,
      file: document.uri.fsPath,
      line: position.line + 1,
      references: references.map((reference) => ({
        file: reference.uri.fsPath,
        line: reference.range.start.line + 1
      }))
    });
  }
  return results;
}

interface FlatSymbol {
  name: string;
  selectionRange: vscode.Range;
}

function flattenSymbols(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): FlatSymbol[] {
  const result: FlatSymbol[] = [];
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      result.push({ name: symbol.name, selectionRange: symbol.selectionRange });
      result.push(...flattenSymbols(symbol.children));
    } else {
      result.push({ name: symbol.name, selectionRange: symbol.location.range });
    }
  }
  return result;
}

function isDocumentSymbol(value: vscode.DocumentSymbol | vscode.SymbolInformation): value is vscode.DocumentSymbol {
  return "children" in value && "selectionRange" in value;
}
