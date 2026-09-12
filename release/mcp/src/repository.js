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
    const target = this.findTarget(symbol, file, line);
    if (!target) {
      return { target: null, nodes: [], edges: [], directional: { calls: [], called_by: [] }, cachedExplanation: null, freshness: "UNINDEXED" };
    }

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
    const directional = this.directionalEdges(target.id, maxEdges);
    return { target: dto, nodes, edges, directional, cachedExplanation: target.my_cached_explanation ?? null, freshness: dto.freshness };
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

  findTarget(symbol, file, line) {
    if (file && line !== undefined && symbol) {
      const node = this.findNode(symbol, file, line);
      if (node) return node;
    }
    if (symbol) {
      const byName = this.findSymbolByName(symbol, file);
      if (byName) return byName;
    }
    if (file && line !== undefined) {
      return this.findContaining(file, line);
    }
    return null;
  }

  findSymbolByName(name, preferredFile) {
    if (preferredFile) {
      const nf = normalizeWorkspaceFile(this.workspaceRoot, preferredFile);
      const inPref = this.db.prepare(`
        SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
        FROM code_nodes n
        LEFT JOIN mind_concepts mc ON mc.node_id = n.id
        LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
        WHERE n.tombstoned = 0 AND n.file = ? AND n.name = ?
        ORDER BY (n.line_end - n.line_start) ASC LIMIT 1
      `).get(nf, name);
      if (inPref) return inPref;
    }
    return this.db.prepare(`
      SELECT n.*, mc.description AS my_cached_explanation, mc.verified_commit, sl.reason AS stale_reason
      FROM code_nodes n
      LEFT JOIN mind_concepts mc ON mc.node_id = n.id
      LEFT JOIN staleness_log sl ON sl.node_id = n.id AND sl.re_verified_at IS NULL
      WHERE n.tombstoned = 0 AND n.name = ?
      ORDER BY (n.line_end - n.line_start) ASC LIMIT 1
    `).get(name) ?? null;
  }

  searchSymbols(query, kind, limit = 20) {
    const cleanLimit = Math.min(Math.max(1, limit), 100);
    if (kind) {
      return this.db.prepare(`
        SELECT n.id, n.name, n.kind, n.file, n.line_start, n.line_end, n.signature,
          ((SELECT COUNT(*) FROM code_edges WHERE to_id = n.id AND dismissed = 0) +
           (SELECT COUNT(*) FROM code_edges WHERE from_id = n.id AND dismissed = 0)) AS total_degree
        FROM code_nodes n
        WHERE n.tombstoned = 0 AND n.kind = ? AND n.name LIKE ?
        ORDER BY (n.name = ?) DESC, total_degree DESC, LENGTH(n.name) ASC, n.file ASC
        LIMIT ?
      `).all(kind, `%${query}%`, query, cleanLimit);
    }
    return this.db.prepare(`
      SELECT n.id, n.name, n.kind, n.file, n.line_start, n.line_end, n.signature,
        ((SELECT COUNT(*) FROM code_edges WHERE to_id = n.id AND dismissed = 0) +
         (SELECT COUNT(*) FROM code_edges WHERE from_id = n.id AND dismissed = 0)) AS total_degree
      FROM code_nodes n
      WHERE n.tombstoned = 0 AND n.name LIKE ?
      ORDER BY (n.name = ?) DESC, total_degree DESC, LENGTH(n.name) ASC, n.file ASC
      LIMIT ?
    `).all(`%${query}%`, query, cleanLimit);
  }

  getContextSlice(symbolName, file, options = {}) {
    const maxCallees = Math.min(Math.max(1, options.maxCallees ?? 3), 10);
    const maxCallers = Math.min(Math.max(1, options.maxCallers ?? 2), 10);

    const target = file ? this.findSymbolByName(symbolName, file) : this.findSymbolByName(symbolName);
    if (!target) return null;

    const callees = this.db.prepare(`
      SELECT tn.id, tn.name, tn.kind, tn.file, tn.line_start, tn.line_end, tn.signature, e.type
      FROM code_edges e
      JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
      WHERE e.from_id = ? AND e.dismissed = 0
      ORDER BY (SELECT COUNT(*) FROM code_edges ce WHERE ce.to_id = tn.id AND ce.dismissed = 0) DESC, tn.name ASC
      LIMIT ?
    `).all(target.id, maxCallees);

    const callers = this.db.prepare(`
      SELECT fn.id, fn.name, fn.kind, fn.file, fn.line_start, fn.line_end, fn.signature, e.type
      FROM code_edges e
      JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
      WHERE e.to_id = ? AND e.dismissed = 0
      ORDER BY (SELECT COUNT(*) FROM code_edges ce WHERE ce.to_id = fn.id AND ce.dismissed = 0) DESC, fn.name ASC
      LIMIT ?
    `).all(target.id, maxCallers);

    const impactRow = this.db.prepare(`
      WITH RECURSIVE impact(node_id, depth) AS (
        SELECT ? AS node_id, 0 AS depth
        UNION
        SELECT e.from_id, imp.depth + 1
        FROM code_edges e
        JOIN impact imp ON e.to_id = imp.node_id
        JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
        WHERE imp.depth < 3 AND e.dismissed = 0
      )
      SELECT COUNT(DISTINCT node_id) - 1 AS blast_radius_count FROM impact;
    `).get(target.id);
    const blastRadiusCount = Math.max(0, impactRow?.blast_radius_count ?? 0);

    const testCallers = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM code_edges e
      JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
      WHERE e.to_id = ? AND e.dismissed = 0
        AND (fn.file LIKE '%.test.%' OR fn.file LIKE '%.spec.%' OR fn.file LIKE '%/test/%' OR fn.file LIKE '%__tests__%')
    `).get(target.id)?.c ?? 0;

    return {
      target: this.toDto(target),
      callees,
      callers,
      blast_radius_count: blastRadiusCount,
      has_test_coverage: testCallers > 0,
      test_callers_count: testCallers
    };
  }

  getOverview(topN = 10) {
    const stats = this.stats();
    const totalEdges = this.db.prepare("SELECT COUNT(*) AS c FROM code_edges WHERE dismissed = 0").get()?.c ?? 0;

    const entrypointNames = ["main", "activate", "init", "start", "run", "app", "createapp", "bootstrap", "handler", "server"];
    const ph = entrypointNames.map(() => "?").join(",");
    const entrypoints = this.db.prepare(`
      SELECT n.id, n.name, n.kind, n.file, n.line_start, n.line_end, n.signature
      FROM code_nodes n
      WHERE n.tombstoned = 0 AND LOWER(n.name) IN (${ph})
      ORDER BY (SELECT COUNT(*) FROM code_edges WHERE to_id = n.id AND dismissed = 0) DESC, n.file ASC
      LIMIT 15
    `).all(...entrypointNames);

    const hubs = this.db.prepare(`
      SELECT n.id, n.name, n.kind, n.file, n.line_start, n.line_end,
        (SELECT COUNT(*) FROM code_edges WHERE to_id = n.id AND dismissed = 0) AS in_degree,
        (SELECT COUNT(*) FROM code_edges WHERE from_id = n.id AND dismissed = 0) AS out_degree,
        ((SELECT COUNT(*) FROM code_edges WHERE to_id = n.id AND dismissed = 0) +
         (SELECT COUNT(*) FROM code_edges WHERE from_id = n.id AND dismissed = 0)) AS total_degree
      FROM code_nodes n
      WHERE n.tombstoned = 0
      ORDER BY total_degree DESC, n.name ASC
      LIMIT ?
    `).all(Math.min(Math.max(1, topN), 50));

    const files = this.db.prepare("SELECT DISTINCT file FROM code_nodes WHERE tombstoned = 0").all();
    const langCounts = {};
    for (const r of files) {
      const idx = r.file.lastIndexOf(".");
      if (idx !== -1) {
        const ext = r.file.slice(idx).toLowerCase();
        langCounts[ext] = (langCounts[ext] || 0) + 1;
      }
    }

    return {
      stats: { indexedFiles: stats.indexedFiles, indexedNodes: stats.indexedNodes, totalEdges },
      entrypoints,
      central_hubs: hubs.filter((h) => h.total_degree > 0),
      languages: langCounts
    };
  }

  getImpactAnalysis(symbolName, file, maxDepth = 3) {
    const target = file ? this.findSymbolByName(symbolName, file) : this.findSymbolByName(symbolName);
    if (!target) return null;

    const rows = this.db.prepare(`
      WITH RECURSIVE impact(node_id, depth, chain) AS (
        SELECT ? AS node_id, 0 AS depth, CAST(? AS TEXT) AS chain
        UNION
        SELECT e.from_id, imp.depth + 1, fn.name || ' -> ' || imp.chain
        FROM code_edges e
        JOIN impact imp ON e.to_id = imp.node_id
        JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
        WHERE imp.depth < ?
          AND e.dismissed = 0
          AND imp.chain NOT LIKE '%' || fn.name || '%'
      )
      SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line_start, n.line_end, imp.depth, imp.chain
      FROM impact imp
      JOIN code_nodes n ON n.id = imp.node_id
      WHERE imp.depth > 0
      ORDER BY imp.depth ASC, n.name ASC
      LIMIT 50;
    `).all(target.id, target.name, Math.min(Math.max(1, maxDepth), 5));

    return {
      target: this.toDto(target),
      dependents_count: rows.length,
      dependents: rows
    };
  }

  findShortestPath(fromSymbol, toSymbol, maxDepth = 6) {
    const fromNode = this.findSymbolByName(fromSymbol);
    const toNode = this.findSymbolByName(toSymbol);
    if (!fromNode || !toNode) {
      return {
        found: false,
        reason: !fromNode ? `Symbol not found: ${fromSymbol}` : `Symbol not found: ${toSymbol}`
      };
    }
    if (fromNode.id === toNode.id) {
      return { found: true, depth: 0, path: [fromNode.name], path_string: fromNode.name };
    }

    const row = this.db.prepare(`
      WITH RECURSIVE search_path(curr_id, depth, path_str) AS (
        SELECT ? AS curr_id, 0 AS depth, CAST(? AS TEXT) AS path_str
        UNION ALL
        SELECT e.to_id, sp.depth + 1, sp.path_str || ' -> ' || tn.name
        FROM code_edges e
        JOIN search_path sp ON e.from_id = sp.curr_id
        JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
        WHERE sp.depth < ?
          AND e.dismissed = 0
          AND sp.path_str NOT LIKE '%' || tn.name || '%'
      )
      SELECT path_str, depth
      FROM search_path
      WHERE curr_id = ?
      ORDER BY depth ASC
      LIMIT 1;
    `).get(fromNode.id, fromNode.name, Math.min(Math.max(1, maxDepth), 8), toNode.id);

    if (!row) {
      return { found: false, reason: `No path found between ${fromSymbol} and ${toSymbol} within depth ${maxDepth}` };
    }

    return {
      found: true,
      depth: row.depth,
      path: row.path_str.split(" -> "),
      path_string: row.path_str
    };
  }

  directionalEdges(targetId, maxEdges = 20) {
    const calls = this.db.prepare(`
      SELECT e.id, e.type, tn.name AS target_name, tn.file AS target_file, tn.line_start
      FROM code_edges e
      JOIN code_nodes tn ON tn.id = e.to_id AND tn.tombstoned = 0
      WHERE e.from_id = ? AND e.dismissed = 0
      ORDER BY e.type, tn.name
      LIMIT ?
    `).all(targetId, maxEdges);

    const calledBy = this.db.prepare(`
      SELECT e.id, e.type, fn.name AS source_name, fn.file AS source_file, fn.line_start
      FROM code_edges e
      JOIN code_nodes fn ON fn.id = e.from_id AND fn.tombstoned = 0
      WHERE e.to_id = ? AND e.dismissed = 0
      ORDER BY e.type, fn.name
      LIMIT ?
    `).all(targetId, maxEdges);

    return { calls, called_by: calledBy };
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
    return this.findSymbolByName(symbol, file);
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
