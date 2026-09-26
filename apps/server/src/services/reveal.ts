/**
 * "Reveal in Finder" for files the server wrote (e.g. chat exports). macOS only (`open -R`);
 * elsewhere it throws {@link RevealUnavailableError} (→ 501).
 */
import { execFile } from "node:child_process";

export type RevealPath = (path: string) => Promise<void>;

export class RevealUnavailableError extends Error {}

export function createRevealPath(platform: NodeJS.Platform = process.platform): RevealPath {
  return (path) => {
    if (platform !== "darwin") return Promise.reject(new RevealUnavailableError("Reveal in Finder is only available on macOS"));
    return new Promise((resolve, reject) => {
      execFile("open", ["-R", path], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
    });
  };
}
