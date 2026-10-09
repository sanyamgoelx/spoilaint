#!/bin/sh
# Builds the Windows tray app: dist/app/Spoilaint.exe (.NET Framework 4.x, built into Windows 10/11).
# Needs Mono's C# compiler (apt-get install mono-devel). Run from the repo root before makensis.
set -e
cd "$(dirname "$0")"
cp ../installer/spoilaint.ico spoilaint.ico
cp ../assets/icon-128.png logo.png
mkdir -p ../dist/app
mcs -nologo -target:winexe -platform:x64 -sdk:4.5 -optimize+ -out:../dist/app/Spoilaint.exe \
  -win32icon:spoilaint.ico -resource:spoilaint.ico,spoilaint.ico -resource:logo.png,logo.png \
  -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.dll -r:System.Core.dll \
  Core.cs Controls.cs App.cs Align.cs Browsers.cs Guide.cs Setup.cs
rm -f spoilaint.ico logo.png
echo "Built dist/app/Spoilaint.exe"
