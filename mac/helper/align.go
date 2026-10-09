// Forced alignment: finds when each subtitle word is spoken. A line-for-line port of tray/Align.cs
// (keep the two in step; bench/ctc_align.py is the reference for both).
package main

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- 80-band log-mel features (Kaldi fbank)

const (
	fbWin   = 400
	fbShift = 160
	fbNFft  = 512
	fbBins  = 80
)

var (
	fbWindow    [fbWin]float64
	fbBankStart [fbBins]int
	fbBankW     [fbBins][]float64
)

func init() {
	for i := 0; i < fbWin; i++ {
		fbWindow[i] = math.Pow(0.5-0.5*math.Cos(2*math.Pi*float64(i)/float64(fbWin-1)), 0.85)
	}
	mel := func(f float64) float64 { return 1127.0 * math.Log(1.0+f/700.0) }
	ml, mh := mel(20), mel(8000)
	delta := (mh - ml) / float64(fbBins+1)
	nf := fbNFft / 2
	for b := 0; b < fbBins; b++ {
		left, center, right := ml+float64(b)*delta, ml+float64(b+1)*delta, ml+float64(b+2)*delta
		var w []float64
		start := -1
		for k := 0; k < nf; k++ {
			m := mel(float64(k) * 16000.0 / fbNFft)
			v := 0.0
			if !(m <= left || m >= right) {
				v = math.Max(0, math.Min((m-left)/(center-left), (right-m)/(right-center)))
			}
			if v > 0 && start < 0 {
				start = k
			}
			if start >= 0 {
				w = append(w, v)
			}
		}
		if start < 0 {
			start = 0
		}
		fbBankStart[b] = start
		for len(w) > 0 && w[len(w)-1] == 0 {
			w = w[:len(w)-1]
		}
		fbBankW[b] = w
	}
}

// fbank: samples (16 kHz, -1..1) -> features [80 x T] band-major, normalised per band over the clip.
func fbank(x []float32) ([]float32, int) {
	n := len(x)
	T := (n + 80) / fbShift
	if T < 1 {
		return make([]float32, fbBins), 0
	}
	feat := make([]float32, fbBins*T)
	re := make([]float64, fbNFft)
	im := make([]float64, fbNFft)
	frame := make([]float64, fbWin)
	rows := make([]float64, T*fbBins)
	for t := 0; t < T; t++ {
		s0 := t*fbShift + 80 - 200
		mean := 0.0
		for i := 0; i < fbWin; i++ {
			j := s0 + i
			if j < 0 {
				j = -j - 1
			} else if j >= n {
				j = 2*n - j - 1
			}
			if j < 0 {
				j = 0
			}
			if j > n-1 {
				j = n - 1
			}
			frame[i] = float64(x[j]) * 32768.0
			mean += frame[i]
		}
		mean /= fbWin
		for i := 0; i < fbWin; i++ {
			frame[i] -= mean
		}
		for i := fbWin - 1; i > 0; i-- {
			frame[i] -= 0.97 * frame[i-1]
		}
		frame[0] -= 0.97 * frame[0]
		for i := 0; i < fbNFft; i++ {
			if i < fbWin {
				re[i] = frame[i] * fbWindow[i]
			} else {
				re[i] = 0
			}
			im[i] = 0
		}
		fft(re, im)
		for b := 0; b < fbBins; b++ {
			e := 0.0
			w := fbBankW[b]
			st := fbBankStart[b]
			for k := range w {
				q := st + k
				e += w[k] * (re[q]*re[q] + im[q]*im[q])
			}
			rows[t*fbBins+b] = math.Log(math.Max(e, 1.1920929e-07))
		}
	}
	for b := 0; b < fbBins; b++ {
		m, v := 0.0, 0.0
		for t := 0; t < T; t++ {
			m += rows[t*fbBins+b]
		}
		m /= float64(T)
		for t := 0; t < T; t++ {
			d := rows[t*fbBins+b] - m
			v += d * d
		}
		sd := math.Sqrt(v/float64(T)) + 1e-5
		for t := 0; t < T; t++ {
			feat[b*T+t] = float32((rows[t*fbBins+b] - m) / sd)
		}
	}
	return feat, T
}

