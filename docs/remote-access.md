# Remote access: use Glade across your devices

Every Glade is a *device* with its own projects, chats and agents. With remote access you can use
another Mac's projects and chats from this one: they appear in your sidebar with a globe, and
their agents run (and keep running) on the Mac whose files they are. The iPhone app connects the
same way.

The device whose projects you use is the **host**; the one you're typing on is the **client**. A
Mac can be both.

### Requirements

- **Tailscale on every device**, signed in to the **same tailnet** (Standalone or App Store
  version). Glade needs Tailscale's command-line tool; if it can't find it, turn on *CLI
  integration* in Tailscale's settings (installs `/usr/local/bin/tailscale`).
- **HTTPS certificates enabled for the tailnet (required).** In the Tailscale **web** admin console
  ([login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), not the Mac app's
  settings), make sure MagicDNS is on, then click **Enable HTTPS** under *HTTPS Certificates*.
  Glade only shares over HTTPS: there is no plain-HTTP fallback. (Machine names end up in public
  certificate logs; your tailnet name, `tailXXXX.ts.net`, is random.)
- **The Glade Mac app on the host.** It runs `tailscale serve` for you (tailnet only, port 443,
  `https://<machine>.<tailnet>.ts.net`) and removes it when you turn sharing off. Glade never uses
  Tailscale Funnel, so it is never on the public internet.
- The same Glade version on every device is best (see [Updating](#updating)).

### Set up

1. **On both devices:** Settings → Remote Access → turn on **Remote access** ("Use Glade across
   your devices").
2. **On the host:** turn on **Let other devices use this device**. The *Tailscale* row should say
   "Reachable on your private tailnet" and *Address* shows `https://<machine>.<tailnet>.ts.net`.
   If the Tailscale row shows a warning instead, follow its fix-it text (see
   [Troubleshooting](#troubleshooting)).
3. **On the client**, same Tailscale account (no code needed):
   1. Under **Connections → Found on your tailnet**, click **Connect…** next to the host (or use
      **Connect to a Device…** and pick it). New hosts show up within seconds; **Refresh** checks
      now.
   2. The client shows "Check that <host> shows **1234**" and the host shows "<client> wants to
      use this device" with a number.
   3. If the numbers match, press **Allow** on the host (otherwise Deny). Done: the host's
      projects appear in the client's sidebar.
4. **Different Tailscale account, or the host asks for a code:** on the host click **Share This
   Device…**. It shows a QR code, a link and a short code with the address (valid 5 minutes, one
   at a time). On the client, **Connect to a Device…** → paste the link, or type the code and
   the address → **Connect**, then **Allow** on the host.

### Connections

Settings → Remote Access → **Connections** lists every other device once, with what it does:

- **You use it**: its address and status, with **Rename**, **Disconnect…** (removes it from this
  device's list; nothing on it is deleted), **Retry** when it can't be reached, and **Pair
  Again…** when it needs pairing.
- **Uses this device**: last seen, address and Tailscale login, with **Revoke…** (it's cut off at
  once) and **Revoke All**.
- A device can be both. Each device names its connections itself (**Rename**, or double-click the
  name); that name is used in the sidebar, pickers and notifications.
- It also says when the other device runs an older or newer Glade.

Status dots (Connections, the globe popover, the sidebar):

| Dot | Status |
| --- | --- |
| green | Connected |
| amber | Connecting… |
| grey | Remote access turned off on <device> · <device> is offline |
| red | Can't reach <device> · Needs pairing |

Devices that are down stay listed (their projects hidden) and reconnect on their own: a device
that turns remote access back on is noticed within a few seconds, at once when you switch back to
Glade.

### Security

- Other devices on your tailnet can reach the host's address, but can't use Glade without being
  **allowed on the host**. Every new device needs your Allow.
- An allowed device sees and uses **all projects and chats on the host, and runs agents there**.
  Only pair devices you trust. Opening things in Finder or an editor stays with the host.
- **Code-free pairing** works only when both devices are signed in to **your own Tailscale
  account**; everyone else needs a code from Share This Device…. The matching number makes sure
  you're allowing the right device.
- The client keeps its key for each host in the **macOS Keychain**; the host stores only a hash.
  Keys unused for 90 days expire (the device then shows "Needs pairing").
- **Revoke** a device anytime; turning **Remote access** off disconnects everyone at once and
  stops sharing (nothing is deleted; turning it back on restores your choices).
- Pairing, revokes, renames and rejected requests are listed under **Recent activity** at the
  bottom of Settings → Remote Access.

### Keeping the host available

A sleeping or quit host is offline, and a reply it was running is cut off (you can Continue it
later).

- **Keep awake:** Settings → General → Power → *Keep this Mac awake while a chat is working*
  (on), and in Remote Access *Keep this device awake while it's shared* (on power, while a device
  is connected; on) plus *Also on battery power* (off). The display can still turn off.
- **Closed lid:** a closed laptop lid still puts the Mac to sleep unless it's on power with an
  external display.
- **Menu bar:** ⌘Q closes the window but keeps Glade running in the menu bar: chats, sub-agents,
  sharing and notifications continue. To stop everything choose **Quit Glade Completely** (menu
  bar icon or ⌥⌘Q). The menu bar menu shows working chats, a *Sharing* toggle, whether it's
  keeping the Mac awake, and Open Glade / New Chat / Settings…. Settings → General → *Glade
  app*: Show in Dock, Open at login, and *⌘Q keeps Glade in the menu bar*.

### Notifications

The device you're using shows macOS banners for its own and remote chats ("On Mac Studio"): when a
chat needs your input, finishes or fails, by default only while Glade is in the background.
Clicking a banner opens the chat. Choose in Settings → General → Notifications (per device).

### Updating

Settings → General shows which build you're running and whether it's behind GitHub's main
(**Check Now**). To update, in the repo folder:

```bash
git pull && pnpm install && pnpm tauri:install
```

or use **Update Now** there; Glade restarts into the new version on its own once nothing is
working. **Update every device**: some features (e.g. code-free pairing) need both sides to be
current.

### Troubleshooting

| You see | What to do |
| --- | --- |
| Can't reach <device> | Check Glade is running there (menu bar is enough), Tailscale is connected on both devices, and the host is awake; then Retry. |
| <device> is offline | Tailscale sees it offline: it's asleep, off, or signed out of Tailscale. |
| Remote access turned off on <device> | Turn on Remote access and *Let other devices use this device* there; it reconnects by itself. |
| Needs pairing | The host revoked it, or its key expired. Click **Pair Again…**. |
| Tailscale: HTTPS is off in your tailnet | Enable HTTPS certificates in the admin console (see [Requirements](#requirements)). A brand-new certificate can take a minute before the first connection works. |
| Port 443 on this computer is already used by Tailscale Serve | Something else is served on 443. Check `tailscale serve status` and remove that entry. |
| Tailscale Funnel is on for port 443 | Turn Funnel off; Glade won't share while it's on. |
| Tailscale isn't installed / can't find the command-line tool | Install Tailscale, or turn on CLI integration in its settings. |
| Tailscale is signed out / turned off / isn't running | Sign in or connect from the Tailscale menu, or open the Tailscale app. |
| "<device> runs an older Glade that needs a code", or "uses a different Tailscale account" | Use a code from Share This Device…, or update the older device. |
| Remote Access says "The Glade app runs Tailscale Serve…" | You're in `pnpm dev`: only the Mac app shares; keep it open (or in the menu bar). |
