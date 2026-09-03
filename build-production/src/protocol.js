// Language detection mirrors the VS Code extension (protocol.ts).
// Keep in sync when adding new extensions.
export function languageIdForFile(file) {
  const lower = String(file).toLowerCase();
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "typescriptreact";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "typescript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh")) return "cpp";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".java") || lower.endsWith(".jar")) return "java";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".zig")) return "zig";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".lua")) return "lua";
  if (lower.endsWith(".sol")) return "solidity";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return null;
}
