/**
 * Migration 5 (I-157): images live in files (`<dataDir>/blobs/`), rows hold references. No schema
 * change: the version bump makes an older Glade (which can't show blob references) refuse the
 * database. The rows are rewritten after the database is open, in batches
 * (`store/migrate-images.ts`), so this migration's transaction stays short.
 */
export const migration005 = {
  version: 5,
  name: "image-blobs",
  sql: "",
};
