#!/bin/sh
# Cargo runner for the desktop app (wired up in src-tauri/.cargo/config.toml).
#
# `tauri dev` runs `cargo run`, which would start the bare `target/debug/glade` executable. A bare
# executable has no Info.plist or icon, so the Dock, ⌘Tab and switchers like AltTab show the
# generic "exec" icon for it. Instead, this wraps the debug binary in a minimal bundle,
# `target/debug/Glade (dev).app` (own bundle id, name "Glade (dev)", icon with a DEV band from
# icons/dev/icon.icns), and execs the binary from inside it. `exec` keeps the pid, so `tauri dev`
# can still stop/restart the app on changes and ⌘Q still ends the dev session.
#
# Anything else cargo runs (tests, release builds) is executed as-is.
set -e

bin="$1"
shift
case "$bin" in
  target/debug/glade | */target/debug/glade) ;;
  *) exec "$bin" "$@" ;;
esac

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
app="$(dirname "$bin")/Glade (dev).app"
contents="$app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources"

# Fresh link to the just-built binary (cargo replaces the file on every build).
ln -f "$bin" "$contents/MacOS/glade" 2>/dev/null || cp -f "$bin" "$contents/MacOS/glade"

changed=""
icon_src="$desktop_dir/src-tauri/icons/dev/icon.icns"
if ! cmp -s "$icon_src" "$contents/Resources/icon.icns"; then
  cp -f "$icon_src" "$contents/Resources/icon.icns"
  changed=1
fi

plist="$(cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>Glade (dev)</string>
  <key>CFBundleExecutable</key><string>glade</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>io.github.jas7457.glade.dev</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Glade (dev)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
)"
if [ "$plist" != "$(cat "$contents/Info.plist" 2>/dev/null)" ]; then
  printf '%s\n' "$plist" > "$contents/Info.plist"
  changed=1
fi

# Tell LaunchServices about new/changed bundle metadata so it doesn't serve a cached icon.
if [ -n "$changed" ]; then
  touch "$app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" || true
fi

exec "$contents/MacOS/glade" "$@"
