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

## 2. What's on this Mac (verified 2026-09-27)

| Thing | State |
|---|---|
| macOS | 27.0, Apple silicon (MacBook Air) |
| Xcode | **27.0** (build 27A266a) at `/Applications/Xcode.app`. First-launch setup is done (`xcodebuild -checkFirstLaunchStatus` exits 0). |
| `xcode-select -p` | **`/Library/Developer/CommandLineTools`**: it still points at the Command Line Tools, not Xcode. Either the user runs `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` once (see §8), or every command sets `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. Agents must not run sudo. |
| iOS simulator runtime | iOS 27.0 installed. Devices include **iPhone 18 Pro** (`D589342D-F5C7-422A-B92E-0B938D999EFD`), iPhone 18 Pro Max, iPhone Air, iPhone 17, iPhone 17e. |
| Rust | rustc 1.98.1 via rustup (`. "$HOME/.cargo/env"` in non-login shells). Installed targets: **only `aarch64-apple-darwin`**. The iOS targets are missing (see §8). |
| Homebrew | 7.0.6 at `/opt/homebrew/bin/brew`. **CocoaPods is not installed** (Tauri's iOS prerequisites list it; see §8). |
| Node / pnpm | Node 24.20.0, pnpm 12.3.4 |
| Tauri | CLI `@tauri-apps/cli ^2.11.5` (in `apps/desktop`), crate `tauri = "2"` |
| Signing | No Apple ID is set up in Xcode yet. The simulator needs no signing; a real iPhone does (see §7). |

Tauri 2 iOS prerequisites (from v2.tauri.app/start/prerequisites):
- the full Xcode, launched once;
- `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`;
- Homebrew and `brew install cocoapods`.

## 3. How to see and screenshot the iPhone app (no user needed)

This is how the lead ran the feasibility demo. Everything below works unattended.

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # unless xcode-select was switched
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
- **Typing and tapping** in the simulator: `simctl` can't tap. Options: (a) drive the web layer
  through the WebView inspector: Safari's Web Inspector attaches to simulator WebViews when the app
  enables `isInspectable` (debug builds), or use the chrome-devtools MCP against the same web
  bundle served in desktop Chrome with a phone viewport (390×844, DPR 3) for most layout work;
  (b) use deep links / URL routes to reach each screen; (c) add a debug-only "demo mode" query
  param that seeds state. Prefer (a) for layout work, then confirm with simulator screenshots.
- The chrome-devtools MCP can't write files to `/tmp` (workspace-roots restriction); screenshots it
  returns inline can be viewed but not saved. `simctl io … screenshot` can save anywhere.

## 4. Architecture

### 4.1 Code layout (target)

```
packages/protocol      (exists) wire types
packages/app-core      NEW: shared client core, moved out of apps/web/src
  ui/                  primitives (Button, Select, Dialog, StatusDot, …)
  state/               signals + actions (store, env-registry, environments, env-api,
                       saved-environments, pairing, sync, chat-session, …)
  chat/                Transcript, message/tool cards, Composer, SideQuestionCard, image-src
  lib/                 api client, socket, secret-store interface, pairing-link, …
apps/web               the desktop layout (sidebar + tabs + split panes), bundled into the Mac app
apps/iphone            NEW: the iPhone layout + Tauri 2 iOS shell
  src/                 phone screens (Preact), imports @glade/app-core
  src-tauri/           Tauri iOS project (tauri ios init), Keychain + camera plugins
```

**Phasing, to avoid a big-bang refactor:** in the first iteration, `apps/iphone` may import the
web code directly through a path alias (`@web/*` → `apps/web/src/*`) and only the pieces it needs.
Once the phone layout works, do the `packages/app-core` split as its own reviewed step: move
files, fix imports, with no behaviour change, and `pnpm check` green. The split touches almost
every web file, so do it when no other worker is editing `apps/web`.

### 4.2 Shell: Tauri 2 iOS (preferred) vs Capacitor

Prefer **Tauri 2 iOS**: the repo already uses Tauri 2, and a Rust side exists for Keychain-style
commands. Capacitor stays the fallback if Tauri iOS blocks on something (note the reason in
PLAN.md). The iPhone app's Tauri project is separate from `apps/desktop/src-tauri`: different
bundle id (e.g. `io.github.jas7457.glade.iphone`), no server sidecar, no tray, no menu.

Needed native bits:
- **Secure storage:** device tokens per environment in the iOS Keychain. The web side already has
  the seam: `apps/web/src/lib/secret-store.ts` (`SecretStore` interface, `setSecretStore()`, keys
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
   user). `DEVELOPER_DIR` set. `xcrun simctl list` works.
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
7. **`packages/app-core` split** (separate step; see §4.1).
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
  simulators/Chrome you start (`xcrun simctl shutdown booted`).
- Never run real models/agents, never `tailscale serve/up/down/set`, never touch the user's
  servers, data folder or Keychain service, and don't install the Mac app unless the user asks.
- Don't do the `packages/app-core` split while other workers edit `apps/web`.
- Commit with explicit paths, verify in a clean worktree (`pnpm install --offline --frozen-lockfile
  && pnpm typecheck && pnpm test`), and push.
