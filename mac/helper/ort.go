// ONNX Runtime through its C API, loaded at run time with purego (no cgo, so it cross-builds for macOS from
// anywhere). Same function-table approach as tray/Align.cs: OrtGetApiBase()->GetApi(20) gives a table of
// function pointers in onnxruntime_c_api.h order.
package main

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	iGetErrorMessage       = 2
	iCreateEnv             = 3
	iCreateSession         = 7
	iRun                   = 9
	iCreateSessionOptions  = 10
	iDisableCpuMemArena    = 19
	iSetGraphOpt           = 23
	iSetIntraOp            = 24
	iSetInterOp            = 25
	iCreateTensor          = 49
	iGetData               = 51
	iGetDimCount           = 61
	iGetDims               = 62
	iGetShapeInfo          = 65
	iCreateCpuMemoryInfo   = 69
	iReleaseEnv            = 92
	iReleaseStatus         = 93
	iReleaseMemoryInfo     = 94
	iReleaseSession        = 95
	iReleaseValue          = 96
	iReleaseShapeInfo      = 99
	iReleaseSessionOptions = 100
	iAddSessionConfigEntry = 130
)

var ortLib uintptr

// loadOrt opens libonnxruntime (path to the .dylib/.so). Safe to call more than once.
func loadOrt(path string) error {
	if ortLib != 0 {
		return nil
	}
	h, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return err
	}
	ortLib = h
	return nil
}

type Ort struct {
	api                     uintptr
	env, opts, session, mem uintptr
	inNames, outNames       []uintptr
	keep                    [][]byte
}

func cstr(s string) []byte { return append([]byte(s), 0) }

