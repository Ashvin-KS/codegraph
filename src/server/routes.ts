import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AUTH_HEADER, AUTH_HEADER_LEGACY, type AgentContextRequest, type EdgeDecisionRequest, type ExplainRequest, type HealthResponse, type IndexBatchRequest, type IndexFileRequest, type IndexLspRequest, type UserLevel } from "../shared/protocol";
import { absoluteWorkspaceFile, relativeWorkspaceFile } from "../shared/fs";
import { callLlm } from "./llm";
import { buildPrompt, fallbackExplanation, type SourceSnippet } from "./prompt";
import type { CodeParser } from "./parser";
import type { Indexer } from "./indexer";
import { type GraphRepository, NotFoundError } from "./repository";
import type { Logger } from "./logger";

export interface RouteContext {
  token: string;
  workspaceRoot: string;
  dbPath: string;
  llamaUrl: string;
  indexer: Indexer;
  parser: CodeParser;
  repository: GraphRepository;
  logger: Logger;
  shutdown(): void;
}

const userLevelSchema = z.enum(["beginner", "intermediate", "expert"]);
const indexFileSchema = z.object({
  file: z.string().min(1),
  content: z.string().optional(),
  workspace_root: z.string().min(1),
  hard_reset: z.boolean().optional()
});
const indexBatchSchema = z.object({
  workspace_root: z.string().min(1),
  files: z.array(indexFileSchema).max(5000),
  hard_reset: z.boolean().optional(),
  clear_graph_cache: z.boolean().optional()
});
const explainSchema = z.object({
  symbol: z.string().min(1).optional(),
  file: z.string().min(1),
  line: z.number().int().positive(),
  depth: z.number().int().min(0).max(5),
  user_level: userLevelSchema,
  workspace_root: z.string().min(1),
  llama_url: z.string().url().optional(),
  max_edges: z.number().int().positive().max(100).optional(),
  debug_graph_json: z.boolean().optional()
});
const agentContextSchema = z.object({
  symbol: z.string().min(1).optional(),
  file: z.string().min(1),
  line: z.number().int().positive(),
  depth: z.number().int().min(0).max(2).optional(),
  workspace_root: z.string().min(1),
  max_edges: z.number().int().positive().max(60).optional(),
  source_budget: z.number().int().positive().max(8000).optional()
});
const lspSchema = z.object({
  workspace_root: z.string().min(1),
  references: z.array(
    z.object({
      symbol: z.string().min(1),
      file: z.string().min(1),
      line: z.number().int().positive(),
      references: z.array(
        z.object({
          file: z.string().min(1),
          line: z.number().int().positive()
        })
      )
    })
  )
});
const edgeDecisionSchema = z.object({ edge_id: z.number().int().positive() });

