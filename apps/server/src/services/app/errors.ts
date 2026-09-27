/**
 * Errors the app service throws; the HTTP layer turns `HttpError`s into responses with their
 * status. Re-exported from `../app-service.ts` (the public import path).
 */
import { activeElsewhereMessage } from "@glade/protocol";
import type { LeaseInfo } from "../leases.js";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 424 | 429 | 500 | 501,
    message: string,
  ) {
    super(message);
  }
}

/** 409: another server sharing the data folder runs this session right now (I-062). */
export class ActiveElsewhereError extends HttpError {
  constructor(readonly lease: LeaseInfo) {
    super(409, activeElsewhereMessage({ serverKind: lease.serverKind }));
  }
}
