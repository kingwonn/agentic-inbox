/** Ordered SQL migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  actor TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  inbox_item_id TEXT,
  triaged INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_triaged ON signals(triaged, observed_at);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source, occurred_at);

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  priority TEXT NOT NULL DEFAULT 'P2',
  level INTEGER NOT NULL DEFAULT 1,
  level_proposed INTEGER NOT NULL DEFAULT 1,
  level_reason TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  suggested_action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  snoozed_until TEXT,
  task_id TEXT,
  source_signal_ids TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, priority, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'todo',
  category TEXT NOT NULL DEFAULT 'other',
  priority TEXT NOT NULL DEFAULT 'P2',
  level INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'todo',
  owner TEXT NOT NULL DEFAULT 'ai',
  runner TEXT,
  model TEXT,
  plan TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  follow_up_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  budget_usd REAL NOT NULL DEFAULT 2,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_summary TEXT,
  last_error TEXT,
  inbox_item_id TEXT,
  workspace TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  runner TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  resume_of TEXT,
  reason TEXT NOT NULL DEFAULT 'scheduled',
  started_at TEXT,
  ended_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  result_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_task ON runs(task_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  risk TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  decision_note TEXT,
  edited_payload TEXT,
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT,
  channel_refs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  url TEXT,
  content TEXT,
  mime TEXT,
  size INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  target TEXT,
  approval_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  external_ref TEXT,
  error TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_approval ON notifications(approval_id, channel);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.7,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sensor_cursors (
  sensor TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sensor, key)
);

CREATE TABLE IF NOT EXISTS schedules (
  name TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  job TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  day TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    id: "0002_fts",
    sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts USING fts5(title, body, content='signals', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS signals_ai AFTER INSERT ON signals BEGIN
  INSERT INTO signals_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS signals_ad AFTER DELETE ON signals BEGIN
  INSERT INTO signals_fts(signals_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS signals_au AFTER UPDATE ON signals BEGIN
  INSERT INTO signals_fts(signals_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO signals_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`,
  },
];