export function createApp(context: RouteContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));
  app.use(auth(context.token));

  app.get("/health", (_req: Request, res: Response<HealthResponse>) => {
    const stats = context.repository.stats();
    res.json({
      ok: true,
      status: context.indexer.status(),
      dbPath: context.dbPath,
      indexedFiles: stats.indexedFiles,
      indexedNodes: stats.indexedNodes
    });
  });

  app.post("/index", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<IndexFileRequest>(indexFileSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      if (body.hard_reset) {
        context.repository.clearAll();
      }
      let content = body.content;
      if (content === undefined) {
        const fullPath = absoluteWorkspaceFile(body.workspace_root, body.file);
        content = await fs.readFile(fullPath, "utf8");
      }
      const result = await context.indexer.indexFile(body.file, content);
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/index_batch", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<IndexBatchRequest>(indexBatchSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      context.logger.info(`[INDEX_BATCH] Received request to index ${body.files.length} files. Files list:`, body.files.map(f => f.file));
      if (body.hard_reset) {
        context.repository.clearAll();
      } else if (body.clear_graph_cache) {
        context.repository.clearGraphCache();
      }
      const result = await context.indexer.indexBatch(body.files);
      context.logger.info(`[INDEX_BATCH] Finished indexing. Result:`, result);
      res.json({ ok: true, result });
    } catch (error) {
      context.logger.error(`[INDEX_BATCH] Error during index batch:`, error instanceof Error ? error.message : String(error));
      next(error);
    }
  });

  app.post("/index_lsp", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<IndexLspRequest>(lspSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      const inserted = context.repository.upsertLspReferences(body.references);
      res.json({ ok: true, edges: inserted });
    } catch (error) {
      next(error);
    }
  });

  app.post("/explain", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<ExplainRequest>(explainSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      const { clampedLine } = await validateLineQuery(context.workspaceRoot, body.file, body.line);
      body.line = clampedLine;
      const subgraph = context.repository.querySubgraph(body.symbol, body.file, body.line, body.depth, body.max_edges ?? 15);
      if (subgraph.target && subgraph.cachedExplanation && subgraph.freshness === "FRESH") {
        res.json({
          explanation: subgraph.cachedExplanation,
          from_cache: true,
          stale: false,
          source_used: false,
          target: subgraph.target,
          edges: subgraph.edges,
          inferred_edges: subgraph.edges.filter((edge) => edge.confidence === "inferred"),
          debug_graph_json: body.debug_graph_json ? JSON.stringify(subgraph) : undefined
        });
        return;
      }

      const source = await maybeReadSource(
        context,
        body,
        subgraph.edges.some((edge) => edge.confidence === "inferred"),
        subgraph.freshness === "STALE"
      );
      const prompt = buildPrompt(body, subgraph, source);
      let explanation: string;
      try {
        explanation = await callLlm(prompt, body.llama_url ?? context.llamaUrl);
      } catch {
        const relativeHoveredFile = relativeWorkspaceFile(context.workspaceRoot, body.file);
        explanation = fallbackExplanation(subgraph, source, relativeHoveredFile);
      }

      if (subgraph.target) {
        context.repository.saveExplanation(
          subgraph.target.id,
          subgraph.target.name,
          explanation,
          body.user_level as UserLevel,
          subgraph.target.commit_hash,
          prompt
        );
      }

      res.json({
        explanation,
        from_cache: false,
        stale: subgraph.freshness === "STALE",
        source_used: Boolean(source),
        target: subgraph.target,
        edges: subgraph.edges,
        inferred_edges: subgraph.edges.filter((edge) => edge.confidence === "inferred"),
        debug_graph_json: body.debug_graph_json ? JSON.stringify(subgraph) : undefined
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/agent/context", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<AgentContextRequest>(agentContextSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      const { clampedLine } = await validateLineQuery(context.workspaceRoot, body.file, body.line);
      body.line = clampedLine;
      context.logger.info(`[AGENT_CONTEXT] Query received: symbol="${body.symbol}", file="${body.file}", line=${body.line}, depth=${body.depth}`);
      const subgraph = context.repository.querySubgraph(
        body.symbol,
        body.file,
        body.line,
        Math.min(body.depth ?? 2, 2),
        body.max_edges ?? 20
      );
      context.logger.info(`[AGENT_CONTEXT] Subgraph queried. Target:`, subgraph.target);
      context.logger.info(`[AGENT_CONTEXT] Freshness state is: ${subgraph.freshness}`);
      const source = await maybeReadBoundedSource(context, body);
      // Deterministic summary so AI clients get prompt-ready grounding
      // without requiring llama.cpp. Mirrors hover fallback prose.
      const relativeFile = relativeWorkspaceFile(context.workspaceRoot, body.file);
      const summary = fallbackExplanation(subgraph, source, relativeFile);
      const guidance =
        subgraph.freshness === "UNINDEXED"
          ? "UNINDEXED: call codegraph_index_workspace (or duckgraph_index_workspace) first, then retry."
          : subgraph.freshness === "STALE"
            ? `STALE${subgraph.target?.stale_reason ? `: ${subgraph.target.stale_reason}` : ""} — hedge structural claims and prefer re-reading source.`
            : subgraph.edges.length === 0
              ? "No verified edges yet — use bounded_source_excerpt for implementation detail only; do not invent callers/callees."
              : "Use verified_edges for ALL structural claims (what calls what). Never state a relationship not in verified_edges.";
      const response = {
        target_symbol: subgraph.target,
        verified_edges: subgraph.edges.filter((edge) => edge.confidence === "syntactic"),
        inferred_edges: subgraph.edges.filter((edge) => edge.confidence === "inferred"),
        stale_state: subgraph.freshness,
        bounded_source_excerpt: source,
        summary,
        usage_guidance: guidance,
        compact_json: ""
      };
      response.compact_json = JSON.stringify({
        target_symbol: response.target_symbol
          ? {
              name: response.target_symbol.name,
              kind: response.target_symbol.kind,
              file: response.target_symbol.file,
              line_start: response.target_symbol.line_start,
              line_end: response.target_symbol.line_end,
              freshness: response.target_symbol.freshness,
              stale_reason: response.target_symbol.stale_reason
            }
          : null,
        verified_edges: response.verified_edges.map((edge) => ({
          id: edge.id,
          type: edge.type,
          target_name: edge.target_name
        })),
        inferred_edges: response.inferred_edges.map((edge) => ({
          id: edge.id,
          type: edge.type,
          target_name: edge.target_name,
          inferred_score: edge.inferred_score
        })),
        stale_state: response.stale_state,
        summary,
        usage_guidance: guidance,
        bounded_source_excerpt: response.bounded_source_excerpt
      });
      context.logger.info(`[AGENT_CONTEXT] Returning context to agent: verified_edges_count=${response.verified_edges.length}, inferred_edges_count=${response.inferred_edges.length}`);
      res.json(response);
    } catch (error) {
      context.logger.error(`[AGENT_CONTEXT] Error during context query:`, error instanceof Error ? error.message : String(error));
      next(error);
    }
  });

  app.post("/agent/subgraph", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<AgentContextRequest>(agentContextSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      const { clampedLine } = await validateLineQuery(context.workspaceRoot, body.file, body.line);
      body.line = clampedLine;
      context.logger.info(`[AGENT_SUBGRAPH] Query received: symbol="${body.symbol}", file="${body.file}", line=${body.line}`);
      const subgraph = context.repository.querySubgraph(
        body.symbol,
        body.file,
        body.line,
        Math.min(body.depth ?? 2, 2),
        body.max_edges ?? 20
      );
      context.logger.info(`[AGENT_SUBGRAPH] Query finished. Matched target:`, subgraph.target);
      res.json(subgraph);
    } catch (error) {
      context.logger.error(`[AGENT_SUBGRAPH] Error:`, error instanceof Error ? error.message : String(error));
      next(error);
    }
  });

  // Dedicated read_source_node endpoint — returns ONLY source excerpt, no graph edges.
  // This fixes BUG-4: the original /agent/context was shared with explain_symbol and
  // included verified_edges / inferred_edges / stale_state which polluted read_source_node.
  app.post("/agent/read_source", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<AgentContextRequest>(agentContextSchema, req.body);
      assertWorkspace(context.workspaceRoot, body.workspace_root);
      const { clampedLine } = await validateLineQuery(context.workspaceRoot, body.file, body.line);
      body.line = clampedLine;
      context.logger.info(`[READ_SOURCE] Query: symbol="${body.symbol}", file="${body.file}", line=${body.line}`);

      // Look up the symbol in the graph to get accurate line_start / line_end
      const subgraph = context.repository.querySubgraph(
        body.symbol,
        body.file,
        body.line,
        0,
        1
      );

      // BUG-5 fix: if symbol not found, return null cleanly instead of reversed line numbers
      if (!subgraph.target) {
        res.json({
          target_symbol: null,
          bounded_source_excerpt: null,
          stale_state: subgraph.freshness
        });
        return;
      }

      const source = await maybeReadBoundedSource(context, body);
      res.json({
        target_symbol: {
          name: subgraph.target.name,
          kind: subgraph.target.kind,
          file: subgraph.target.file,
          line_start: subgraph.target.line_start,
          line_end: subgraph.target.line_end,
          freshness: subgraph.target.freshness,
          stale_reason: subgraph.target.stale_reason
        },
        bounded_source_excerpt: source,
        stale_state: subgraph.freshness
      });
    } catch (error) {
      context.logger.error(`[READ_SOURCE] Error:`, error instanceof Error ? error.message : String(error));
      next(error);
    }
  });

  app.post("/edge/confirm", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<EdgeDecisionRequest>(edgeDecisionSchema, req.body);
      context.repository.confirmEdge(body.edge_id);
      // BUG-7 fix: return result key in ok:true responses
      res.json({ ok: true, result: "confirmed" });
    } catch (error) {
      if (error instanceof NotFoundError) {
        next(new Error(error.message));
      } else {
        next(error);
      }
    }
  });

  app.post("/edge/dismiss", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody<EdgeDecisionRequest>(edgeDecisionSchema, req.body);
      context.repository.dismissEdge(body.edge_id);
      // BUG-7 fix: return result key in ok:true responses
      res.json({ ok: true, result: "dismissed" });
    } catch (error) {
      if (error instanceof NotFoundError) {
        next(new Error(error.message));
      } else {
        next(error);
      }
    }
  });

  app.post("/cache/clear", (req: Request, res: Response) => {
    const hardReset = req.body?.hard_reset === true;
    const graphOnly = req.body?.graph_only === true;
    if (hardReset) {
      context.repository.clearAll();
    } else if (graphOnly) {
      context.repository.clearGraphCache();
    } else {
      context.repository.clearCache();
    }
    res.json({ ok: true });
  });

  app.get("/graph/orbit", (_req: Request, res: Response) => {
    res.json(context.repository.orbitGraph());
  });

  app.post("/shutdown", (_req: Request, res: Response) => {
    res.json({ ok: true });
    setTimeout(() => context.shutdown(), 10);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    context.logger.warn("request failed", message);
    if (error instanceof NotFoundError) {
      res.status(404).json({ ok: false, error: message });
    } else {
      res.status(400).json({ ok: false, error: message });
    }
  });

  return app;
}

