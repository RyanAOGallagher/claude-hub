#!/bin/zsh
# Generates builds/Claude Hub.app — a double-clickable launcher that runs the
# app straight from this repo (no terminal window, no packaging step).
# Re-run after moving the repo. Drag the .app to the Dock or /Applications.
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
APP="$REPO/builds/Claude Hub.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>Claude Hub</string>
  <key>CFBundleIdentifier</key><string>local.claude-hub.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <!-- the launcher itself stays out of the Dock; Electron provides the real Dock icon -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

cat > "$APP/Contents/MacOS/launcher" <<EOF
#!/bin/zsh
exec "$REPO/node_modules/.bin/electron" "$REPO"
EOF
chmod +x "$APP/Contents/MacOS/launcher"

echo "Created: $APP"
