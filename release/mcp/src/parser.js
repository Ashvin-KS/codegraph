// Regex fallback parser — dependency-free and deterministic.
// The full VS Code extension prefers tree-sitter WASM and falls back to
// these same patterns; the standalone MCP ships regex-only so friends can
// `npm install` with zero native toolchain beyond better-sqlite3.
import { languageIdForFile } from "./protocol.js";
import { bodyHashForText } from "./hash.js";

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
  "import", "export", "from", "class", "function", "def", "fn",
  "let", "const", "var", "new", "await", "async"
]);

const PATTERNS = {
  rust: [
    { kind: "function", regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "struct", regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "enum", regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "interface", regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "module", regex: /^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }
  ],
  typescript: [
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^{=]+)?\s*=\s*(?:async\s*)?(?:\(.*?\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^{=>]+)?\s*=>/ },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "function", regex: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^{=]+)?\s*=\s*/ }
  ],
  typescriptreact: [
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^{=]+)?\s*=\s*(?:async\s*)?(?:\(.*?\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^{=>]+)?\s*=>/ },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ }
  ],
  python: [
    { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }
  ],
  go: [
    { kind: "function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/ },
    { kind: "type", regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }
  ],
  c: [{ kind: "function", regex: /^\s*(?:static\s+)?(?:[\w\*]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ }],
  cpp: [{ kind: "function", regex: /^\s*(?:[\w:<>\*&,]+\s+)+([A-Za-z_][A-Za-z0-9_:]*)\s*\(/ }],
  csharp: [{ kind: "class", regex: /^\s*(?:public|private|protected|internal|sealed|abstract|static|\s)*\s*(?:class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  java: [{ kind: "class", regex: /^\s*(?:public|private|protected|abstract|final|\s)*\s*(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  ruby: [
    { kind: "function", regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_?!]*)\b/ },
    { kind: "class", regex: /^\s*(?:class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)\b/ }
  ],
  php: [{ kind: "function", regex: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  zig: [{ kind: "function", regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  bash: [{ kind: "function", regex: /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{/ }],
  kotlin: [{ kind: "function", regex: /^\s*(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  lua: [{ kind: "function", regex: /^\s*(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.:]*)\b/ }],
  solidity: [{ kind: "function", regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }],
  swift: [{ kind: "function", regex: /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\b/ }]
};

export function parseFile(file, content) {
  const language = languageIdForFile(file);
  if (!language) return null;
  const list = PATTERNS[language] ?? [];
  const lines = String(content).split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const pattern of list) {
      const match = pattern.regex.exec(line);
      if (match?.[1]) {
        starts.push({
          index,
          name: match[1],
          kind: pattern.kind,
          indent: line.length - line.trimStart().length
        });
        break;
      }
    }
  }
  const nodes = starts.map((start, order) => {
    const next = starts[order + 1];
    const maxEnd = next ? next.index - 1 : lines.length - 1;
    const lineEnd = findBlockEnd(lines, start.index, start.indent, language, maxEnd);
    const body = lines.slice(start.index, lineEnd + 1).join("\n").replace(/\r\n/g, "\n").trimEnd();
    const sig = String(lines[start.index] ?? "").trim().slice(0, 180);
    return {
      name: start.name,
      kind: start.kind,
      lineStart: start.index + 1,
      lineEnd: lineEnd + 1,
      signature: sig,
      bodyHash: bodyHashForText(body),
      body
    };
  });
  return { language, nodes, edges: inferEdges(nodes) };
}

export function readNodeBody(file, content, line) {
  const parsed = parseFile(file, content);
  if (!parsed) return null;
  const node = parsed.nodes
    .filter((c) => c.lineStart <= line && c.lineEnd >= line)
    .sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart))[0];
  if (!node) return null;
  return { text: node.body, lineStart: node.lineStart, lineEnd: node.lineEnd };
}

function findBlockEnd(lines, startIndex, indent, language, maxEndIndex) {
  if (language === "python") {
    for (let i = startIndex + 1; i <= maxEndIndex; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim().length > 0 && line.length - line.trimStart().length <= indent) {
        return Math.max(startIndex, i - 1);
      }
    }
    return maxEndIndex;
  }
  let depth = 0;
  let saw = false;
  for (let i = startIndex; i <= maxEndIndex; i += 1) {
    const text = stripStrings(lines[i] ?? "");
    for (const ch of text) {
      if (ch === "{") { depth += 1; saw = true; }
      else if (ch === "}") depth -= 1;
    }
    if (saw && depth <= 0) return i;
  }
  return maxEndIndex;
}

function stripStrings(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const next = line[i + 1];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && next === "/") break;
    if (c === "#") break;
    out += c;
  }
  return out;
}

function inferEdges(nodes) {
  const edges = [];
  const names = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n && !names.has(n.name)) names.set(n.name, i);
  }
  const re = /\b([A-Za-z_$][\w$]*)\s*(?:::<[^\n>]+>)?\s*\(/g;
  for (let from = 0; from < nodes.length; from += 1) {
    const node = nodes[from];
    if (!node) continue;
    for (const m of node.body.matchAll(re)) {
      const target = m[1];
      if (!target || target === node.name || CALL_KEYWORDS.has(target)) continue;
      const to = names.get(target);
      if (to !== undefined && to !== from) edges.push({ fromIndex: from, toIndex: to, type: "calls" });
    }
  }
  const seen = new Set();
  return edges.filter((e) => {
    const k = `${e.fromIndex}:${e.toIndex}:${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
