# The Glade iPhone app: plan and handover

Status: planned (Inbox **I-164**, promoted from F-022). Written 2026-09-27 by the lead, so another
agent can pick this up without having to rediscover the setup. Read `AGENTS.md`,
`docs/ARCHITECTURE.md` (Environments, Device auth and pairing, Transports, "Images are files") and
the F-022 / I-164 entries in `PLAN.md` first.

Naming: always **"iPhone app"** (never "phone app"). The folder is `apps/iphone`. Android is a
separate future app (F-025) on the same shared core.

---

## 1. What we're building (the user's decisions)

- **A real iPhone app that wraps the web code**: not a native rewrite, and not a home-screen web
  app. The user's words: "something that is installable for an iPhone app that probably just is
  using web views … two completely different layouts for the desktop app and the phone app …
  we will share the different components."
- **Two separate apps, one shared core.** The Mac app keeps only the desktop layout; the iPhone app
  has only a phone layout. Shared: UI primitives, state, the composer, transcript, tool cards,
  pickers, the API and sync client.
- **The iPhone app runs no server.** It is purely a client of the user's Macs ("environments"),
  connected through remote access (Tailscale + pairing). It must work with **zero local
  environments**: zero or more environments, all remote.
- **Phone layout** (user, F-022): no tabs; the sidebar (chat list) is an overlay, not always open;
  sub-agents can't be opened as side panes (show them as cards, and open a sub-agent's chat full
  screen if at all); one chat on screen at a time.
- **Pairing starts from the phone**: scan the QR code shown by a Mac's *Share This Device…* with the
  iPhone camera (or paste the link / type the code). Tokens live in the iOS Keychain.

## 2. What's on this Mac (verified 2026-09-27; the §8 setup is done, re-verified the same day)

| Thing | State |
|---|---|
| macOS | 27.0, Apple silicon (MacBook Air) |
| Xcode | **27.0** (build 27A266a) at `/Applications/Xcode.app`. First-launch setup is done (`xcodebuild -checkFirstLaunchStatus` exits 0). |
| `xcode-select -p` | `/Applications/Xcode.app/Contents/Developer` (switched by the user; `DEVELOPER_DIR` is no longer needed). iOS SDK 27.0 and iPhoneSimulator SDK 27.0 are present. |
| iOS simulator runtime | iOS 27.0 installed. Devices include **iPhone 18 Pro** (`D589342D-F5C7-422A-B92E-0B938D999EFD`), iPhone 18 Pro Max, iPhone Air, iPhone 17, iPhone 17e. |
| Rust | rustc 1.98.1 via rustup (`. "$HOME/.cargo/env"` in non-login shells). Targets: `aarch64-apple-darwin`, `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`. A test crate builds for `aarch64-apple-ios-sim` and `aarch64-apple-ios`. |
| Homebrew / CocoaPods | Homebrew 7.0.6; CocoaPods 1.17.0 at `/opt/homebrew/bin/pod`. It warns unless `LANG=en_US.UTF-8`, so export that in commands that run `pod`. |
| Node / pnpm | Node 24.20.0, pnpm 12.3.4 |
| Tauri | CLI `@tauri-apps/cli ^2.11.5` (in `apps/desktop`; `tauri ios init|dev|build` available), crate `tauri = "2"` |
| Signing | No Apple ID is set up in Xcode yet. The simulator needs no signing; a real iPhone does (see §7). |
| Xcode MCP (`xcrun mcpbridge`) | Xcode 27's built-in MCP server (53 tools: build, tests, docs search, **simulator tap/swipe/type + screenshot + UI hierarchy**). Registered for pi as server `xcode` in `~/.config/mcp/mcp.json` (loaded when a pi session starts). The user approved it in Xcode on 2026-09-28. Wrapped for scripts by `scripts/ios-sim.mjs`. |
| Tauri iOS build | Verified 2026-09-28 end to end: `tauri ios init` → `tauri ios build --target aarch64-sim --debug` (about 55 s cold) → `simctl install/launch` → Xcode tap on a WebView button → screenshot. The fixes it needs are in §3.1. |

Tauri 2 iOS prerequisites (from v2.tauri.app/start/prerequisites):
- the full Xcode, launched once;
- `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`;
- Homebrew and `brew install cocoapods`.

## 3. How agents build, run, see and drive the iPhone app (no user needed)

