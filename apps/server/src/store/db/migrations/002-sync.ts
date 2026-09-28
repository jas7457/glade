/**
 * Migration 2 (I-122): sequenced sync to clients. Replays read one session's events by
 * `(session_id, seq)`; `command_receipts` remembers the outcome of mutating requests that carried
 * a client `commandId`, so a retry after a dropped connection isn't applied twice (pruned after a
 * day). Additive only: a schema-1 server that is still running keeps working until it restarts.
 */
export const migration002 = {
  version: 2,
  name: "sync",
  sql: /* sql */ `
    CREATE INDEX events_session ON events (session_id, seq);

    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      -- "POST /api/sessions/:id/prompt" etc. (a reused id on another route is rejected)
      route TEXT NOT NULL,
      server_id TEXT NOT NULL,
      -- NULL while the command runs; the HTTP status once it finished
      status INTEGER,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX command_receipts_created ON command_receipts (created_at);
  `,
};
