export function migrate(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS code_nodes (
      id INTEGER PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      signature TEXT,
      body_hash TEXT,
      commit_hash TEXT NOT NULL DEFAULT 'unknown',
      tombstoned INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_name_file ON code_nodes(name, file);
    CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON code_nodes(file, line_start, line_end);
    CREATE INDEX IF NOT EXISTS idx_nodes_tombstoned ON code_nodes(tombstoned);
    CREATE TABLE IF NOT EXISTS code_edges (
      id INTEGER PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'syntactic',
      inferred_score REAL,
      confirmed_at TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      file_context TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_id, to_id, type),
      FOREIGN KEY (from_id) REFERENCES code_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES code_nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON code_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON code_edges(to_id);
    CREATE TABLE IF NOT EXISTS mind_concepts (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL UNIQUE,
      term TEXT NOT NULL,
      description TEXT,
      user_level TEXT NOT NULL DEFAULT 'intermediate',
      verified_commit TEXT,
      context_used TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (node_id) REFERENCES code_nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS staleness_log (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      old_commit TEXT,
      new_commit TEXT,
      reason TEXT,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      re_verified_at TEXT,
      FOREIGN KEY (node_id) REFERENCES code_nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS index_runs (
      id INTEGER PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    );
    INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
  `);
}