All of this was verified on 2026-09-28 with a throwaway Tauri iOS app, and it works unattended. The
loop is: **edit → build (Tauri CLI) → install + launch (`simctl`) → look and tap (Xcode MCP /
`scripts/ios-sim.mjs`) → fix → repeat.** Use the chrome-devtools MCP at phone size for fast layout
work on the web code, and the simulator to confirm the real app.

### 3.1 Build the app (Tauri CLI, not Xcode)

```bash
. "$HOME/.cargo/env"; export LANG=en_US.UTF-8     # rustup + CocoaPods' locale warning
cd apps/iphone
pnpm tauri ios build --target aarch64-sim --debug --ci > /tmp/glade-iphone-build.log 2>&1
#   → src-tauri/gen/apple/build/arm64-sim/<productName>.app   (about 55 s cold, faster after)
grep -nE 'error(\[|:)|BUILD (SUCC|FAIL)' /tmp/glade-iphone-build.log   # read the log, not the whole output
```

Gotchas found in the trial (bake these into `apps/iphone` once):

- **iOS deployment target:** Tauri's template says 14.0, and Xcode 27 rejects anything below 15.0.
  Set `"bundle": { "iOS": { "minimumSystemVersion": "17.0" } }` in `tauri.conf.json` **before**
  `tauri ios init` (or re-init: `rm -rf src-tauri/gen && pnpm tauri ios init --ci`).
- **`pnpm-native`:** with pnpm 12, `tauri ios init` writes `pnpm-native tauri ios xcode-script …`
  into the Xcode "Build Rust Code" phase, and that command doesn't exist. After every init, run
  `sed -i '' 's/pnpm-native tauri/pnpm tauri/' src-tauri/gen/apple/project.yml src-tauri/gen/apple/app.xcodeproj/project.pbxproj`.
  Commit `src-tauri/gen/apple` (it's meant to be committed) so this happens once.
- **Run the CLI through the package's `tauri` script** (`pnpm tauri …` inside a package that
  has `@tauri-apps/cli` and `"tauri": "tauri"`). Calling the binary by path writes `node tauri`
  into the Xcode project, which breaks the build.
- **Don't build from inside Xcode** (`BuildProject`, `DeviceInteractionInstallAndRun`, Cmd+R). Xcode
  launched from the Dock doesn't have the nvm Node/pnpm PATH, so the Rust phase fails with "Launch
  session has not been found". Build with the CLI and install with `simctl` instead.
- `cargo`/`xcodebuild` output is huge: always redirect to a log file and grep it.

### 3.2 Install, launch, screenshot (`simctl`)

```bash
SIM=D589342D-F5C7-422A-B92E-0B938D999EFD                          # iPhone 18 Pro

xcrun simctl boot $SIM                      # boot (ignore "already booted")
xcrun simctl openurl booted "http://127.0.0.1:<port>/"            # open a URL in the sim's Safari
xcrun simctl io booted screenshot /tmp/glade-iphone-<name>.png    # screenshot (full resolution)
sips -Z 900 /tmp/glade-iphone-<name>.png --out /tmp/glade-iphone-<name>-s.png  # smaller copy to read
xcrun simctl install booted path/to/Glade.app                     # install a simulator build
xcrun simctl launch booted <bundle id>                            # launch it
xcrun simctl terminate booted <bundle id>
xcrun simctl shutdown booted                                      # when done
```

- **The simulator shares the Mac's network,** so `127.0.0.1:<port>` on the simulator is the Mac. The
  demo loaded a `pnpm dev:agent` sandbox in the simulator's Safari (it rendered, but as the
  squeezed desktop layout). The first `openurl` after a fresh boot may land on Safari's start page:
  just run `openurl` again.
- **Data to point it at:** always a sandbox: `pnpm dev:agent --name <agent> > /tmp/glade-<agent>.log 2>&1 &`
  (it prints `Web:` and `API:` URLs; the fake harness is the default). Pair the iPhone app with the
  sandbox like a remote device. **Never** use the user's servers (:4317, :5317, the installed app on
  :4327) or their data folder, and never the user's tailnet for writes.
- **Typing and tapping** in the simulator: `simctl` can't tap, but Xcode's MCP can (§3.3).
  Deep links / URL routes and a debug-only "demo mode" query param that seeds state are still
  handy for jumping straight to a screen.
- The chrome-devtools MCP can't write files to `/tmp` (workspace-roots restriction); screenshots it
  returns inline can be viewed but not saved. `simctl io … screenshot` can save anywhere.
