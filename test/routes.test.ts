import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDuckDatabase } from "../src/server/db";
import { GraphRepository } from "../src/server/repository";
import { CodeParser } from "../src/server/parser";
import { Indexer } from "../src/server/indexer";
import { createLogger } from "../src/server/logger";
import { createApp } from "../src/server/routes";
import { AUTH_HEADER } from "../src/shared/protocol";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("server routes", () => {
  it("requires auth and explains through deterministic fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckgraph-routes-"));
    tempDirs.push(root);
    fs.writeFileSync(
      path.join(root, "sample.ts"),
      "export function add(a: number, b: number): number { return a + b; }\n",
      "utf8"
    );
    const dbPath = path.join(root, ".duckgraph", "graph.db");
    const db = openDuckDatabase(dbPath);
    const repository = new GraphRepository(db, root);
    const parser = new CodeParser(process.cwd(), createLogger("routes-parser"));
    const indexer = new Indexer(root, parser, repository);
    const app = createApp({
      token: "secret",
      workspaceRoot: root,
      dbPath,
      llamaUrl: "http://127.0.0.1:9/completion",
      indexer,
      parser,
      repository,
      logger: createLogger("routes"),
      shutdown: () => undefined
    });

    await request(app).get("/health").expect(401);
    await request(app)
      .post("/index")
      .set(AUTH_HEADER, "secret")
      .send({
        file: "sample.ts",
        content: "export function add(a: number, b: number): number { return a + b; }\n",
        workspace_root: root
      })
      .expect(200);
    const explain = await request(app)
      .post("/explain")
      .set(AUTH_HEADER, "secret")
      .send({
        symbol: "add",
        file: "sample.ts",
        line: 1,
        depth: 1,
        user_level: "intermediate",
        workspace_root: root,
        llama_url: "http://127.0.0.1:9/completion"
      })
      .expect(200);
    expect(explain.body.explanation).toContain("add");

    await request(app)
      .post("/explain")
      .set(AUTH_HEADER, "secret")
      .send({
        symbol: "add",
        file: "sample.ts",
        line: 999,
        depth: 1,
        user_level: "intermediate",
        workspace_root: root,
        llama_url: "http://127.0.0.1:9/completion"
      })
      .expect(400);

    db.close();
  });
});
