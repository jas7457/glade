import { render } from "preact";
import "./styles.css";

function Hello() {
  return (
    <div class="flex h-full items-center justify-center bg-window text-fg">
      <h1 class="text-2xl font-semibold">Hello Glade</h1>
    </div>
  );
}

render(<Hello />, document.getElementById("app")!);
