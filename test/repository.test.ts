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

  it("preserves stable node IDs, updates lines silently, and avoids stale churn on comment shift and re-index", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-stable-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);
    const parser = new CodeParser(process.cwd(), createLogger("repo-test"));

    const v1 = `export function add(a: number, b: number): number {
  return a + b;
}
export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
`;
    const parsed1 = await parser.parseFile("sample.ts", v1);
    expect(parsed1).not.toBeNull();
    const res1 = repository.upsertFileIndex("sample.ts", parsed1?.nodes ?? [], parsed1?.edges ?? [], "commit-a");
    expect(res1.nodes).toBe(2);

    const initialAdd = repository.querySubgraph("add", "sample.ts", 1, 1, 15);
    const initialTotal = repository.querySubgraph("total", "sample.ts", 4, 1, 15);
    expect(initialAdd.target).not.toBeNull();
    expect(initialTotal.target).not.toBeNull();
    const addId = initialAdd.target!.id;
    const totalId = initialTotal.target!.id;

    // Cache an explanation for total
    repository.saveExplanation(totalId, "total", "cached total", "intermediate", "commit-a", "{}");
    const freshCheck = repository.querySubgraph("total", "sample.ts", 4, 1, 15);
    expect(freshCheck.freshness).toBe("FRESH");

    // Prepend a comment line shifting all lines down by 1
    const v2 = `// prepended comment shifts line numbers down by one
export function add(a: number, b: number): number {
  return a + b;
}
export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
`;
    const parsed2 = await parser.parseFile("sample.ts", v2);
    repository.upsertFileIndex("sample.ts", parsed2?.nodes ?? [], parsed2?.edges ?? [], "commit-a");

    const shiftedAdd = repository.querySubgraph("add", "sample.ts", 2, 1, 15);
    const shiftedTotal = repository.querySubgraph("total", "sample.ts", 5, 1, 15);

    // Assert SAME node IDs
    expect(shiftedAdd.target?.id).toBe(addId);
    expect(shiftedTotal.target?.id).toBe(totalId);

    // Assert updated lines
    expect(shiftedAdd.target?.line_start).toBe(initialAdd.target!.line_start + 1);
    expect(shiftedTotal.target?.line_start).toBe(initialTotal.target!.line_start + 1);

    // Assert freshness != STALE (remains FRESH)
    expect(shiftedTotal.freshness).not.toBe("STALE");
    expect(shiftedTotal.freshness).toBe("FRESH");

    // Re-index identical content and assert zero churn
    const beforeRows = db.prepare("SELECT id, stable_key, line_start, line_end, updated_at FROM code_nodes ORDER BY id").all();
    repository.upsertFileIndex("sample.ts", parsed2?.nodes ?? [], parsed2?.edges ?? [], "commit-a");
    const afterRows = db.prepare("SELECT id, stable_key, line_start, line_end, updated_at FROM code_nodes ORDER BY id").all();

    expect(afterRows).toEqual(beforeRows);
    db.close();
  });

  it("collapses nodes reachable at multiple depths via DISTINCT in querySubgraph", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-distinct-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);

    // Diamond graph: A -> B, A -> C, B -> C
    // C is reachable at depth 1 (A -> C) and depth 2 (A -> B -> C)
    db.prepare(`
      INSERT INTO code_nodes(id, stable_key, name, kind, file, line_start, line_end, commit_hash)
      VALUES (1, 'k1', 'A', 'function', 'test.ts', 1, 3, 'c1'),
             (2, 'k2', 'B', 'function', 'test.ts', 4, 6, 'c1'),
             (3, 'k3', 'C', 'function', 'test.ts', 7, 9, 'c1')
    `).run();
    db.prepare(`
      INSERT INTO code_edges(from_id, to_id, type, confidence, dismissed, file_context)
      VALUES (1, 2, 'calls', 'syntactic', 0, 'test.ts'),
             (1, 3, 'calls', 'syntactic', 0, 'test.ts'),
             (2, 3, 'calls', 'syntactic', 0, 'test.ts')
    `).run();

    const graph = repository.querySubgraph("A", "test.ts", 1, 2, 10);
    const cNodes = graph.nodes.filter((n) => n.name === "C");
    expect(cNodes.length).toBe(1);
    expect(graph.nodes.length).toBe(3);
    db.close();
  });

  it("supports decoupled symbol queries, search, overview, impact analysis, and shortest path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-features-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);

    // Nodes: activate, startServer, handleRequest, authenticate
    db.prepare(`
      INSERT INTO code_nodes(id, stable_key, name, kind, file, line_start, line_end, commit_hash)
      VALUES (1, 'k1', 'activate', 'function', 'src/extension.ts', 1, 15, 'c1'),
             (2, 'k2', 'startServer', 'function', 'src/server.ts', 20, 50, 'c1'),
             (3, 'k3', 'handleRequest', 'function', 'src/server.ts', 60, 90, 'c1'),
             (4, 'k4', 'authenticate', 'function', 'src/auth.ts', 10, 30, 'c1')
    `).run();

    // Call chain: activate -> startServer -> handleRequest -> authenticate
    db.prepare(`
      INSERT INTO code_edges(from_id, to_id, type, confidence, dismissed, file_context)
      VALUES (1, 2, 'calls', 'syntactic', 0, 'src/extension.ts'),
             (2, 3, 'calls', 'syntactic', 0, 'src/server.ts'),
             (3, 4, 'calls', 'syntactic', 0, 'src/server.ts')
    `).run();

    // 1. Decoupled querySubgraph (no file, no line)
    const decoupled = repository.querySubgraph("handleRequest");
    expect(decoupled.target).not.toBeNull();
    expect(decoupled.target?.name).toBe("handleRequest");
    expect(decoupled.target?.file).toBe("src/server.ts");

    // 2. Search symbols
    const search = repository.searchSymbols("auth");
    expect(search.length).toBe(1);
    expect(search[0]?.name).toBe("authenticate");

    // 3. Overview
    const overview = repository.getOverview(5);
    expect(overview.entrypoints.some((e) => e.name === "activate")).toBe(true);
    expect(overview.stats.indexedNodes).toBe(4);
    expect(overview.stats.totalEdges).toBe(3);

    // 4. Impact analysis (who is impacted if authenticate changes?)
    const impact = repository.getImpactAnalysis("authenticate");
    expect(impact).not.toBeNull();
    expect(impact?.dependents_count).toBe(3); // handleRequest (depth 1), startServer (depth 2), activate (depth 3)
    const depNames = impact?.dependents.map((d) => d.name);
    expect(depNames).toContain("handleRequest");
    expect(depNames).toContain("startServer");
    expect(depNames).toContain("activate");

    // 5. Shortest path (activate -> authenticate)
    const pathRes = repository.findShortestPath("activate", "authenticate");
    expect(pathRes.found).toBe(true);
    expect(pathRes.depth).toBe(3);
    expect(pathRes.path).toEqual(["activate", "startServer", "handleRequest", "authenticate"]);

    // 6. getContextSlice (1-turn composite cluster)
    const slice = repository.getContextSlice("startServer");
    expect(slice).not.toBeNull();
    expect(slice?.target.name).toBe("startServer");
    expect(slice?.callees.map((c) => c.name)).toContain("handleRequest");
    expect(slice?.callers.map((c) => c.name)).toContain("activate");
    expect(slice?.blast_radius_count).toBe(1); // activate -> startServer

    // 7. Centrality-ranked search: symbols with more callers/callees rank higher
    // Insert low-degree auth helper and high-degree auth hub
    db.prepare(`
      INSERT INTO code_nodes(id, stable_key, name, kind, file, line_start, line_end, commit_hash)
      VALUES (5, 'k5', 'authHelper', 'function', 'src/auth.ts', 40, 45, 'c1'),
             (6, 'k6', 'authService', 'class', 'src/auth.ts', 50, 100, 'c1')
    `).run();
    // authService has 2 incoming edges
    db.prepare(`
      INSERT INTO code_edges(from_id, to_id, type, confidence, dismissed, file_context)
      VALUES (1, 6, 'calls', 'syntactic', 0, 'src/extension.ts'),
             (2, 6, 'calls', 'syntactic', 0, 'src/server.ts')
    `).run();
    const ranked = repository.searchSymbols("auth");
    // authService (degree 2) and authenticate (degree 1) should rank before authHelper (degree 0)
    expect(ranked[0]?.name).toBe("authService");

    db.close();
  });

  it("links cross-file calls and handles CTE substring collisions and tombstone edge purges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-crossfile-"));
    tempDirs.push(root);
    const db = openDuckDatabase(path.join(root, ".duckgraph", "graph.db"));
    const repository = new GraphRepository(db, root);
    const parser = new CodeParser(process.cwd(), createLogger("repo-test"));

    // File 1: Service definition (init and initialize - substring test)
    const file1 = `
export function init(): void {}
export function initialize(): void {
  init();
}
`;
    // File 2: App calling initialize across files
    const file2 = `
export function app(): void {
  initialize();
}
`;
    const p1 = await parser.parseFile("service.ts", file1);
    const p2 = await parser.parseFile("app.ts", file2);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();

    repository.upsertFileIndex("service.ts", p1!.nodes, p1!.edges, "c1", p1!.unresolvedCalls ?? []);
    repository.upsertFileIndex("app.ts", p2!.nodes, p2!.edges, "c1", p2!.unresolvedCalls ?? []);

    // Perform cross-file linking
    const crossLinked = repository.linkCrossFileCalls();
    expect(crossLinked).toBeGreaterThanOrEqual(1);

    // Verify cross-file edge exists from app() to initialize()
    const appEdges = db.prepare(`
      SELECT e.type, fn.name AS from_name, tn.name AS to_name, fn.file AS from_file, tn.file AS to_file
      FROM code_edges e
      JOIN code_nodes fn ON fn.id = e.from_id
      JOIN code_nodes tn ON tn.id = e.to_id
      WHERE fn.name = 'app'
    `).all() as Array<{ from_name: string; to_name: string; from_file: string; to_file: string }>;

    expect(appEdges.some((e) => e.to_name === "initialize" && e.from_file !== e.to_file)).toBe(true);

    // Verify CTE substring collision fix (init vs initialize)
    // init is called by initialize, initialize is called by app
    const impact = repository.getImpactAnalysis("init");
    expect(impact).not.toBeNull();
    const depNames = impact!.dependents.map((d) => d.name);
    // Even though 'init' is a substring of 'initialize', cycle detection using IDs must NOT drop initialize or app
    expect(depNames).toContain("initialize");
    expect(depNames).toContain("app");

    // Shortest path app -> init
    const pathRes = repository.findShortestPath("app", "init");
    expect(pathRes.found).toBe(true);
    expect(pathRes.path).toEqual(["app", "initialize", "init"]);

    // Verify tombstone deletes orphan edges
    // Update app.ts removing 'app' function
    const p2Empty = await parser.parseFile("app.ts", "// empty");
    repository.upsertFileIndex("app.ts", p2Empty!.nodes, p2Empty!.edges, "c2", []);

    const remainingEdges = db.prepare(`
      SELECT COUNT(*) as c FROM code_edges WHERE file_context = 'app.ts'
    `).get() as { c: number };
    expect(remainingEdges.c).toBe(0);

    db.close();
  });
});

