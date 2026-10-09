// macOS setup: copying Spoilaint's parts out of the app bundle, VLC's automatic mode, the launch agent,
// and the browsers (which are installed, opening their extensions page, whether Spoilaint is in them).
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const agentLabel = "app.spoilaint.helper"

func agentPlist() string {
	return filepath.Join(home(), "Library", "LaunchAgents", agentLabel+".plist")
}

// ---------------------------------------------------------------- install from the app bundle

type InstallState struct {
	Running bool     `json:"running"`
	Percent float64  `json:"percent"`
	Step    string   `json:"step"`
	Done    bool     `json:"done"`
	Error   string   `json:"error,omitempty"`
	Flags   []string `json:"flags,omitempty"` // vlcrunning, novlc, vlcerror
}

var (
	installMu sync.Mutex
	install   InstallState
)

func installStatus() InstallState        { installMu.Lock(); defer installMu.Unlock(); return install }
func setInstall(f func(s *InstallState)) { installMu.Lock(); f(&install); installMu.Unlock() }

func bundleRes() string {
	b, _ := os.ReadFile(filepath.Join(dataDir(), "bundle.txt"))
	return strings.TrimSpace(string(b))
}

func readVersion(p string) string { b, _ := os.ReadFile(p); return strings.TrimSpace(string(b)) }

// installedVersion: the version whose model, extension and VLC script are in place ("" = not set up yet).
func installedVersion() string { return readVersion(filepath.Join(dataDir(), "VERSION")) }
func bundleVersion() string {
	if r := bundleRes(); r != "" {
		return readVersion(filepath.Join(r, "VERSION"))
	}
	return ""
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	os.MkdirAll(filepath.Dir(dst), 0o755)
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	return os.Rename(tmp, dst)
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(t, 0o755)
		}
		return copyFile(p, t, info.Mode().Perm()|0o600)
	})
}

// runInstall copies everything from the bundle and turns on VLC's automatic mode. Runs in the background;
// the window follows installStatus().
func runInstall() {
	setInstall(func(s *InstallState) { *s = InstallState{Running: true, Step: "Getting ready"} })
	res := bundleRes()
	fail := func(err error) {
		setInstall(func(s *InstallState) { s.Running = false; s.Error = err.Error() })
	}
	if res == "" || !exists(res) {
		fail(fmt.Errorf("open Spoilaint from the Applications folder to finish setting up"))
		return
	}
	step := func(p float64, t string) { setInstall(func(s *InstallState) { s.Percent = p; s.Step = t }) }
	type part struct {
		pct  float64
		text string
		do   func() error
	}
	parts := []part{
		{8, "Copying FFmpeg, for film sound and .mkv subtitles", func() error {
			return copyFile(filepath.Join(res, "bin", "ffmpeg"), filepath.Join(binDir(), "ffmpeg"), 0o755)
		}},
		{30, "Copying the speech model", func() error {
			if err := copyTree(filepath.Join(res, "speech-model"), modelDir()); err != nil {
				return err
			}
			return copyFile(filepath.Join(res, "lib", "libonnxruntime.dylib"), ortPath(), 0o644)
		}},
		{60, "Copying the browser extension", func() error {
			os.RemoveAll(extensionDir() + ".old")
			if exists(extensionDir()) {
				os.Rename(extensionDir(), extensionDir()+".old")
			}
			err := copyTree(filepath.Join(res, "extension"), extensionDir())
			os.RemoveAll(extensionDir() + ".old")
			return err
		}},
		{85, "Turning on VLC's automatic mode", func() error {
			if err := copyFile(filepath.Join(res, "vlc", "spoilaint.lua"), vlcScript(), 0o644); err != nil {
				return err
			}
			return configureVLC(false)
		}},
	}
	var flags []string
	for _, p := range parts {
		step(p.pct, p.text)
		if err := p.do(); err != nil {
			if strings.HasPrefix(p.text, "Turning on VLC") {
				flags = append(flags, "vlcerror")
				continue
			}
			fail(err)
			return
		}
	}
	if !vlcInstalled() {
		flags = append(flags, "novlc")
	} else if vlcRunning() {
		flags = append(flags, "vlcrunning")
	}
	os.WriteFile(filepath.Join(dataDir(), "VERSION"), []byte(bundleVersion()), 0o644)
	if filepath.Base(res) == "pending" {
		os.RemoveAll(res) // everything is in place now
	}
	alignAvailMu.Lock()
	alignAvail = -1 // the model may have just arrived
	alignAvailMu.Unlock()
	setInstall(func(s *InstallState) {
		s.Running = false
		s.Done = true
		s.Percent = 100
		s.Step = "Done"
		s.Flags = flags
	})
}

// ---------------------------------------------------------------- VLC

func vlcInstalled() bool {
	if !isMac() {
		_, err := exec.LookPath("vlc")
		return err == nil
	}
	for _, p := range []string{"/Applications/VLC.app", filepath.Join(home(), "Applications", "VLC.app")} {
		if exists(p) {
			return true
		}
	}
	return false
}

