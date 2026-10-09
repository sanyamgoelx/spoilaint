# Spoilaint: turns VLC's automatic mode on (or off with -Uninstall).
# Called by the installer. Safe to run more than once.
#   - adds  extraintf=...:luaintf  and  lua-intf=spoilaint  to %APPDATA%\vlc\vlcrc
#   - writes %APPDATA%\vlc\spoilaint.ini with default settings (kept if it already exists)
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$vlcDir = Join-Path $env:APPDATA 'vlc'
$rc = Join-Path $vlcDir 'vlcrc'
$ini = Join-Path $vlcDir 'spoilaint.ini'
New-Item -ItemType Directory -Force -Path $vlcDir | Out-Null

$lines = @()
if (Test-Path -LiteralPath $rc) {
  # Keep a one-time backup of the original settings.
  $backup = "$rc.before-spoilaint"
  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $rc -Destination $backup }
  $lines = [IO.File]::ReadAllLines($rc)
}

# Pull out the active extraintf / lua-intf lines; everything else stays as it is.
$extra = @()
$out = New-Object System.Collections.Generic.List[string]
foreach ($l in $lines) {
  if ($l -match '^extraintf=(.*)$') { $extra += ($Matches[1] -split ':' | Where-Object { $_ }); continue }
  if ($l -match '^lua-intf=') { continue }
  if ($l -match '^# Spoilaint') { continue }
  $out.Add($l)
}
$extra = @($extra | Where-Object { $_ -ne 'luaintf' } | Select-Object -Unique)

if (-not $Uninstall) {
  $extra += 'luaintf'
  # VLC reads the last value it sees, so these go at the end.
  $out.Add('# Spoilaint: spoiler-free subtitles (remove these two lines to turn it off)')
  $out.Add('extraintf=' + ($extra -join ':'))
  $out.Add('lua-intf=spoilaint')
} elseif ($extra.Count -gt 0) {
  $out.Add('extraintf=' + ($extra -join ':'))
}
[IO.File]::WriteAllLines($rc, $out, (New-Object System.Text.UTF8Encoding($false)))

if ($Uninstall) {
  if (Test-Path -LiteralPath $ini) { Remove-Item -LiteralPath $ini }
  exit 0
}

if (Test-Path -LiteralPath $ini) {
  # 0.2.0: the delay now means "0 = on time" (estimated lines get their own +300 ms), so move old defaults.
  $iniLines = [IO.File]::ReadAllLines($ini)
  if ($iniLines -contains 'lag=300') {
    $iniLines = $iniLines | ForEach-Object { if ($_ -eq 'lag=300') { 'lag=0' } else { $_ } }
    [IO.File]::WriteAllLines($ini, $iniLines, (New-Object System.Text.UTF8Encoding($false)))
  }
} else {
  # ffmpeg reads subtitles built into .mkv files. Use the one next to this script, else one on PATH.
  $ffmpeg = Join-Path $PSScriptRoot 'ffmpeg.exe'
  if (-not (Test-Path -LiteralPath $ffmpeg)) {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    $ffmpeg = if ($cmd) { $cmd.Source } else { '' }
  }
  $content = @(
    '# Spoilaint settings for VLC. Restart VLC after changing them.',
    'mode=word',
    '# word | chunk | off',
    'lag=0',
    '# milliseconds; 0 = on time, higher = later. Lines not matched to speech get +300 by themselves',
    'theme=amber',
    '# amber | dark | indigo | green',
    'highlight=1',
    'size=64',
    'box=0',
    'font=Segoe UI',
    "ffmpeg=$ffmpeg"
  )
  [IO.File]::WriteAllLines($ini, $content, (New-Object System.Text.UTF8Encoding($false)))
}

if (Get-Process vlc -ErrorAction SilentlyContinue) { exit 3 }  # tells the installer to say "restart VLC"
exit 0
