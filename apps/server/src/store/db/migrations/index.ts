/**
 * The store's schema migrations, in order (I-121). Compiled into the server; `openDatabase`
 * applies the ones newer than the database's `PRAGMA user_version`. Never edit a released
 * migration: add the next number.
 */
import { migration001 } from "./001-initial.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [migration001];

/** The schema version this build writes (also announced in `servers/<pid>.json`). */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;
