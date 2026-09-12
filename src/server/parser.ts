import path from "node:path";
import Parser from "web-tree-sitter";
import { languageIdForFile, type SupportedLanguageId } from "../shared/protocol";
import { bodyHashForText } from "./hash";
import type { Logger } from "./logger";

type SyntaxNode = Parser.SyntaxNode;

export interface ParsedNode {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  bodyHash: string;
  body: string;
}

export interface ParsedEdge {
  fromIndex: number;
  toIndex: number;
  type: "calls" | "uses_type" | "imports" | "implements" | "mutates" | "re_exports";
}

export interface UnresolvedCall {
  fromIndex: number;
  targetName: string;
  type: "calls" | "uses_type" | "imports" | "implements" | "mutates" | "re_exports";
}

export interface ParsedFile {
  language: SupportedLanguageId;
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  unresolvedCalls?: UnresolvedCall[];
}

interface TreeSitterLanguage {
  language: Parser.Language;
  parser: Parser;
}

const DECLARATION_TYPES: Record<SupportedLanguageId, string[]> = {
  rust: ["function_item", "struct_item", "enum_item", "trait_item", "impl_item", "mod_item"],
  typescript: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "variable_declaration"
  ],
  typescriptreact: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "jsx_element",
    "lexical_declaration",
    "variable_declaration"
  ],
  python: ["function_definition", "class_definition"],
  go: ["function_declaration", "method_declaration", "type_declaration", "const_declaration"],
  c: ["function_definition", "struct_specifier", "enum_specifier", "type_definition"],
  cpp: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier", "namespace_definition"],
  csharp: ["method_declaration", "class_declaration", "struct_declaration", "enum_declaration", "interface_declaration"],
  java: ["method_declaration", "class_declaration", "interface_declaration", "enum_declaration"],
  ruby: ["method", "class", "module"],
  php: ["function_definition", "method_declaration", "class_declaration", "interface_declaration", "trait_declaration"],
  zig: ["fn_proto", "container_decl"],
  bash: ["function_definition"],
  html: ["element"],
  css: ["ruleset"],
  json: ["object"],
  kotlin: ["function_declaration", "class_declaration", "object_declaration"],
  lua: ["function_definition", "local_function_definition"],
  solidity: ["function_definition", "contract_declaration", "interface_declaration", "library_declaration", "struct_definition"],
  swift: ["function_declaration", "class_declaration", "struct_declaration", "enum_declaration", "protocol_declaration"],
  yaml: ["block_mapping_pair"]
};

export class CodeParser {
  private initialized = false;
  private readonly languages = new Map<SupportedLanguageId, TreeSitterLanguage>();
  private readonly wasmDir: string;

  public constructor(
    extensionRoot: string,
    private readonly logger: Logger
  ) {
    this.wasmDir = path.join(extensionRoot, "dist", "wasm");
  }

  public async parseFile(file: string, content: string): Promise<ParsedFile | null> {
    const language = languageIdForFile(file);
    if (!language) {
      return null;
    }

    try {
      return await this.parseWithTreeSitter(language, content);
    } catch (error) {
      this.logger.warn("tree-sitter parse failed", {
        file,
        error: error instanceof Error ? error.message : String(error)
      });
      return { language, nodes: [], edges: [] };
    }
  }

  public async readNodeBody(file: string, content: string, line: number): Promise<{ text: string; lineStart: number; lineEnd: number } | null> {
    const parsed = await this.parseFile(file, content);
    if (!parsed) {
      return null;
    }
    const node = parsed.nodes
      .filter((candidate) => candidate.lineStart <= line && candidate.lineEnd >= line)
      .sort((a, b) => a.lineEnd - a.lineStart - (b.lineEnd - b.lineStart))[0];
    if (!node) {
      return null;
    }
    return { text: node.body, lineStart: node.lineStart, lineEnd: node.lineEnd };
  }

  private async parseWithTreeSitter(languageId: SupportedLanguageId, content: string): Promise<ParsedFile> {
    const language = await this.loadLanguage(languageId);
    const tree = language.parser.parse(content);
    if (!tree) {
      throw new Error("tree-sitter returned no tree");
    }

    const declarationTypes = DECLARATION_TYPES[languageId];
    const declarations = tree.rootNode
      .descendantsOfType(declarationTypes)
      .filter((node) => shouldKeepDeclaration(languageId, node));
    const nodes = declarations
      .map((node) => nodeFromSyntax(languageId, node))
      .filter((node): node is ParsedNode => node !== null);

    const { edges, unresolvedCalls } = inferEdges(nodes);
    return {
      language: languageId,
      nodes,
      edges,
      unresolvedCalls
    };
  }

