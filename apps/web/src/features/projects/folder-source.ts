/**
 * Where the Create Project dialog looks for folders (I-124). Moved to app-core
 * (`state/folder-source.ts`) so a group project's folder picker (I-213) and the iPhone share it.
 */
export { envFolderSource, localFolderSource, type ProjectFolderSource } from "@glade/app-core/state/folder-source";
