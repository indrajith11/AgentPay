// db.js - SQLite ledger via node:sqlite. Idempotency key: (tx_hash, log_index).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export class Ledger {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        tx_hash      TEXT NOT NULL,
        log_index    INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_time   INTEGER,
        contract     TEXT NOT NULL,
        event        TEXT NOT NULL,
        merchant     TEXT,
        token        TEXT,
        amount       TEXT,
        payload      TEXT NOT NULL,
        ingested_at  INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_events_event ON ledger_events(event, block_number);
      CREATE TABLE IF NOT EXISTS watcher_state (
        name        TEXT PRIMARY KEY,
        last_block  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS heartbeat (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        last_poll  INTEGER NOT NULL,
        last_error TEXT
      );
    `);
  }

  /** INSERT OR IGNORE = the idempotency safety net. Returns 1 if new, 0 if duplicate. */
  ingest(row) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_events
        (tx_hash, log_index, block_number, block_time, contract, event, merchant, token, amount, payload, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      row.txHash.toLowerCase(),
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      row.contract,
      row.event,
      row.merchant ? row.merchant.toLowerCase() : null,
      row.token ? row.token.toLowerCase() : null,
      row.amount ?? null,
      row.payload,
      Math.floor(Date.now() / 1000)
    );
    return Number(res.changes);
  }

  getCheckpoint(name) {
    const row = this.db.prepare("SELECT last_block FROM watcher_state WHERE name = ?").get(name);
    return row ? Number(row.last_block) : 0;
  }

  setCheckpoint(name, block) {
    this.db.prepare(`
      INSERT INTO watcher_state (name, last_block, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at
    `).run(name, block, Math.floor(Date.now() / 1000));
  }

  heartbeat(error) {
    this.db.prepare(`
      INSERT INTO heartbeat (id, last_poll, last_error) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_poll = excluded.last_poll, last_error = excluded.last_error
    `).run(Math.floor(Date.now() / 1000), error ?? null);
  }

  heartbeatAge() {
    const row = this.db.prepare("SELECT last_poll FROM heartbeat WHERE id = 1").get();
    return row ? Math.floor(Date.now() / 1000) - Number(row.last_poll) : -1;
  }

  counts() {
    const rows = this.db
      .prepare("SELECT event, COUNT(*) AS n FROM ledger_events GROUP BY event ORDER BY n DESC")
      .all();
    const out = {};
    for (const r of rows) out[String(r.event)] = Number(r.n);
    return out;
  }

  recent(limit) {
    return this.db
      .prepare("SELECT * FROM ledger_events ORDER BY block_number DESC, log_index DESC LIMIT ?")
      .all(limit);
  }

  head() {
    const row = this.db.prepare("SELECT MAX(block_number) AS h FROM ledger_events").get();
    return row && row.h !== null ? Number(row.h) : 0;
  }
}
