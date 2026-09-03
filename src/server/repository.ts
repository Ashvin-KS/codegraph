import type Database from "better-sqlite3";
import { normalizeWorkspaceFile } from "../shared/fs";
import type { EdgeConfidence, Freshness, GraphEdgeDto, GraphNodeDto, OrbitGraphResponse, UserLevel } from "../shared/protocol";
import { stableNodeKey } from "./hash";
import type { ParsedEdge, ParsedNode } from "./parser";

interface NodeRow {
  id: number;
  stable_key: string;
  name: string;
  kind: string;
  file: string;
  line_start: number;
  line_end: number;
  signature: string | null;
  body_hash: string | null;
  commit_hash: string;
  tombstoned: number;
  my_cached_explanation?: string | null;
  verified_commit?: string | null;
  stale_reason?: string | null;
}

interface EdgeRow {
  id: number;
  from_id: number;
  to_id: number;
  type: string;
  confidence: EdgeConfidence;
  inferred_score: number | null;
  confirmed_at: string | null;
  dismissed: number;
  target_name: string;
}

interface ConceptRow {
  id: number;
  description: string | null;
  verified_commit: string | null;
  user_level: UserLevel;
  context_used: string | null;
}

export interface SubgraphResult {
  target: GraphNodeDto | null;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  cachedExplanation: string | null;
  freshness: Freshness;
}

export interface IndexResult {
  file: string;
  nodes: number;
  edges: number;
}

export class NotFoundError extends Error {}

export class GraphRepository {
  public constructor(
    private readonly db: Database.Database,
    private readonly workspaceRoot: string
  ) {}

  public beginIndexRun(fileCount: number): number {
    const result = this.db
      .prepare("INSERT INTO index_runs(workspace_root, file_count) VALUES (?, ?)")
      .run(this.workspaceRoot, fileCount);
    return Number(result.lastInsertRowid);
  }

  public finishIndexRun(runId: number, nodeCount: number, status: "ready" | "failed", error?: string): void {
    this.db
      .prepare(
        "UPDATE index_runs SET finished_at = CURRENT_TIMESTAMP, node_count = ?, status = ?, error = ? WHERE id = ?"
      )
      .run(nodeCount, status, error ?? null, runId);
  }