func fft(re, im []float64) {
	n := len(re)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for l := 2; l <= n; l <<= 1 {
		ang := -2 * math.Pi / float64(l)
		wr, wi := math.Cos(ang), math.Sin(ang)
		for i := 0; i < n; i += l {
			cr, ci := 1.0, 0.0
			for k := 0; k < l/2; k++ {
				a, b := i+k, i+k+l/2
				tr, ti := re[b]*cr-im[b]*ci, re[b]*ci+im[b]*cr
				re[b], im[b] = re[a]-tr, im[a]-ti
				re[a] += tr
				im[a] += ti
				ncr := cr*wr - ci*wi
				ci = cr*wi + ci*wr
				cr = ncr
			}
		}
	}
}

// ---------------------------------------------------------------- subtitle words -> model tokens

type Tokenizer struct {
	id     map[string]int
	maxLen int
	Blank  int
}

func NewTokenizer(path string) (*Tokenizer, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t := &Tokenizer{id: map[string]int{}}
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r", ""), "\n") {
		sp := strings.LastIndex(line, " ")
		if sp <= 0 {
			continue
		}
		v, err := strconv.Atoi(line[sp+1:])
		if err != nil {
			continue
		}
		piece := line[:sp]
		t.id[piece] = v
		if v > t.Blank {
			t.Blank = v
		}
		if n := len([]rune(piece)); n > t.maxLen {
			t.maxLen = n
		}
	}
	return t, nil
}

var ones = strings.Split("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", " ")
var tens = strings.Split("_ _ twenty thirty forty fifty sixty seventy eighty ninety", " ")

func say(n int64) string {
	switch {
	case n < 20:
		return ones[n]
	case n < 100:
		if n%10 == 0 {
			return tens[n/10]
		}
		return tens[n/10] + " " + ones[n%10]
	case n < 1000:
		if n%100 == 0 {
			return ones[n/100] + " hundred"
		}
		return ones[n/100] + " hundred " + say(n%100)
	case n < 1000000:
		if n%1000 == 0 {
			return say(n/1000) + " thousand"
		}
		return say(n/1000) + " thousand " + say(n%1000)
	}
	var sb strings.Builder
	for _, c := range strconv.FormatInt(n, 10) {
		sb.WriteString(ones[c-'0'])
		sb.WriteByte(' ')
	}
	return strings.TrimSpace(sb.String())
}

func sayDigits(s string) string {
	n, err := strconv.ParseInt(s, 10, 64)
	if len(s) > 15 || err != nil {
		var sb strings.Builder
		for _, c := range s {
			sb.WriteString(ones[c-'0'])
			sb.WriteByte(' ')
		}
		return sb.String()
	}
	if len(s) == 4 && n >= 1100 && n <= 2099 && n%1000 >= 10 {
		tail := say(n % 100)
		if n%100 < 10 {
			tail = "oh " + ones[n%100]
		}
		return say(n/100) + " " + tail
	}
	return say(n)
}

var (
	digitsRe   = regexp.MustCompile(`[0-9]+`)
	nonLetters = regexp.MustCompile(`[^a-z' ]+`)
)

// spoken: how a written word is said, as plain lowercase words ("1999" -> nineteen ninety nine).
func spoken(word string) []string {
	w := strings.ToLower(word)
	w = strings.NewReplacer("’", "'", "‘", "'").Replace(w)
	w = digitsRe.ReplaceAllStringFunc(w, func(m string) string { return " " + sayDigits(m) + " " })
	w = strings.NewReplacer("&", " and ", "%", " percent ").Replace(w)
	w = nonLetters.ReplaceAllString(w, " ")
	var res []string
	for _, p := range strings.Fields(w) {
		q := strings.Trim(p, "'")
		if q != "" {
			res = append(res, q)
		}
	}
	return res
}

func (t *Tokenizer) Encode(w string) []int {
	var res []int
	s := []rune("▁" + w)
	pos := 0
	for pos < len(s) {
		found := false
		maxL := t.maxLen
		if len(s)-pos < maxL {
			maxL = len(s) - pos
		}
		for L := maxL; L > 0; L-- {
			piece := string(s[pos : pos+L])
			if v, ok := t.id[piece]; ok && piece != "<unk>" {
				res = append(res, v)
				pos += L
				found = true
				break
			}
		}
		if !found {
			pos++
		}
	}
	return res
}

// ---------------------------------------------------------------- CTC forced alignment (Viterbi)

const frameMs = 40

