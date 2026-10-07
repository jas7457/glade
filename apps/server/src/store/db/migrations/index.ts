/**
 * The store's schema migrations, in order (I-121). Compiled into the server; `openDatabase`
 * applies the ones newer than the database's `PRAGMA user_version`. Never edit a released
 * migration: add the next number.
 */
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-sync.js";
import { migration003 } from "./003-environment.js";
import { migration004 } from "./004-auth.js";
import { migration005 } from "./005-image-blobs.js";
import { migration006 } from "./006-images-per-chat.js";
import { migration007 } from "./007-folders.js";
import { migration008 } from "./008-bookmarks.js";
import type { Db } from "../database.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Data changes SQL alone can't make (runs after `sql`, in the same transaction). */
  run?: (db: Db) => void;
}

export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008];

/** The schema version this build writes (also announced in `servers/<pid>.json`). */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;