- **First launch after a boot** often stays behind the home screen: `simctl launch` again (with
  `--terminate-running-process`), or let `scripts/ios-sim.mjs --app <bundle id>` activate it.
- **Is it running?** `xcrun simctl spawn $SIM launchctl list | grep <bundle id>`. App logs:
  `xcrun simctl spawn $SIM log show --last 1m --style compact --predicate 'process == "<name>"'`
  (WebKit logs page loads and JS errors there). Crashes: `~/Library/Logs/DiagnosticReports`.
- Screenshots are 1206×2622 px: shrink before reading (`sips -Z 700 in.png --out small.png`).

### 3.3 Tap, swipe, type: Xcode's MCP server

`simctl` can't tap. Xcode 27 can: its MCP server (`xcrun mcpbridge`) has
`DeviceInteractionSynthesize`, which sends touches/keys to the simulator and returns a screenshot +
UI hierarchy. Requirements: **Xcode is running** (`open -a Xcode`), and the agent was approved once
in Xcode (done 2026-09-28; if a call says "This agent isn't approved to use Xcode's tools yet", the
user must open a project through `XcodeOpenWorkspace` and click Allow in Xcode: that needs the user).

**The easy way: `scripts/ios-sim.mjs`** (one session per run, works from any agent or sub-agent):

```bash
node scripts/ios-sim.mjs --app io.github.jas7457.glade.iphone ""                 # capture only
node scripts/ios-sim.mjs --app io.github.jas7457.glade.iphone "t 201 498" ""     # tap, then capture
node scripts/ios-sim.mjs "t 200 600 f 200 200 0.3"                             # swipe up (scroll)
node scripts/ios-sim.mjs "t 100 300" "sender keyboard kbd hello\u{000A}"       # focus a field, type + return
#   → /tmp/glade-ios-sim/step-N.png (screenshot) and step-N.txt (UI hierarchy); paths are printed
```

- Options: `--app <bundle id>` (activates the app first), `--device "iPhone 18 Pro"`,
  `--out <dir>`, `--settle <s>` (default 0.6: wait after each event, then capture again, because
  the capture right after a tap can come before the page repaints).
- **Coordinates are points**: 402×874 on the iPhone 18 Pro, which equals CSS px in a full-screen
  WebView (the page starts under the status bar only if it uses `viewport-fit=cover`). Measure a
  target from the screenshot (px ÷ 3) or from the DOM (`getBoundingClientRect()` in Chrome at
  402×874). In the trial, a centered button in a `100vh` page was at y≈498, not 437.
- **Web content is opaque to the hierarchy**: inside a WKWebView it's a `RemotePlaceholder`
  (`isRemoteLeafPlaceholder: true`), so the `hitPoint` tricks from Xcode's skill don't apply to our
  UI. Use the screenshot or the DOM for positions. Native things (keyboard, alerts, permission
  prompts, the share sheet) do appear in the hierarchy with hitPoints.
- Session names can't be reused right after use (the script makes unique ones). Xcode deletes the
  screenshots when a session ends (the script copies them first).
- The full command syntax (tap/hold, double tap, swipe, drag, multi-touch, `b h` home, `kbd`,
  `w` wait, `orientation …`) is in Xcode's `device-interaction` skill:
  `xcrun mcpbridge run-agent skills export /tmp/xcode-skills` → `/tmp/xcode-skills/device-interaction/SKILL.md`.

**From pi directly:** new pi sessions have the `xcode` MCP server (`mcp({ server: "xcode" })`):
`DeviceInteractionStartSession { deviceIdentifier: "iPhone 18 Pro", sessionIdentifier }` →
`DeviceInteractionSynthesize { interactSessionKey, interactionCommand, activationBundleId? }` →
`DeviceInteractionEndSession { interactionSessionKey }` (always end it; sessions are expensive).
Xcode's reply tells you to "spawn a SUBAGENT with the device-interaction skill": that's advice for
Xcode's own agent. Here you can drive it yourself or give a sub-agent `scripts/ios-sim.mjs`. Other
useful tools: `DocumentationSearch` (Apple docs), `GetBuildLog`, `GetConsoleOutput`.

### 3.4 Fast iteration on the web code

- Most phone-layout work is web code: run it in Chrome with the chrome-devtools MCP (`emulate`
  viewport `402x874x3,mobile,touch`) against a sandbox, then confirm in the simulator.
- Not verified yet: `pnpm tauri ios dev` (the WebView loads Vite's dev server, so edits reload
  without a rebuild). Try it once `apps/iphone` exists; fall back to rebuild + reinstall.
