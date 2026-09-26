import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { startSync } from "./state/store";

startSync();
render(<App />, document.getElementById("app")!);
