// VLC's background work, as in tray/Core.cs (JobRunner): VLC's script writes job files into jobsDir();
// this runs them and writes the same outputs the Windows app does, so vlc/spoilaint.lua reads them the same way.
package main

import (
	"bufio"
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Job struct {
	Name, ID, Task, Video, Dir, Base, Title, Out string
	Pos                                          int
	Progress                                     float64 // 0..1, -1 unknown
	Phase                                        string
	SecondsLeft                                  float64
	Offset                                       int
	Scale                                        float64
}

func parseJob(file string) *Job {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	d := map[string]string{}
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimRight(l, "\r")
		if eq := strings.Index(l, "="); eq > 0 {
			d[l[:eq]] = l[eq+1:]
		}
	}
	if _, ok := d["end"]; !ok {
		return nil
	}
	j := &Job{Name: filepath.Base(file), ID: d["id"], Task: d["task"], Video: d["video"], Dir: d["dir"], Base: d["base"],
		Title: d["title"], Out: d["out"], Progress: -1, Phase: "Waiting", Scale: 1, SecondsLeft: -1}
	j.Pos, _ = strconv.Atoi(d["pos"])
	if j.Task == "" || j.Video == "" {
		return nil
	}
	if j.Title == "" {
		j.Title = j.Video
	}
	j.Title = strings.TrimSuffix(filepath.Base(j.Title), filepath.Ext(j.Title))
	return j
}

type RecentItem struct {
	When   time.Time `json:"when"`
	Base   string    `json:"-"`
	Title  string    `json:"title"`
	OK     bool      `json:"ok"`
	Detail string    `json:"detail"`
}

type Runner struct {
	mu       sync.Mutex
	current  *Job
	recent   []RecentItem
	seen     map[string]bool
	speech   chan *Job
	extract  chan *Job
	OnFinish func(j *Job, ok bool, msg string)
}

func NewRunner() *Runner {
	r := &Runner{seen: map[string]bool{}, speech: make(chan *Job, 64), extract: make(chan *Job, 64)}
	r.recent = loadRecent()
	return r
}

func (r *Runner) Start() {
	os.MkdirAll(jobsDir(), 0o755)
	go func() {
		for {
			r.heartbeat()
			time.Sleep(2 * time.Second)
		}
	}()
	go func() {
		for {
			r.scan()
			time.Sleep(700 * time.Millisecond)
		}
	}()
	go r.worker(r.speech)
	go r.worker(r.extract)
}

func (r *Runner) Current() *Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current == nil {
		return nil
	}
	c := *r.current
	return &c
}

func (r *Runner) Recent() []RecentItem {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RecentItem(nil), r.recent...)
}

func (r *Runner) update(j *Job, f func(j *Job)) {
	r.mu.Lock()
	f(j)
	r.mu.Unlock()
}

// helper.alive: unix time, plus "align" when the speech model can run. Swapped in whole, never half-written.
func (r *Runner) heartbeat() {
	s := strconv.FormatInt(time.Now().Unix(), 10)
	if alignAvailable() {
		s += " align"
	}
	tmp := aliveFile() + ".tmp"
	if os.WriteFile(tmp, []byte(s), 0o644) == nil {
		os.Rename(tmp, aliveFile())
	}
}

func (r *Runner) StopHeartbeat() { os.Remove(aliveFile()) }

func (r *Runner) scan() {
	files, _ := filepath.Glob(filepath.Join(jobsDir(), "*.job"))
	for _, f := range files {
		j := parseJob(f)
		if j == nil {
			continue
		}
		if os.Remove(f) != nil {
			continue // claim it
		}
		key := j.Name + "|" + j.ID
		r.mu.Lock()
		dup := r.seen[key]
		r.seen[key] = true
		r.mu.Unlock()
		if dup {
			continue
		}
		if j.Task == "extract" {
			r.extract <- j
		} else {
			r.speech <- j
		}
	}
	results, _ := filepath.Glob(filepath.Join(jobsDir(), "*.result"))
	for _, f := range results {
		b, err := os.ReadFile(f)
		if err != nil || !strings.Contains(string(b), "end=1") {
			continue
		}
		os.Remove(f)
		kv := map[string]string{}
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimRight(l, "\r")
			if eq := strings.Index(l, "="); eq > 0 {
				kv[l[:eq]] = l[eq+1:]
			}
		}
		if kv["base"] == "" {
			continue
		}
		synced, _ := strconv.Atoi(kv["synced"])
		count, _ := strconv.Atoi(kv["count"])
		title := kv["title"]
		if title == "" {
			title = kv["base"]
		}
		title = strings.TrimSuffix(filepath.Base(title), filepath.Ext(title))
		detail := "Synced to speech"
		if count > 0 {
			detail = fmt.Sprintf("%d of %d lines matched to speech", synced, count)
		}
		r.addRecent(kv["base"], title, synced > 0, detail, true)
	}
}

