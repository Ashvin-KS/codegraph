import type { ExplainRequest, GraphEdgeDto } from "../shared/protocol";
import type { SubgraphResult } from "./repository";

export interface SourceSnippet {
  file: string;
  line_start: number;
  line_end: number;
  text: string;
}

export function buildPrompt(request: ExplainRequest, subgraph: SubgraphResult, source: SourceSnippet | null): string {
  // Always echo the query so the LLM knows the symbol/file/line even when
  // the target is unindexed (null). Keep empty edges arrays (don't strip)
  // so "no verified edges" is distinguishable from "omitted".
  const payload = {
    system:
      "You are a codebase explainer. You receive a verified subgraph of code relationships and optionally raw source. Use the graph for ALL structural claims (what calls what, what depends on what). Use source ONLY for implementation detail or inline comments. Never state a relationship not present in graph edges.",
    user_level: request.user_level,
    query: stripEmpty({
      symbol: request.symbol ?? null,
      file: request.file,
      line: request.line,
      depth: request.depth
    }),
    subgraph: {
      target: subgraph.target,
      edges: subgraph.edges.map((edge) => ({
        type: edge.type,
        target: edge.target_name,
        confidence: edge.confidence,
        score: edge.inferred_score
      })),
      edge_count: subgraph.edges.length,
      mind_graph: {
        freshness: subgraph.freshness,
        stale_reason: subgraph.target?.stale_reason ?? null
      }
    },
    source,
    instructions:
      "Explain in exactly two short lines. Lead with why the symbol matters in this codebase. If freshness is STALE, append one warning line. Do not mention inferred edges unless asked."
  };
  return JSON.stringify(stripEmpty(payload) ?? {});
}

export function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Keep empty arrays: an empty edges list is meaningful signal
    // ("no verified edges") and must not vanish into undefined.
    return value.map((item) => stripEmpty(item) ?? null);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripEmpty(entry);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  return value;
}

export function fallbackExplanation(subgraph: SubgraphResult, source: SourceSnippet | null, relativeHoveredFile?: string): string {
  if (!subgraph.target) {
    return "CodeGraph has not indexed this symbol yet.\nRun CodeGraph (alias DuckGraph): Reindex Workspace after language services finish loading.";
  }

  const target = subgraph.target;
  const targetPath = target.file.replace(/\\/g, "/");
  const hoveredPath = relativeHoveredFile ? relativeHoveredFile.replace(/\\/g, "/") : "";
  const isLocal = hoveredPath && (targetPath === hoveredPath || targetPath.endsWith("/" + hoveredPath) || hoveredPath.endsWith("/" + targetPath));
  
  const fileDesc = isLocal ? "locally in this file" : `in ${target.file}`;
  const outgoing = subgraph.edges.filter((edge) => edge.from_id === target.id && edge.confidence === "syntactic");
  const stale = target.freshness === "STALE" ? `\nWarning: this cached context is stale${target.stale_reason ? ` (${target.stale_reason})` : ""}.` : "";
  const relationshipLine = relationshipSummary(outgoing);
  const sourceLine = source ? ` Source was read from lines ${source.line_start}-${source.line_end}.` : "";

  return `${target.name} is a ${target.kind} defined ${fileDesc}; CodeGraph found ${relationshipLine}.${sourceLine}${stale}`;
}

function relationshipSummary(edges: GraphEdgeDto[]): string {
  if (edges.length === 0) {
    return "no verified outgoing relationships yet";
  }
  const first = edges.slice(0, 3).map((edge) => `${edge.type} ${edge.target_name}`).join(", ");
  const suffix = edges.length > 3 ? ` and ${edges.length - 3} more` : "";
  return `verified relationships: ${first}${suffix}`;
}
