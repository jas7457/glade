/**
 * Migration 1 (I-121): the whole of Glade's app data. Records keep their protocol shape in
 * `data_json` (projects, workspaces, sessions, sub-agent records, settings overrides); the columns
 * next to it are what queries filter or join on. Conversations are normalized: one `messages` row
 * per `TranscriptMessage` (stable Glade id, protocol payload with a version) and one
 * `tool_results` row per tool call. `events` is the change log other servers poll (I-062) and,
 * later, what clients replay from (I-122).
 */
export const migration001 = {
  version: 1,
  name: "initial",
  sql: /* sql */ `
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      -- I-123: the environment a project belongs to (NULL = this server's own environment).
      environment_id TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX workspaces_project ON workspaces (project_id);

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      harness TEXT NOT NULL,
      -- The harness's own session (pi: its JSONL file; ACP: Glade's ref). Also inside data_json.
      session_ref TEXT,
      -- Opaque per-adapter resume cursor (pi: {"sessionFile"}, ACP: {"acpSessionId", "title"}).
      resume_json TEXT,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_workspace ON sessions (workspace_id);
    CREATE INDEX sessions_ref ON sessions (session_ref);

    -- One row per session whose conversation is in the store. source = where it came from
    -- ("live", or the harness id it was imported from); source_sig = the harness file's
    -- mtime/size when we last knew it was in sync (a different one means it changed outside
    -- Glade: re-import). version increases with every write (search re-indexes on change).
    CREATE TABLE transcripts (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_sig TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      imported_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      -- NULL, or "agent_message" for delivered sub-agent messages/reports (meta_json: from, to, kind).
      kind TEXT,
      meta_json TEXT,
      -- Plain user/assistant text (search, titles, chat tools); NULL for other roles.
      text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- "streaming" | "running" | "done"
      status TEXT NOT NULL,
      payload_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX messages_session ON messages (session_id, seq);

    CREATE TABLE tool_results (
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, tool_call_id)
    );

    CREATE TABLE agents (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX agents_parent ON agents (parent_session_id);

    -- The stored settings overrides (defaults are merged on read). One row.
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      at INTEGER NOT NULL
    );

    -- Every change a client could see, appended in the same transaction as the change.
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      -- "shell" (projects, workspaces, sessions, settings, agents) or "session" (a transcript)
      scope TEXT NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      entity_id TEXT,
      payload_json TEXT
    );
    CREATE INDEX events_at ON events (at);
  `,
};
