// The app window: a local page (ui/) served on 127.0.0.1, plus a small JSON API for it.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed ui
var uiFiles embed.FS

const basePort = 47821

func portFile() string { return filepath.Join(dataDir(), "port") }

// Ini: key=value file that keeps comments and unknown lines (same as tray/Core.cs).
type Ini struct {
	path  string
	lines []string
}

func loadIni(p string) *Ini {
	i := &Ini{path: p}
	if b, err := os.ReadFile(p); err == nil {
		i.lines = strings.Split(strings.TrimRight(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n"), "\n")
	}
	return i
}
func (i *Ini) find(k string) int {
	for n, l := range i.lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "#") {
			continue
		}
		if eq := strings.Index(t, "="); eq > 0 && strings.TrimSpace(t[:eq]) == k {
			return n
		}
	}
	return -1
}
func (i *Ini) Get(k, def string) string {
	if n := i.find(k); n >= 0 {
		return strings.TrimSpace(i.lines[n][strings.Index(i.lines[n], "=")+1:])
	}
	return def
}
func (i *Ini) Set(k, v string) {
	if n := i.find(k); n >= 0 {
		i.lines[n] = k + "=" + v
	} else {
		i.lines = append(i.lines, k+"="+v)
	}
}
func (i *Ini) Save() error {
	os.MkdirAll(filepath.Dir(i.path), 0o755)
	return os.WriteFile(i.path, []byte(strings.Join(i.lines, "\n")+"\n"), 0o644)
}

type Settings struct {
	Mode      string `json:"mode"`
	Lag       int    `json:"lag"`
	Size      int    `json:"size"`
	Theme     string `json:"theme"`
	Highlight bool   `json:"highlight"`
	Box       bool   `json:"box"`
	Notify    bool   `json:"notify"`
	AtLogin   bool   `json:"atLogin"`
}

func readSettings() Settings {
	v := loadIni(vlcIni())
	a := loadIni(appIni())
	lag, _ := strconv.Atoi(v.Get("lag", "0"))
	size, _ := strconv.Atoi(v.Get("size", "64"))
	return Settings{Mode: v.Get("mode", "word"), Lag: lag, Size: size, Theme: v.Get("theme", "amber"),
		Highlight: v.Get("highlight", "1") == "1", Box: v.Get("box", "0") == "1", Notify: a.Get("notify", "1") == "1",
		AtLogin: agentRunAtLoad()}
}

func b01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func writeSettings(s Settings) {
	v := loadIni(vlcIni())
	switch s.Mode {
	case "word", "chunk", "off":
		v.Set("mode", s.Mode)
	}
	if s.Lag < -500 {
		s.Lag = -500
	}
	if s.Lag > 1500 {
		s.Lag = 1500
	}
	v.Set("lag", strconv.Itoa(s.Lag))
	if s.Size >= 40 && s.Size <= 100 {
		v.Set("size", strconv.Itoa(s.Size))
	}
	switch s.Theme {
	case "amber", "dark", "indigo", "green":
		v.Set("theme", s.Theme)
	}
	v.Set("highlight", b01(s.Highlight))
	v.Set("box", b01(s.Box))
	v.Save()
	a := loadIni(appIni())
	a.Set("notify", b01(s.Notify))
	a.Save()
	if s.AtLogin != agentRunAtLoad() {
		writeAgent(s.AtLogin) // takes effect at the next login; nothing to restart
	}
}

type Status struct {
	Version    string         `json:"version"`
	Installed  string         `json:"installed"`
	Bundle     string         `json:"bundle"`
	NeedsSetup bool           `json:"needsSetup"`
	Install    InstallState   `json:"install"`
	VLC        map[string]any `json:"vlc"`
	Browsers   []BrowserState `json:"browsers"`
	ExtDir     string         `json:"extDir"`
	Job        *Job           `json:"job"`
	Recent     []RecentItem   `json:"recent"`
	Settings   Settings       `json:"settings"`
	Align      bool           `json:"align"`
	Mac        bool           `json:"mac"`
}

