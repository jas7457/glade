import { render } from "preact";
import "./styles.css";
import { App } from "./app/App";
import { startAppearanceSync } from "@glade/app-core/app/appearance";
import { installExternalLinks } from "./lib/external-links";
import { startAttentionSync } from "@glade/app-core/state/attention";
import { startEnvironments } from "@glade/app-core/state/environments";
import { startNotifications } from "@glade/app-core/state/notifications";
import { startVersionSync } from "@glade/app-core/state/version";
import { startAgentVersionsSync } from "@glade/app-core/state/agent-versions";
import { startAutoRestart } from "./state/update";

startAppearanceSync();
// The page's own server is the local environment (I-123); remote ones follow the saved list.
void startEnvironments();
startAttentionSync();
// System notifications for chats needing input / finished / failed (I-135).
startNotifications();
// Is this Glade behind origin's main? (I-149/I-160: top of Settings → General, a dot on Settings)
startVersionSync();
// I-198: agent versions on this Mac (a dot on Settings → Agents when one is behind).
startAgentVersionsSync();
// I-197: the Mac app restarts into a newly installed version on its own (when no chat is working).
startAutoRestart();
// Links to other sites open in the default browser, never inside the app (I-129).
installExternalLinks();
render(<App />, document.getElementById("app")!);
