; Spoilaint installer (NSIS 3). Build: makensis installer/spoilaint.nsi  (after `node build.js` and `sh tray/build.sh`)
;
; The installer has no NSIS pages: it runs silently and shows Spoilaint's own setup window instead
; (Spoilaint.exe --setup, see tray/Setup.cs), talking to it through files in $PLUGINSDIR:
;   window writes ui.ready, then go (Install) or cancel;  installer writes progress ("percent|text") and done.
; If the window can't start (very old .NET), it falls back to plain message boxes.
Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"

!define APP "Spoilaint"
!define VERSION "0.8.0"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Spoilaint"

Name "${APP}"
OutFile "..\dist\Spoilaint Setup ${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Spoilaint"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "spoilaint.ico"
UninstallIcon "spoilaint.ico"
SilentInstall silent
SilentUnInstall silent
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Spoilaint"
VIAddVersionKey "FileDescription" "Spoilaint Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Spoilaint"

Var Flags     ; done flags for the window: vlcrunning, novlc, vlcerror
Var UiOk      ; 1 when Spoilaint's setup window is showing
Var UiExe

!macro Progress PCT TEXT
  FileOpen $9 "$PLUGINSDIR\progress" w
  FileWrite $9 "${PCT}|${TEXT}"
  FileClose $9
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Spoilaint needs 64-bit Windows."
    Abort
  ${EndIf}
  InitPluginsDir
  StrCpy $Flags ""
  StrCpy $0 "new"
  IfFileExists "$INSTDIR\Spoilaint.exe" 0 +2
    StrCpy $0 "update"
  ; The window runs from %TEMP% (not the plugins folder, which is removed when the installer exits, while
  ; the window stays up to show the finish screen). It deletes itself when closed.
  StrCpy $UiExe "$TEMP\Spoilaint-setup-${VERSION}.exe"
  SetOutPath "$TEMP"
  File "/oname=$UiExe" "..\dist\app\Spoilaint.exe"
  Exec '"$UiExe" --setup "$PLUGINSDIR" ${VERSION} $0 "$INSTDIR"'
  StrCpy $UiOk 0
  StrCpy $1 0
  wait:
    IfFileExists "$PLUGINSDIR\go" go
    IfFileExists "$PLUGINSDIR\cancel" cancel
    IfFileExists "$PLUGINSDIR\ui.ready" 0 +2
      StrCpy $UiOk 1
    Sleep 100
    IntOp $1 $1 + 1
    ${If} $UiOk == 0
    ${AndIf} $1 >= 450
      ; no window after 45 s (a slow first start, or antivirus holding it): ask the plain way, and close the
      ; window if it turns up late so there aren't two
      nsExec::Exec 'taskkill /IM "Spoilaint-setup-${VERSION}.exe" /F'
      Pop $2
      MessageBox MB_YESNO|MB_ICONQUESTION "Install Spoilaint ${VERSION}? It sets up VLC to show subtitles word by word as they're spoken, and adds a browser extension." IDYES go
      Abort
    ${EndIf}
    ${If} $1 >= 36000 ; an hour with no answer
      Abort
    ${EndIf}
    Goto wait
  cancel:
    Abort
  go:
FunctionEnd

; Close the app (an update or uninstall) and anything it started (ffmpeg), so their files can be replaced.
!macro CloseApp
  IfFileExists "$INSTDIR\Spoilaint.exe" 0 +3
    ExecWait '"$INSTDIR\Spoilaint.exe" --quit'
    Sleep 800
  nsExec::Exec 'taskkill /IM Spoilaint.exe /T /F'
  Pop $0
  Sleep 300
!macroend

Section "-Core"
  !insertmacro Progress 3 "Closing the running Spoilaint"
  !insertmacro CloseApp
  !insertmacro Progress 8 "Copying the app"
  SetOutPath "$INSTDIR"
  File "..\dist\app\Spoilaint.exe"
  File "configure-vlc.ps1"
  File "setup-extension.html"
  File "spoilaint.ico"
  WriteUninstaller "$INSTDIR\Uninstall Spoilaint.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Spoilaint"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Spoilaint"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\spoilaint.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Spoilaint.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ; Runs in the tray from sign-in: does VLC's background work without console windows.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Spoilaint" '"$INSTDIR\Spoilaint.exe" --background'
  CreateShortCut "$SMPROGRAMS\Spoilaint.lnk" "$INSTDIR\Spoilaint.exe" "" "$INSTDIR\Spoilaint.exe" 0
  Delete "$SMPROGRAMS\Spoilaint browser extension setup.lnk" ; replaced in 0.7.0
  CreateShortCut "$SMPROGRAMS\Add Spoilaint to your browser.lnk" "$INSTDIR\Spoilaint.exe" "--add-extension" "$INSTDIR\Spoilaint.exe" 0
  ; spoilaint://add-extension/<browser> lets the setup page's buttons open the guide (web pages can't open chrome://extensions).
  WriteRegStr HKCU "Software\Classes\spoilaint" "" "URL:Spoilaint"
  WriteRegStr HKCU "Software\Classes\spoilaint" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\spoilaint\DefaultIcon" "" "$INSTDIR\Spoilaint.exe,0"
  WriteRegStr HKCU "Software\Classes\spoilaint\shell\open\command" "" '"$INSTDIR\Spoilaint.exe" "%1"'
SectionEnd

Section "-FFmpeg"
  ; Reads each film's sound for the speech model and subtitles built into .mkv files.
  !insertmacro Progress 12 "Unpacking FFmpeg, for film sound and .mkv subtitles"
  SetOutPath "$INSTDIR"
  File "vendor\ffmpeg.exe"
  File "vendor\ffmpeg-LICENSE.txt"
  File "vendor\ffmpeg-README.txt"