function getClampedSlidingWindow(content: string, targetLine: number): { lineStart: number; lineEnd: number; text: string } {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const clampedTarget = Math.max(1, Math.min(totalLines, targetLine));
  const startIdx = Math.max(0, clampedTarget - 1 - 10);
  const endIdx = Math.min(totalLines - 1, clampedTarget - 1 + 10);
  const selectedLines = lines.slice(startIdx, endIdx + 1);
  return {
    lineStart: startIdx + 1,
    lineEnd: endIdx + 1,
    text: selectedLines.join("\n")
  };
}

async function maybeReadBoundedSource(
  context: RouteContext,
  request: AgentContextRequest
): Promise<{ file: string; line_start: number; line_end: number; text: string } | null> {
  try {
    const absolute = assertFileInsideWorkspace(context.workspaceRoot, request.file);
    const content = await fs.readFile(absolute, "utf8");
    const snippet = await context.parser.readNodeBody(request.file, content, request.line);
    let lineStart: number;
    let lineEnd: number;
    let text: string;

    if (snippet) {
      lineStart = snippet.lineStart;
      lineEnd = snippet.lineEnd;
      text = snippet.text;
    } else {
      const fallback = getClampedSlidingWindow(content, request.line);
      lineStart = fallback.lineStart;
      lineEnd = fallback.lineEnd;
      text = fallback.text;
    }

    const budget = request.source_budget ?? 2500;
    return {
      file: request.file,
      line_start: lineStart,
      line_end: lineEnd,
      text: text.length > budget ? `${text.slice(0, budget)}\n...` : text
    };
  } catch {
    return null;
  }
}

