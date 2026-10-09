package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

func home() string { h, _ := os.UserHomeDir(); return h }

func isMac() bool { return runtime.GOOS == "darwin" }

// dataDir: everything Spoilaint keeps (programs, model, extension, jobs, settings of the app itself).
func dataDir() string {
	if d := os.Getenv("SPOIL_DATA"); d != "" {
		return d
	}
	if isMac() {
		return filepath.Join(home(), "Library", "Application Support", "Spoilaint")
	}
	return filepath.Join(home(), ".local", "share", "Spoilaint")
}

func jobsDir() string      { return filepath.Join(dataDir(), "jobs") }
func aliveFile() string    { return filepath.Join(dataDir(), "helper.alive") }
func appIni() string       { return filepath.Join(dataDir(), "app.ini") }
func recentFile() string   { return filepath.Join(dataDir(), "recent.txt") }
func binDir() string       { return filepath.Join(dataDir(), "bin") }
func extensionDir() string { return filepath.Join(dataDir(), "extension") }

// VLC keeps its scripts and our settings file in its user data folder, and vlcrc in its config folder.
func vlcUserData() string {
	if isMac() {
		return filepath.Join(home(), "Library", "Application Support", "org.videolan.vlc")
	}
	return filepath.Join(home(), ".local", "share", "vlc")
}
func vlcConfigDir() string {
	if isMac() {
		return filepath.Join(home(), "Library", "Preferences", "org.videolan.vlc")
	}
	return filepath.Join(home(), ".config", "vlc")
}
func vlcIni() string    { return filepath.Join(vlcUserData(), "spoilaint.ini") }
func vlcRc() string     { return filepath.Join(vlcConfigDir(), "vlcrc") }
func vlcLog() string    { return filepath.Join(vlcUserData(), "spoilaint.log") }
func vlcScript() string { return filepath.Join(vlcUserData(), "lua", "intf", "spoilaint.lua") }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func ffmpegPath() string {
	if p := os.Getenv("SPOIL_FFMPEG"); p != "" {
		return p
	}
	if p := filepath.Join(binDir(), "ffmpeg"); exists(p) {
		return p
	}
	return "ffmpeg"
}

func modelDir() string {
	if p := os.Getenv("SPOIL_MODEL"); p != "" {
		return p
	}
	return filepath.Join(dataDir(), "speech-model")
}

func ortPath() string {
	if p := os.Getenv("SPOIL_ORT"); p != "" {
		return p
	}
	if isMac() {
		return filepath.Join(dataDir(), "lib", "libonnxruntime.dylib")
	}
	return filepath.Join(dataDir(), "lib", "libonnxruntime.so")
}

var (
	alignAvail   = -1
	alignAvailMu sync.Mutex
)

// alignAvailable: the model, ffmpeg and ONNX Runtime are all there and ONNX Runtime really loads.
func alignAvailable() bool {
	alignAvailMu.Lock()
	defer alignAvailMu.Unlock()
	if alignAvail >= 0 {
		return alignAvail == 1
	}
	ok := exists(filepath.Join(modelDir(), "model.int8.onnx")) && exists(filepath.Join(modelDir(), "tokens.txt")) && ffmpegPath() != "ffmpeg"
	if ok {
		ok = loadOrt(ortPath()) == nil
	}
	if ok {
		alignAvail = 1
	} else {
		alignAvail = 0
	}
	return ok
}