func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var b []byte
	for i := uintptr(0); i < 4096; i++ {
		c := *(*byte)(unsafe.Pointer(p + i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func (o *Ort) fn(i int) uintptr {
	return *(*uintptr)(unsafe.Pointer(o.api + uintptr(i)*unsafe.Sizeof(uintptr(0))))
}

func (o *Ort) call(i int, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(o.fn(i), args...)
	return r
}

func (o *Ort) check(status uintptr) error {
	if status == 0 {
		return nil
	}
	msg := goString(o.call(iGetErrorMessage, status))
	o.call(iReleaseStatus, status)
	return errors.New("ONNX Runtime: " + msg)
}

func ptr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

// NewOrt loads the model with `threads` intra-op threads; worker threads sleep instead of spinning.
func NewOrt(modelPath string, threads int) (*Ort, error) {
	if ortLib == 0 {
		return nil, errors.New("ONNX Runtime isn't loaded")
	}
	sym, err := purego.Dlsym(ortLib, "OrtGetApiBase")
	if err != nil {
		return nil, err
	}
	base, _, _ := purego.SyscallN(sym)
	if base == 0 {
		return nil, errors.New("OrtGetApiBase failed")
	}
	getApi := *(*uintptr)(unsafe.Pointer(base))
	api, _, _ := purego.SyscallN(getApi, 20)
	if api == 0 {
		return nil, errors.New("ONNX Runtime is too old")
	}
	o := &Ort{api: api}
	keep := func(s string) uintptr {
		b := cstr(s)
		o.keep = append(o.keep, b)
		return uintptr(unsafe.Pointer(&b[0]))
	}
	if err := o.check(o.call(iCreateEnv, 3, keep("spoilaint"), ptr(&o.env))); err != nil {
		return nil, err
	}
	steps := []func() error{
		func() error { return o.check(o.call(iCreateSessionOptions, ptr(&o.opts))) },
		func() error { return o.check(o.call(iSetIntraOp, o.opts, uintptr(threads))) },
		func() error { return o.check(o.call(iSetInterOp, o.opts, 1)) },
		func() error { return o.check(o.call(iSetGraphOpt, o.opts, 99)) },
		func() error {
			return o.check(o.call(iAddSessionConfigEntry, o.opts, keep("session.intra_op.allow_spinning"), keep("0")))
		},
		func() error {
			return o.check(o.call(iAddSessionConfigEntry, o.opts, keep("session.inter_op.allow_spinning"), keep("0")))
		},
		func() error { return o.check(o.call(iCreateSession, o.env, keep(modelPath), o.opts, ptr(&o.session))) },
		func() error { return o.check(o.call(iCreateCpuMemoryInfo, 0, 0, ptr(&o.mem))) },
	}
	for _, s := range steps {
		if err := s(); err != nil {
			o.Close()
			return nil, err
		}
	}
	o.inNames = []uintptr{keep("audio_signal"), keep("length")}
	o.outNames = []uintptr{keep("logprobs")}
	runtime.KeepAlive(o.keep)
	return o, nil
}

// Run takes features [80 x T] (band-major) and returns log-probs [frames][vocab].
func (o *Ort) Run(feats []float32, T int) (*Mat, error) {
	shape := []int64{1, 80, int64(T)}
	lenArr := []int64{int64(T)}
	lenShape := []int64{1}
	var vIn, vLen uintptr
	outs := []uintptr{0}
	defer func() {
		if vIn != 0 {
			o.call(iReleaseValue, vIn)
		}
		if vLen != 0 {
			o.call(iReleaseValue, vLen)
		}
		if outs[0] != 0 {
			o.call(iReleaseValue, outs[0])
		}
		runtime.KeepAlive(feats)
		runtime.KeepAlive(lenArr)
		runtime.KeepAlive(shape)
		runtime.KeepAlive(lenShape)
	}()
	if err := o.check(o.call(iCreateTensor, o.mem, uintptr(unsafe.Pointer(&feats[0])), uintptr(len(feats)*4),
		uintptr(unsafe.Pointer(&shape[0])), 3, 1, ptr(&vIn))); err != nil {
		return nil, err
	}
	if err := o.check(o.call(iCreateTensor, o.mem, uintptr(unsafe.Pointer(&lenArr[0])), 8,
		uintptr(unsafe.Pointer(&lenShape[0])), 1, 7, ptr(&vLen))); err != nil {
		return nil, err
	}
	ins := []uintptr{vIn, vLen}
	if err := o.check(o.call(iRun, o.session, 0, uintptr(unsafe.Pointer(&o.inNames[0])), uintptr(unsafe.Pointer(&ins[0])), 2,
		uintptr(unsafe.Pointer(&o.outNames[0])), 1, uintptr(unsafe.Pointer(&outs[0])))); err != nil {
		return nil, err
	}
	runtime.KeepAlive(ins)
	var info uintptr
	if err := o.check(o.call(iGetShapeInfo, outs[0], ptr(&info))); err != nil {
		return nil, err
	}
	var n uintptr
	if err := o.check(o.call(iGetDimCount, info, ptr(&n))); err != nil {
		return nil, err
	}
	if n != 3 {
		o.call(iReleaseShapeInfo, info)
		return nil, fmt.Errorf("unexpected output rank %d", n)
	}
	dims := make([]int64, n)
	if err := o.check(o.call(iGetDims, info, uintptr(unsafe.Pointer(&dims[0])), n)); err != nil {
		return nil, err
	}
	o.call(iReleaseShapeInfo, info)
	var data uintptr
	if err := o.check(o.call(iGetData, outs[0], ptr(&data))); err != nil {
		return nil, err
	}
	frames, vocab := int(dims[1]), int(dims[2])
	m := &Mat{R: frames, C: vocab, D: make([]float32, frames*vocab)}
	copy(m.D, unsafe.Slice((*float32)(unsafe.Pointer(data)), frames*vocab))
	return m, nil
}

func (o *Ort) Close() {
	if o.session != 0 {
		o.call(iReleaseSession, o.session)
		o.session = 0
	}
	if o.opts != 0 {
		o.call(iReleaseSessionOptions, o.opts)
		o.opts = 0
	}
	if o.mem != 0 {
		o.call(iReleaseMemoryInfo, o.mem)
		o.mem = 0
	}
	if o.env != 0 {
		o.call(iReleaseEnv, o.env)
		o.env = 0
	}
}

// Mat is a row-major float matrix (frames x vocab).
type Mat struct {
	R, C int
	D    []float32
}

func (m *Mat) At(r, c int) float32 { return m.D[r*m.C+c] }