function auth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const got = req.header(AUTH_HEADER) ?? req.header(AUTH_HEADER_LEGACY);
    if (got !== token) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    next();
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function assertWorkspace(expected: string, received: string): void {
  const a = path.resolve(expected);
  const b = path.resolve(received);
  // Case-insensitive only where the OS is case-insensitive.
  const equal =
    process.platform === "win32" || process.platform === "darwin"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  if (!equal) {
    throw new Error("workspace_root does not match daemon workspace");
  }
}

function assertFileInsideWorkspace(workspaceRoot: string, file: string): string {
  const absolute = absoluteWorkspaceFile(workspaceRoot, file);
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedFile = path.resolve(absolute);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const rootCmp = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
  const fileCmp = caseInsensitive ? resolvedFile.toLowerCase() : resolvedFile;
  const inside =
    fileCmp === rootCmp ||
    fileCmp.startsWith(rootCmp + path.sep);
  if (!inside) {
    throw new Error(`File escapes workspace: ${file}`);
  }
  return absolute;
}

async function validateLineQuery(workspaceRoot: string, file: string, line: number): Promise<{ totalLines: number; clampedLine: number }> {
  const absolute = assertFileInsideWorkspace(workspaceRoot, file);
  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch {
    throw new Error(`File not found: ${file}`);
  }
  const totalLines = content.split(/\r?\n/).length;
  // After a branch switch / edit, the AI may replay a stale line number from
  // the graph. Clamp instead of 400 so the query degrades gracefully; the
  // repository falls back to the containing node / global name search.
  const clampedLine = Math.max(1, Math.min(line, Math.max(1, totalLines)));
  return { totalLines, clampedLine };
}

async function maybeReadSource(
  context: RouteContext,
  request: ExplainRequest,
  hasInferredEdges: boolean,
  isStale: boolean
): Promise<SourceSnippet | null> {
  const needsSource =
    hasInferredEdges || isStale || request.user_level === "expert" || request.depth >= 2 || request.debug_graph_json === true;
  if (!needsSource) {
    return null;
  }

  try {
    const absolute = assertFileInsideWorkspace(context.workspaceRoot, request.file);
    const content = await fs.readFile(absolute, "utf8");
    const snippet = await context.parser.readNodeBody(request.file, content, request.line);
    if (!snippet) {
      const fallback = getClampedSlidingWindow(content, request.line);
      const text = fallback.text;
      const budget = 2500;
      return {
        file: request.file,
        line_start: fallback.lineStart,
        line_end: fallback.lineEnd,
        text: text.length > budget ? `${text.slice(0, budget)}\n...[truncated]` : text
      };
    }
    // Cap even AST-bounded source so a huge file can't blow the LLM context
    // or hang llama.cpp (the old code had no cap here).
    const budget = 2500;
    const text = snippet.text;
    return {
      file: request.file,
      line_start: snippet.lineStart,
      line_end: snippet.lineEnd,
      text: text.length > budget ? `${text.slice(0, budget)}\n...[truncated]` : text
    };
  } catch {
    return null;
  }
}
