/**
 * Migration 7 (I-165): folders in the chat list. One row per folder; like the other record tables
 * the protocol object is kept in `data_json`, the columns are what queries filter on. Membership
 * is on the members (`Project.folderId`, `Workspace.folderId` in their `data_json`). Additive: a
 * schema-6 server still running ignores the table (and keeps the members' `folderId` when it
 * rewrites them, since it stores the whole object).
 */
export const migration007 = {
  version: 7,
  name: "folders",
  sql: /* sql */ `
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      -- NULL: a top-level folder; else the project it belongs to.
      project_id TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX folders_project ON folders (project_id);
  `,
};
