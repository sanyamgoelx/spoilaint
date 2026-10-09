// Forced alignment: finds when each subtitle word is spoken, using a small speech model
// (NVIDIA NeMo Conformer-CTC small, English, int8 ONNX, from k2-fsa/sherpa-onnx) and ONNX Runtime's C API.
// The subtitles already say *what* is said; the model only has to find *where* in the audio.
// Reference implementation and bench: bench/ctc_align.py (keep the numbers here in step with it).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace Spoilaint
{
    // ---------------------------------------------------------------- ONNX Runtime (C API, no NuGet needed)
    sealed class Ort : IDisposable
    {
        const string Lib = "onnxruntime";
        [DllImport(Lib, CallingConvention = CallingConvention.Winapi)] static extern IntPtr OrtGetApiBase();

        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetApiFn(uint version);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetErrorMessageFn(IntPtr status);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ReleaseFn(IntPtr p);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateEnvFn(int level, [MarshalAs(UnmanagedType.LPStr)] string id, out IntPtr env);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateSessionOptionsFn(out IntPtr opts);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr SetIntFn(IntPtr opts, int value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr OptsFn(IntPtr opts);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr AddConfigFn(IntPtr opts, [MarshalAs(UnmanagedType.LPStr)] string key, [MarshalAs(UnmanagedType.LPStr)] string value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateSessionWFn(IntPtr env, [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr opts, out IntPtr session);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateSessionAFn(IntPtr env, IntPtr utf8Path, IntPtr opts, out IntPtr session);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateCpuMemoryInfoFn(int allocType, int memType, out IntPtr info);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr CreateTensorFn(IntPtr info, IntPtr data, UIntPtr bytes, long[] shape, UIntPtr shapeLen, int type, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr RunFn(IntPtr session, IntPtr runOpts, IntPtr[] inNames, IntPtr[] inputs, UIntPtr inLen, IntPtr[] outNames, UIntPtr outLen, IntPtr[] outputs);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDataFn(IntPtr value, out IntPtr data);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetShapeInfoFn(IntPtr value, out IntPtr info);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDimCountFn(IntPtr info, out UIntPtr count);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr GetDimsFn(IntPtr info, long[] dims, UIntPtr count);

        // Positions in the OrtApi function table (onnxruntime_c_api.h, API version 20 / ORT 1.20).
        const int I_GetErrorMessage = 2, I_CreateEnv = 3, I_CreateSession = 7, I_Run = 9, I_CreateSessionOptions = 10,
            I_SetGraphOpt = 23, I_SetIntraOp = 24, I_SetInterOp = 25, I_CreateTensor = 49, I_GetData = 51, I_GetDimCount = 61,
            I_GetDims = 62, I_GetShapeInfo = 65, I_CreateCpuMemoryInfo = 69, I_AddSessionConfigEntry = 130, I_DisableCpuMemArena = 19, I_ReleaseEnv = 92, I_ReleaseStatus = 93,
            I_ReleaseMemoryInfo = 94, I_ReleaseSession = 95, I_ReleaseValue = 96, I_ReleaseShapeInfo = 99, I_ReleaseSessionOptions = 100;

        readonly IntPtr api;
        IntPtr env, opts, session, mem;
        readonly IntPtr[] inNames, outNames;

        T Fn<T>(int index) where T : class
        {
            IntPtr p = Marshal.ReadIntPtr(api, index * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
        }
        void Check(IntPtr status)
        {
            if (status == IntPtr.Zero) return;
            string msg = Marshal.PtrToStringAnsi(Fn<GetErrorMessageFn>(I_GetErrorMessage)(status));
            Fn<ReleaseFn>(I_ReleaseStatus)(status);
            throw new Exception("ONNX Runtime: " + msg);
        }

        public static bool CanLoad()
        {
            try { return OrtGetApiBase() != IntPtr.Zero; } catch { return false; }
        }

        public Ort(string modelPath, int threads) : this(modelPath, threads, false) { }
        // spin = false: worker threads sleep while waiting instead of busy-looping, so idle cores stay idle
        // (ONNX Runtime spins by default, which keeps cores at 100% between operations and makes a PC feel slow).
        public Ort(string modelPath, int threads, bool spin)
        {
            IntPtr bas = OrtGetApiBase();
            var getApi = (GetApiFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(bas), typeof(GetApiFn));
            api = getApi(20);
            if (api == IntPtr.Zero) throw new Exception("ONNX Runtime is too old");
            Check(Fn<CreateEnvFn>(I_CreateEnv)(3, "spoilaint", out env)); // 3 = errors only
            Check(Fn<CreateSessionOptionsFn>(I_CreateSessionOptions)(out opts));
            Check(Fn<SetIntFn>(I_SetIntraOp)(opts, threads));
            Check(Fn<SetIntFn>(I_SetInterOp)(opts, 1));
            Check(Fn<SetIntFn>(I_SetGraphOpt)(opts, 99)); // all optimisations
            Check(Fn<AddConfigFn>(I_AddSessionConfigEntry)(opts, "session.intra_op.allow_spinning", spin ? "1" : "0"));
            // No memory pool: each window's tensors are freed after use instead of the pool growing to the largest one.
            if (Environment.GetEnvironmentVariable("SPOIL_ARENA") == "0") Check(Fn<OptsFn>(I_DisableCpuMemArena)(opts));
            Check(Fn<AddConfigFn>(I_AddSessionConfigEntry)(opts, "session.inter_op.allow_spinning", spin ? "1" : "0"));
            if (Path.DirectorySeparatorChar == '\\')
                Check(Fn<CreateSessionWFn>(I_CreateSession)(env, modelPath, opts, out session));
            else
            {
                byte[] b = Encoding.UTF8.GetBytes(modelPath + "\0");
                IntPtr p = Marshal.AllocHGlobal(b.Length);
                Marshal.Copy(b, 0, p, b.Length);
                try { Check(Fn<CreateSessionAFn>(I_CreateSession)(env, p, opts, out session)); }
                finally { Marshal.FreeHGlobal(p); }
            }
            Check(Fn<CreateCpuMemoryInfoFn>(I_CreateCpuMemoryInfo)(0, 0, out mem));
            inNames = new[] { Marshal.StringToHGlobalAnsi("audio_signal"), Marshal.StringToHGlobalAnsi("length") };
            outNames = new[] { Marshal.StringToHGlobalAnsi("logprobs") };
        }

        // feats: [80 x T] row-major (band-major, as the model wants). Returns log-probs [frames x vocab].
        public float[,] Run(float[] feats, int T)
        {
            var hf = GCHandle.Alloc(feats, GCHandleType.Pinned);
            var lenArr = new long[] { T };
            var hl = GCHandle.Alloc(lenArr, GCHandleType.Pinned);
            IntPtr vIn = IntPtr.Zero, vLen = IntPtr.Zero;
            var outs = new IntPtr[1];
            try
            {
                Check(Fn<CreateTensorFn>(I_CreateTensor)(mem, hf.AddrOfPinnedObject(), (UIntPtr)(feats.Length * 4), new long[] { 1, 80, T }, (UIntPtr)3, 1, out vIn));
                Check(Fn<CreateTensorFn>(I_CreateTensor)(mem, hl.AddrOfPinnedObject(), (UIntPtr)8, new long[] { 1 }, (UIntPtr)1, 7, out vLen));
                Check(Fn<RunFn>(I_Run)(session, IntPtr.Zero, inNames, new[] { vIn, vLen }, (UIntPtr)2, outNames, (UIntPtr)1, outs));
                IntPtr info;
                Check(Fn<GetShapeInfoFn>(I_GetShapeInfo)(outs[0], out info));
                UIntPtr n;
                Check(Fn<GetDimCountFn>(I_GetDimCount)(info, out n));
                var dims = new long[(int)n];
                Check(Fn<GetDimsFn>(I_GetDims)(info, dims, n));
                Fn<ReleaseFn>(I_ReleaseShapeInfo)(info);
                IntPtr data;
                Check(Fn<GetDataFn>(I_GetData)(outs[0], out data));
                int frames = (int)dims[1], vocab = (int)dims[2];
                var flat = new float[frames * vocab];
                Marshal.Copy(data, flat, 0, flat.Length);
                var res = new float[frames, vocab];
                Buffer.BlockCopy(flat, 0, res, 0, flat.Length * 4);
                return res;
            }
            finally
            {
                var release = Fn<ReleaseFn>(I_ReleaseValue);
                if (vIn != IntPtr.Zero) release(vIn);
                if (vLen != IntPtr.Zero) release(vLen);
                if (outs[0] != IntPtr.Zero) release(outs[0]);
                hf.Free(); hl.Free();
            }
        }

        public void Dispose()
        {
            if (session != IntPtr.Zero) { Fn<ReleaseFn>(I_ReleaseSession)(session); session = IntPtr.Zero; }
            if (opts != IntPtr.Zero) { Fn<ReleaseFn>(I_ReleaseSessionOptions)(opts); opts = IntPtr.Zero; }
            if (mem != IntPtr.Zero) { Fn<ReleaseFn>(I_ReleaseMemoryInfo)(mem); mem = IntPtr.Zero; }
            if (env != IntPtr.Zero) { Fn<ReleaseFn>(I_ReleaseEnv)(env); env = IntPtr.Zero; }
            foreach (var p in inNames) Marshal.FreeHGlobal(p);
            foreach (var p in outNames) Marshal.FreeHGlobal(p);
        }
    }

    // ---------------------------------------------------------------- 80-band log-mel features (Kaldi fbank)
    static class Fbank
    {
        const int Win = 400, Shift = 160, NFft = 512, Bins = 80;
        static readonly double[] Window = new double[Win];
        static readonly int[] BankStart = new int[Bins];
        static readonly double[][] BankW = new double[Bins][];
        static Fbank()
        {
            for (int i = 0; i < Win; i++) Window[i] = Math.Pow(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (Win - 1)), 0.85);
            Func<double, double> mel = f => 1127.0 * Math.Log(1.0 + f / 700.0);
            double ml = mel(20), mh = mel(8000), delta = (mh - ml) / (Bins + 1);
            int nf = NFft / 2;
            for (int b = 0; b < Bins; b++)
            {
                double left = ml + b * delta, center = ml + (b + 1) * delta, right = ml + (b + 2) * delta;
                var w = new List<double>(); int start = -1;
                for (int k = 0; k < nf; k++)
                {
                    double m = mel(k * 16000.0 / NFft);
                    double v = (m <= left || m >= right) ? 0 : Math.Max(0, Math.Min((m - left) / (center - left), (right - m) / (right - center)));
                    if (v > 0 && start < 0) start = k;
                    if (start >= 0) w.Add(v);
                }
                BankStart[b] = Math.Max(0, start);
                while (w.Count > 0 && w[w.Count - 1] == 0) w.RemoveAt(w.Count - 1);
                BankW[b] = w.ToArray();
            }
        }

        // samples (16 kHz, -1..1) -> features [80 x T] band-major, normalised per band over the clip.
        public static float[] Compute(float[] x, int n, out int T)
        {
            T = (n + 80) / Shift;
            var feat = new float[Bins * Math.Max(T, 1)];
            if (T < 1) { T = 0; return feat; }
            var re = new double[NFft]; var im = new double[NFft];
            var frame = new double[Win];
            var rows = new double[T, Bins];
            for (int t = 0; t < T; t++)
            {
                int s0 = t * Shift + 80 - 200;
                double mean = 0;
                for (int i = 0; i < Win; i++)
                {
                    int j = s0 + i;
                    if (j < 0) j = -j - 1;                 // reflect at the edges
                    else if (j >= n) j = 2 * n - j - 1;
                    j = Math.Max(0, Math.Min(n - 1, j));
                    frame[i] = x[j] * 32768.0;
                    mean += frame[i];
                }
                mean /= Win;
                for (int i = 0; i < Win; i++) frame[i] -= mean;
                for (int i = Win - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
                frame[0] -= 0.97 * frame[0];
                for (int i = 0; i < NFft; i++) { re[i] = i < Win ? frame[i] * Window[i] : 0; im[i] = 0; }
                Fft(re, im);
                for (int b = 0; b < Bins; b++)
                {
                    double e = 0; var w = BankW[b]; int st = BankStart[b];
                    for (int k = 0; k < w.Length; k++) { int q = st + k; e += w[k] * (re[q] * re[q] + im[q] * im[q]); }
                    rows[t, b] = Math.Log(Math.Max(e, 1.1920929e-07));
                }
            }
            for (int b = 0; b < Bins; b++)
            {
                double m = 0, v = 0;
                for (int t = 0; t < T; t++) m += rows[t, b];
                m /= T;
                for (int t = 0; t < T; t++) { double d = rows[t, b] - m; v += d * d; }
                double sd = Math.Sqrt(v / T) + 1e-5;
                for (int t = 0; t < T; t++) feat[b * T + t] = (float)((rows[t, b] - m) / sd);
            }
            return feat;
        }

        static void Fft(double[] re, double[] im)
        {
            int n = re.Length;
            for (int i = 1, j = 0; i < n; i++)
            {
                int bit = n >> 1;
                for (; (j & bit) != 0; bit >>= 1) j ^= bit;
                j ^= bit;
                if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
            }
            for (int len = 2; len <= n; len <<= 1)
            {
                double ang = -2 * Math.PI / len, wr = Math.Cos(ang), wi = Math.Sin(ang);
                for (int i = 0; i < n; i += len)
                {
                    double cr = 1, ci = 0;
                    for (int k = 0; k < len / 2; k++)
                    {
                        int a = i + k, b = a + len / 2;
                        double tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                        double ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- subtitle words -> model tokens
    sealed class Tokenizer
    {
        readonly Dictionary<string, int> id = new Dictionary<string, int>();
        readonly int maxLen;
        public readonly int Blank;
        public Tokenizer(string tokensPath)
        {
            foreach (var line in File.ReadAllLines(tokensPath, Encoding.UTF8))
            {
                int sp = line.LastIndexOf(' ');
                if (sp <= 0) continue;
                int v = int.Parse(line.Substring(sp + 1), CultureInfo.InvariantCulture);
                id[line.Substring(0, sp)] = v;
                Blank = Math.Max(Blank, v);
                maxLen = Math.Max(maxLen, sp);
            }
        }

        static readonly string[] Ones = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".Split(' ');
        static readonly string[] Tens = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".Split(' ');
        static string Say(long n)
        {
            if (n < 20) return Ones[n];
            if (n < 100) return Tens[n / 10] + (n % 10 == 0 ? "" : " " + Ones[n % 10]);
            if (n < 1000) return Ones[n / 100] + " hundred" + (n % 100 == 0 ? "" : " " + Say(n % 100));
            if (n < 1000000) return Say(n / 1000) + " thousand" + (n % 1000 == 0 ? "" : " " + Say(n % 1000));
            var sb = new StringBuilder();
            foreach (char c in n.ToString(CultureInfo.InvariantCulture)) sb.Append(Ones[c - '0']).Append(' ');
            return sb.ToString().Trim();
        }
        static string SayDigits(string s)
        {
            long n;
            if (s.Length > 15 || !long.TryParse(s, out n)) { var sb = new StringBuilder(); foreach (char c in s) sb.Append(Ones[c - '0']).Append(' '); return sb.ToString(); }
            if (s.Length == 4 && n >= 1100 && n <= 2099 && n % 1000 >= 10)
                return Say(n / 100) + " " + (n % 100 < 10 ? "oh " + Ones[n % 100] : Say(n % 100));
            return Say(n);
        }

        // How a written word is spoken, as plain lowercase words ("1999" -> nineteen ninety nine).
        public static List<string> Spoken(string word)
        {
            string w = word.ToLowerInvariant().Replace('’', '\'').Replace('‘', '\'');
            w = Regex.Replace(w, @"[0-9]+", m => " " + SayDigits(m.Value) + " ");  // ASCII digits only: \d also matches ٣ or ३, which SayDigits can't read
            w = w.Replace("&", " and ").Replace("%", " percent ");
            w = Regex.Replace(w, @"[^a-z' ]+", " ");
            var res = new List<string>();
            foreach (var p in w.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string q = p.Trim('\'');
                if (q.Length > 0) res.Add(q);
            }
            return res;
        }

        public List<int> Encode(string w)
        {
            var res = new List<int>();
            string s = "▁" + w;
            int pos = 0;
            while (pos < s.Length)
            {
                bool found = false;
                for (int L = Math.Min(maxLen, s.Length - pos); L > 0; L--)
                {
                    string piece = s.Substring(pos, L);
                    int v;
                    if (piece != "<unk>" && id.TryGetValue(piece, out v)) { res.Add(v); pos += L; found = true; break; }
                }
                if (!found) pos++;
            }
            return res;
        }
    }

    // ---------------------------------------------------------------- CTC forced alignment (Viterbi)
    static class Ctc
    {
        public const int FrameMs = 40;
        // Returns the first frame of each token and the mean best log-prob of the tokens (confidence).
        public static int[] Align(float[,] lp, int[] toks, int blank, out double confidence)
        {
            return Align(lp, 0, lp.GetLength(0), toks, blank, out confidence);
        }
        // Frames t0 .. t1-1 of lp only; returned frames are relative to t0.
        public static int[] Align(float[,] lpAll, int t0, int t1, int[] toks, int blank, out double confidence)
        {
            var lp = new RowView(lpAll, t0);
            int T = t1 - t0, L = toks.Length, S = 2 * L + 1;
            confidence = double.NegativeInfinity;
            if (L == 0 || T < L) return null;
            var lab = new int[S];
            for (int s = 0; s < S; s++) lab[s] = s % 2 == 1 ? toks[s / 2] : blank;
            var skip = new bool[S];
            for (int s = 3; s < S; s += 2) skip[s] = lab[s] != lab[s - 2];
            const float NEG = -1e30f;
            var prev = new float[S]; var cur = new float[S];
            var bp = new sbyte[T, S];
            for (int s = 0; s < S; s++) prev[s] = NEG;
            prev[0] = lp[0, blank]; prev[1] = lp[0, toks[0]];
            for (int t = 1; t < T; t++)
            {
                for (int s = 0; s < S; s++)
                {
                    float best = prev[s]; sbyte c = 0;
                    if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; c = 1; }
                    if (s >= 2 && skip[s] && prev[s - 2] > best) { best = prev[s - 2]; c = 2; }
                    cur[s] = best <= NEG ? NEG : best + lp[t, lab[s]];
                    bp[t, s] = c;
                }
                var tmp = prev; prev = cur; cur = tmp;
            }
            int st = S > 1 && prev[S - 2] > prev[S - 1] ? S - 2 : S - 1;
            if (prev[st] <= NEG / 2) return null;
            var path = new int[T];
            for (int t = T - 1; t >= 0; t--) { path[t] = st; st -= bp[t, st]; }
            var first = new int[L]; var peak = new float[L];
            for (int k = 0; k < L; k++) { first[k] = -1; peak[k] = NEG; }
            for (int t = 0; t < T; t++)
            {
                int s = path[t];
                if (s % 2 == 1)
                {
                    int k = s / 2;
                    if (first[k] < 0) first[k] = t;
                    peak[k] = Math.Max(peak[k], lp[t, toks[k]]);
                }
            }
            double sum = 0;
            for (int k = 0; k < L; k++) { if (first[k] < 0) return null; sum += peak[k]; }
            confidence = sum / L;
            return first;
        }
    }

    // A window of rows of a log-prob matrix without copying it.
    struct RowView
    {
        readonly float[,] m; readonly int off;
        public RowView(float[,] m, int off) { this.m = m; this.off = off; }
        public float this[int t, int v] { get { return m[t + off, v]; } }
    }

    // ---------------------------------------------------------------- the whole-film job
    class LineWords
    {
        public int Start, End;          // ms
        public string[] Words;
        public bool[] Instant;          // helper text: [laughs], JOHN:
        public int[] Times;             // result, ms (-1 = keep the estimate)
        public double Confidence = double.NegativeInfinity;
    }

    static class Prof
    {
        public static readonly System.Diagnostics.Stopwatch Read = new System.Diagnostics.Stopwatch(), Fb = new System.Diagnostics.Stopwatch(), Model = new System.Diagnostics.Stopwatch();
        public static string Report() { return string.Format("audio read {0:0.0}s  features {1:0.0}s  model {2:0.0}s", Read.Elapsed.TotalSeconds, Fb.Elapsed.TotalSeconds, Model.Elapsed.TotalSeconds); }
    }

    static class Aligner
    {
        public const int LatencyMs = -70;         // the model fires ~100 ms after a word starts (bench: rb1/rb2)
        public const double MinConfidence = -7.0;
        public const int FirstWordMs = 40;         // stress bench (echo, 5.1): halves early first words, precision unchanged  // below this the text doesn't match the audio (wrong subs, other language)

        public static string ModelDir { get { return Path.Combine(Paths.AppDir, "speech-model"); } }
        // The model and ffmpeg are installed, and ONNX Runtime really loads here (it needs the VC++ runtime DLLs that
        // ship next to it). Checked once; if it fails VLC keeps using the loudness method instead of failing every film.
        static int availability = -1;
        public static bool Available
        {
            get
            {
                if (availability >= 0) return availability == 1;
                bool ok = File.Exists(Path.Combine(ModelDir, "model.int8.onnx")) && File.Exists(Path.Combine(ModelDir, "tokens.txt")) &&
                          Paths.Ffmpeg() != "ffmpeg";
                if (ok) ok = Ort.CanLoad();
                availability = ok ? 1 : 0;
                return ok;
            }
        }

        // words file (written by VLC): "hash=..." then one line per subtitle: start \t end \t flags \t word<US>word...
        public static List<LineWords> ReadWords(string path, out string hash)
        {
            hash = "";
            var res = new List<LineWords>();
            foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
            {
                if (raw.StartsWith("hash=")) { hash = raw.Substring(5); continue; }
                var p = raw.Split('\t');
                if (p.Length < 4) continue;
                var words = p[3].Split('\u001f');
                var lw = new LineWords { Start = int.Parse(p[0]), End = int.Parse(p[1]), Words = words, Instant = new bool[words.Length], Times = new int[words.Length] };
                for (int i = 0; i < words.Length; i++) { lw.Instant[i] = i < p[2].Length && p[2][i] == '1'; lw.Times[i] = -1; }
                res.Add(lw);
            }
            return res;
        }

        // Aligns every line. pcm: the film's dialogue at 16 kHz mono, read in order (a stream, never all in memory).
        // Lines close together are aligned from one model run over their shared stretch (up to GroupMs):
        // fewer runs, no audio processed twice. Each line is still aligned only within its own window.
        public static int GroupMs = int.Parse(Environment.GetEnvironmentVariable("SPOIL_GROUP") ?? "0"), GroupGapMs = 1000;

        // readPcm yields the film's dialogue from startMs on. afterLine(lineStartMs) is called after each line.
        public static void Run(List<LineWords> lines, Func<float[], int, int> readPcm, Ort model, Tokenizer tok, Action<float> progress,
            long startMs = 0, Action<int> afterLine = null)
        {
            var order = new List<int>();
            for (int i = 0; i < lines.Count; i++) order.Add(i);
            order.Sort((a, b) => lines[a].Start.CompareTo(lines[b].Start));
            // each line's window: its time +-300 ms, not reaching far into its neighbours
            var win = new List<int[]>(); // [lineIndex, a, b]
            for (int n = 0; n < order.Count; n++)
            {
                var L = lines[order[n]];
                int prevEnd = n > 0 ? lines[order[n - 1]].End : 0;
                int nextStart = n + 1 < order.Count ? lines[order[n + 1]].Start : int.MaxValue;
                int a = Math.Max(0, Math.Max(L.Start - 300, prevEnd - 100));
                int b = Math.Min(L.End + 300, nextStart == int.MaxValue ? L.End + 300 : nextStart + 100);
                if (b - a >= 200) win.Add(new[] { order[n], a, b });
            }
            // groups of nearby windows
            var groups = new List<List<int[]>>();
            foreach (var w in win)
            {
                var g = groups.Count > 0 ? groups[groups.Count - 1] : null;
                if (g != null && w[1] - g[g.Count - 1][2] <= GroupGapMs && w[2] - g[0][1] <= GroupMs) g.Add(w);
                else groups.Add(new List<int[]> { w });
            }
            // Rolling buffer of samples [bufStart, bufStart + bufLen)
            var buf = new float[16000 * 60];
            long bufStart = startMs * 16; int bufLen = 0; bool eof = false;
            var chunk = new float[16000];
            int done = 0;
            foreach (var g in groups)
            {
                int ga = g[0][1], gb = 0;
                foreach (var w in g) gb = Math.Max(gb, w[2]);
                long sa = (long)ga * 16, sb = (long)gb * 16;
                if (sa > bufStart)
                {
                    int drop = (int)Math.Min(bufLen, sa - bufStart);
                    Array.Copy(buf, drop, buf, 0, bufLen - drop); bufLen -= drop; bufStart += drop;
                }
                while (!eof && bufStart + bufLen < sb)
                {
                    Prof.Read.Start(); int got = readPcm(chunk, chunk.Length); Prof.Read.Stop();
                    if (got <= 0) { eof = true; break; }
                    if (bufLen + got > buf.Length) Array.Resize(ref buf, Math.Max(buf.Length * 2, bufLen + got));
                    Array.Copy(chunk, 0, buf, bufLen, got); bufLen += got;
                    // skip samples before the window start (long gaps without subtitles)
                    if (bufStart + bufLen < sa) { bufStart += bufLen; bufLen = 0; }
                    else if (bufStart < sa) { int d = (int)(sa - bufStart); Array.Copy(buf, d, buf, 0, bufLen - d); bufLen -= d; bufStart = sa; }
                }
                int off = (int)Math.Max(0, sa - bufStart);
                int len = (int)Math.Min(bufLen - off, sb - Math.Max(sa, bufStart));
                done += g.Count;
                if (len < 3200) { progress((float)done / win.Count); continue; }
                var clip = new float[len];
                Array.Copy(buf, off, clip, 0, len);
                long clipStartMs = (bufStart + off) / 16;
                int T;
                Prof.Fb.Start(); var feats = Fbank.Compute(clip, clip.Length, out T); Prof.Fb.Stop();
                if (T >= 4)
                {
                    Prof.Model.Start(); var lp = model.Run(feats, T); Prof.Model.Stop();
                    int F = lp.GetLength(0);
                    foreach (var w in g)
                    {
                        int f0 = (int)Math.Max(0, (w[1] - clipStartMs) / Ctc.FrameMs), f1 = (int)Math.Min(F, (w[2] - clipStartMs) / Ctc.FrameMs);
                        if (f1 - f0 >= 4) AlignInRange(lines[w[0]], lp, f0, f1, clipStartMs, tok);
                    }
                }
                progress((float)done / win.Count);
                if (afterLine != null) afterLine(lines[g[g.Count - 1][0]].Start);
            }
        }

        static void AlignInRange(LineWords L, float[,] lp, int f0, int f1, long clipStartMs, Tokenizer tok)
        {
            var toks = new List<int>(); var owner = new List<int>();
            for (int w = 0; w < L.Words.Length; w++)
            {
                if (L.Instant[w]) continue;
                foreach (var part in Tokenizer.Spoken(L.Words[w]))
                    foreach (var id in tok.Encode(part)) { toks.Add(id); owner.Add(w); }
            }
            if (toks.Count == 0) return;
            double conf;
            var first = Ctc.Align(lp, f0, f1, toks.ToArray(), tok.Blank, out conf);
            L.Confidence = conf;
            if (first == null || conf < MinConfidence) return;
            for (int k = 0; k < first.Length; k++)
            {
                int w = owner[k];
                // a line's first word is the one most often caught early (a breath, the echo of the previous line)
                if (L.Times[w] < 0) L.Times[w] = (int)(clipStartMs + (f0 + first[k]) * Ctc.FrameMs + LatencyMs + (k == 0 ? FirstWordMs : 0));
            }
        }

        // The model over a long clip in ~10 s pieces (1 s of overlap each side), so memory stays small.
        static float[,] RunChunked(Ort model, float[] clip)
        {
            const int Piece = 10 * 16000, Over = 16000;
            if (clip.Length <= Piece + 2 * Over) { int T0; var f0 = Fbank.Compute(clip, clip.Length, out T0); return T0 < 4 ? null : model.Run(f0, T0); }
            var rows = new List<float[]>(); int vocab = 0;
            for (int s0 = 0; s0 < clip.Length; s0 += Piece)
            {
                int a = Math.Max(0, s0 - Over), b = Math.Min(clip.Length, s0 + Piece + Over);
                var part = new float[b - a]; Array.Copy(clip, a, part, 0, b - a);
                int T; var feats = Fbank.Compute(part, part.Length, out T);
                if (T < 4) break;
                var lp = model.Run(feats, T);
                int F = lp.GetLength(0); vocab = lp.GetLength(1);
                int keepFrom = (s0 - a) / 640, keepTo = Math.Min(F, keepFrom + Piece / 640);
                if (b == clip.Length) keepTo = F;
                for (int f = keepFrom; f < keepTo; f++) { var r = new float[vocab]; for (int v = 0; v < vocab; v++) r[v] = lp[f, v]; rows.Add(r); }
                if (b == clip.Length) break;
            }
            if (rows.Count == 0) return null;
            var res = new float[rows.Count, vocab];
            for (int f = 0; f < rows.Count; f++) Buffer.BlockCopy(rows[f], 0, res, f * vocab * 4, vocab * 4);
            return res;
        }

        static void AlignLine(LineWords L, float[] clip, long clipStartMs, Ort model, Tokenizer tok)
        {
            var toks = new List<int>(); var owner = new List<int>();
            for (int w = 0; w < L.Words.Length; w++)
            {
                if (L.Instant[w]) continue;
                foreach (var part in Tokenizer.Spoken(L.Words[w]))
                    foreach (var id in tok.Encode(part)) { toks.Add(id); owner.Add(w); }
            }
            if (toks.Count == 0) return;
            int T;
            var feats = Fbank.Compute(clip, clip.Length, out T);
            if (T < 4) return;
            var lp = model.Run(feats, T);
            double conf;
            var first = Ctc.Align(lp, toks.ToArray(), tok.Blank, out conf);
            L.Confidence = conf;
            if (first == null || conf < MinConfidence) return;
            for (int k = 0; k < first.Length; k++)
            {
                int w = owner[k];
                if (L.Times[w] < 0) L.Times[w] = (int)(clipStartMs + first[k] * Ctc.FrameMs + LatencyMs);
            }
        }

        // Subtitles that run early or late against this film (another release, a different intro) leave each line's
        // speech outside the ±0.3 s searched around it. Sample lines across the film, run the model on ±15 s around
        // each, score every shift in 0.2 s steps, and if most lines agree on one shift, use it for all.
        // readClip(startMs, durMs) returns the dialogue audio (16 kHz) of that stretch.
        public static int DetectOffset(List<LineWords> lines, Func<int, int, float[]> readClip, Ort model, Tokenizer tok, Action<float> progress)
        {
            double scale;
            return DetectOffset(lines, readClip, model, tok, progress, out scale);
        }

        // Frame-rate mismatches make subtitles drift (made for 25 fps, played on 23.976): right at the start, seconds
        // out by the end. When no single shift fits, these ratios are tried too: subtitle time x scale + offset.
        static readonly double[] Scales = { 25 / 23.976, 23.976 / 25, 25 / 24.0, 24 / 25.0, 24 / 23.976, 23.976 / 24 };

        public static int DetectOffset(List<LineWords> lines, Func<int, int, float[]> readClip, Ort model, Tokenizer tok, Action<float> progress, out double scale)
        {
            scale = 1;
            var cand = new List<KeyValuePair<LineWords, int[]>>();
            foreach (var L in lines)
            {
                var toks = new List<int>();
                for (int w = 0; w < L.Words.Length; w++)
                    if (!L.Instant[w]) foreach (var part in Tokenizer.Spoken(L.Words[w])) toks.AddRange(tok.Encode(part));
                if (toks.Count >= 8 && L.End - L.Start >= 800) cand.Add(new KeyValuePair<LineWords, int[]>(L, toks.ToArray()));
            }
            if (cand.Count < 6) return 0;
            // Usual cases first, cheaply: in sync, or off by under 2 s.
            var quick = QuickOffset(cand, readClip, model, tok);
            if (quick.HasValue) return quick.Value;
            bool inSync;
            int off = TryScale(cand, 1.0, readClip, model, tok, f => progress(f * 0.5f), true, out inSync);
            if (inSync) return 0;
            if (off != int.MinValue) return off;
            // No single shift: try the frame-rate ratios on a few lines each, keep the one most lines agree on.
            for (int k = 0; k < Scales.Length; k++)
            {
                int o = TryScale(cand, Scales[k], readClip, model, tok, f => progress(0.5f + (k + f) / Scales.Length * 0.5f), false, out inSync);
                if (o != int.MinValue) { scale = Scales[k]; return o; }
            }
            return 0;
        }

        // The usual cases, cheaply: subtitles in sync, or off by up to 2 s (a common release-to-release difference).
        // 16 lines spread over the film, each searched +-2 s around where the subtitles put it: each gives the shift
        // from where its speech starts (as TryScale does). If most agree, that's the answer: 0 when within 0.25 s,
        // else the shift (within 0.3 s the line windows absorb it anyway). No absolute confidence threshold, so echoey or noisy films are judged as fairly as clean ones.
        // Returns null when the lines don't agree (bigger shift, drift, or other subtitles): the full search follows.
        static int? QuickOffset(List<KeyValuePair<LineWords, int[]>> cand, Func<int, int, float[]> readClip, Ort model, Tokenizer tok)
        {
            const int Range = 2000, Step = 100;
            var shifts = new List<int>();
            int want = Math.Min(16, cand.Count);
            for (int k = 0; k < want; k++)
            {
                var c = cand[(int)((k + 0.5) * cand.Count / want)];
                var L = c.Key;
                int a = Math.Max(0, L.Start - Range - 300), b = L.End + Range + 300;
                var clip = readClip(a, b - a);
                if (clip == null || clip.Length < 16000) continue;
                var lp = RunChunked(model, clip);
                if (lp == null) continue;
                int F = lp.GetLength(0);
                double best = double.NegativeInfinity; int bestOnset = 0;
                var confs = new List<double>();
                for (int d = -Range; d <= Range; d += Step)
                {
                    int f0 = (L.Start + d - 300 - a) / Ctc.FrameMs, f1 = (L.End + d + 300 - a) / Ctc.FrameMs;
                    if (f0 < 0 || f1 > F || f1 - f0 < c.Value.Length) continue;
                    double conf;
                    var first = Ctc.Align(lp, f0, f1, c.Value, tok.Blank, out conf);
                    if (first == null) continue;
                    confs.Add(conf);
                    if (conf > best) { best = conf; bestOnset = a + (f0 + first[0]) * Ctc.FrameMs + LatencyMs; }
                }
                if (confs.Count < 10) continue;
                // a real find stands out from the typical window (the words heard, not just any speech)
                confs.Sort();
                if (best - confs[confs.Count / 2] < 0.5) continue;
                shifts.Add(bestOnset - L.Start - 150);
            }
            if (Environment.GetEnvironmentVariable("SPOIL_DEBUG") == "1") Console.Error.WriteLine("quick shifts: " + string.Join(" ", shifts.ConvertAll(x => x.ToString()).ToArray()));
            if (shifts.Count < 6) return null;
            shifts.Sort();
            int med = shifts[shifts.Count / 2];
            var near = shifts.FindAll(x => Math.Abs(x - med) <= 400);
            if (near.Count < Math.Max(6, shifts.Count * 0.6)) return null;
            double mean = 0; foreach (var x in near) mean += x; mean /= near.Count;
            if (Math.Abs(mean) < 300) return 0;
            if (Math.Abs(mean) > Range - 300) return null;  // near the edge of the search: let the full search confirm it
            return (int)Math.Round(mean / 10) * 10;
        }

        // Returns the shift that most sampled lines agree on at this scale, or int.MinValue if they don't agree.
        static int TryScale(List<KeyValuePair<LineWords, int[]>> cand, double sc, Func<int, int, float[]> readClip, Ort model, Tokenizer tok,
            Action<float> progress, bool full, out bool inSync)
        {
            const int Range = 15000, Step = 200;
            inSync = false;
            int want = Math.Min(full ? 30 : 12, cand.Count);
            var bestShifts = new List<int>();
            for (int k = 0; k < want; k++)
            {
                var c = cand[(int)((k + 0.5) * cand.Count / want)];
                var L = c.Key;
                int st = (int)Math.Round(L.Start * sc), en = (int)Math.Round(L.End * sc);
                int a = Math.Max(0, st - Range - 300), b = en + Range + 300;
                var clip = readClip(a, b - a);
                progress((k + 1f) / want);
                if (clip == null || clip.Length < 16000) continue;
                var lp = RunChunked(model, clip);
                if (lp == null) continue;
                int F = lp.GetLength(0);
                double best = double.NegativeInfinity; int bestOnset = 0;
                for (int d = -Range; d <= Range; d += Step)
                {
                    int f0 = (st + d - 300 - a) / Ctc.FrameMs, f1 = (en + d + 300 - a) / Ctc.FrameMs;
                    if (f0 < 0 || f1 > F || f1 - f0 < c.Value.Length) continue;
                    double conf;
                    var first = Ctc.Align(lp, f0, f1, c.Value, tok.Blank, out conf);
                    if (first == null) continue;
                    if (conf > best) { best = conf; bestOnset = a + (f0 + first[0]) * Ctc.FrameMs + LatencyMs; }
                }
                // The window only finds the line (many shifts fit it equally); the shift is where its speech starts,
                // against the subtitle appearing (subtitlers put it ~0.15 s ahead of the voice).
                if (best > -2.5) bestShifts.Add(bestOnset - st - 150);
            }
            if (bestShifts.Count < 5) return int.MinValue;
            bestShifts.Sort();
            int med = bestShifts[bestShifts.Count / 2], agree = 0;
            foreach (var d in bestShifts) if (Math.Abs(d - med) <= 400) agree++;
            if (agree < Math.Max(5, bestShifts.Count * 0.6)) return int.MinValue;
            if (sc == 1.0 && Math.Abs(med) < 400) { inSync = true; return 0; }
            double sum = 0; int n = 0;
            foreach (var d in bestShifts) if (Math.Abs(d - med) <= 400) { sum += d; n++; }
            return (int)Math.Round(sum / n / 10) * 10;
        }

        public static void Shift(List<LineWords> lines, int offsetMs, double scale = 1)
        {
            foreach (var L in lines) { L.Start = (int)Math.Round(L.Start * scale) + offsetMs; L.End = (int)Math.Round(L.End * scale) + offsetMs; }
        }

        public static void WriteResult(string path, string hash, List<LineWords> lines, int offsetMs = 0, double scale = 1)
        {
            var sb = new StringBuilder();
            sb.Append("hash=").Append(hash).Append("\r\n");
            if (offsetMs != 0 || scale != 1) sb.Append("offset=").Append(offsetMs).Append("\r\n");
            if (scale != 1) sb.Append("scale=").Append(scale.ToString("0.000000", CultureInfo.InvariantCulture)).Append("\r\n");
            foreach (var L in lines)
            {
                bool ok = L.Confidence >= MinConfidence;
                sb.Append(ok ? "1" : "0").Append('\t').Append(double.IsInfinity(L.Confidence) ? "-99" : L.Confidence.ToString("0.00", CultureInfo.InvariantCulture)).Append('\t');
                for (int i = 0; i < L.Times.Length; i++) { if (i > 0) sb.Append(','); sb.Append(ok ? L.Times[i] : -1); }
                sb.Append("\r\n");
            }
            File.WriteAllText(path + ".tmp", sb.ToString());
            if (File.Exists(path)) File.Delete(path);
            File.Move(path + ".tmp", path);
        }
    }
}