  private async loadLanguage(languageId: SupportedLanguageId): Promise<TreeSitterLanguage> {
    const existing = this.languages.get(languageId);
    if (existing) {
      return existing;
    }

    if (!this.initialized) {
      await Parser.init({
        locateFile: (scriptName: string) => path.join(this.wasmDir, scriptName)
      });
      this.initialized = true;
    }

    const wasmName = languageId === "typescriptreact" ? "tsx" : languageId === "csharp" ? "c_sharp" : languageId;
    const language = await Parser.Language.load(path.join(this.wasmDir, `tree-sitter-${wasmName}.wasm`));
    const parser = new Parser();
    parser.setLanguage(language);
    const loaded = { language, parser };
    this.languages.set(languageId, loaded);
    return loaded;
  }
}

function shouldKeepDeclaration(language: SupportedLanguageId, node: SyntaxNode): boolean {
  if (language === "typescriptreact" && node.type === "jsx_element") {
    return false;
  }
  if ((language === "typescript" || language === "typescriptreact") && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
    const hasFunction = node.descendantsOfType(["arrow_function", "function_expression"]).length > 0;
    return hasFunction;
  }
  return true;
}

function nodeFromSyntax(language: SupportedLanguageId, node: SyntaxNode): ParsedNode | null {
  const name = nameForNode(language, node);
  if (!name) {
    return null;
  }
  const text = node.text.replace(/\r\n/g, "\n").trimEnd();
  const signature = signatureForText(text);
  return {
    name,
    kind: kindForNode(node.type),
    lineStart: node.startPosition.row + 1,
    lineEnd: Math.max(node.endPosition.row + 1, node.startPosition.row + 1),
    signature,
    bodyHash: bodyHashForText(text),
    body: text
  };
}

function nameForNode(language: SupportedLanguageId, node: SyntaxNode): string | null {
  const named = node.childForFieldName("name")?.text;
  if (named) {
    return named;
  }

  if (language === "rust" && node.type === "impl_item") {
    const type = node.childForFieldName("type")?.text;
    const trait = node.childForFieldName("trait")?.text;
    return trait && type ? `${trait} for ${type}` : type ? `impl ${type}` : "impl";
  }

  const identifier = node.descendantsOfType(["identifier", "type_identifier", "field_identifier"])[0]?.text;
  if (identifier) {
    return identifier;
  }

  return null;
}

function kindForNode(type: string): string {
  if (type.includes("function") || type.includes("method") || type === "lexical_declaration" || type === "variable_declaration") {
    return "function";
  }
  if (type.includes("class")) {
    return "class";
  }
  if (type.includes("struct")) {
    return "struct";
  }
  if (type.includes("enum")) {
    return "enum";
  }
  if (type.includes("trait") || type.includes("interface")) {
    return "interface";
  }
  if (type.includes("type_alias")) {
    return "type";
  }
  if (type.includes("impl")) {
    return "impl";
  }
  if (type.includes("mod")) {
    return "module";
  }
  return type.replace(/_item|_declaration|_definition/g, "");
}

function signatureForText(text: string): string {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first.length <= 180) {
    return first;
  }
  return `${first.slice(0, 177)}...`;
}

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
  "import", "export", "from", "class", "function", "def", "fn", "let", "const", "var"
]);

function inferEdges(nodes: ParsedNode[]): { edges: ParsedEdge[]; unresolvedCalls: UnresolvedCall[] } {
  const edges: ParsedEdge[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];
  // Last index wins was a bug for overloads; first wins is deterministic.
  const names = new Map<string, number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node && !names.has(node.name)) names.set(node.name, index);
  }
  const callRegex = /\b([A-Za-z_$][\w$]*)\s*(?:::<[^\n>]+>)?\s*\(/g;
  for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
    const from = nodes[fromIndex];
    if (!from) {
      continue;
    }
    for (const match of from.body.matchAll(callRegex)) {
      const targetName = match[1];
      if (!targetName || targetName === from.name || CALL_KEYWORDS.has(targetName)) {
        continue;
      }
      const toIndex = names.get(targetName);
      if (toIndex !== undefined && toIndex !== fromIndex) {
        edges.push({ fromIndex, toIndex, type: "calls" });
      } else if (toIndex === undefined) {
        unresolvedCalls.push({ fromIndex, targetName, type: "calls" });
      }
    }
  }
  const seenUnresolved = new Set<string>();
  const dedupedUnresolved = unresolvedCalls.filter((u) => {
    const key = `${u.fromIndex}:${u.targetName}:${u.type}`;
    if (seenUnresolved.has(key)) return false;
    seenUnresolved.add(key);
    return true;
  });
  return { edges: dedupeEdges(edges), unresolvedCalls: dedupedUnresolved };
}

function dedupeEdges(edges: ParsedEdge[]): ParsedEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.fromIndex}:${edge.toIndex}:${edge.type}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
