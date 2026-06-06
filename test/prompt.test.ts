import { describe, expect, it } from "vitest";
import { buildPrompt, fallbackExplanation, stripEmpty } from "../src/server/prompt";
import type { ExplainRequest } from "../src/shared/protocol";
import type { SubgraphResult } from "../src/server/repository";

const request: ExplainRequest = {
  symbol: "total",
  file: "src/sample.ts",
  line: 5,
  depth: 1,
  user_level: "intermediate",
  workspace_root: process.cwd()
};

const subgraph: SubgraphResult = {
  target: {
    id: 1,
    name: "total",
    kind: "function",
    file: "src/sample.ts",
    line_start: 5,
    line_end: 7,
    signature: "export function total(values: number[]): number {",
    commit_hash: "abc",
    freshness: "NEW",
    stale_reason: null
  },
  nodes: [],
  edges: [
    {
      id: 1,
      from_id: 1,
      to_id: 2,
      type: "calls",
      confidence: "syntactic",
      inferred_score: null,
      confirmed_at: null,
      dismissed: false,
      target_name: "add"
    }
  ],
  cachedExplanation: null,
  freshness: "NEW"
};

describe("prompt assembly", () => {
  it("strips nulls and empty values", () => {
    expect(stripEmpty({ a: null, b: [], c: { d: "ok" } })).toEqual({ c: { d: "ok" } });
  });

  it("builds minified graph-grounded prompt JSON", () => {
    const prompt = buildPrompt(request, subgraph, null);
    expect(prompt).toContain("verified subgraph");
    expect(prompt).toContain("total");
    expect(prompt).not.toContain("null");
  });

  it("creates deterministic fallback text", () => {
    expect(fallbackExplanation(subgraph, null)).toContain("verified relationships");
  });
});
