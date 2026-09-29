/**
 * Image files (I-157), mounted under `/api` by `createApp`:
 *
 *   GET /blobs/:hash   → the blob's bytes (`:hash` = the hex SHA-256, or `sha256:<hex>`)
 *
 * Content-addressed, so a response never changes: cached for a year (`immutable`, `private`:
 * it's behind auth) with the hash as ETag. Auth is the security middleware's, like every API
 * read: the local owner, or a paired device's bearer token.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { blobHash } from "@glade/protocol";
import type { BlobStore } from "../store/blobs.js";

export function blobRoutes(blobs: BlobStore): Hono {
  const api = new Hono();
  api.get("/blobs/:hash", (c) => {
    const hash = blobHash(decodeURIComponent(c.req.param("hash")));
    if (!hash) return c.json({ error: "Not a blob hash" }, 400);
    const found = blobs.find(hash);
    if (!found) return c.json({ error: "Not found" }, 404);
    const etag = `"${hash}"`;
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("ETag", etag);
    c.header("X-Content-Type-Options", "nosniff");
    // An SVG opened on its own must not run scripts in the API's origin.
    c.header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    c.header("Content-Type", found.mimeType);
    c.header("Content-Length", String(found.size));
    return c.body(Readable.toWeb(createReadStream(found.path)) as ReadableStream);
  });
  return api;
}
