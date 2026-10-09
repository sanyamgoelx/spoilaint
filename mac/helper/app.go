package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// alert shows a plain macOS dialog (for errors before the window exists).
func alert(title, text string) {
	if !isMac() {
		return
	}
	q := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) }
	exec.Command("osascript", "-e", `display alert "`+q(title)+`" message "`+q(text)+`" as critical`).Run()
}

func openPath(p string) error {
	if isMac() {
		return exec.Command("open", p).Run()
	}
	return exec.Command("xdg-open", p).Run()
}

// openApp is what Spoilaint.app runs. It puts the helper in place (first run or update), starts the background
// agent and opens the window. Copying the big parts (model, extension, FFmpeg) waits for the Install button.
func openApp(args []string) error {
	exe, _ := os.Executable()
	res := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--bundle" {
			res = args[i+1]
		}
	}
	if res == "" {
		res = filepath.Join(filepath.Dir(filepath.Dir(exe)), "Resources") // Contents/MacOS/Spoilaint -> Contents/Resources
	}
	os.MkdirAll(dataDir(), 0o755)
	// One at a time (a double-click can start two).
	lock := filepath.Join(dataDir(), "open.lock")
	if st, err := os.Stat(lock); err == nil && time.Since(st.ModTime()) > 2*time.Minute {
		os.Remove(lock)
	}
	lf, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil // already opening
	}
	lf.Close()
	defer os.Remove(lock)
	// A new version to set up: copy its parts out of the app now (a downloaded app can run from a temporary,
	// read-only place that is gone later), and the Install button moves them into place.
	if bv := readVersion(filepath.Join(res, "VERSION")); bv != "" && bv != installedVersion() {
		pending := filepath.Join(dataDir(), "pending")
		if readVersion(filepath.Join(pending, "VERSION")) != bv {
			os.RemoveAll(pending)
			if err := copyTree(res, pending); err != nil {
				return fmt.Errorf("couldn't copy Spoilaint's files: %v", err)
			}
		}
		os.WriteFile(filepath.Join(dataDir(), "bundle.txt"), []byte(pending), 0o644)
	}
	dst := filepath.Join(binDir(), "spoilaint-helper")
	// The bundle carries the helper as its own signed program (the app's main program is sealed to the app).
	src := filepath.Join(res, "bin", "spoilaint-helper")
	if !exists(src) {
		src = exe
	}
	updated := false
	if readVersion(filepath.Join(binDir(), "VERSION")) != version || !exists(dst) {
		os.Remove(dst + ".old")
		if exists(dst) {
			os.Rename(dst, dst+".old") // a running copy keeps its file; the new one takes the name
		}
		if err := copyFile(src, dst, 0o755); err != nil {
			return err
		}
		os.Remove(dst + ".old")
		os.WriteFile(filepath.Join(binDir(), "VERSION"), []byte(version), 0o644)
		updated = true
	}
	if isMac() {
		if updated || !exists(agentPlist()) {
			writeAgent(!exists(agentPlist()) || agentRunAtLoad()) // keep the viewer's "Start when I log in"
			restartAgent()
		} else if !agentAlive() {
			exec.Command("launchctl", "kickstart", "gui/"+uid()+"/"+agentLabel).Run()
		}
	}
	// launchd may refuse (Login Items > Allow in the Background turned off): then run it ourselves.
	for i := 0; i < 24 && !agentAlive(); i++ {
		time.Sleep(250 * time.Millisecond)
	}
	if !agentAlive() {
		cmd := exec.Command(dst, "serve")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Start()
	}
	// wait for the agent's page
	url := ""
	for i := 0; i < 60; i++ {
		if p := strings.TrimSpace(readVersion(portFile())); p != "" {
			u := "http://127.0.0.1:" + p + "/"
			if resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(u + "api/status"); err == nil {
				resp.Body.Close()
				url = u
				break
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	if url == "" {
		return fmt.Errorf("the Spoilaint helper didn't start; see %s", filepath.Join(dataDir(), "helper.log"))
	}
	return openWindow(url)
}

func agentAlive() bool {
	b, err := os.ReadFile(aliveFile())
	if err != nil {
		return false
	}
	var t int64
	fmt.Sscan(strings.Fields(string(b) + " 0")[0], &t)
	return time.Now().Unix()-t <= 10
}

// openWindow shows the page as an app window (Chrome's --app mode: no tabs or address bar) when a Chromium
// browser is installed, else in the default browser.
func openWindow(url string) error {
	if isMac() {
		for _, b := range allBrowsers() {
			if b.installed() {
				if exec.Command("open", "-na", b.App, "--args", "--app="+url, "--window-size=480,820").Run() == nil {
					return nil
				}
			}
		}
	}
	return openPath(url)
}