// ctcAlign over frames t0..t1-1 of lp: first frame of each token (relative to t0) and the mean best log-prob.
func ctcAlign(lp *Mat, t0, t1 int, toks []int, blank int) ([]int, float64) {
	T, L := t1-t0, len(toks)
	S := 2*L + 1
	conf := math.Inf(-1)
	if L == 0 || T < L {
		return nil, conf
	}
	at := func(t, v int) float32 { return lp.D[(t+t0)*lp.C+v] }
	lab := make([]int, S)
	for s := 0; s < S; s++ {
		if s%2 == 1 {
			lab[s] = toks[s/2]
		} else {
			lab[s] = blank
		}
	}
	skip := make([]bool, S)
	for s := 3; s < S; s += 2 {
		skip[s] = lab[s] != lab[s-2]
	}
	const NEG = float32(-1e30)
	prev := make([]float32, S)
	cur := make([]float32, S)
	bp := make([]int8, T*S)
	for s := range prev {
		prev[s] = NEG
	}
	prev[0] = at(0, blank)
	prev[1] = at(0, toks[0])
	for t := 1; t < T; t++ {
		for s := 0; s < S; s++ {
			best, c := prev[s], int8(0)
			if s >= 1 && prev[s-1] > best {
				best, c = prev[s-1], 1
			}
			if s >= 2 && skip[s] && prev[s-2] > best {
				best, c = prev[s-2], 2
			}
			if best <= NEG {
				cur[s] = NEG
			} else {
				cur[s] = best + at(t, lab[s])
			}
			bp[t*S+s] = c
		}
		prev, cur = cur, prev
	}
	st := S - 1
	if S > 1 && prev[S-2] > prev[S-1] {
		st = S - 2
	}
	if prev[st] <= NEG/2 {
		return nil, conf
	}
	path := make([]int, T)
	for t := T - 1; t >= 0; t-- {
		path[t] = st
		st -= int(bp[t*S+st])
	}
	first := make([]int, L)
	peak := make([]float32, L)
	for k := range first {
		first[k] = -1
		peak[k] = NEG
	}
	for t := 0; t < T; t++ {
		s := path[t]
		if s%2 == 1 {
			k := s / 2
			if first[k] < 0 {
				first[k] = t
			}
			if v := at(t, toks[k]); v > peak[k] {
				peak[k] = v
			}
		}
	}
	sum := 0.0
	for k := 0; k < L; k++ {
		if first[k] < 0 {
			return nil, conf
		}
		sum += float64(peak[k])
	}
	return first, sum / float64(L)
}

// ---------------------------------------------------------------- the whole-film job

type LineWords struct {
	Start, End int
	Words      []string
	Instant    []bool
	Times      []int
	Confidence float64
}

const (
	latencyMs     = -70
	minConfidence = -7.0
	firstWordMs   = 40
	groupGapMs    = 1000
)

var groupMs = 0

// readWords reads the words file VLC writes: "hash=..." then start \t end \t flags \t word<US>word...
func readWords(path string) ([]*LineWords, string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	hash := ""
	var res []*LineWords
	for _, raw := range strings.Split(string(b), "\n") {
		raw = strings.TrimRight(raw, "\r")
		if strings.HasPrefix(raw, "hash=") {
			hash = raw[5:]
			continue
		}
		p := strings.Split(raw, "\t")
		if len(p) < 4 {
			continue
		}
		st, e1 := strconv.Atoi(p[0])
		en, e2 := strconv.Atoi(p[1])
		if e1 != nil || e2 != nil {
			continue
		}
		words := strings.Split(p[3], "\x1f")
		lw := &LineWords{Start: st, End: en, Words: words, Instant: make([]bool, len(words)), Times: make([]int, len(words)), Confidence: math.Inf(-1)}
		for i := range words {
			lw.Instant[i] = i < len(p[2]) && p[2][i] == '1'
			lw.Times[i] = -1
		}
		res = append(res, lw)
	}
	return res, hash, nil
}

func lineTokens(L *LineWords, tok *Tokenizer) ([]int, []int) {
	var toks, owner []int
	for w := range L.Words {
		if L.Instant[w] {
			continue
		}
		for _, part := range spoken(L.Words[w]) {
			for _, id := range tok.Encode(part) {
				toks = append(toks, id)
				owner = append(owner, w)
			}
		}
	}
	return toks, owner
}

