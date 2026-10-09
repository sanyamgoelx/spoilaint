package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// gentleCmd runs a background command: on macOS through taskpolicy -b (background QoS: efficiency cores,
// throttled disk), so syncing a film never makes playback stutter; elsewhere through nice.
func gentleCmd(ctx context.Context, name string, args ...string) *exec.Cmd {
	if runtime.GOOS == "darwin" {
		if _, err := exec.LookPath("/usr/sbin/taskpolicy"); err == nil {
			return exec.CommandContext(ctx, "/usr/sbin/taskpolicy", append([]string{"-b", name}, args...)...)
		}
	}
	if p, err := exec.LookPath("nice"); err == nil {
		return exec.CommandContext(ctx, p, append([]string{"-n", "19", name}, args...)...)
	}
	return exec.CommandContext(ctx, name, args...)
}

func probe(video string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, _ := gentleCmd(ctx, ffmpegPath(), "-hide_banner", "-nostdin", "-i", video).CombinedOutput()
	return string(out)
}

var (
	durationRe = regexp.MustCompile(`Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`)
	audioRe    = regexp.MustCompile(`Stream #\d+:\d+.*?: Audio: (.*)`)
	surroundRe = regexp.MustCompile(`\b[5-7]\.1\b`)
)

// panFor: dialogue lives in the centre channel of 5.1/7.1; in stereo it sits in the middle.
func panFor(probe string) string {
	if m := audioRe.FindStringSubmatch(probe); m != nil {
		if surroundRe.MatchString(m[1]) {
			return "pan=mono|c0=FC"
		}
		if strings.Contains(m[1], "mono") {
			return "anull"
		}
	}
	return "pan=mono|c0=0.5*FL+0.5*FR"
}

func durationOf(probe string) float64 {
	m := durationRe.FindStringSubmatch(probe)
	if m == nil {
		return 0
	}
	var h, mi int
	var s float64
	fmt.Sscan(m[1], &h)
	fmt.Sscan(m[2], &mi)
	fmt.Sscan(m[3], &s)
	return float64(h*3600+mi*60) + s
}

func s16ToFloat(b []byte, dst []float32) int {
	n := len(b) / 2
	for i := 0; i < n; i++ {
		dst[i] = float32(int16(uint16(b[2*i])|uint16(b[2*i+1])<<8)) / 32768
	}
	return n
}

// readClip: a stretch of the film's dialogue at 16 kHz mono (nil if it can't be read).
func readClip(video, pan string, startMs, durMs int) []float32 {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := gentleCmd(ctx, ffmpegPath(), "-nostdin", "-v", "error", "-ss", fmt.Sprintf("%.3f", float64(startMs)/1000), "-t", fmt.Sprintf("%.3f", float64(durMs)/1000),
		"-i", video, "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", pan+",aresample=16000", "-ac", "1", "-f", "s16le", "-")
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	f := make([]float32, len(out)/2)
	s16ToFloat(out, f)
	return f
}

// pcmStream decodes the dialogue from fromMs (for durMs, or to the end when durMs <= 0). read fills dst like
// tray/Core.cs does: up to len(dst) samples, fewer only at the end.
type pcmStream struct {
	cmd    *exec.Cmd
	r      *bufio.Reader
	buf    []byte
	stderr bytes.Buffer
	cancel context.CancelFunc
}

func openPcm(video, pan string, fromMs, toMs int) (*pcmStream, error) {
	ctx, cancel := context.WithCancel(context.Background())
	args := []string{"-nostdin", "-v", "error"}
	if fromMs > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", float64(fromMs)/1000))
	}
	if toMs > 0 {
		args = append(args, "-t", fmt.Sprintf("%.3f", float64(toMs-fromMs)/1000))
	}
	args = append(args, "-i", video, "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", pan+",aresample=16000", "-ac", "1", "-f", "s16le", "-")
	cmd := gentleCmd(ctx, ffmpegPath(), args...)
	p := &pcmStream{cmd: cmd, cancel: cancel, buf: make([]byte, 32000)}
	cmd.Stderr = &p.stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	p.r = bufio.NewReaderSize(out, 64*1024)
	return p, nil
}

func (p *pcmStream) read(dst []float32) int {
	want := len(dst) * 2
	if want > len(p.buf) {
		want = len(p.buf)
	}
	got, _ := io.ReadFull(p.r, p.buf[:want])
	return s16ToFloat(p.buf[:got-got%2], dst)
}

func (p *pcmStream) close() string {
	p.cancel()
	p.cmd.Wait()
	return p.stderr.String()
}
