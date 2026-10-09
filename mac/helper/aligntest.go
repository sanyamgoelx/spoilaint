package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// spoilaint-helper aligntest MODEL_DIR media words.txt out.txt  (same as tray/test/AlignTest.cs, for the bench)
func alignTest(a []string) error {
	if len(a) < 4 {
		return fmt.Errorf("usage: aligntest MODEL_DIR media words.txt out.txt")
	}
	t0 := time.Now()
	if err := loadOrt(ortPath()); err != nil {
		return err
	}
	pan := panFor(probe(a[1]))
	lines, hash, err := readWords(a[2])
	if err != nil {
		return err
	}
	tok, err := NewTokenizer(filepath.Join(a[0], "tokens.txt"))
	if err != nil {
		return err
	}
	th, _ := strconv.Atoi(os.Getenv("SPOIL_THREADS"))
	if th <= 0 {
		th = 2
	}
	model, err := NewOrt(filepath.Join(a[0], "model.int8.onnx"), th)
	if err != nil {
		return err
	}
	defer model.Close()
	off, sc := 0, 1.0
	if os.Getenv("SPOIL_NOOFFSET") != "1" {
		off, sc = detectOffset(lines, func(st, du int) []float32 { return readClip(a[1], pan, st, du) }, model, tok, func(float32) {})
	}
	fmt.Printf("offset %d ms, scale %v\n", off, sc)
	if off != 0 || sc != 1 {
		shiftLines(lines, off, sc)
	}
	p, err := openPcm(a[1], pan, 0, -1)
	if err != nil {
		return err
	}
	if err := alignRun(lines, p.read, model, tok, func(float32) {}, 0, nil); err != nil {
		return err
	}
	p.close()
	if err := writeResult(a[3], hash, lines, off, sc); err != nil {
		return err
	}
	ok := 0
	for _, l := range lines {
		if l.Confidence >= minConfidence {
			ok++
		}
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	fmt.Printf("aligned %d of %d lines in %.1f s (Go heap %d MB)\n", ok, len(lines), time.Since(t0).Seconds(), ms.Sys>>20)
	return nil
}
