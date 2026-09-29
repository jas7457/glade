/**
 * `/pair?link=<glade://pair…>` (I-126): a pairing link handed to the web UI (deep links, the
 * future phone app, F-022). Opens Settings → Remote Access with the connect dialog filled in.
 */
import { Navigate, useLocation } from "react-router";
import { routes } from "@glade/app-core/app/routes";
import { pairDialogRequest } from "@glade/app-core/state/pairing";

export function PairRoute() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  // `/pair?link=…`, or a whole link in the fragment (`/pair#glade://pair?…`).
  const link = params.get("link") ?? (hash.length > 1 ? decodeURIComponent(hash.slice(1)) : null);
  pairDialogRequest.value = { link: link ?? undefined };
  return <Navigate to={routes.settings("remote")} replace />;
}