// alignRun aligns every line. readPcm fills dst with the film's dialogue (16 kHz mono) from startMs on, in order.
func alignRun(lines []*LineWords, readPcm func(dst []float32) int, model *Ort, tok *Tokenizer, progress func(float32),
	startMs int64, afterLine func(int)) error {
	order := make([]int, len(lines))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return lines[order[a]].Start < lines[order[b]].Start })
	type win struct{ line, a, b int }
	var wins []win
	for n, i := range order {
		L := lines[i]
		prevEnd := 0
		if n > 0 {
			prevEnd = lines[order[n-1]].End
		}
		nextStart := math.MaxInt32
		if n+1 < len(order) {
			nextStart = lines[order[n+1]].Start
		}
		a := maxInt(0, maxInt(L.Start-300, prevEnd-100))
		b := L.End + 300
		if nextStart != math.MaxInt32 && nextStart+100 < b {
			b = nextStart + 100
		}
		if b-a >= 200 {
			wins = append(wins, win{i, a, b})
		}
	}
	var groups [][]win
	for _, w := range wins {
		if len(groups) > 0 {
			g := groups[len(groups)-1]
			if w.a-g[len(g)-1].b <= groupGapMs && w.b-g[0].a <= groupMs {
				groups[len(groups)-1] = append(g, w)
				continue
			}
		}
		groups = append(groups, []win{w})
	}
	buf := make([]float32, 0, 16000*60)
	bufStart := startMs * 16
	eof := false
	chunk := make([]float32, 16000)
	done := 0
	for _, g := range groups {
		ga, gb := g[0].a, 0
		for _, w := range g {
			gb = maxInt(gb, w.b)
		}
		sa, sb := int64(ga)*16, int64(gb)*16
		if sa > bufStart {
			drop := int(minI64(int64(len(buf)), sa-bufStart))
			buf = append(buf[:0], buf[drop:]...)
			bufStart += int64(drop)
		}
		for !eof && bufStart+int64(len(buf)) < sb {
			got := readPcm(chunk)
			if got <= 0 {
				eof = true
				break
			}
			buf = append(buf, chunk[:got]...)
			if bufStart+int64(len(buf)) < sa {
				bufStart += int64(len(buf))
				buf = buf[:0]
			} else if bufStart < sa {
				d := int(sa - bufStart)
				buf = append(buf[:0], buf[d:]...)
				bufStart = sa
			}
		}
		off := int(maxI64(0, sa-bufStart))
		ln := int(minI64(int64(len(buf)-off), sb-maxI64(sa, bufStart)))
		done += len(g)
		if ln < 3200 {
			progress(float32(done) / float32(len(wins)))
			continue
		}
		clip := make([]float32, ln)
		copy(clip, buf[off:off+ln])
		clipStartMs := (bufStart + int64(off)) / 16
		feats, T := fbank(clip)
		if T >= 4 {
			lp, err := model.Run(feats, T)
			if err != nil {
				return err
			}
			F := lp.R
			for _, w := range g {
				f0 := int(maxI64(0, (int64(w.a)-clipStartMs)/frameMs))
				f1 := int(minI64(int64(F), (int64(w.b)-clipStartMs)/frameMs))
				if f1-f0 >= 4 {
					alignInRange(lines[w.line], lp, f0, f1, clipStartMs, tok)
				}
			}
		}
		progress(float32(done) / float32(len(wins)))
		if afterLine != nil {
			afterLine(lines[g[len(g)-1].line].Start)
		}
	}
	return nil
}

func alignInRange(L *LineWords, lp *Mat, f0, f1 int, clipStartMs int64, tok *Tokenizer) {
	toks, owner := lineTokens(L, tok)
	if len(toks) == 0 {
		return
	}
	first, conf := ctcAlign(lp, f0, f1, toks, tok.Blank)
	L.Confidence = conf
	if first == nil || conf < minConfidence {
		return
	}
	for k := range first {
		w := owner[k]
		extra := 0
		if k == 0 {
			extra = firstWordMs
		}
		if L.Times[w] < 0 {
			L.Times[w] = int(clipStartMs + int64((f0+first[k])*frameMs) + latencyMs + int64(extra))
		}
	}
}

