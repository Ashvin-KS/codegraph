import crypto from "node:crypto";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeBodyText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

export function bodyHashForText(value: string): string {
  return sha256(normalizeBodyText(value));
}

// Stable across re-indexes and line shifts: file + kind + name only.
// The 4th `disambiguator` arg is optional and used ONLY to distinguish
// duplicate symbols in the same file (overloads). Callers must NOT pass
// line numbers here — that was the old bug that produced a new tree on
// every re-index after any edit above a symbol.
// Legacy callers passing a line number will still work (it becomes part of
// the key), but new code passes "" or "#2" style suffixes.
export function stableNodeKey(file: string, kind: string, name: string, disambiguator = ""): string {
  return sha256(`${file}\0${kind}\0${name}\0${disambiguator}`);
}