- Pointing the app at a sandbox: the simulator shares the Mac's network, so the app can call
  `http://127.0.0.1:<sandbox API port>` (ATS allows localhost). Check CORS for the app's origin
  (§4.3).

### 3.5 Clean up after every session

`pnpm dev:agent --name <agent> --stop`, `xcrun simctl terminate`/`uninstall` any throwaway apps,
`xcrun simctl shutdown $SIM`, and close any workspace you opened in Xcode (`XcodeCloseWorkspace`).
Leave Xcode itself running if another agent may need it.

## 4. Architecture

### 4.1 Code layout

Done in step 7 (2026-09-29): the shared client core lives in `packages/app-core`
(`@glade/app-core`); both apps import it and neither reaches into the other.

```
packages/protocol      wire types
packages/app-core      shared client core (moved out of apps/web/src, same relative layout)
  src/ui/              primitives (Button, Select, Dialog, StatusDot, Sidebar, TabStrip, …)
  src/state/           signals + actions (store, env-registry, environments, env-api,
                       saved-environments, pairing, sync, chat-session, folders, …)
  src/features/chat/   Transcript, message/tool cards, Composer, SideQuestionCard, image-src,
                       tools/, mentions/, slash/, context-bar/, usage/
  src/features/…       the few desktop-feature files the chat needs: workspace/agent-chips +
                       SubagentStrip, changes/CommitDialog + api, environments/EnvironmentPicker,
                       sidebar/time
  src/app/             routes.ts (route builders), appearance.ts (theme sync)
  src/lib/             api client, socket, secret-store, pairing-link, paths, cn, desktop bridge, …
  src/test/            Vitest setup + fixtures shared by every jsdom project
  src/styles.css       design tokens + Tailwind entry; each app imports it and adds `@source "./"`
  vite.shared.ts       aliases/dedupe/test settings every consumer's vite + vitest config uses
apps/web               the desktop layout: app/ (shell, shortcuts, commands, last route), sidebar,
                       workspace (tabs, WorkspaceView, layout), settings, palette, projects,
                       changes panel, environments UI, ChatView/ChatHeader/ChatLocation, and
                       Mac-only bits (state/power, state/update, lib/native, lib/external-links,
                       lib/api-search); bundled into the Mac app
apps/iphone            the iPhone layout + Tauri 2 iOS shell
  src/                 phone screens (Preact, `~/…`), imports @glade/app-core
  src-tauri/           Tauri iOS project (tauri ios init), Keychain + camera plugins
```

**Imports:** `@glade/app-core/<path under src>` everywhere (e.g. `@glade/app-core/state/store`,
`@glade/app-core/ui`). It's an alias to `packages/app-core/src` (`appCoreAlias` in
`vite.shared.ts`) plus a `paths` entry in each tsconfig; the apps also list the package as a
`workspace:*` dependency. Inside app-core, files use relative imports or the same
`@glade/app-core/…` form, never an app's alias. `@/…` in `apps/web` is the desktop layout only;
`~/…` in `apps/iphone` is the phone layout. One copy of preact / signals / react-router: every
config uses `dedupe` from `vite.shared.ts`, and tests alias `react`/`react-dom` → preact/compat and
react-router → its ESM build (`testAliases`). app-core has its own Vitest project (`app-core`,
jsdom, the same setup file).

Three tests of core modules stay in `apps/web` because they exercise desktop code too:
`features/chat/slash/SlashCommands.test.tsx` (settings), `state/notifications.test.ts`
(`app/openChatRequests`) and `state/remote-status.test.ts` (`features/environments/use-discovery`).

### 4.2 Shell: Tauri 2 iOS (preferred) vs Capacitor

Prefer **Tauri 2 iOS**: the repo already uses Tauri 2, and a Rust side exists for Keychain-style
commands. Capacitor stays the fallback if Tauri iOS blocks on something (note the reason in
PLAN.md). The iPhone app's Tauri project is separate from `apps/desktop/src-tauri`: different
bundle id (e.g. `io.github.jas7457.glade.iphone`), no server sidecar, no tray, no menu.

Needed native bits:
- **Secure storage:** device tokens per environment in the iOS Keychain. The web side already has
  the seam: `packages/app-core/src/lib/secret-store.ts` (`SecretStore` interface, `setSecretStore()`, keys
  `env:<id>`). Implement it with a Tauri plugin or command backed by the Keychain.
