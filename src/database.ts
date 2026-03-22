import Database from 'better-sqlite3';
import { getDatabasePath } from './config.js';
import { createLogger } from './logger.js';
import type { CLIType } from './config.js';

const logger = createLogger('DB');

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  cli_type TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  max_context INTEGER,
  effort TEXT,
  max_budget_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  thread_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  cli_session_id TEXT,
  cli_type TEXT NOT NULL,
  directory TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  first_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDatabase(): Database.Database {
  if (db) return db;

  const dbPath = getDatabasePath();
  logger.log(`Opening database: ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration: add columns if missing (for existing DBs)
  const cols = db.pragma('table_info(channels)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('model')) db.exec('ALTER TABLE channels ADD COLUMN model TEXT');
  if (!colNames.has('max_context')) db.exec('ALTER TABLE channels ADD COLUMN max_context INTEGER');
  if (!colNames.has('effort')) db.exec('ALTER TABLE channels ADD COLUMN effort TEXT');
  if (!colNames.has('max_budget_usd')) db.exec('ALTER TABLE channels ADD COLUMN max_budget_usd REAL');

  const sessCols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const sessColNames = new Set(sessCols.map(c => c.name));
  if (!sessColNames.has('first_prompt')) db.exec('ALTER TABLE sessions ADD COLUMN first_prompt TEXT');

  logger.log('Database initialized');
  return db;
}

export function getDb(): Database.Database {
  if (!db) return initDatabase();
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.log('Database closed');
  }
}

// --- Channel operations ---

export function setChannelDirectory(channelId: string, directory: string, cliType: CLIType = 'claude'): void {
  getDb().prepare(
    `INSERT INTO channels (channel_id, directory, cli_type) VALUES (?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET directory = excluded.directory, cli_type = excluded.cli_type`
  ).run(channelId, directory, cliType);
}

export interface ChannelConfig {
  directory: string;
  cli_type: CLIType;
  model: string | null;
  max_context: number | null;
  effort: string | null;
  max_budget_usd: number | null;
}

export function getChannelConfig(channelId: string): ChannelConfig | undefined {
  const row = getDb().prepare(
    'SELECT directory, cli_type, model, max_context, effort, max_budget_usd FROM channels WHERE channel_id = ?'
  ).get(channelId) as { directory: string; cli_type: string; model: string | null; max_context: number | null; effort: string | null; max_budget_usd: number | null } | undefined;
  if (!row) return undefined;
  return {
    directory: row.directory,
    cli_type: row.cli_type as CLIType,
    model: row.model,
    max_context: row.max_context,
    effort: row.effort,
    max_budget_usd: row.max_budget_usd,
  };
}

export function setChannelCLI(channelId: string, cliType: CLIType): boolean {
  return getDb().prepare('UPDATE channels SET cli_type = ? WHERE channel_id = ?').run(cliType, channelId).changes > 0;
}

export function setChannelModel(channelId: string, model: string | null): boolean {
  return getDb().prepare('UPDATE channels SET model = ? WHERE channel_id = ?').run(model, channelId).changes > 0;
}

export function setChannelMaxContext(channelId: string, maxContext: number | null): boolean {
  return getDb().prepare('UPDATE channels SET max_context = ? WHERE channel_id = ?').run(maxContext, channelId).changes > 0;
}

export function setChannelEffort(channelId: string, effort: string | null): boolean {
  return getDb().prepare('UPDATE channels SET effort = ? WHERE channel_id = ?').run(effort, channelId).changes > 0;
}

export function setChannelMaxBudget(channelId: string, maxBudget: number | null): boolean {
  return getDb().prepare('UPDATE channels SET max_budget_usd = ? WHERE channel_id = ?').run(maxBudget, channelId).changes > 0;
}

// --- Session operations ---

export function createSession(params: {
  threadId: string;
  channelId: string;
  cliType: CLIType;
  directory: string;
  cliSessionId?: string;
  firstPrompt?: string;
}): void {
  getDb().prepare(
    `INSERT INTO sessions (thread_id, channel_id, cli_type, directory, cli_session_id, first_prompt, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(thread_id) DO UPDATE SET
       cli_session_id = COALESCE(excluded.cli_session_id, sessions.cli_session_id),
       status = 'active',
       updated_at = datetime('now')`
  ).run(params.threadId, params.channelId, params.cliType, params.directory, params.cliSessionId || null, params.firstPrompt || null);
}

export function getSession(threadId: string): {
  thread_id: string;
  channel_id: string;
  cli_session_id: string | null;
  cli_type: CLIType;
  directory: string;
  status: string;
} | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE thread_id = ?').get(threadId) as any;
}

export function updateSessionStatus(threadId: string, status: string): void {
  getDb().prepare(`UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE thread_id = ?`).run(status, threadId);
}

export function updateSessionCLIId(threadId: string, cliSessionId: string): void {
  getDb().prepare(`UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE thread_id = ?`).run(cliSessionId, threadId);
}

export function listSessions(channelId?: string, limit = 20): Array<{
  thread_id: string;
  channel_id: string;
  cli_session_id: string | null;
  cli_type: string;
  directory: string;
  status: string;
  first_prompt: string | null;
  created_at: string;
  updated_at: string;
}> {
  if (channelId) {
    return getDb().prepare(
      'SELECT * FROM sessions WHERE channel_id = ? ORDER BY updated_at DESC LIMIT ?'
    ).all(channelId, limit) as any[];
  }
  return getDb().prepare(
    'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
  ).all(limit) as any[];
}

// --- Conversation history ---

export function appendMessage(threadId: string, role: 'user' | 'assistant', content: string): void {
  getDb().prepare(
    `INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)`
  ).run(threadId, role, content);
}

export function getMessages(threadId: string, limit = 20): Array<{ role: string; content: string }> {
  return getDb().prepare(
    'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?'
  ).all(threadId, limit).reverse() as any[];
}

// --- Config operations ---

export function getConfigValue(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfigValue(key: string, value: string): void {
  getDb().prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