  public upsertFileIndex(file: string, nodes: ParsedNode[], edges: ParsedEdge[], commitHash: string): IndexResult {
    const normalizedFile = normalizeWorkspaceFile(this.workspaceRoot, file);
    const tx = this.db.transaction(() => {
      // Include tombstoned rows so a re-added symbol reuses its stable id.
      const previousRows = this.db
        .prepare("SELECT * FROM code_nodes WHERE file = ?")
        .all(normalizedFile) as NodeRow[];

      const previousByKey = new Map(previousRows.map((row) => [row.stable_key, row]));
      const currentKeys = new Set<string>();
      const idByKey = new Map<string, number>();
      // Map from node array index -> stable key (handles duplicate names).
      const keyByIndex = new Map<number, string>();

      // Assign stable keys WITHOUT line numbers so line shifts don't churn
      // the tree. Duplicates in the same file get deterministic "#2" suffixes
      // in lineStart order (stable unless nodes are added/removed in between).
      const order = nodes.map((n, i) => i).sort((a, b) => (nodes[a]?.lineStart ?? 0) - (nodes[b]?.lineStart ?? 0));
      const seenCount = new Map<string, number>();
      for (const idx of order) {
        const node = nodes[idx];
        if (!node) continue;
        const base = `${node.kind}\0${node.name}`;
        const count = (seenCount.get(base) ?? 0) + 1;
        seenCount.set(base, count);
        const disambiguator = count === 1 ? "" : `#${count}`;
        keyByIndex.set(idx, stableNodeKey(normalizedFile, node.kind, node.name, disambiguator));
      }

      const insertNode = this.db.prepare(`
        INSERT INTO code_nodes(stable_key, name, kind, file, line_start, line_end, signature, body_hash, commit_hash, tombstoned, updated_at)
        VALUES (@stable_key, @name, @kind, @file, @line_start, @line_end, @signature, @body_hash, @commit_hash, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(stable_key) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          file = excluded.file,
          line_start = excluded.line_start,
          line_end = excluded.line_end,
          signature = excluded.signature,
          body_hash = excluded.body_hash,
          commit_hash = excluded.commit_hash,
          tombstoned = 0,
          updated_at = CURRENT_TIMESTAMP
      `);
      // Silent position-only update: keeps stable tree + stable updated_at
      // when only line numbers shifted (edit above the symbol).
      const touchPosition = this.db.prepare(`
        UPDATE code_nodes SET line_start = ?, line_end = ?, commit_hash = ?, tombstoned = 0 WHERE stable_key = ?
      `);
      const getId = this.db.prepare("SELECT id FROM code_nodes WHERE stable_key = ?");

      for (let idx = 0; idx < nodes.length; idx += 1) {
        const node = nodes[idx];
        if (!node) continue;
        const key = keyByIndex.get(idx) ?? stableNodeKey(normalizedFile, node.kind, node.name);
        currentKeys.add(key);
        const previous = previousByKey.get(key);
        if (!previous) {
          insertNode.run({
            stable_key: key,
            name: node.name,
            kind: node.kind,
            file: normalizedFile,
            line_start: node.lineStart,
            line_end: node.lineEnd,
            signature: node.signature,
            body_hash: node.bodyHash,
            commit_hash: commitHash
          });
        } else if (
          previous.body_hash === node.bodyHash &&
          (previous.signature ?? null) === (node.signature ?? null)
        ) {
          // Content identical: only lines/commit may have shifted. Update
          // silently without touching updated_at and without stale marking.
          // This is the core fix for "new tree on every re-index".
          if (
            previous.line_start !== node.lineStart ||
            previous.line_end !== node.lineEnd ||
            previous.commit_hash !== commitHash ||
            previous.tombstoned === 1
          ) {
            touchPosition.run(node.lineStart, node.lineEnd, commitHash, key);
          }
        } else {
          if (previous.body_hash !== node.bodyHash) {
            this.markNodeStale(previous.id, previous.commit_hash, commitHash, "Function body changed");
          }
          if ((previous.signature ?? null) !== (node.signature ?? null)) {
            this.markNodeStale(previous.id, previous.commit_hash, commitHash, "Signature changed");
          }
          insertNode.run({
            stable_key: key,
            name: node.name,
            kind: node.kind,
            file: normalizedFile,
            line_start: node.lineStart,
            line_end: node.lineEnd,
            signature: node.signature,
            body_hash: node.bodyHash,
            commit_hash: commitHash
          });
        }

        const row = getId.get(key) as { id: number };
        idByKey.set(key, row.id);
      }

      for (const previous of previousRows) {
        if (previous.tombstoned === 0 && !currentKeys.has(previous.stable_key)) {
          this.markNodeStale(previous.id, previous.commit_hash, commitHash, "Node deleted");
          this.db.prepare("UPDATE code_nodes SET tombstoned = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(previous.id);
        }
      }

      // Collect desired edges for this file index run
      const desiredEdges: Array<{ fromId: number; toId: number; type: string }> = [];
      for (const edge of edges) {
        const fromKey = keyByIndex.get(edge.fromIndex);
        const toKey = keyByIndex.get(edge.toIndex);
        if (!fromKey || !toKey) {
          continue;
        }
        const fromId = idByKey.get(fromKey);
        const toId = idByKey.get(toKey);
        if (fromId && toId && fromId !== toId) {
          desiredEdges.push({ fromId, toId, type: edge.type });
        }
      }

      // Query existing syntactic edges in this file for the given from_ids
      interface EdgeRecord {
        id: number;
        from_id: number;
        to_id: number;
        type: string;
      }
      let existingEdges: EdgeRecord[] = [];
      if (idByKey.size > 0) {
        const ids = [...idByKey.values()];
        const placeholders = ids.map(() => "?").join(",");
        existingEdges = this.db
          .prepare(`SELECT id, from_id, to_id, type FROM code_edges WHERE confidence = 'syntactic' AND file_context = ? AND from_id IN (${placeholders})`)
          .all(normalizedFile, ...ids) as EdgeRecord[];
      }

      const edgeKey = (e: { fromId: number; toId: number; type: string }) => `${e.fromId}:${e.toId}:${e.type}`;
      const edgeRecordKey = (e: EdgeRecord) => `${e.from_id}:${e.to_id}:${e.type}`;

      const desiredEdgeKeys = new Set(desiredEdges.map(edgeKey));
      const existingEdgeKeys = new Set(existingEdges.map(edgeRecordKey));

      // Delete syntactic edges that are no longer present in the parsed code
      const deleteEdge = this.db.prepare("DELETE FROM code_edges WHERE id = ?");
      for (const existing of existingEdges) {
        if (!desiredEdgeKeys.has(edgeRecordKey(existing))) {
          deleteEdge.run(existing.id);
        }
      }

      // Insert only new syntactic edges that do not already exist in the database
      const insertEdge = this.db.prepare(`
        INSERT INTO code_edges(from_id, to_id, type, confidence, inferred_score, dismissed, file_context, updated_at)
        VALUES (?, ?, ?, 'syntactic', NULL, 0, ?, CURRENT_TIMESTAMP)
      `);

      let edgeCount = 0;
      for (const desired of desiredEdges) {
        if (!existingEdgeKeys.has(edgeKey(desired))) {
          insertEdge.run(desired.fromId, desired.toId, desired.type, normalizedFile);
        }
        edgeCount += 1;
      }

      return { file: normalizedFile, nodes: nodes.length, edges: edgeCount };
    });

    return tx() as IndexResult;
  }

  public upsertLspReferences(references: Array<{ symbol: string; file: string; line: number; references: Array<{ file: string; line: number }> }>): number {
    const tx = this.db.transaction(() => {
      let count = 0;
      const insertEdge = this.db.prepare(`
        INSERT INTO code_edges(from_id, to_id, type, confidence, inferred_score, dismissed, file_context, updated_at)
        VALUES (?, ?, 'used_by', 'syntactic', NULL, 0, 'lsp', CURRENT_TIMESTAMP)
        ON CONFLICT(from_id, to_id, type) DO UPDATE SET
          confidence = 'syntactic',
          dismissed = 0,
          updated_at = CURRENT_TIMESTAMP
      `);

      for (const entry of references) {
        const source = this.findNode(entry.symbol, entry.file, entry.line);
        if (!source) {
          continue;
        }
        for (const ref of entry.references) {
          const target = this.findContainingNode(ref.file, ref.line);
          if (target && target.id !== source.id) {
            insertEdge.run(source.id, target.id);
            count += 1;
          }
        }
      }
      return count;
    });

    return tx() as number;
  }

  public querySubgraph(symbol: string | undefined, file: string, line: number, depth: number, maxEdges: number): SubgraphResult {
    let targetRow = this.findNode(symbol || "", file, line);
    if (!targetRow) {
      const containing = this.findContainingNode(file, line);
      if (containing && (!symbol || containing.name.toLowerCase() === symbol.toLowerCase())) {
        targetRow = containing;
      }
    }
    if (!targetRow) {
      return { target: null, nodes: [], edges: [], cachedExplanation: null, freshness: "UNINDEXED" };
    }

    const rows = this.db
      .prepare(
        `
        WITH RECURSIVE subgraph(node_id, depth) AS (
          SELECT ? AS node_id, 0 AS depth
          UNION
          SELECT e.to_id, s.depth + 1
          FROM code_edges e
          JOIN subgraph s ON e.from_id = s.node_id
          JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
          WHERE s.depth < ?
            AND e.confidence = 'syntactic'
            AND e.dismissed = 0
            AND e.type IN ('calls', 'uses_type', 'mutates', 'implements', 'imports', 're_exports', 'used_by')
            AND (SELECT COUNT(*) FROM code_edges incoming WHERE incoming.to_id = e.to_id AND incoming.dismissed = 0) <= ?
        )
        SELECT DISTINCT
          n.*,
          mc.description AS my_cached_explanation,
          mc.verified_commit,
          sl.reason AS stale_reason
        FROM subgraph s
        JOIN code_nodes n ON n.id = s.node_id
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0
        ORDER BY s.depth, n.name
        `
      )
      .all(targetRow.id, Math.max(0, depth), maxEdges) as NodeRow[];

    const nodeIds = rows.map((row) => row.id);
    const edges = nodeIds.length > 0 ? this.edgesForNodes(nodeIds, maxEdges) : [];
    const nodes = rows.map((row) => this.toGraphNode(row));
    const target = nodes.find((node) => node.id === targetRow.id) ?? this.toGraphNode(targetRow);
    const freshness = target.freshness;

    return {
      target,
      nodes,
      edges,
      cachedExplanation: targetRow.my_cached_explanation ?? null,
      freshness
    };
  }

  public saveExplanation(nodeId: number, term: string, description: string, userLevel: UserLevel, verifiedCommit: string, contextUsed: string): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM mind_concepts WHERE node_id = ?").get(nodeId) as ConceptRow | undefined;
      if (existing?.description && existing.description !== description) {
        this.db
          .prepare(
            `INSERT INTO mind_concept_history(node_id, term, description, user_level, verified_commit, context_used, reason)
             VALUES (?, ?, ?, ?, ?, ?, 'replaced')`
          )
          .run(nodeId, term, existing.description, existing.user_level, existing.verified_commit, existing.context_used);
      }

      this.db
        .prepare(
          `
          INSERT INTO mind_concepts(node_id, term, description, user_level, verified_commit, context_used, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(node_id) DO UPDATE SET
            term = excluded.term,
            description = excluded.description,
            user_level = excluded.user_level,
            verified_commit = excluded.verified_commit,
            context_used = excluded.context_used,
            updated_at = CURRENT_TIMESTAMP
          `
        )
        .run(nodeId, term, description, userLevel, verifiedCommit, contextUsed);

      const session = this.db
        .prepare("INSERT INTO mind_sessions(trigger_symbol, zoom_level, explanation) VALUES (?, ?, ?)")
        .run(term, userLevel, description);
      const concept = this.db.prepare("SELECT id FROM mind_concepts WHERE node_id = ?").get(nodeId) as { id: number };
      this.db
        .prepare("INSERT INTO mind_concept_sessions(concept_id, session_id) VALUES (?, ?)")
        .run(concept.id, Number(session.lastInsertRowid));
      this.db
        .prepare("UPDATE staleness_log SET re_verified_at = CURRENT_TIMESTAMP WHERE node_id = ? AND re_verified_at IS NULL")
        .run(nodeId);
    });

    tx();
  }

  public clearCache(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM mind_concept_sessions").run();
      this.db.prepare("DELETE FROM mind_sessions").run();
      this.db.prepare("DELETE FROM mind_concept_history").run();
      this.db.prepare("DELETE FROM mind_concepts").run();
      this.db.prepare("UPDATE staleness_log SET re_verified_at = CURRENT_TIMESTAMP WHERE re_verified_at IS NULL").run();
    });
    tx();
  }

  public clearAll(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM mind_concept_sessions").run();
      this.db.prepare("DELETE FROM mind_sessions").run();
      this.db.prepare("DELETE FROM mind_concept_history").run();
      this.db.prepare("DELETE FROM mind_concepts").run();
      this.db.prepare("DELETE FROM staleness_log").run();
      this.db.prepare("DELETE FROM code_edges").run();
      this.db.prepare("DELETE FROM code_nodes").run();
      this.db.prepare("DELETE FROM index_runs").run();
    });
    tx();
  }

  public clearGraphCache(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM code_edges").run();
      this.db.prepare("DELETE FROM code_nodes").run();
      this.db.prepare("DELETE FROM index_runs").run();
    });
    tx();
  }

  public confirmEdge(edgeId: number): void {
    const result = this.db
      .prepare("UPDATE code_edges SET confidence = 'syntactic', confirmed_at = CURRENT_TIMESTAMP, dismissed = 0 WHERE id = ?")
      .run(edgeId);
    if (result.changes === 0) {
      throw new NotFoundError(`Edge with ID ${edgeId} not found`);
    }
  }

  public dismissEdge(edgeId: number): void {
    const result = this.db
      .prepare("UPDATE code_edges SET dismissed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(edgeId);
    if (result.changes === 0) {
      throw new NotFoundError(`Edge with ID ${edgeId} not found`);
    }
  }

  public orbitGraph(limit = 250): OrbitGraphResponse {
    const nodes = this.db
      .prepare(
        `
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0
        ORDER BY n.file ASC, n.name ASC
        LIMIT ?
        `
      )
      .all(limit) as NodeRow[];
    const nodeIds = new Set(nodes.map((node) => node.id));
    const placeholders = [...nodeIds].map(() => "?").join(",");
    const edges = nodeIds.size
      ? (this.db
          .prepare(
            `
            SELECT e.*, tn.name AS target_name
            FROM code_edges e
            JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
            JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
            WHERE e.dismissed = 0
              AND e.from_id IN (${placeholders})
              AND e.to_id IN (${placeholders})
            LIMIT ?
            `
          )
          .all(...nodeIds, ...nodeIds, limit * 2) as EdgeRow[])
      : [];

    return {
      nodes: nodes.map((node) => {
        const dto = this.toGraphNode(node);
        return {
          id: dto.id,
          name: dto.name,
          kind: dto.kind,
          file: dto.file,
          freshness: dto.freshness
        };
      }),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.from_id,
        target: edge.to_id,
        type: edge.type,
        confidence: edge.confidence
      }))
    };
  }

  public stats(): { indexedFiles: number; indexedNodes: number } {
    const files = this.db
      .prepare("SELECT COUNT(DISTINCT file) AS count FROM code_nodes WHERE tombstoned = 0")
      .get() as { count: number };
    const nodes = this.db
      .prepare("SELECT COUNT(*) AS count FROM code_nodes WHERE tombstoned = 0")
      .get() as { count: number };
    return { indexedFiles: files.count, indexedNodes: nodes.count };
  }

  public nodesForFiles(files: string[]): NodeRow[] {
    if (files.length === 0) {
      return [];
    }
    const normalized = files.map((file) => normalizeWorkspaceFile(this.workspaceRoot, file));
    const placeholders = normalized.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM code_nodes WHERE tombstoned = 0 AND file IN (${placeholders})`)
      .all(...normalized) as NodeRow[];
  }

  public recordGitRationale(files: string[], commitHash: string, message: string, author: string, committedAt: string): void {
    const nodes = this.nodesForFiles(files);
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO git_rationale(node_id, commit_hash, commit_message, author, committed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id, commit_hash) DO UPDATE SET
          commit_message = excluded.commit_message,
          author = excluded.author,
          committed_at = excluded.committed_at
      `);
      for (const node of nodes) {
        insert.run(node.id, commitHash, message, author, committedAt);
        this.markNodeStale(node.id, node.commit_hash, commitHash, `Git commit touched ${node.file}`);
      }
    });
    tx();
  }

  private findNode(symbol: string, file: string, line: number): NodeRow | null {
    const normalizedFile = normalizeWorkspaceFile(this.workspaceRoot, file);
    const exact = this.db
      .prepare(
        `
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0
          AND n.file = ?
          AND n.name = ?
          AND ? BETWEEN n.line_start AND n.line_end
        ORDER BY (n.line_end - n.line_start) ASC
        LIMIT 1
        `
      )
      .get(normalizedFile, symbol, line) as NodeRow | undefined;
    if (exact) {
      return exact;
    }

    const byName = this.db
      .prepare(
        `
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0 AND n.file = ? AND n.name = ?
        ORDER BY ABS(n.line_start - ?) ASC
        LIMIT 1
        `
      )
      .get(normalizedFile, symbol, line) as NodeRow | undefined;
    if (byName) {
      return byName;
    }

    // Fallback: If not defined locally, search globally by symbol name (e.g. for imports)
    const globalMatch = this.db
      .prepare(
        `
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0 AND n.name = ?
        ORDER BY (n.line_end - n.line_start) ASC
        LIMIT 1
        `
      )
      .get(symbol) as NodeRow | undefined;
    return globalMatch ?? null;
  }

  private findContainingNode(file: string, line: number): NodeRow | null {
    const normalizedFile = normalizeWorkspaceFile(this.workspaceRoot, file);
    const row = this.db
      .prepare(
        `
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0 AND n.file = ? AND ? BETWEEN n.line_start AND n.line_end
        ORDER BY (n.line_end - n.line_start) ASC
        LIMIT 1
        `
      )
      .get(normalizedFile, line) as NodeRow | undefined;
    return row ?? null;
  }

  private edgesForNodes(nodeIds: number[], maxEdges: number): GraphEdgeDto[] {
    const placeholders = nodeIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `
        SELECT e.*, tn.name AS target_name
        FROM code_edges e
        JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
        WHERE e.from_id IN (${placeholders})
          AND e.dismissed = 0
        ORDER BY e.confidence, e.type, tn.name
        LIMIT ?
        `
      )
      .all(...nodeIds, maxEdges) as EdgeRow[];
    return rows.map((row) => ({
      id: row.id,
      from_id: row.from_id,
      to_id: row.to_id,
      type: row.type,
      confidence: row.confidence,
      inferred_score: row.inferred_score,
      confirmed_at: row.confirmed_at,
      dismissed: row.dismissed === 1,
      target_name: row.target_name
    }));
  }

  private markNodeStale(nodeId: number, oldCommit: string | null, newCommit: string | null, reason: string): void {
    const concept = this.db.prepare("SELECT * FROM mind_concepts WHERE node_id = ?").get(nodeId) as ConceptRow | undefined;
    if (concept?.description) {
      this.db
        .prepare(
          `INSERT INTO mind_concept_history(node_id, term, description, user_level, verified_commit, context_used, reason)
           SELECT node_id, term, description, user_level, verified_commit, context_used, ?
           FROM mind_concepts WHERE node_id = ?`
        )
        .run(reason, nodeId);
    }

    const open = this.db
      .prepare("SELECT id FROM staleness_log WHERE node_id = ? AND re_verified_at IS NULL")
      .get(nodeId);
    if (!open) {
      this.db
        .prepare("INSERT INTO staleness_log(node_id, old_commit, new_commit, reason) VALUES (?, ?, ?, ?)")
        .run(nodeId, oldCommit, newCommit, reason);
    }
  }

  private toGraphNode(row: NodeRow): GraphNodeDto {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      file: row.file,
      line_start: row.line_start,
      line_end: row.line_end,
      signature: row.signature,
      commit_hash: row.commit_hash,
      freshness: freshnessFor(row),
      stale_reason: row.stale_reason ?? null
    };
  }
}

function freshnessFor(row: NodeRow): Freshness {
  if (row.stale_reason) {
    return "STALE";
  }
  if (row.commit_hash === "unknown") {
    // No git info: never claim FRESH — a branch switch or edit without a
    // commit would otherwise lie to the AI and the hover.
    return row.verified_commit ? "STALE" : "NEW";
  }
  if (!row.verified_commit) {
    return "NEW";
  }
  if (row.verified_commit !== row.commit_hash) {
    return "STALE";
  }
  return "FRESH";
}
