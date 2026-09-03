import crypto from "node:crypto";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeBodyText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

export function bodyHashForText(value) {
  return sha256(normalizeBodyText(value));
}

// Stable across re-indexes and line shifts: file + kind + name only.
// 4th arg is an optional disambiguator ("", "#2", ...) for duplicate
// symbols in the same file. NEVER pass line numbers here.
export function stableNodeKey(file, kind, name, disambiguator = "") {
  return sha256(`${file}\0${kind}\0${name}\0${disambiguator}`);
}
