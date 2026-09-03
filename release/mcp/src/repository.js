// Self-contained graph repository (better-sqlite3, no daemon).
// Stable keys = file + kind + name (never line numbers) so re-indexing
// the same code yields the same tree and the same ids.
import { normalizeWorkspaceFile } from "./fs.js";
import { stableNodeKey } from "./hash.js";

export class NotFoundError extends Error {}

export class GraphRepository {
  constructor(db, workspaceRoot) {
    this.db = db;
    this.workspaceRoot = workspaceRoot;
  }

  upsertFileIndex(file, nodes, edges, commitHash = "unknown") {
    const normalizedFile = normalizeWorkspaceFile(this.workspaceRoot, file);
    const tx = this.db.transaction(() => {
      const previousRows = this.db
        .prepare("SELECT * FROM code_nodes WHERE file = ?")
        .all(normalizedFile);

      const previousByKey = new Map(previousRows.map((r) => [r.stable_key, r]));
      const currentKeys = new Set();
      const idByKey = new Map();
      const keyByIndex = new Map();

      const order = nodes.map((_, i) => i).sort((a, b) => (nodes[a]?.lineStart ?? 0) - (nodes[b]?.lineStart ?? 0));
      const seen = new Map();
      for (const idx of order) {
        const node = nodes[idx];
        if (!node) continue;
        const base = `${node.kind}\0${node.name}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        keyByIndex.set(idx, stableNodeKey(normalizedFile, node.kind, node.name, count === 1 ? "" : `#${count}`));
      }

      const insertNode = this.db.prepare(`
        INSERT INTO code_nodes(stable_key, name, kind, file, line_start, line_end, signature, body_hash, commit_hash, tombstoned, updated_at)
        VALUES (@stable_key, @name, @kind, @file, @line_start, @line_end, @signature, @body_hash, @commit_hash, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(stable_key) DO UPDATE SET
          name = excluded.name, kind = excluded.kind, file = excluded.file,
          line_start = excluded.line_start, line_end = excluded.line_end,
          signature = excluded.signature, body_hash = excluded.body_hash,
          commit_hash = excluded.commit_hash, tombstoned = 0, updated_at = CURRENT_TIMESTAMP
      `);
      const touchPosition = this.db.prepare(
        `UPDATE code_nodes SET line_start = ?, line_end = ?, commit_hash = ?, tombstoned = 0 WHERE stable_key = ?`
      );
      const getId = this.db.prepare("SELECT id FROM code_nodes WHERE stable_key = ?");

      for (let idx = 0; idx < nodes.length; idx += 1) {
        const node = nodes[idx];
        if (!node) continue;
        const key = keyByIndex.get(idx) ?? stableNodeKey(normalizedFile, node.kind, node.name);
        currentKeys.add(key);
        const previous = previousByKey.get(key);
        if (!previous) {
          insertNode.run({
            stable_key: key, name: node.name, kind: node.kind, file: normalizedFile,
            line_start: node.lineStart, line_end: node.lineEnd,
            signature: node.signature, body_hash: node.bodyHash, commit_hash: commitHash
          });
        } else if (previous.body_hash === node.bodyHash && (previous.signature ?? null) === (node.signature ?? null)) {
          if (previous.line_start !== node.lineStart || previous.line_end !== node.lineEnd ||
              previous.commit_hash !== commitHash || previous.tombstoned === 1) {
            touchPosition.run(node.lineStart, node.lineEnd, commitHash, key);
          }
        } else {
          this.markStale(previous.id, previous.commit_hash, commitHash,
            previous.body_hash !== node.bodyHash ? "Function body changed" : "Signature changed");
          insertNode.run({
            stable_key: key, name: node.name, kind: node.kind, file: normalizedFile,
            line_start: node.lineStart, line_end: node.lineEnd,
            signature: node.signature, body_hash: node.bodyHash, commit_hash: commitHash
          });
        }
        idByKey.set(key, getId.get(key).id);
      }

      for (const previous of previousRows) {
        if (previous.tombstoned === 0 && !currentKeys.has(previous.stable_key)) {
          this.markStale(previous.id, previous.commit_hash, commitHash, "Node deleted");
          this.db.prepare("UPDATE code_nodes SET tombstoned = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(previous.id);
        }
      }

      const desired = [];
      for (const edge of edges) {
        const fromKey = keyByIndex.get(edge.fromIndex);
        const toKey = keyByIndex.get(edge.toIndex);
        if (!fromKey || !toKey) continue;
        const fromId = idByKey.get(fromKey);
        const toId = idByKey.get(toKey);
        if (fromId && toId && fromId !== toId) desired.push({ fromId, toId, type: edge.type });
      }

      let existing = [];
      if (idByKey.size > 0) {
        const ids = [...idByKey.values()];
        const ph = ids.map(() => "?").join(",");
        existing = this.db.prepare(
          `SELECT id, from_id, to_id, type FROM code_edges WHERE confidence = 'syntactic' AND file_context = ? AND from_id IN (${ph})`
        ).all(normalizedFile, ...ids);
      }
      const key = (e) => `${e.fromId ?? e.from_id}:${e.toId ?? e.to_id}:${e.type}`;
      const desiredKeys = new Set(desired.map(key));
      const del = this.db.prepare("DELETE FROM code_edges WHERE id = ?");
      for (const e of existing) {
        if (!desiredKeys.has(`${e.from_id}:${e.to_id}:${e.type}`)) del.run(e.id);
      }
      const existingKeys = new Set(existing.map((e) => `${e.from_id}:${e.to_id}:${e.type}`));
      const ins = this.db.prepare(
        `INSERT INTO code_edges(from_id, to_id, type, confidence, inferred_score, dismissed, file_context, updated_at)
         VALUES (?, ?, ?, 'syntactic', NULL, 0, ?, CURRENT_TIMESTAMP)`
      );
      let edgeCount = 0;
      for (const d of desired) {
        if (!existingKeys.has(`${d.fromId}:${d.toId}:${d.type}`)) ins.run(d.fromId, d.toId, d.type, normalizedFile);
        edgeCount += 1;
      }
      return { file: normalizedFile, nodes: nodes.length, edges: edgeCount };
    });
    return tx();
  }

  querySubgraph(symbol, file, line, depth = 2, maxEdges = 20) {
    let target = this.findNode(symbol || "", file, line);
    if (!target) {
      const containing = this.findContaining(file, line);
      if (containing && (!symbol || containing.name.toLowerCase() === String(symbol).toLowerCase())) target = containing;
    }
    if (!target) return { target: null, nodes: [], edges: [], cachedExplanation: null, freshness: "UNINDEXED" };

    const rows = this.db.prepare(`
      WITH RECURSIVE subgraph(node_id, depth) AS (
        SELECT ? AS node_id, 0 AS depth
        UNION
        SELECT e.to_id, s.depth + 1
        FROM code_edges e
        JOIN subgraph s ON e.from_id = s.node_id
        JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
        WHERE s.depth < ?
          AND e.confidence = 'syntactic' AND e.dismissed = 0
          AND e.type IN ('calls','uses_type','mutates','implements','imports','re_exports','used_by')
          AND (SELECT COUNT(*) FROM code_edges incoming WHERE incoming.to_id = e.to_id AND incoming.dismissed = 0) <= ?
      )
      SELECT DISTINCT n.*, mc.description AS my_cached_explanation, mc.verified_commit,
        sl.reason AS stale_reason
      FROM subgraph s
      JOIN code_nodes n ON n.id = s.node_id
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0
      ORDER BY s.depth, n.name
    `).all(target.id, Math.max(0, depth), maxEdges);

    const ids = rows.map((r) => r.id);
    const edges = ids.length ? this.edgesFor(ids, maxEdges) : [];
    const nodes = rows.map((r) => this.toDto(r));
    const dto = nodes.find((n) => n.id === target.id) ?? this.toDto(target);
    return { target: dto, nodes, edges, cachedExplanation: target.my_cached_explanation ?? null, freshness: dto.freshness };
  }

  confirmEdge(id) {
    const r = this.db.prepare(
      "UPDATE code_edges SET confidence = 'syntactic', confirmed_at = CURRENT_TIMESTAMP, dismissed = 0 WHERE id = ?"
    ).run(id);
    if (r.changes === 0) throw new NotFoundError(`Edge ${id} not found`);
  }

  dismissEdge(id) {
    const r = this.db.prepare("UPDATE code_edges SET dismissed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    if (r.changes === 0) throw new NotFoundError(`Edge ${id} not found`);
  }

  stats() {
    const files = this.db.prepare("SELECT COUNT(DISTINCT file) AS c FROM code_nodes WHERE tombstoned = 0").get();
    const nodes = this.db.prepare("SELECT COUNT(*) AS c FROM code_nodes WHERE tombstoned = 0").get();
    return { indexedFiles: files.c, indexedNodes: nodes.c };
  }

  clearGraphCache() {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM code_edges").run();
      this.db.prepare("DELETE FROM code_nodes").run();
      this.db.prepare("DELETE FROM index_runs").run();
    });
    tx();
  }

