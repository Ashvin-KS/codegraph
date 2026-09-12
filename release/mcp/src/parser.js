// Pure Tree-Sitter WASM AST parser — zero regex, zero native build toolchain.
import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { languageIdForFile } from "./protocol.js";
import { bodyHashForText } from "./hash.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let initialized = false;
const languageCache = new Map();

function resolveWasmFile(name) {
  // 1. Check local wasm folder in build-production
  const localWasm = path.join(__dirname, "../wasm", name);
  if (fs.existsSync(localWasm)) return localWasm;
  // 2. Resolve from node_modules packages
  try {
    if (name === "tree-sitter.wasm" || name === "web-tree-sitter.wasm") {
      return require.resolve(`web-tree-sitter/${name}`);
    }
    return require.resolve(`tree-sitter-wasms/out/${name}`);
  } catch {}
  return null;
}

async function ensureTreeSitterInit() {
  if (initialized) return;
  const mainWasm = resolveWasmFile("tree-sitter.wasm");
  if (!mainWasm) throw new Error("TreeSitter core WASM not found");
  await Parser.init({
    locateFile: () => mainWasm
  });
  initialized = true;
}

async function loadLanguage(languageId) {
  const existing = languageCache.get(languageId);
  if (existing) return existing;

  await ensureTreeSitterInit();

  const wasmName = languageId === "typescriptreact" ? "tsx" : languageId === "csharp" ? "c_sharp" : languageId;
  const wasmFile = resolveWasmFile(`tree-sitter-${wasmName}.wasm`);
  if (!wasmFile) return null;

  try {
    const language = await Parser.Language.load(wasmFile);
    const parser = new Parser();
    parser.setLanguage(language);
    const entry = { language, parser };
    languageCache.set(languageId, entry);
    return entry;
  } catch {
    return null;
  }
}

const DECLARATION_TYPES = {
  rust: ["function_item", "struct_item", "enum_item", "trait_item", "impl_item", "mod_item"],
  typescript: [
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "enum_declaration",
    "lexical_declaration", "variable_declaration"
  ],
  typescriptreact: [
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "enum_declaration",
    "lexical_declaration", "variable_declaration"
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

function shouldKeepDeclaration(language, node) {
  if (language === "typescriptreact" && node.type === "jsx_element") return false;
  if ((language === "typescript" || language === "typescriptreact") && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
    return node.descendantsOfType(["arrow_function", "function_expression"]).length > 0;
  }
  return true;
}

function nameForNode(language, node) {
  const named = node.childForFieldName("name")?.text;
  if (named) return named;

  if (language === "rust" && node.type === "impl_item") {
    const type = node.childForFieldName("type")?.text;
    const trait = node.childForFieldName("trait")?.text;
    return trait && type ? `${trait} for ${type}` : type ? `impl ${type}` : "impl";
  }

  const identifier = node.descendantsOfType(["identifier", "type_identifier", "field_identifier"])[0]?.text;
  if (identifier) return identifier;

  return null;
}

function kindForNode(type) {
  if (type.includes("function") || type.includes("method") || type === "lexical_declaration" || type === "variable_declaration") {
    return "function";
  }
  if (type.includes("class")) return "class";
  if (type.includes("struct")) return "struct";
  if (type.includes("enum")) return "enum";
  if (type.includes("trait") || type.includes("interface")) return "interface";
  if (type.includes("type_alias")) return "type";
  if (type.includes("impl")) return "impl";
  if (type.includes("mod")) return "module";
  return type.replace(/_item|_declaration|_definition/g, "");
}

function signatureForText(text) {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.length <= 180 ? first : `${first.slice(0, 177)}...`;
}

function nodeFromSyntax(language, node) {
  const name = nameForNode(language, node);
  if (!name) return null;
  const text = node.text.replace(/\r\n/g, "\n").trimEnd();
  return {
    name,
    kind: kindForNode(node.type),
    lineStart: node.startPosition.row + 1,
    lineEnd: Math.max(node.endPosition.row + 1, node.startPosition.row + 1),
    signature: signatureForText(text),
    bodyHash: bodyHashForText(text),
    body: text
  };
}

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
  "import", "export", "from", "class", "function", "def", "fn",
  "let", "const", "var", "new", "await", "async"
]);

function inferEdges(nodes) {
  const edges = [];
  const unresolvedCalls = [];
  const names = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n && !names.has(n.name)) names.set(n.name, i);
  }
  const callRegex = /\b([A-Za-z_$][\w$]*)\s*(?:::<[^\n>]+>)?\s*\(/g;
  for (let from = 0; from < nodes.length; from += 1) {
    const node = nodes[from];
    if (!node) continue;
    for (const m of node.body.matchAll(callRegex)) {
      const target = m[1];
      if (!target || target === node.name || CALL_KEYWORDS.has(target)) continue;
      const to = names.get(target);
      if (to !== undefined && to !== from) {
        edges.push({ fromIndex: from, toIndex: to, type: "calls" });
      } else if (to === undefined) {
        unresolvedCalls.push({ fromIndex: from, targetName: target, type: "calls" });
      }
    }
  }
  const seen = new Set();
  const filteredEdges = edges.filter((e) => {
    const k = `${e.fromIndex}:${e.toIndex}:${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const seenUnresolved = new Set();
  const filteredUnresolved = unresolvedCalls.filter((u) => {
    const k = `${u.fromIndex}:${u.targetName}:${u.type}`;
    if (seenUnresolved.has(k)) return false;
    seenUnresolved.add(k);
    return true;
  });
  return { edges: filteredEdges, unresolvedCalls: filteredUnresolved };
}

export async function parseFile(file, content) {
  const language = languageIdForFile(file);
  if (!language) return null;

  try {
    const langEntry = await loadLanguage(language);
    if (!langEntry) return { language, nodes: [], edges: [], unresolvedCalls: [] };

    const tree = langEntry.parser.parse(String(content));
    if (!tree) return { language, nodes: [], edges: [], unresolvedCalls: [] };

    const declarationTypes = DECLARATION_TYPES[language] || [];
    const declarations = tree.rootNode
      .descendantsOfType(declarationTypes)
      .filter((node) => shouldKeepDeclaration(language, node));

    const nodes = declarations
      .map((node) => nodeFromSyntax(language, node))
      .filter((node) => node !== null);

    const { edges, unresolvedCalls } = inferEdges(nodes);
    return { language, nodes, edges, unresolvedCalls };
  } catch {
    return { language, nodes: [], edges: [], unresolvedCalls: [] };
  }
}

export async function readNodeBody(file, content, line) {
  const parsed = await parseFile(file, content);
  if (!parsed || parsed.nodes.length === 0) return null;
  const node = parsed.nodes
    .filter((c) => c.lineStart <= line && c.lineEnd >= line)
    .sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart))[0];
  if (!node) return null;
  return { text: node.body, lineStart: node.lineStart, lineEnd: node.lineEnd };
}