func serve() error {
	os.MkdirAll(dataDir(), 0o755)
	runner := NewRunner()
	runner.OnFinish = func(j *Job, ok bool, msg string) {
		if j.Task == "extract" || !ok || loadIni(appIni()).Get("notify", "1") != "1" {
			return
		}
		notify("Synced to speech", j.Title+": words now appear exactly when they're spoken.")
	}
	runner.Start()

	mux := http.NewServeMux()
	sub, _ := fs.Sub(uiFiles, "ui")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		inst, bun := installedVersion(), bundleVersion()
		st := Status{
			Version: version, Installed: inst, Bundle: bun,
			NeedsSetup: inst == "" || (bun != "" && bun != inst), Install: installStatus(),
			VLC:      map[string]any{"installed": vlcInstalled(), "configured": vlcConfigured(), "running": vlcRunning()},
			Browsers: browserStates(), ExtDir: extensionDir(), Job: runner.Current(), Recent: runner.Recent(),
			Settings: readSettings(), Align: alignAvailable(), Mac: isMac(),
		}
		writeJSON(w, st)
	})
	post := func(path string, h func(r *http.Request) (any, error)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || !sameOrigin(r) {
				http.Error(w, "no", http.StatusForbidden)
				return
			}
			res, err := h(r)
			if err != nil {
				writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			if res == nil {
				res = map[string]any{"ok": true}
			}
			writeJSON(w, res)
		})
	}
	post("/api/install", func(r *http.Request) (any, error) {
		if !installStatus().Running {
			go runInstall()
		}
		return nil, nil
	})
	post("/api/settings", func(r *http.Request) (any, error) {
		var s Settings
		if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
			return nil, err
		}
		writeSettings(s)
		return nil, nil
	})
	post("/api/vlc/setup", func(r *http.Request) (any, error) {
		if b := bundleRes(); b != "" && exists(filepath.Join(b, "vlc", "spoilaint.lua")) {
			copyFile(filepath.Join(b, "vlc", "spoilaint.lua"), vlcScript(), 0o644)
		}
		return nil, configureVLC(false)
	})
	post("/api/browser/open", func(r *http.Request) (any, error) {
		b, ok := browserByKey(r.URL.Query().Get("b"))
		if !ok {
			return nil, fmt.Errorf("unknown browser")
		}
		copyToClipboard(extensionDir())
		return nil, openExtensionsPage(b)
	})
	post("/api/copy", func(r *http.Request) (any, error) { return nil, copyToClipboard(extensionDir()) })
	post("/api/reveal", func(r *http.Request) (any, error) { return nil, revealInFinder(extensionDir()) })
	post("/api/open-log", func(r *http.Request) (any, error) { return nil, openPath(vlcLog()) })
	post("/api/get-vlc", func(r *http.Request) (any, error) {
		return nil, openPath("https://www.videolan.org/vlc/download-macosx.html")
	})
	post("/api/uninstall", func(r *http.Request) (any, error) {
		configureVLC(true)
		os.Remove(vlcScript())
		go func() {
			time.Sleep(300 * time.Millisecond)
			runner.StopHeartbeat()
			os.Remove(agentPlist())
			os.RemoveAll(dataDir())
			exec.Command("launchctl", "bootout", "gui/"+uid()+"/"+agentLabel).Run() // stops this process
			os.Exit(0)
		}()
		return nil, nil
	})
	post("/api/quit", func(r *http.Request) (any, error) {
		go func() { time.Sleep(200 * time.Millisecond); runner.StopHeartbeat(); os.Exit(0) }()
		return nil, nil
	})

	var ln net.Listener
	var err error
	for p := basePort; p < basePort+10; p++ {
		ln, err = net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			os.WriteFile(portFile(), []byte(strconv.Itoa(p)), 0o644)
			break
		}
	}
	if ln == nil {
		return err
	}
	return http.Serve(ln, mux)
}

// Only the page itself may change things (a web page elsewhere can't post to us).
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return r.Header.Get("X-Spoilaint") == "1"
	}
	return strings.HasPrefix(o, "http://127.0.0.1:") || strings.HasPrefix(o, "http://localhost:")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