- **QR scanning:** Tauri's barcode-scanner plugin (`@tauri-apps/plugin-barcode-scanner`, mobile only),
  plus the camera usage string in Info.plist. It feeds the same pairing-link parser
  (`lib/pairing-link.ts`, which understands `https://<host>/pair#g=…&e=…`).
- **Opening links:** the opener plugin (external links open in Safari).
- **Notifications:** out of scope for the first version (needs APNs or a relay; the Mac-side
  notifications from I-135 stay Mac-only). Note it as a later step.

### 4.3 Networking and security (must keep the I-125/I-127 model)

- The iPhone reaches Macs over **Tailscale**: the Tailscale iOS app must be installed and signed in
  to the same tailnet. Hosts are `https://<mac>.<tailnet>.ts.net` (served by `tailscale serve`,
  run by the Mac app). **HTTPS only**; there's no plain-HTTP fallback, and iOS App Transport Security
  would block it anyway (localhost is exempt, which is what the simulator + sandbox use).
- Every request carries the device token (bearer). WebSockets use tickets (existing). `<img>` can't
  carry the token, so remote images are fetched with it and shown as `blob:` URLs (already in
  `features/chat/image-src.ts`).
- **CORS / origin:** the iPhone app's WebView origin is `tauri://localhost` (or
  `http://tauri.localhost`, depending on the platform config). Verify the server accepts
  cross-origin API calls from it with a device token (the desktop client already makes
  cross-origin calls to remote hosts, so the mechanism exists; check `http/security.ts` for the
  allowed-origin rules and extend them for the iPhone origin if needed, keeping "local owner" =
  loopback + own origin only).
- **The iPhone's own identity:** it has no environment id (no server). Generate a stable random
  device id on first launch, keep it in the Keychain, and send it as `clientEnvironmentId` when
  pairing, so the Mac's Connections list can show and rename it (I-136/I-138). `deviceName`: use
  the iPhone's name if available, else "iPhone".
- **Code-free tailnet pairing (I-143)** requires the host to see a `Tailscale-User-Login` header
  from serve. That also works for an iPhone on the same account, but the iPhone can't *discover*
  hosts via `tailscale status` (no CLI). So pairing on the iPhone = scan the QR code / paste the
  link / type the code + host.
- **The Mac's Allow prompt** shows a laptop icon today; show a phone icon for iPhone clients
  (a small protocol hint, e.g. `deviceKind: "iphone"` in the pair request).

### 4.4 Client core assumptions to fix

- `env-registry` / `environments` must work with **no local environment**: no `This Mac`, no
  `localEnvironmentId`, the first run shows "Connect to a Device". I-123 was written with this in
  mind; verify every place that assumes a local server (settings for the local device,
  `hasLocalEnvironment`, folder browser defaults, notifications, power, update, Remote Access host
  controls). The iPhone app shows none of the "this device shares itself" UI.
