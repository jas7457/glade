import Database from "better-sqlite3";
import type { CheckResult } from "./checks/http.js";

const RETENTION_DAYS = 30;

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        check_id   TEXT    NOT NULL,
        ok         INTEGER NOT NULL,
        status     INTEGER,
        latency_ms INTEGER NOT NULL,
        error      TEXT,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS results_check_at ON results (check_id, at);
    `);
  }

  record(result: CheckResult): void {
    this.db
      .prepare("INSERT INTO results (check_id, ok, status, latency_ms, error, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(result.checkId, result.ok ? 1 : 0, result.status, result.latencyMs, result.error ?? null, result.at);
  }

  /** Share of successful runs in the last `hours`, 0–1 (null without data). */
  uptime(checkId: string, hours = 24): number | null {
    const since = Date.now() - hours * 3_600_000;
    const row = this.db
      .prepare("SELECT AVG(ok) AS uptime FROM results WHERE check_id = ? AND at >= ?")
      .get(checkId, since) as { uptime: number | null };
    return row.uptime;
  }

  history(checkId: string, limit = 288): CheckResult[] {
    return this.db
      .prepare("SELECT check_id AS checkId, ok, status, latency_ms AS latencyMs, error, at FROM results WHERE check_id = ? ORDER BY at DESC LIMIT ?")
      .all(checkId, limit)
      .map((r: any) => ({ ...r, ok: r.ok === 1 }));
  }

  prune(): number {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    return this.db.prepare("DELETE FROM results WHERE at < ?").run(cutoff).changes;
  }
}