// addRecent puts a film at the top of the list. A result from VLC (merge) updates a film synced in the last
// 12 hours and keeps its proper title.
func (r *Runner) addRecent(base, title string, ok bool, detail string, merge bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var keep []RecentItem
	for _, it := range r.recent {
		if it.Base == base {
			if merge && time.Since(it.When) < 12*time.Hour {
				title = it.Title
			}
			continue
		}
		keep = append(keep, it)
	}
	r.recent = append([]RecentItem{{When: time.Now(), Base: base, Title: title, OK: ok, Detail: detail}}, keep...)
	if len(r.recent) > 20 {
		r.recent = r.recent[:20]
	}
	saveRecent(r.recent)
}

func (r *Runner) worker(q chan *Job) {
	for j := range q {
		ok, msg := false, ""
		func() {
			defer func() {
				if e := recover(); e != nil {
					msg = fmt.Sprint(e)
				}
			}()
			switch j.Task {
			case "extract":
				ok, msg = runExtract(j)
			case "align":
				r.mu.Lock()
				r.current = j
				r.mu.Unlock()
				ok, msg = r.runAlign(j)
			default:
				r.mu.Lock()
				r.current = j
				r.mu.Unlock()
				ok, msg = r.runSpeech(j)
			}
		}()
		if j.Task != "extract" {
			r.mu.Lock()
			r.current = nil
			r.mu.Unlock()
			if ok {
				r.addRecent(j.Base, j.Title, true, "Synced to speech · "+msg, false)
			} else {
				r.addRecent(j.Base, j.Title, false, "Couldn't sync: "+msg+". Using the estimate.", false)
			}
		}
		if r.OnFinish != nil {
			r.OnFinish(j, ok, msg)
		}
	}
}

// Must stay identical to FILTER_TAIL in vlc/spoilaint.lua.
const filterTail = "aresample=16000,highpass=f=250,lowpass=f=3500,asetnsamples=n=320:p=0," +
	"astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level," +
	"ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file="

// runSpeech: the dialogue's loudness through the film (used when the speech model isn't available).
func (r *Runner) runSpeech(j *Job) (bool, string) {
	tmp := j.Base + ".speech.tmp"
	final := filepath.Join(j.Dir, j.Base+".speech.txt")
	done := filepath.Join(j.Dir, j.Base+".speech.done")
	errF := filepath.Join(j.Dir, j.Base+".speech.err")
	r.update(j, func(j *Job) { j.Phase = "Getting ready" })
	pr := probe(j.Video)
	total := durationOf(pr)
	if !strings.Contains(pr, "Stream") {
		os.WriteFile(errF, []byte(pr), 0o644)
		os.WriteFile(done, []byte("done"), 0o644)
		return false, "ffmpeg couldn't read the file"
	}
	pan := panFor(pr)
	r.update(j, func(j *Job) { j.Phase = "Listening to the dialogue"; j.Progress = 0 })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd := gentleCmd(ctx, ffmpegPath(), "-nostdin", "-v", "error", "-y", "-progress", "pipe:1", "-nostats", "-i", j.Video,
		"-map", "0:a:0", "-vn", "-sn", "-dn", "-af", pan+","+filterTail+tmp, "-f", "null", "-")
	cmd.Dir = j.Dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, _ := cmd.StdoutPipe()
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		return false, err.Error()
	}
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		l := sc.Text()
		if total <= 0 || !(strings.HasPrefix(l, "out_time_us=") || strings.HasPrefix(l, "out_time_ms=")) {
			continue
		}
		us, err := strconv.ParseInt(l[12:], 10, 64)
		if err != nil || us < 0 {
			continue
		}
		p := math.Min(1, float64(us)/1e6/total)
		el := time.Since(t0).Seconds()
		r.update(j, func(j *Job) {
			j.Progress = p
			if p > 0.03 {
				j.SecondsLeft = el / p * (1 - p)
			}
		})
	}
	cmd.Wait()
	os.WriteFile(errF, []byte(stderr.String()), 0o644)
	if exists(filepath.Join(j.Dir, tmp)) {
		os.Remove(final)
		os.Rename(filepath.Join(j.Dir, tmp), final)
	}
	os.WriteFile(done, []byte("done"), 0o644)
	r.update(j, func(j *Job) { j.Progress = 1; j.Phase = "Done" })
	if st, err := os.Stat(final); err == nil && st.Size() > 100 {
		return true, fmt.Sprintf("%.0f s of audio in %.0f s", total, time.Since(t0).Seconds())
	}
	return false, "No speech track found"
}