  findNode(symbol, file, line) {
    const nf = normalizeWorkspaceFile(this.workspaceRoot, file);
    const exact = this.db.prepare(`
      SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
      FROM code_nodes n
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0 AND n.file = ? AND n.name = ? AND ? BETWEEN n.line_start AND n.line_end
      ORDER BY (n.line_end - n.line_start) ASC LIMIT 1
    `).get(nf, symbol, line);
    if (exact) return exact;
    const byName = this.db.prepare(`
      SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
      FROM code_nodes n
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0 AND n.file = ? AND n.name = ?
      ORDER BY ABS(n.line_start - ?) ASC LIMIT 1
    `).get(nf, symbol, line);
    if (byName) return byName;
    return this.db.prepare(`
      SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
      FROM code_nodes n
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0 AND n.name = ?
      ORDER BY (n.line_end - n.line_start) ASC LIMIT 1
    `).get(symbol) ?? null;
  }

  findContaining(file, line) {
    const nf = normalizeWorkspaceFile(this.workspaceRoot, file);
    return this.db.prepare(`
      SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
      FROM code_nodes n
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0 AND n.file = ? AND ? BETWEEN n.line_start AND n.line_end
      ORDER BY (n.line_end - n.line_start) ASC LIMIT 1
    `).get(nf, line) ?? null;
  }

