import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { startAppearanceSync } from "./app/appearance";
import { startAttentionSync } from "./state/attention";
import { startEnvironments } from "./state/environments";

startAppearanceSync();
// The page's own server is the local environment (I-123); remote ones follow the saved list.
void startEnvironments();
startAttentionSync();
render(<App />, document.getElementById("app")!);
