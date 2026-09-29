import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { bootIphone } from "./boot";

void bootIphone();
render(<App />, document.getElementById("app")!);