// background QoS for this process while it aligns (macOS), so a sync is never felt.
func setBackground(on bool) {
	if runtime.GOOS != "darwin" {
		return
	}
	const prioDarwinProcess, prioDarwinBG = 4, 0x1000
	v := 0
	if on {
		v = prioDarwinBG
	}
	syscall.Setpriority(prioDarwinProcess, 0, v)
}

// runAlign matches every subtitle word to the moment it is spoken (speech model). Words file in j.Out.
func (r *Runner) runAlign(j *Job) (ok bool, msg string) {
	resultPath := filepath.Join(j.Dir, j.Base+".align.txt")
	done := filepath.Join(j.Dir, j.Base+".align.done")
	errF := filepath.Join(j.Dir, j.Base+".align.err")
	os.Remove(done)
	os.Remove(errF)
	t0 := time.Now()
	setBackground(true)
	defer setBackground(false)
	fail := func(err error) (bool, string) {
		f, _ := os.OpenFile(errF, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if f != nil {
			fmt.Fprintln(f, err)
			f.Close()
		}
		os.WriteFile(done, []byte("fail\r\nid="+j.ID+"\r\n"), 0o644)
		return false, err.Error()
	}
	r.update(j, func(j *Job) { j.Phase = "Getting ready" })
	lines, hash, err := readWords(j.Out)
	if err != nil {
		return fail(err)
	}
	pr := probe(j.Video)
	if !strings.Contains(pr, "Audio:") {
		return fail(fmt.Errorf("no sound track found"))
	}
	if err := loadOrt(ortPath()); err != nil {
		return fail(err)
	}
	tok, err := NewTokenizer(filepath.Join(modelDir(), "tokens.txt"))
	if err != nil {
		return fail(err)
	}
	threads := runtime.NumCPU() / 2
	if threads > 4 {
		threads = 4
	}
	if threads < 1 {
		threads = 1
	}
	model, err := NewOrt(filepath.Join(modelDir(), "model.int8.onnx"), threads)
	if err != nil {
		return fail(err)
	}
	defer model.Close()
	pan := panFor(pr)
	r.update(j, func(j *Job) { j.Phase = "Checking the subtitles are in sync"; j.Progress = 0 })
	offset, scale := detectOffset(lines, func(st, du int) []float32 { return readClip(j.Video, pan, st, du) }, model, tok,
		func(f float32) { r.update(j, func(j *Job) { j.Progress = float64(f) }) })
	if offset != 0 || scale != 1 {
		shiftLines(lines, offset, scale)
	}
	r.update(j, func(j *Job) { j.Offset = offset; j.Scale = scale })
	// Start where the viewer is: that stretch first, a partial result once 5 minutes past it are matched, then the rest.
	pos := j.Pos - 10000
	if pos < 60000 {
		pos = 0
	}
	var first, rest []*LineWords
	for _, l := range lines {
		if l.Start >= pos {
			first = append(first, l)
		} else {
			rest = append(rest, l)
		}
	}
	partPath := filepath.Join(j.Dir, j.Base+".align.part.txt")
	partDone := filepath.Join(j.Dir, j.Base+".align.part.done")
	os.Remove(partDone)
	published := false
	total, before := len(lines), 0
	publish := func() {
		writeResult(partPath, hash, lines, offset, scale)
		os.WriteFile(partDone, []byte("ok\r\nid="+j.ID+"\r\n"), 0o644)
	}
	r.update(j, func(j *Job) { j.Phase = "Matching words to speech"; j.Progress = 0 })
	pass := func(subset []*LineWords, isFirst bool, fromMs, toMs int) error {
		if len(subset) == 0 {
			return nil
		}
		base := before
		st, err := openPcm(j.Video, pan, fromMs, toMs)
		if err != nil {
			return err
		}
		err = alignRun(subset, st.read, model, tok, func(f float32) {
			all := (float64(base) + float64(f)*float64(len(subset))) / float64(total)
			el := time.Since(t0).Seconds()
			r.update(j, func(j *Job) {
				j.Progress = all
				if all > 0.03 {
					j.SecondsLeft = el / all * (1 - all)
				}
			})
		}, int64(fromMs), func(lineStart int) {
			if !published && isFirst && lineStart > pos+300000 {
				published = true
				publish()
			}
		})
		if e := st.close(); e != "" {
			f, _ := os.OpenFile(errF, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
			if f != nil {
				f.WriteString(e)
				f.Close()
			}
		}
		before += len(subset)
		return err
	}
	if err := pass(first, true, pos, -1); err != nil {
		return fail(err)
	}
	if len(rest) > 0 && !published && pos > 0 {
		publish()
	}
	restEnd := pos
	for _, l := range rest {
		if l.End > restEnd {
			restEnd = l.End
		}
	}
	if err := pass(rest, false, 0, restEnd+1500); err != nil {
		return fail(err)
	}
	if err := writeResult(resultPath, hash, lines, offset, scale); err != nil {
		return fail(err)
	}
	n := 0
	for _, l := range lines {
		if l.Confidence >= minConfidence {
			n++
		}
	}
	os.WriteFile(done, []byte("ok\r\nid="+j.ID+"\r\n"), 0o644)
	r.update(j, func(j *Job) { j.Progress = 1; j.Phase = "Done" })
	msg = fmt.Sprintf("%d of %d lines matched in %.0f s", n, len(lines), time.Since(t0).Seconds())
	if scale != 1 {
		msg += " · subtitles drifted (made for another frame rate), fixed"
	} else if offset != 0 {
		dir := "late"
		if offset > 0 {
			dir = "early"
		}
		msg += fmt.Sprintf(" · subtitles were %.1f s %s, fixed", math.Abs(float64(offset))/1000, dir)
	}
	return n > 0, msg
}

var (
	textCodecs = map[string]bool{"subrip": true, "srt": true, "ass": true, "ssa": true, "mov_text": true, "webvtt": true, "text": true}
	subRe      = regexp.MustCompile(`Stream #0:(\d+)(?:\((\w*)\))?[^:]*: Subtitle: (\w+)`)
)

// runExtract: the text subtitles inside a film (.mkv), English first, forced tracks last (as the VLC script picks).
func runExtract(j *Job) (bool, string) {
	marker := j.Out + ".done"
	pr := probe(j.Video)
	best, bestScore := "", -1
	for _, line := range strings.Split(pr, "\n") {
		m := subRe.FindStringSubmatch(line)
		if m == nil || !textCodecs[m[3]] {
			continue
		}
		s := 1
		if m[2] == "eng" || m[2] == "en" {
			s += 10
		}
		if strings.Contains(strings.ToLower(line), "forced") {
			s -= 5
		}
		if s > bestScore {
			best, bestScore = m[1], s
		}
	}
	ok := false
	if best != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		gentleCmd(ctx, ffmpegPath(), "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", j.Video, "-map", "0:"+best, "-c:s", "srt", j.Out).Run()
		cancel()
		if st, err := os.Stat(j.Out); err == nil && st.Size() > 0 {
			ok = true
		}
	}
	okS := "0"
	if ok {
		okS = "1"
	}
	os.WriteFile(marker, []byte("id="+j.ID+"\r\nok="+okS+"\r\n"), 0o644)
	switch {
	case best == "":
		return false, "no text subtitles inside"
	case ok:
		return true, "subtitles read"
	}
	return false, "couldn't read subtitles"
}

func loadRecent() []RecentItem {
	b, err := os.ReadFile(recentFile())
	if err != nil {
		return nil
	}
	var res []RecentItem
	for _, l := range strings.Split(string(b), "\n") {
		p := strings.Split(strings.TrimRight(l, "\r"), "\t")
		if len(p) < 5 {
			continue
		}
		ms, err := strconv.ParseInt(p[0], 10, 64)
		if err != nil {
			continue
		}
		res = append(res, RecentItem{When: time.UnixMilli(ms), Base: p[1], Title: p[2], OK: p[3] == "1", Detail: p[4]})
	}
	return res
}

func saveRecent(list []RecentItem) {
	clean := func(s string) string { return strings.NewReplacer("\t", " ", "\n", " ", "\r", " ").Replace(s) }
	var sb strings.Builder
	for _, it := range list {
		ok := "0"
		if it.OK {
			ok = "1"
		}
		sb.WriteString(fmt.Sprintf("%d\t%s\t%s\t%s\t%s\n", it.When.UnixMilli(), it.Base, clean(it.Title), ok, clean(it.Detail)))
	}
	os.MkdirAll(dataDir(), 0o755)
	os.WriteFile(recentFile(), []byte(sb.String()), 0o644)
}

// notify shows a macOS notification (best effort).
func notify(title, text string) {
	if !isMac() {
		return
	}
	q := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) }
	exec.Command("osascript", "-e", `display notification "`+q(text)+`" with title "`+q(title)+`"`).Run()
}
