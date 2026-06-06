import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDuckDatabase } from "../src/server/db";
import { GraphRepository } from "../src/server/repository";
import { CodeParser } from "../src/server/parser";
import { createLogger } from "../src/server/logger";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GraphRepository", () => {
  it("indexes symbols and queries a bounded subgraph", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-repo-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);
    const parser = new CodeParser(process.cwd(), createLogger("repo-test"));
    const content = `
export function add(a: number, b: number): number {
  return a + b;
}
export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
`;
    const parsed = await parser.parseFile(path.join(root, "sample.ts"), content);
    expect(parsed).not.toBeNull();
    repository.upsertFileIndex("sample.ts", parsed?.nodes ?? [], parsed?.edges ?? [], "commit-a");

    const graph = repository.querySubgraph("total", "sample.ts", 5, 1, 15);
    expect(graph.target?.name).toBe("total");
    expect(graph.edges.some((edge) => edge.type === "calls" && edge.target_name === "add")).toBe(true);
    db.close();
  });

  it("marks cached concepts stale when a body changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-stale-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);
    const parser = new CodeParser(process.cwd(), createLogger("repo-test"));
    const first = await parser.parseFile("sample.ts", "export function total(): number { return 1; }");
    repository.upsertFileIndex("sample.ts", first?.nodes ?? [], first?.edges ?? [], "commit-a");
    const graph = repository.querySubgraph("total", "sample.ts", 1, 1, 15);
    expect(graph.target).not.toBeNull();
    repository.saveExplanation(graph.target!.id, "total", "cached", "intermediate", "commit-a", "{}");

    const second = await parser.parseFile("sample.ts", "export function total(): number { return 2; }");
    repository.upsertFileIndex("sample.ts", second?.nodes ?? [], second?.edges ?? [], "commit-b");
    const stale = repository.querySubgraph("total", "sample.ts", 1, 1, 15);
    expect(stale.freshness).toBe("STALE");
    db.close();
  });
});
