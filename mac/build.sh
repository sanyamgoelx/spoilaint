#!/bin/sh
# Builds dist/Spoilaint-<version>-mac.dmg (Apple Silicon + Intel) from Linux. Run from the repo root after `node build.js`.
#
# Needs: go 1.22+, llvm-lipo (apt install llvm), genisoimage, and in mac/vendor/ (all from GitHub releases):
#   rcodesign                 indygreg/apple-platform-rs  apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz
#   dmg                       fanquake/libdmg-hfsplus, built with cmake (turns the ISO into a compressed .dmg)
#   ffmpeg-darwin-arm64, ffmpeg-darwin-x64, ffmpeg-LICENSE, ffmpeg-README   eugeneware/ffmpeg-static b6.1.1
#   libonnxruntime.dylib      microsoft/onnxruntime v1.20.1 onnxruntime-osx-universal2-1.20.1.tgz (lib/, a real file)
# Speech model: installer/vendor/speech-model (same as Windows).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
V=$ROOT/mac/vendor
VERSION=$(sed -n 's/^const version = "\(.*\)"/\1/p' "$ROOT/mac/helper/main.go")
OUT=$ROOT/dist/mac
APP=$OUT/Spoilaint.app
LIPO=$(command -v llvm-lipo || command -v llvm-lipo-18)
rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/lib" "$APP/Contents/Resources/vlc"

# The app's program: the helper for both kinds of Mac in one file. It also becomes the background agent.
cd "$ROOT/mac/helper"
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/helper-arm64" .
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/helper-x64" .
"$LIPO" -create "$OUT/helper-arm64" "$OUT/helper-x64" -output "$APP/Contents/MacOS/Spoilaint"
# the same program as its own signed file: the copy that runs in the background (outside the app)
cp "$APP/Contents/MacOS/Spoilaint" "$APP/Contents/Resources/bin/spoilaint-helper"
"$LIPO" -create "$V/ffmpeg-darwin-arm64" "$V/ffmpeg-darwin-x64" -output "$APP/Contents/Resources/bin/ffmpeg"
rm "$OUT/helper-arm64" "$OUT/helper-x64"
chmod 755 "$APP/Contents/MacOS/Spoilaint" "$APP/Contents/Resources/bin/ffmpeg" "$APP/Contents/Resources/bin/spoilaint-helper"

R=$APP/Contents/Resources
echo "$VERSION" > "$R/VERSION"
cp "$ROOT/mac/assets/AppIcon.icns" "$R/"
cp "$V/libonnxruntime.dylib" "$R/lib/"
cp -R "$ROOT/installer/vendor/speech-model" "$R/speech-model"
cp -R "$ROOT/dist/extension" "$R/extension"
cp "$ROOT/vlc/spoilaint.lua" "$R/vlc/"
mkdir -p "$R/licenses"
cp "$V/ffmpeg-LICENSE" "$R/licenses/ffmpeg-LICENSE.txt"; cp "$V/ffmpeg-README" "$R/licenses/ffmpeg-README.txt"
cp "$ROOT/installer/vendor/onnxruntime-LICENSE.txt" "$R/licenses/"
cp "$ROOT/store/THIRD_PARTY_NOTICES.txt" "$R/licenses/"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Spoilaint</string>
  <key>CFBundleDisplayName</key><string>Spoilaint</string>
  <key>CFBundleIdentifier</key><string>app.spoilaint.Spoilaint</string>
  <key>CFBundleExecutable</key><string>Spoilaint</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Spoilaint opens your browser's extensions page so you can add its extension.</string>
  <key>NSHumanReadableCopyright</key><string>Spoilaint</string>
</dict>
</plist>
EOF

# Signature. No Apple developer account yet, so a self-signed certificate (mac/signing/spoilaint.crt/.key,
# made once with `rcodesign generate-self-signed-certificate --person-name Spoilaint --pem-filename mac/signing/spoilaint`).
# Apple Silicon needs every program signed; a stable certificate (unlike ad-hoc) keeps macOS's permissions
# (files in Downloads, controlling the browser) across updates. Gatekeeper still asks once ("Open Anyway").
# On GitHub Actions the key comes from the MAC_SIGN_KEY secret; without it the app is signed ad hoc (works the same,
# but macOS asks for its permissions again after an update).
KEY=$ROOT/mac/signing/spoilaint.key
if [ ! -f "$KEY" ] && [ -n "$MAC_SIGN_KEY" ]; then printf '%s\n' "$MAC_SIGN_KEY" > "$KEY"; fi
if [ -f "$KEY" ]; then SIGN="--timestamp-url none --pem-file $ROOT/mac/signing/spoilaint.crt --pem-file $KEY"; else SIGN=""; echo "no signing key: ad-hoc signature"; fi
"$V/rcodesign" sign $SIGN --binary-identifier app.spoilaint.helper "$R/bin/spoilaint-helper" >/dev/null
"$V/rcodesign" sign $SIGN "$APP" >/dev/null

# The disk image: the app, a link to Applications, and first-open help.
STAGE=$OUT/stage; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/mac/assets/First open - read me.txt" "$STAGE/"
genisoimage -quiet -no-cache-inodes -D -l -V "Spoilaint" -no-pad -r -dir-mode 0755 -apple -o "$OUT/Spoilaint.iso" "$STAGE" 2>/dev/null \
  || genisoimage -quiet -no-cache-inodes -D -l -V "Spoilaint" -no-pad -r -dir-mode 0755 -o "$OUT/Spoilaint.iso" "$STAGE"
"$V/dmg" "$OUT/Spoilaint.iso" "$ROOT/dist/Spoilaint-$VERSION-mac.dmg" >/dev/null
rm -rf "$STAGE" "$OUT/Spoilaint.iso"
echo "Built dist/Spoilaint-$VERSION-mac.dmg ($(du -h "$ROOT/dist/Spoilaint-$VERSION-mac.dmg" | cut -f1))"