// runChunked: the model over a long clip in ~10 s pieces (1 s of overlap each side).
func runChunked(model *Ort, clip []float32) *Mat {
	const piece, over = 10 * 16000, 16000
	if len(clip) <= piece+2*over {
		f, T := fbank(clip)
		if T < 4 {
			return nil
		}
		m, err := model.Run(f, T)
		if err != nil {
			return nil
		}
		return m
	}
	var rows []float32
	vocab, nrows := 0, 0
	for s0 := 0; s0 < len(clip); s0 += piece {
		a, b := maxInt(0, s0-over), minInt(len(clip), s0+piece+over)
		f, T := fbank(clip[a:b])
		if T < 4 {
			break
		}
		lp, err := model.Run(f, T)
		if err != nil {
			break
		}
		F := lp.R
		vocab = lp.C
		keepFrom := (s0 - a) / 640
		keepTo := minInt(F, keepFrom+piece/640)
		if b == len(clip) {
			keepTo = F
		}
		for fr := keepFrom; fr < keepTo; fr++ {
			rows = append(rows, lp.D[fr*vocab:(fr+1)*vocab]...)
			nrows++
		}
		if b == len(clip) {
			break
		}
	}
	if nrows == 0 {
		return nil
	}
	return &Mat{R: nrows, C: vocab, D: rows}
}

var scales = []float64{25 / 23.976, 23.976 / 25, 25 / 24.0, 24 / 25.0, 24 / 23.976, 23.976 / 24}

type cand struct {
	L    *LineWords
	toks []int
}

// detectOffset finds subtitles shifted (or stretched by a frame-rate mismatch) against this film.
func detectOffset(lines []*LineWords, readClip func(startMs, durMs int) []float32, model *Ort, tok *Tokenizer, progress func(float32)) (int, float64) {
	var cs []cand
	for _, L := range lines {
		var toks []int
		for w := range L.Words {
			if !L.Instant[w] {
				for _, part := range spoken(L.Words[w]) {
					toks = append(toks, tok.Encode(part)...)
				}
			}
		}
		if len(toks) >= 8 && L.End-L.Start >= 800 {
			cs = append(cs, cand{L, toks})
		}
	}
	if len(cs) < 6 {
		return 0, 1
	}
	if q, ok := quickOffset(cs, readClip, model, tok); ok {
		return q, 1
	}
	off, inSync := tryScale(cs, 1.0, readClip, model, tok, func(f float32) { progress(f * 0.5) }, true)
	if inSync {
		return 0, 1
	}
	if off != math.MinInt32 {
		return off, 1
	}
	for k, sc := range scales {
		kk := k
		o, _ := tryScale(cs, sc, readClip, model, tok, func(f float32) { progress(0.5 + (float32(kk)+f)/float32(len(scales))*0.5) }, false)
		if o != math.MinInt32 {
			return o, sc
		}
	}
	return 0, 1
}

func quickOffset(cs []cand, readClip func(int, int) []float32, model *Ort, tok *Tokenizer) (int, bool) {
	const rng, step = 2000, 100
	var shifts []int
	want := minInt(16, len(cs))
	for k := 0; k < want; k++ {
		c := cs[int((float64(k)+0.5)*float64(len(cs))/float64(want))]
		L := c.L
		a, b := maxInt(0, L.Start-rng-300), L.End+rng+300
		clip := readClip(a, b-a)
		if clip == nil || len(clip) < 16000 {
			continue
		}
		lp := runChunked(model, clip)
		if lp == nil {
			continue
		}
		F := lp.R
		best, bestOnset := math.Inf(-1), 0
		var confs []float64
		for d := -rng; d <= rng; d += step {
			f0, f1 := (L.Start+d-300-a)/frameMs, (L.End+d+300-a)/frameMs
			if f0 < 0 || f1 > F || f1-f0 < len(c.toks) {
				continue
			}
			first, conf := ctcAlign(lp, f0, f1, c.toks, tok.Blank)
			if first == nil {
				continue
			}
			confs = append(confs, conf)
			if conf > best {
				best = conf
				bestOnset = a + (f0+first[0])*frameMs + latencyMs
			}
		}
		if len(confs) < 10 {
			continue
		}
		sort.Float64s(confs)
		if best-confs[len(confs)/2] < 0.5 {
			continue
		}
		shifts = append(shifts, bestOnset-L.Start-150)
	}
	if os.Getenv("SPOIL_DEBUG") == "1" {
		fmt.Fprintln(os.Stderr, "quick shifts:", shifts)
	}
	if len(shifts) < 6 {
		return 0, false
	}
	sort.Ints(shifts)
	med := shifts[len(shifts)/2]
	var near []int
	for _, x := range shifts {
		if absInt(x-med) <= 400 {
			near = append(near, x)
		}
	}
	if float64(len(near)) < math.Max(6, float64(len(shifts))*0.6) {
		return 0, false
	}
	mean := 0.0
	for _, x := range near {
		mean += float64(x)
	}
	mean /= float64(len(near))
	if math.Abs(mean) < 300 {
		return 0, true
	}
	if math.Abs(mean) > rng-300 {
		return 0, false
	}
	return int(roundHalfEven(mean/10)) * 10, true
}

