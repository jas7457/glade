import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { startAppearanceSync } from "./app/appearance";
import { installExternalLinks } from "./lib/external-links";
import { startAttentionSync } from "./state/attention";
import { startEnvironments } from "./state/environments";

startAppearanceSync();
// The page's own server is the local environment (I-123); remote ones follow the saved list.
void startEnvironments();
startAttentionSync();
// Links to other sites open in the default browser, never inside the app (I-129).
installExternalLinks();
render(<App />, document.getElementById("app")!);
