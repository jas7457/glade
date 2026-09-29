/**
 * Migration 6 (I-163): images live in one folder per chat (`<dataDir>/blobs/<sessionId>/`), refs
 * are `<sessionId>/<name>`. No schema change: the version bump makes an older Glade (which only
 * knows `sha256:` refs) refuse the database. The files are copied and the rows rewritten after
 * the database is open, in batches (`store/migrate-images.ts`), so this transaction stays short.
 */
export const migration006 = {
  version: 6,
  name: "images-per-chat",
  sql: "",
};
