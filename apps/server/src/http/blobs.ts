/**
 * Image files (I-157, per chat since I-163), mounted under `/api` by `createApp`:
 *
 *   GET /blobs/:sessionId/:name   → a chat's image (ref `<sessionId>/<name>`)
 *   GET /blobs/:hash              → a legacy shared file (`:hash` = hex SHA-256 or `sha256:<hex>`),
 *                                   until the store has moved it into the chats' folders
 *
 * A file never changes (its name comes from its bytes), so responses are cached for a year
 * (`immutable`, `private`: it's behind auth) with an ETag. Both segments are checked against a
 * strict pattern (no separators, no leading dot), so nothing outside the image folders can be
 * reached. Auth is the security middleware's, like every API read: the local owner, or a paired
 * device's bearer token.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { chatBlobRef, parseBlobRef } from "@glade/protocol";
import type { BlobStore } from "../store/blobs.js";

/** A path segment decoded once more (encoded refs); malformed escapes stay as they are (then 400). */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function blobRoutes(blobs: BlobStore): Hono {
  const api = new Hono();
  const serve = (c: Context, ref: string) => {
    const parsed = parseBlobRef(ref);
    if (!parsed) return c.json({ error: "Not an image reference" }, 400);
    const found = blobs.find(ref);
    if (!found) return c.json({ error: "Not found" }, 404);
    const etag = `"${parsed.kind === "hash" ? parsed.hash : `${parsed.sessionId}-${parsed.name}`}"`;
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("ETag", etag);
    c.header("X-Content-Type-Options", "nosniff");
    // An SVG opened on its own must not run scripts in the API's origin.
    c.header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    c.header("Content-Type", found.mimeType);
    c.header("Content-Length", String(found.size));
    return c.body(Readable.toWeb(createReadStream(found.path)) as ReadableStream);
  };
  api.get("/blobs/:sessionId/:name", (c) => serve(c, chatBlobRef(decode(c.req.param("sessionId")), decode(c.req.param("name")))));
  api.get("/blobs/:hash", (c) => serve(c, decode(c.req.param("hash"))));
  return api;
}
