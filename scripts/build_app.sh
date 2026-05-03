#!/bin/bash
# Build a minimal macOS .app bundle that wraps launcher.py.
#
# The bundle is hard-linked to this checkout: it execs the project's
# backend/.venv python on this project's launcher.py. Move the project
# directory and the .app stops working — that's the trade-off for the
# 5-minute wrapper approach. For a relocatable bundle, use py2app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${APP_NAME:-gorchestra}"
APP="${ROOT}/${APP_NAME}.app"
PYTHON="${ROOT}/backend/.venv/bin/python"
LAUNCHER="${ROOT}/launcher.py"
LOG_FILE="${TMPDIR:-/tmp}/${APP_NAME}.log"

if [[ ! -x "$PYTHON" ]]; then
    echo "error: $PYTHON not found. Run 'make install' first." >&2
    exit 1
fi
if [[ ! -f "$LAUNCHER" ]]; then
    echo "error: $LAUNCHER not found." >&2
    exit 1
fi
if [[ ! -d "${ROOT}/frontend/dist" ]]; then
    echo "error: frontend/dist not found. Run 'make app-build' first." >&2
    exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

# The executable in Contents/MacOS/ MUST be a real Mach-O binary, not a
# shell script. Otherwise LaunchServices can't read the architecture from
# the file header, falls back to assuming x86_64, and refuses to launch on
# Apple Silicon with a misleading "Rosetta required" / -10669 error.
# We compile a tiny C wrapper that execs the Python launcher.
TMPDIR_BUILD="$(mktemp -d -t gorchestra_build)"
SRC="${TMPDIR_BUILD}/launcher.c"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

cat > "$SRC" <<EOF
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    int fd = open("${LOG_FILE}", O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); close(fd); }
    chdir("${ROOT}");
    execl("${PYTHON}", "python", "${LAUNCHER}", (char *)NULL);
    return 1;
}
EOF

# Build for the host arch (arm64 on Apple Silicon). The point of the C
# wrapper is purely to give LaunchServices a real Mach-O header to read;
# no x86_64 or Rosetta is involved at any point.
clang -O2 -o "$APP/Contents/MacOS/$APP_NAME" "$SRC"
chmod +x "$APP/Contents/MacOS/$APP_NAME"

# Ad-hoc sign so Gatekeeper / App Management on macOS 15+ lets us launch
# without the "damaged or untrusted developer" prompt. Identity "-" means
# no real cert; sufficient for local-only use.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>local.gorchestra</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>gorchestra</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>LSUIElement</key>
    <false/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

# Touch the bundle so Finder picks up changes immediately.
touch "$APP"

echo "Built: $APP"
echo "Logs:  $LOG_FILE"
echo
echo "Drag $APP_NAME.app into /Applications, or run:"
echo "    open '$APP'"