SectionEnd

Section "-Model"
  !insertmacro Progress 42 "Unpacking the speech model"
  ; Finds when each subtitle word is spoken (forced alignment), for VLC (in the Spoilaint app) and the browser.
  SetOutPath "$INSTDIR"
  File "vendor\onnxruntime.dll"
  ; ONNX Runtime needs the Visual C++ 2019+ runtime; shipped next to it (app-local) for PCs without it.
  File "vendor\vcrt\msvcp140.dll"
  File "vendor\vcrt\msvcp140_1.dll"
  File "vendor\vcrt\vcruntime140.dll"
  File "vendor\vcrt\vcruntime140_1.dll"
  File "vendor\onnxruntime-LICENSE.txt"
  SetOutPath "$INSTDIR\speech-model"
  File "vendor\speech-model\model.int8.onnx"
  File "vendor\speech-model\tokens.txt"
  File "vendor\speech-model\README.txt"
SectionEnd

Section "-VLC"
  !insertmacro Progress 66 "Turning on VLC's automatic mode"
  SetOutPath "$APPDATA\vlc\lua\intf"
  File "..\dist\vlc\spoilaint.lua"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\configure-vlc.ps1"'
  Pop $0
  ${If} $0 == 3
    StrCpy $Flags "$Flags|vlcrunning"
  ${ElseIf} $0 != 0
    StrCpy $Flags "$Flags|vlcerror"
  ${EndIf}
  SetRegView 64
  ReadRegStr $1 HKLM "Software\VideoLAN\VLC" "InstallDir"
  SetRegView 32
  ${If} $1 == ""
    ReadRegStr $1 HKLM "Software\VideoLAN\VLC" "InstallDir"
  ${EndIf}
  ${If} $1 == ""
    StrCpy $Flags "$Flags|novlc"
  ${EndIf}
SectionEnd

Section "-Extension"
  !insertmacro Progress 72 "Copying the browser extension"
  SetOutPath "$INSTDIR\extension"
  File /r "..\dist\extension\*.*"
SectionEnd


; Start the tray app now (it also starts with Windows), so VLC's background work is ready straight away;
; the finish screen's "Add to my browser" then just asks it to open the guide.
Section "-Start"
  !insertmacro Progress 97 "Starting Spoilaint"
  Exec '"$INSTDIR\Spoilaint.exe" --background'
SectionEnd

Function .onInstSuccess
  !insertmacro Progress 100 "Done"
  FileOpen $9 "$PLUGINSDIR\done" w
  FileWrite $9 "ok$Flags"
  FileClose $9
  ${If} $UiOk == 0
    MessageBox MB_ICONINFORMATION "Spoilaint is installed. Next, a small guide helps you add it to your browser."
    Exec '"$INSTDIR\Spoilaint.exe" --add-extension'
  ${EndIf}
  Sleep 400 ; let the window read it before the plugins folder goes
FunctionEnd

Function .onInstFailed
  FileOpen $9 "$PLUGINSDIR\done" w
  FileWrite $9 "failed|Some files couldn't be written. Is Spoilaint or ffmpeg still running?"
  FileClose $9
  Sleep 400
FunctionEnd

Function un.onInit
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove Spoilaint from this PC? VLC goes back to normal subtitles." IDYES +2
  Abort
FunctionEnd

Section "Uninstall"
  !insertmacro CloseApp
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Spoilaint"
  Delete "$SMPROGRAMS\Spoilaint.lnk"
  Delete "$SMPROGRAMS\Spoilaint browser extension setup.lnk"
  Delete "$SMPROGRAMS\Add Spoilaint to your browser.lnk"
  DeleteRegKey HKCU "Software\Classes\spoilaint"
  Delete "$INSTDIR\guide.req"
  Delete /REBOOTOK "$INSTDIR\Spoilaint.exe"
  Delete /REBOOTOK "$INSTDIR\onnxruntime.dll"
  Delete /REBOOTOK "$INSTDIR\msvcp140.dll"
  Delete /REBOOTOK "$INSTDIR\msvcp140_1.dll"
  Delete /REBOOTOK "$INSTDIR\vcruntime140.dll"
  Delete /REBOOTOK "$INSTDIR\vcruntime140_1.dll"
  ; VLC's converted subtitles, speech data and log
  RMDir /r "$APPDATA\vlc\spoilaint"
  RMDir /r "$LOCALAPPDATA\vlc\spoilaint"
  Delete "$APPDATA\vlc\spoilaint.log"
  Delete "$APPDATA\vlc\vlcrc.before-spoilaint"
  Delete "$INSTDIR\onnxruntime-LICENSE.txt"
  RMDir /r "$INSTDIR\speech-model"
  RMDir /r "$INSTDIR\jobs"
  Delete "$INSTDIR\helper.alive"
  Delete "$INSTDIR\recent.txt"
  Delete "$INSTDIR\app.ini"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\configure-vlc.ps1" -Uninstall'
  Pop $0
  Delete "$APPDATA\vlc\lua\intf\spoilaint.lua"
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\configure-vlc.ps1"
  Delete "$INSTDIR\setup-extension.html"
  Delete "$INSTDIR\spoilaint.ico"
  Delete /REBOOTOK "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffmpeg-LICENSE.txt"
  Delete "$INSTDIR\ffmpeg-README.txt"
  Delete "$INSTDIR\Uninstall Spoilaint.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  MessageBox MB_ICONINFORMATION "Spoilaint is removed from VLC. If you added the browser extension, remove it too: open your browser's extensions page (chrome://extensions, brave://extensions or edge://extensions) and click Remove on Spoilaint."
SectionEnd
