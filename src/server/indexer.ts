import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { currentCommitHash } from "./git";
import type { CodeParser } from "./parser";
import type { GraphRepository, IndexResult } from "./repository";

export class Indexer {
  private isIndexing = false;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly parser: CodeParser,
    private readonly repository: GraphRepository
  ) {}

  public status(): "indexing" | "ready" {
    return this.isIndexing ? "indexing" : "ready";
  }

  public async indexFile(file: string, content: string): Promise<IndexResult> {
    const parsed = await this.parser.parseFile(file, content);
    if (!parsed) {
      return { file, nodes: 0, edges: 0 };
    }
    // Don't wipe a previously indexed file when the parser finds zero
    // symbols in non-empty content (wasm missing, regex gap, etc.).
    // Tombstoning here is what shrank the graph on re-index.
    if (parsed.nodes.length === 0 && content.trim().length > 0) {
      return { file, nodes: 0, edges: 0 };
    }
    const commit = await currentCommitHash(this.workspaceRoot);
    return this.repository.upsertFileIndex(file, parsed.nodes, parsed.edges, commit);
  }

  public async indexBatch(files: Array<{ file: string; content?: string }>, chunkSize = 50): Promise<{ files: number; nodes: number; edges: number }> {
    const runId = this.repository.beginIndexRun(files.length);
    this.isIndexing = true;
    let nodes = 0;
    let edges = 0;
    let processedFiles = 0;
    try {
      for (let index = 0; index < files.length; index += chunkSize) {
        const chunk = files.slice(index, index + chunkSize);
        for (const file of chunk) {
          let content = file.content;
          if (content === undefined) {
            try {
              const fullPath = path.resolve(this.workspaceRoot, file.file);
              content = await fs.readFile(fullPath, "utf8");
            } catch {
              continue;
            }
          }
          try {
            const result = await this.indexFile(file.file, content as string);
            nodes += result.nodes;
            edges += result.edges;
            processedFiles += 1;
          } catch {
            continue;
          }
        }
        await yieldImmediate();
      }
      this.repository.finishIndexRun(runId, nodes, "ready");
      return { files: processedFiles, nodes, edges };
    } catch (error) {
      this.repository.finishIndexRun(runId, nodes, "failed", error instanceof Error ? error.message || "Unknown error" : String(error));
      throw error;
    } finally {
      this.isIndexing = false;
    }
  }
}