- **Settings on the iPhone:** only the client-side things: connected devices (Connect, Rename,
  Disconnect), appearance (theme, stored on the phone), and read-only views of each Mac's AI
  settings (I-155: another device's settings are view-only).

## 5. Phone layout (first version)

Screens (all full width, safe-area aware, 44pt touch targets, native-feeling iOS look: system font,
large titles where natural, sheets instead of popovers):

1. **First run: Connect to a Device.** Explains "Glade on your iPhone uses your Macs." Buttons:
   Scan QR Code, Paste Link, Enter Code. Mentions Tailscale must be installed on the iPhone.
2. **Chats (home):** one list across all connected Macs, grouped by project (like the desktop
   sidebar, merged, with the globe/device marker), showing status dots (working / needs you /
   unread) and search. A "+" makes a new chat (pick device → project → agent).
3. **Chat:** the transcript (shared components), a composer tuned for touch (↩ is a newline on
   iOS, and a Send button; steer vs follow-up via a long-press or menu on Send; Ask Aside via a
   menu), the model and agent picker as a sheet, attachments from Photos/Files. Tool groups are
   collapsed by default. Sub-agents show as cards; tapping one opens its chat full screen with a
   back button. No tabs, and no split panes.
4. **Sidebar overlay:** swipe from the left edge or tap the menu button to reveal the chat list
   over the current chat.
5. **Settings:** Devices (connections), Theme, and per-device read-only AI settings.

Out of scope for v1: Changes panel / diffs editing (read-only view maybe later), worktree
management, creating projects (folder browsing on a Mac from the phone could come later), the
command palette, keyboard shortcuts.

## 6. Work plan (suggested order; each step ends with `pnpm check` green + screenshots)

1. **Toolchain check:** the iOS Rust targets and CocoaPods exist (§8; if not, stop and ask the
   user). `xcrun simctl list` works. Xcode is running and `node scripts/ios-sim.mjs ""` captures
   a screenshot (if it says the agent isn't approved, stop: that needs the user).
2. **Scaffold `apps/iphone`:** a Vite + Preact entry, a Tauri iOS project
   (`pnpm tauri ios init` in `apps/iphone`), a bundle id, app icon (reuse the leaf), and a workspace
   entry in `pnpm-workspace.yaml`. Build for the simulator
   (`pnpm tauri ios build --target aarch64-sim` or `tauri ios dev` pointed at the simulator), install,
   launch, screenshot a "Hello Glade".
3. **Zero-local-environment client:** boot the shared state with no local server. First-run
   Connect screen. Pair against a sandbox (`pnpm dev:agent`) from the simulator (loopback over
   http is allowed for the sandbox in dev builds only; production requires https). Tokens go to
   a Keychain-backed `SecretStore`.
4. **Chats list + chat screen + composer** on the shared components; live sync (replay/snapshot,
   `Load earlier`), images via `image-src`.
5. **Sidebar overlay, sub-agent cards, pickers as sheets, settings screen.**
6. **QR scanning** (barcode-scanner plugin) + the camera permission string; test the parsing with a
   fixed image in unit tests. The real camera needs a device.
7. **`packages/app-core` split** (separate step; see §4.1). Done 2026-09-29.
8. **Device run** with the user (§7).

Tests: the phone layout gets component tests like the desktop (@testing-library/preact), and
shared-core tests keep running. Rust: `cargo check`/`cargo test` for the iPhone shell. No real
model or agent anywhere (fake harness sandboxes only).

## 7. What needs the user (can't be done unattended)

- **Signing for a real iPhone:** Xcode → Settings → Accounts → add the Apple ID. Then in the
  generated Xcode project pick the team (Personal Team is fine). Free provisioning expires every
  7 days; TestFlight / App Store need the Apple Developer Program ($99/yr), not needed now.
- **Connect the iPhone** (cable, or wireless pairing in Xcode's Devices window), enable Developer
  Mode on the phone (Settings → Privacy & Security → Developer Mode, restart), and trust the
  developer certificate on first launch (Settings → General → VPN & Device Management).
- **Tailscale app** on the iPhone, signed in to the same tailnet.
- **Pair with a real Mac:** Share This Device… on the Mac, scan with the iPhone. Uses the real
  tailnet, so the user does it.
- Anything that changes the user's Tailscale, Keychain (`io.github.jas7457.glade`) or installed apps.

## 8. One-time setup the user can do in advance (recommended)

These change the user's toolchain, so the user should run them, not an agent:

```bash
. "$HOME/.cargo/env"
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim   # a few hundred MB
brew install cocoapods
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer              # optional: then DEVELOPER_DIR isn't needed
```

Note: switching `xcode-select` to Xcode also changes which `git`/`clang` the command line uses (Xcode's
copies instead of the Command Line Tools'). That's normally fine; skip it and use `DEVELOPER_DIR` if
in doubt.

## 9. Rules for the agent doing this (from AGENTS.md, applied here)

- Work from the Inbox item (I-164) and this doc; tick sub-steps in PLAN.md with dates and outcomes;
  add CHANGELOG entries when something user-visible lands.
- Test only against `pnpm dev:agent` sandboxes; stop them afterwards (`--stop`). Kill any
  simulators/Chrome you start (`xcrun simctl shutdown booted`), and follow §3.5.
- **Verify every UI step in the simulator**, not just in Chrome: build (§3.1), install + launch
  (§3.2), tap through the flow with `scripts/ios-sim.mjs` (§3.3), and look at the screenshots.
  Put the key screenshots' paths (or a short description) in the step's `Outcome:` in PLAN.md.
- Never click Allow on Xcode's agent prompts, sign in to accounts, or change signing: those are
  the user's.
- Never run real models/agents, never `tailscale serve/up/down/set`, never touch the user's
  servers, data folder or Keychain service, and don't install the Mac app unless the user asks.
- Don't do the `packages/app-core` split while other workers edit `apps/web`.
- Commit with explicit paths, verify in a clean worktree (`pnpm install --offline --frozen-lockfile
  && pnpm typecheck && pnpm test`), and push.