  edgesFor(ids, maxEdges) {
    const ph = ids.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT e.*, tn.name AS target_name
      FROM code_edges e
      JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
      WHERE e.from_id IN (${ph}) AND e.dismissed = 0
      ORDER BY e.confidence, e.type, tn.name LIMIT ?
    `).all(...ids, maxEdges).map((r) => ({
      id: r.id, from_id: r.from_id, to_id: r.to_id, type: r.type,
      confidence: r.confidence, inferred_score: r.inferred_score,
      confirmed_at: r.confirmed_at, dismissed: r.dismissed === 1, target_name: r.target_name
    }));
  }

  markStale(nodeId, oldCommit, newCommit, reason) {
    const open = this.db.prepare(
      "SELECT id FROM staleness_log WHERE node_id = ? AND re_verified_at IS NULL"
    ).get(nodeId);
    if (!open) {
      this.db.prepare("INSERT INTO staleness_log(node_id, old_commit, new_commit, reason) VALUES (?, ?, ?, ?)")
        .run(nodeId, oldCommit ?? null, newCommit ?? null, reason);
    }
  }

  toDto(row) {
    return {
      id: row.id, name: row.name, kind: row.kind, file: row.file,
      line_start: row.line_start, line_end: row.line_end,
      signature: row.signature ?? null, commit_hash: row.commit_hash,
      freshness: freshnessOf(row), stale_reason: row.stale_reason ?? null
    };
  }
}

function freshnessOf(row) {
  if (row.stale_reason) return "STALE";
  if (row.commit_hash === "unknown") return row.verified_commit ? "STALE" : "NEW";
  if (!row.verified_commit) return "NEW";
  if (row.verified_commit !== row.commit_hash) return "STALE";
  return "FRESH";
}
