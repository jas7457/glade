/**
 * Migration 4 (I-125/I-126): device auth and pairing. Paired devices (token stored as a SHA-256
 * hash, sliding expiry via `last_seen_at`), pairing invites (grant and short code hashed; one
 * active at a time), pairings waiting for the host's answer (in the database so every server on
 * the data folder sees them), and an audit log. The remote-access switch is `meta.remote_access`
 * ("1" = on; missing = off). WebSocket tickets are per server and live in memory.
 * Additive: a schema-3 server that's still running ignores all of it.
 */
export const migration004 = {
  version: 4,
  name: "auth",
  sql: /* sql */ `
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL DEFAULT '["full"]',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_address TEXT,
      tailscale_login TEXT,
      client_environment_id TEXT,
      revoked_at INTEGER
    );

    CREATE TABLE pairing_invites (
      id TEXT PRIMARY KEY,
      grant_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      -- set when a pairing used it, it was replaced or cancelled, or too many wrong codes
      used_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE pairing_pending (
      id TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      device_kind TEXT NOT NULL,
      client_environment_id TEXT,
      remote_address TEXT,
      tailscale_login TEXT,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      -- pending | allowed | denied | expired | cancelled | paired
      status TEXT NOT NULL DEFAULT 'pending',
      device_id TEXT
    );
    CREATE INDEX pairing_pending_status ON pairing_pending (status);

    CREATE TABLE auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      device_id TEXT,
      device_name TEXT,
      remote_address TEXT,
      detail TEXT
    );
    CREATE INDEX auth_audit_at ON auth_audit (at);
  `,
};