func tryScale(cs []cand, sc float64, readClip func(int, int) []float32, model *Ort, tok *Tokenizer, progress func(float32), full bool) (int, bool) {
	const rng, step = 15000, 200
	want := 12
	if full {
		want = 30
	}
	want = minInt(want, len(cs))
	var bestShifts []int
	for k := 0; k < want; k++ {
		c := cs[int((float64(k)+0.5)*float64(len(cs))/float64(want))]
		L := c.L
		st, en := int(roundHalfEven(float64(L.Start)*sc)), int(roundHalfEven(float64(L.End)*sc))
		a, b := maxInt(0, st-rng-300), en+rng+300
		clip := readClip(a, b-a)
		progress(float32(k+1) / float32(want))
		if clip == nil || len(clip) < 16000 {
			continue
		}
		lp := runChunked(model, clip)
		if lp == nil {
			continue
		}
		F := lp.R
		best, bestOnset := math.Inf(-1), 0
		for d := -rng; d <= rng; d += step {
			f0, f1 := (st+d-300-a)/frameMs, (en+d+300-a)/frameMs
			if f0 < 0 || f1 > F || f1-f0 < len(c.toks) {
				continue
			}
			first, conf := ctcAlign(lp, f0, f1, c.toks, tok.Blank)
			if first == nil {
				continue
			}
			if conf > best {
				best = conf
				bestOnset = a + (f0+first[0])*frameMs + latencyMs
			}
		}
		if best > -2.5 {
			bestShifts = append(bestShifts, bestOnset-st-150)
		}
	}
	if len(bestShifts) < 5 {
		return math.MinInt32, false
	}
	sort.Ints(bestShifts)
	med := bestShifts[len(bestShifts)/2]
	agree := 0
	for _, d := range bestShifts {
		if absInt(d-med) <= 400 {
			agree++
		}
	}
	if float64(agree) < math.Max(5, float64(len(bestShifts))*0.6) {
		return math.MinInt32, false
	}
	if sc == 1.0 && absInt(med) < 400 {
		return 0, true
	}
	sum, n := 0.0, 0
	for _, d := range bestShifts {
		if absInt(d-med) <= 400 {
			sum += float64(d)
			n++
		}
	}
	return int(roundHalfEven(sum/float64(n)/10)) * 10, false
}

func shiftLines(lines []*LineWords, offsetMs int, scale float64) {
	for _, L := range lines {
		L.Start = int(roundHalfEven(float64(L.Start)*scale)) + offsetMs
		L.End = int(roundHalfEven(float64(L.End)*scale)) + offsetMs
	}
}

func writeResult(path, hash string, lines []*LineWords, offsetMs int, scale float64) error {
	var sb strings.Builder
	sb.WriteString("hash=" + hash + "\r\n")
	if offsetMs != 0 || scale != 1 {
		sb.WriteString("offset=" + strconv.Itoa(offsetMs) + "\r\n")
	}
	if scale != 1 {
		sb.WriteString("scale=" + strconv.FormatFloat(scale, 'f', 6, 64) + "\r\n")
	}
	for _, L := range lines {
		ok := L.Confidence >= minConfidence
		if ok {
			sb.WriteString("1\t")
		} else {
			sb.WriteString("0\t")
		}
		if math.IsInf(L.Confidence, 0) {
			sb.WriteString("-99")
		} else {
			c := strconv.FormatFloat(L.Confidence, 'f', 2, 64)
			if c == "-0.00" {
				c = "0.00" // as .NET Framework writes it
			}
			sb.WriteString(c)
		}
		sb.WriteByte('\t')
		for i, t := range L.Times {
			if i > 0 {
				sb.WriteByte(',')
			}
			if ok {
				sb.WriteString(strconv.Itoa(t))
			} else {
				sb.WriteString("-1")
			}
		}
		sb.WriteString("\r\n")
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(sb.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// C#'s Math.Round rounds half to even.
func roundHalfEven(x float64) float64 { return math.RoundToEven(x) }

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func maxI64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func minI64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
func absInt(a int) int {
	if a < 0 {
		return -a
	}
	return a
}
