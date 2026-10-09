#!/bin/sh
# Downloads the third-party parts the installers bundle (none of them live in the repository).
# Everything comes from GitHub releases or PyPI, pinned to the versions Spoilaint is tested with.
#   installer/vendor/  ffmpeg.exe, onnxruntime.dll, vcrt/*.dll, speech-model/{model.int8.onnx,tokens.txt}
#   mac/vendor/        ffmpeg-darwin-{arm64,x64}, ffmpeg-LICENSE/README, libonnxruntime.dylib, rcodesign, dmg
# Run from the repo root on Linux (needs curl, unzip, python3 + pip, cmake, a C compiler, zlib headers).
set -e
ROOT=$(pwd)
TMP=$(mktemp -d)
GH=https://github.com
dl() { curl -fsSL --retry 3 -o "$2" "$1"; }

W=$ROOT/installer/vendor; M=$ROOT/mac/vendor
mkdir -p "$W/vcrt" "$W/speech-model" "$M"

# --- Windows -----------------------------------------------------------------------------------
if [ ! -f "$W/ffmpeg.exe" ]; then
  dl "$GH/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip" "$TMP/ff.zip"
  (cd "$TMP" && unzip -q ff.zip) && cp "$(find "$TMP" -name ffmpeg.exe | head -1)" "$W/ffmpeg.exe"
fi
if [ ! -f "$W/onnxruntime.dll" ]; then
  dl "$GH/microsoft/onnxruntime/releases/download/v1.20.1/onnxruntime-win-x64-1.20.1.zip" "$TMP/ort.zip"
  (cd "$TMP" && unzip -q ort.zip) && cp "$TMP/onnxruntime-win-x64-1.20.1/lib/onnxruntime.dll" "$W/"
fi
if [ ! -f "$W/vcrt/vcruntime140_1.dll" ]; then
  python3 -m pip download msvc-runtime==14.44.35112 --platform win_amd64 --python-version 3.13 --only-binary=:all: --no-deps -d "$TMP/vc" -q
  (cd "$TMP/vc" && unzip -q -o ./*.whl)
  for f in msvcp140.dll msvcp140_1.dll vcruntime140.dll vcruntime140_1.dll; do cp "$(find "$TMP/vc" -name $f | head -1)" "$W/vcrt/"; done
fi
if [ ! -f "$W/speech-model/model.int8.onnx" ]; then
  dl "$GH/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2" "$TMP/m.tar.bz2"
  (cd "$TMP" && tar xjf m.tar.bz2)
  d=$(dirname "$(find "$TMP" -name model.int8.onnx | head -1)")
  cp "$d/model.int8.onnx" "$d/tokens.txt" "$W/speech-model/"
fi

# --- macOS -------------------------------------------------------------------------------------
for a in arm64 x64; do
  if [ ! -f "$M/ffmpeg-darwin-$a" ]; then
    dl "$GH/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-$a.gz" "$TMP/ff-$a.gz"
    gunzip -c "$TMP/ff-$a.gz" > "$M/ffmpeg-darwin-$a"; chmod 755 "$M/ffmpeg-darwin-$a"
  fi
done
[ -f "$M/ffmpeg-LICENSE" ] || dl "$GH/eugeneware/ffmpeg-static/releases/download/b6.1.1/darwin-x64.LICENSE" "$M/ffmpeg-LICENSE"
[ -f "$M/ffmpeg-README" ] || dl "$GH/eugeneware/ffmpeg-static/releases/download/b6.1.1/darwin-x64.README" "$M/ffmpeg-README"
if [ ! -f "$M/libonnxruntime.dylib" ]; then
  dl "$GH/microsoft/onnxruntime/releases/download/v1.20.1/onnxruntime-osx-universal2-1.20.1.tgz" "$TMP/ortm.tgz"
  (cd "$TMP" && tar xzf ortm.tgz) && cp "$TMP/onnxruntime-osx-universal2-1.20.1/lib/libonnxruntime.1.20.1.dylib" "$M/libonnxruntime.dylib"
fi
if [ ! -x "$M/rcodesign" ]; then
  dl "$GH/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz" "$TMP/rc.tgz"
  (cd "$TMP" && tar xzf rc.tgz) && cp "$TMP"/apple-codesign-0.29.0-*/rcodesign "$M/"
fi
if [ ! -x "$M/dmg" ]; then
  git clone -q --depth 1 https://github.com/fanquake/libdmg-hfsplus "$TMP/dmg-src"
  (cd "$TMP/dmg-src" && cmake . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && make -C build -j4 >/dev/null)
  cp "$TMP/dmg-src/build/dmg/dmg" "$M/"
fi
rm -rf "$TMP"
echo "vendor ready"
