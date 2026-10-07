/**
 * Migration 8 (I-203): bookmarked messages. One row per bookmark; like the other record tables
 * the protocol object is kept in `data_json`, the columns are what queries filter on (a chat's
 * bookmarks, and deleting them with the chat). Additive: a schema-7 server still running ignores
 * the table (bookmarks of chats it deletes are dropped by the next newer server that loads them,
 * since their session is gone).
 */
export const migration008 = {
  version: 8,
  name: "bookmarks",
  sql: /* sql */ `
    CREATE TABLE bookmarks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX bookmarks_session ON bookmarks (session_id);
    CREATE INDEX bookmarks_workspace ON bookmarks (workspace_id);
  `,
};