func vlcRunning() bool {
	name := "vlc"
	if isMac() {
		name = "VLC"
	}
	return exec.Command("pgrep", "-x", name).Run() == nil
}

func vlcConfigured() bool {
	if !exists(vlcScript()) {
		return false
	}
	b, err := os.ReadFile(vlcRc())
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) == "lua-intf=spoilaint" {
			return true
		}
	}
	return false
}

// configureVLC adds (or removes) the two vlcrc lines that start Spoilaint with VLC, like installer/configure-vlc.ps1.
func configureVLC(uninstall bool) error {
	os.MkdirAll(vlcConfigDir(), 0o755)
	var lines []string
	if b, err := os.ReadFile(vlcRc()); err == nil {
		backup := vlcRc() + ".before-spoilaint"
		if !exists(backup) {
			os.WriteFile(backup, b, 0o644)
		}
		lines = strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	}
	var extra, out []string
	for _, l := range lines {
		switch {
		case strings.HasPrefix(l, "extraintf="):
			for _, e := range strings.Split(l[10:], ":") {
				if e != "" && e != "luaintf" {
					extra = append(extra, e)
				}
			}
		case strings.HasPrefix(l, "lua-intf="), strings.HasPrefix(l, "# Spoilaint"):
		default:
			out = append(out, l)
		}
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	if !uninstall {
		extra = append(extra, "luaintf")
		out = append(out, "# Spoilaint: spoiler-free subtitles (remove these two lines to turn it off)",
			"extraintf="+strings.Join(extra, ":"), "lua-intf=spoilaint")
	} else if len(extra) > 0 {
		out = append(out, "extraintf="+strings.Join(extra, ":"))
	}
	if err := os.WriteFile(vlcRc(), []byte(strings.Join(out, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	if uninstall {
		os.Remove(vlcIni())
		return nil
	}
	if !exists(vlcIni()) {
		font := "Helvetica Neue"
		if !isMac() {
			font = "Sans"
		}
		os.MkdirAll(vlcUserData(), 0o755)
		return os.WriteFile(vlcIni(), []byte(strings.Join([]string{
			"# Spoilaint settings for VLC. Restart VLC after changing them.",
			"mode=word", "# word | chunk | off",
			"lag=0", "# milliseconds; 0 = on time, higher = later. Lines not matched to speech get +300 by themselves",
			"theme=amber", "# amber | dark | indigo | green",
			"highlight=1", "size=64", "box=0", "font=" + font,
			"ffmpeg=" + filepath.Join(binDir(), "ffmpeg"), ""}, "\n")), 0o644)
	}
	return nil
}

// ---------------------------------------------------------------- launch agent

func writeAgent(runAtLoad bool) error {
	exe := filepath.Join(binDir(), "spoilaint-helper")
	// KeepAlive (restart after a crash, not after Quit) also starts the agent at login, so it's only set when
	// "Start when I log in" is on; otherwise VLC or the app start it when needed.
	ral, keep := "false", ""
	if runAtLoad {
		ral = "true"
		keep = "\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + agentLabel + `</string>
  <key>ProgramArguments</key><array><string>` + xmlEsc(exe) + `</string><string>serve</string></array>
  <key>RunAtLoad</key><` + ral + `/>` + keep + `
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>` + xmlEsc(filepath.Join(dataDir(), "helper.log")) + `</string>
</dict>
</plist>
`
	os.MkdirAll(filepath.Dir(agentPlist()), 0o755)
	return os.WriteFile(agentPlist(), []byte(plist), 0o644)
}

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func agentRunAtLoad() bool {
	b, _ := os.ReadFile(agentPlist())
	return strings.Contains(string(b), "<key>RunAtLoad</key><true/>")
}

func uid() string { return strconv.Itoa(os.Getuid()) }

// (re)starts the agent with the plist on disk.
func restartAgent() {
	svc := "gui/" + uid() + "/" + agentLabel
	exec.Command("launchctl", "bootout", svc).Run()
	// bootout returns before the old one is gone; bootstrap fails ("5: Input/output error") until it is
	for i := 0; i < 25 && exec.Command("launchctl", "print", svc).Run() == nil; i++ {
		time.Sleep(200 * time.Millisecond)
	}
	ok := false
	for i := 0; i < 4 && !ok; i++ {
		ok = exec.Command("launchctl", "bootstrap", "gui/"+uid(), agentPlist()).Run() == nil
		if !ok {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if !ok {
		exec.Command("launchctl", "load", "-w", agentPlist()).Run() // older macOS
	}
	exec.Command("launchctl", "kickstart", svc).Run()
}

// ---------------------------------------------------------------- browsers

type Browser struct {
	Key, Name, App, Scheme, UserData string
}

type BrowserState struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	FoundAt   string `json:"foundAt,omitempty"`
	Ours      bool   `json:"ours"`
	URL       string `json:"url"`
}

func allBrowsers() []Browser {
	sup := filepath.Join(home(), "Library", "Application Support")
	if !isMac() {
		sup = filepath.Join(home(), ".config")
	}
	return []Browser{
		{"chrome", "Chrome", "Google Chrome", "chrome://", filepath.Join(sup, "Google", "Chrome")},
		{"brave", "Brave", "Brave Browser", "brave://", filepath.Join(sup, "BraveSoftware", "Brave-Browser")},
		{"edge", "Edge", "Microsoft Edge", "edge://", filepath.Join(sup, "Microsoft Edge")},
	}
}

func (b Browser) installed() bool {
	if !isMac() {
		return exists(b.UserData)
	}
	for _, p := range []string{"/Applications/" + b.App + ".app", filepath.Join(home(), "Applications", b.App+".app")} {
		if exists(p) {
			return true
		}
	}
	return false
}

func browserStates() []BrowserState {
	var res []BrowserState
	for _, b := range allBrowsers() {
		st := BrowserState{Key: b.Key, Name: b.Name, Installed: b.installed(), URL: b.Scheme + "extensions/"}
		if st.Installed {
			st.FoundAt = findSpoilaint(b)
			st.Ours = st.FoundAt != "" && samePath(st.FoundAt, extensionDir())
		}
		res = append(res, st)
	}
	return res
}

func samePath(a, b string) bool {
	ca, _ := filepath.EvalSymlinks(a)
	cb, _ := filepath.EvalSymlinks(b)
	if ca == "" {
		ca = a
	}
	if cb == "" {
		cb = b
	}
	return strings.EqualFold(strings.TrimRight(ca, "/"), strings.TrimRight(cb, "/"))
}

var (
	prefCacheMu sync.Mutex
	prefCache   = map[string]struct {
		t     time.Time
		found string
	}{}
	prefPathRe = regexp.MustCompile(`"path"\s*:\s*"((?:[^"\\]|\\.)*)"`)
	nameRe     = regexp.MustCompile(`(?i)"name"\s*:\s*"Spoilaint`)
)

// findSpoilaint: where a Spoilaint extension is loaded in this browser (any profile), or "". Same rule as
// tray/Browsers.cs: any extension "path" whose manifest.json is named Spoilaint.
func findSpoilaint(b Browser) string {
	dirs, _ := os.ReadDir(b.UserData)
	for _, d := range dirs {
		if !d.IsDir() || (d.Name() != "Default" && !strings.HasPrefix(d.Name(), "Profile ")) {
			continue
		}
		prof := filepath.Join(b.UserData, d.Name())
		for _, f := range []string{"Secure Preferences", "Preferences"} {
			if hit := scanPrefs(filepath.Join(prof, f), prof); hit != "" {
				return hit
			}
		}
	}
	return ""
}

func scanPrefs(file, prof string) string {
	st, err := os.Stat(file)
	if err != nil {
		return ""
	}
	prefCacheMu.Lock()
	c, ok := prefCache[file]
	prefCacheMu.Unlock()
	if ok && c.t.Equal(st.ModTime()) {
		return c.found
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	found := ""
	for _, m := range prefPathRe.FindAllStringSubmatch(string(b), -1) {
		var p string
		if json.Unmarshal([]byte(`"`+m[1]+`"`), &p) != nil || p == "" || len(p) > 400 {
			continue
		}
		full := p
		if !filepath.IsAbs(p) {
			full = filepath.Join(prof, "Extensions", p)
		}
		mf := filepath.Join(full, "manifest.json")
		if fi, err := os.Stat(mf); err == nil && fi.Size() < 200000 {
			if t, err := os.ReadFile(mf); err == nil && nameRe.Match(t) {
				found = full
				break
			}
		}
	}
	prefCacheMu.Lock()
	prefCache[file] = struct {
		t     time.Time
		found string
	}{st.ModTime(), found}
	prefCacheMu.Unlock()
	return found
}

func browserByKey(k string) (Browser, bool) {
	for _, b := range allBrowsers() {
		if b.Key == k {
			return b, true
		}
	}
	return Browser{}, false
}

// copyToClipboard puts text on the clipboard (pbcopy on macOS).
func copyToClipboard(s string) error {
	name, args := "pbcopy", []string{}
	if !isMac() {
		name, args = "xclip", []string{"-selection", "clipboard"}
	}
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "LANG=en_US.UTF-8", "LC_CTYPE=UTF-8") // launchd gives no locale: keep non-English letters
	cmd.Stdin = strings.NewReader(s)
	return cmd.Run()
}

// openExtensionsPage: a new browser window showing chrome://extensions (brave://, edge://). Pages and `open`
// can't load these addresses, but the browsers' AppleScript can set a tab's address to one.
func openExtensionsPage(b Browser) error {
	if !isMac() {
		return fmt.Errorf("only on macOS")
	}
	script := `tell application "` + b.App + `"
  activate
  make new window
  set URL of active tab of front window to "` + b.Scheme + `extensions/"
end tell`
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// revealInFinder shows the extension folder selected in Finder, ready to drag onto the extensions page.
func revealInFinder(p string) error {
	if !isMac() {
		return nil
	}
	return exec.Command("open", "-R", p).Run()
}
