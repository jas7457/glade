import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { startAppearanceSync } from "./app/appearance";
import { startAttentionSync } from "./state/attention";
import { startSync } from "./state/store";

startAppearanceSync();
startSync();
startAttentionSync();
render(<App />, document.getElementById("app")!);
