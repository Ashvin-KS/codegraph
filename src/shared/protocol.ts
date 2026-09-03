export const EXTENSION_ID = "codegraph";
export const EXTENSION_ID_LEGACY = "duckgraph";
// Accept both headers on the server; clients send the new one.
export const AUTH_HEADER = "X-CodeGraph-Auth";
export const AUTH_HEADER_LEGACY = "X-DuckGraph-Auth";

export const SUPPORTED_LANGUAGE_IDS = [
  "rust",
  "typescript",
  "typescriptreact",
  "python",
  "go",
  "c",
  "cpp",
  "csharp",
  "java",
  "ruby",
  "php",
  "zig",
  "bash",
  "html",
  "css",
  "json",
  "kotlin",
  "lua",
  "solidity",
  "swift",
  "yaml"
] as const;

export type SupportedLanguageId = (typeof SUPPORTED_LANGUAGE_IDS)[number];
export type UserLevel = "beginner" | "intermediate" | "expert";
export type HoverMode = "always" | "commandOnly";
export type EdgeConfidence = "syntactic" | "inferred";
export type Freshness = "UNINDEXED" | "NEW" | "STALE" | "FRESH";

export interface Lockfile {
  port: number;
  token: string;
  pid: number;
  workspaceRoot: string;
  dbPath: string;
  createdAt: string;
}

export interface IndexFileRequest {
  file: string;
  content?: string;
  workspace_root: string;
  hard_reset?: boolean;
}

export interface IndexBatchRequest {
  files: IndexFileRequest[];
  workspace_root: string;
  hard_reset?: boolean;
  clear_graph_cache?: boolean;
}

export interface LspReferenceLocation {
  symbol: string;
  file: string;
  line: number;
  references: Array<{
    file: string;
    line: number;
  }>;
}

export interface IndexLspRequest {
  workspace_root: string;
  references: LspReferenceLocation[];
}

export interface ExplainRequest {
  symbol?: string;
  file: string;
  line: number;
  depth: number;
  user_level: UserLevel;
  workspace_root: string;
  llama_url?: string;
  max_edges?: number;
  debug_graph_json?: boolean;
}

export interface AgentContextRequest {
  symbol?: string;
  file: string;
  line: number;
  depth?: number;
  workspace_root: string;
  max_edges?: number;
  source_budget?: number;
}

export interface GraphNodeDto {
  id: number;
  name: string;
  kind: string;
  file: string;
  line_start: number;
  line_end: number;
  signature: string | null;
  commit_hash: string;
  freshness: Freshness;
  stale_reason: string | null;
}

export interface GraphEdgeDto {
  id: number;
  from_id: number;
  to_id: number;
  type: string;
  confidence: EdgeConfidence;
  inferred_score: number | null;
  confirmed_at: string | null;
  dismissed: boolean;
  target_name: string;
}

export interface ExplainResponse {
  explanation: string;
  from_cache: boolean;
  stale: boolean;
  source_used: boolean;
  target: GraphNodeDto | null;
  edges: GraphEdgeDto[];
  inferred_edges: GraphEdgeDto[];
  debug_graph_json?: string;
}

export interface AgentContextResponse {
  target_symbol: GraphNodeDto | null;
  verified_edges: GraphEdgeDto[];
  inferred_edges: GraphEdgeDto[];
  stale_state: Freshness;
  bounded_source_excerpt: {
    file: string;
    line_start: number;
    line_end: number;
    text: string;
  } | null;
  summary?: string;
  usage_guidance?: string;
  compact_json: string;
}

export interface EdgeDecisionRequest {
  edge_id: number;
}

export interface OrbitGraphResponse {
  nodes: Array<{
    id: number;
    name: string;
    kind: string;
    file: string;
    freshness: Freshness;
  }>;
  edges: Array<{
    id: number;
    source: number;
    target: number;
    type: string;
    confidence: EdgeConfidence;
  }>;
}

export interface HealthResponse {
  ok: true;
  status: "indexing" | "ready";
  dbPath: string;
  indexedFiles: number;
  indexedNodes: number;
}

export function isSupportedLanguageId(value: string): value is SupportedLanguageId {
  return (SUPPORTED_LANGUAGE_IDS as readonly string[]).includes(value);
}

export function languageIdForFile(file: string): SupportedLanguageId | null {
  const lower = file.toLowerCase();
  if (lower.endsWith(".rs")) {
    return "rust";
  }
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return "typescriptreact";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "typescript";
  }
  if (lower.endsWith(".py")) {
    return "python";
  }
  if (lower.endsWith(".go")) {
    return "go";
  }
  if (lower.endsWith(".c") || lower.endsWith(".h")) {
    return "c";
  }
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh")) {
    return "cpp";
  }
  if (lower.endsWith(".cs")) {
    return "csharp";
  }
  if (lower.endsWith(".java") || lower.endsWith(".jar")) {
    return "java";
  }
  if (lower.endsWith(".rb")) {
    return "ruby";
  }
  if (lower.endsWith(".php")) {
    return "php";
  }
  if (lower.endsWith(".zig")) {
    return "zig";
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) {
    return "bash";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "html";
  }
  if (lower.endsWith(".css")) {
    return "css";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) {
    return "kotlin";
  }
  if (lower.endsWith(".lua")) {
    return "lua";
  }
  if (lower.endsWith(".sol")) {
    return "solidity";
  }
  if (lower.endsWith(".swift")) {
    return "swift";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  return null;
}
