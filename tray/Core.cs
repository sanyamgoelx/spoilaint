// Spoilaint tray app: the background side of Spoilaint on Windows.
// Runs ffmpeg for VLC (speech sync, subtitles inside .mkv files) with no console windows,
// shows what it's doing, and keeps the settings and the browser-extension setup one click away.
//
// VLC's script (vlc/spoilaint.lua) talks to it through files in %LOCALAPPDATA%\Spoilaint\jobs:
//   <base>.speech.job / <base>.extract.job   key=value lines ending with end=1 (written by VLC)
//   <base>.result                            how many lines matched speech (written by VLC)
//   ..\helper.alive                          unix time, rewritten every 2 s (so VLC knows we're running)
// Outputs go exactly where the old console script put them, so the VLC side reads them the same way.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace Spoilaint
{
    static class Paths
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        public static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Spoilaint");
        public static string Jobs { get { return Path.Combine(Data, "jobs"); } }
        public static string Alive { get { return Path.Combine(Data, "helper.alive"); } }
        public static string AppIni { get { return Path.Combine(Data, "app.ini"); } }
        public static string Recent { get { return Path.Combine(Data, "recent.txt"); } }
        public static readonly string VlcDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "vlc");
        public static string VlcIni { get { return Path.Combine(VlcDir, "spoilaint.ini"); } }
        public static string VlcRc { get { return Path.Combine(VlcDir, "vlcrc"); } }
        public static string VlcLog { get { return Path.Combine(VlcDir, "spoilaint.log"); } }
        public static string VlcScript { get { return Path.Combine(VlcDir, "lua", "intf", "spoilaint.lua"); } }
        public static string SetupPage { get { return Path.Combine(AppDir, "setup-extension.html"); } }
        public static string ConfigureScript { get { return Path.Combine(AppDir, "configure-vlc.ps1"); } }

        public static string Ffmpeg()
        {
            string local = Path.Combine(AppDir, "ffmpeg.exe");
            if (File.Exists(local)) return local;
            string fromIni = new Ini(VlcIni).Get("ffmpeg", "");
            if (fromIni != "" && File.Exists(fromIni)) return fromIni;
            return "ffmpeg";
        }
    }

    // key=value file that keeps comments and unknown lines as they are.
    class Ini
    {
        readonly string path;
        readonly List<string> lines = new List<string>();
        public Ini(string path)
        {
            this.path = path;
            try { if (File.Exists(path)) lines.AddRange(File.ReadAllLines(path, Encoding.UTF8)); } catch { }
        }
        int Find(string key)
        {
            for (int i = 0; i < lines.Count; i++)
            {
                string l = lines[i].TrimStart();
                if (l.StartsWith("#")) continue;
                int eq = l.IndexOf('=');
                if (eq > 0 && l.Substring(0, eq).Trim() == key) return i;
            }
            return -1;
        }
        public string Get(string key, string def)
        {
            int i = Find(key);
            if (i < 0) return def;
            return lines[i].Substring(lines[i].IndexOf('=') + 1).Trim();
        }
        public int GetInt(string key, int def)
        {
            int v;
            return int.TryParse(Get(key, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : def;
        }
        public bool GetBool(string key, bool def)
        {
            string v = Get(key, "").ToLowerInvariant();
            if (v == "") return def;
            return v == "1" || v == "true" || v == "yes";
        }
        public void Set(string key, string value)
        {
            int i = Find(key);
            if (i >= 0) lines[i] = key + "=" + value; else lines.Add(key + "=" + value);
        }
        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllLines(path, lines.ToArray(), new UTF8Encoding(false));
            }
            catch { }
        }
    }

    static class Autostart
    {
        const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
        static string Command { get { return "\"" + Path.Combine(Paths.AppDir, "Spoilaint.exe") + "\" --background"; } }
        public static bool Enabled
        {
            get
            {
                try { using (var k = Registry.CurrentUser.OpenSubKey(Key)) return k != null && k.GetValue("Spoilaint") != null; }
                catch { return false; }
            }
            set
            {
                try
                {
                    using (var k = Registry.CurrentUser.CreateSubKey(Key))
                    {
                        if (value) k.SetValue("Spoilaint", Command); else k.DeleteValue("Spoilaint", false);
                    }
                }
                catch { }
            }
        }
    }

    static class VlcCheck
    {
        public static bool Installed()
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (var hk = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    using (var k = hk.OpenSubKey(@"Software\VideoLAN\VLC"))
                        if (k != null && k.GetValue("InstallDir") != null) return true;
                }
                catch { }
            }
            return false;
        }
        public static bool Configured()
        {
            try
            {
                if (!File.Exists(Paths.VlcScript) || !File.Exists(Paths.VlcRc)) return false;
                foreach (var l in File.ReadAllLines(Paths.VlcRc)) if (l.Trim() == "lua-intf=spoilaint") return true;
            }
            catch { }
            return false;
        }
        public static void Configure()
        {
            Tools.RunHidden("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Paths.ConfigureScript + "\"", null, 30000);
        }
    }

    // Background work must never make the PC feel slow: lowest CPU priority (Idle class: only leftover CPU),
    // very low disk priority (reading a big film can't starve VLC or other apps of the disk), and Windows 11's
    // efficiency mode (EcoQoS: efficiency cores, low clocks). Every call is best effort.
    static class Gentle
    {
        [System.Runtime.InteropServices.DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref PowerThrottling info, int len);
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        struct PowerThrottling { public uint Version, ControlMask, StateMask; }

        public static void Apply(Process p, bool on)
        {
            if (p == null) return;
            try { p.PriorityClass = on ? ProcessPriorityClass.Idle : ProcessPriorityClass.Normal; } catch { }
            if (System.IO.Path.DirectorySeparatorChar != '\\') return;
            try { int io = on ? 0 : 2; NtSetInformationProcess(p.Handle, 33, ref io, 4); } catch { }   // ProcessIoPriority: 0 very low, 2 normal
            try { int page = on ? 1 : 5; NtSetInformationProcess(p.Handle, 39, ref page, 4); } catch { } // ProcessPagePriority
            try
            {
                var t = new PowerThrottling { Version = 1, ControlMask = 1, StateMask = on ? 1u : 0u }; // EXECUTION_SPEED
                SetProcessInformation(p.Handle, 4, ref t, 12); // ProcessPowerThrottling
            }
            catch { }
        }
    }

    static class Tools
    {
        public static void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
        }
        public static string RunHidden(string exe, string args, string dir, int timeoutMs)
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardError = true, RedirectStandardOutput = true,
                StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = Encoding.UTF8
            };
            if (dir != null) psi.WorkingDirectory = dir;
            var sb = new StringBuilder();
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                    p.Start();
                    p.BeginOutputReadLine(); p.BeginErrorReadLine();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } }
                    p.WaitForExit();
                }
            }
            catch (Exception e) { return "ERROR " + e.Message; }
            lock (sb) return sb.ToString();
        }
    }

    class Job
    {
        public string Name, Id, Task, Video, Dir, Base, Title, Out;
        public volatile float Progress = -1;   // 0..1, or -1 while unknown
        public volatile string Phase = "Waiting";
        public DateTime Started = DateTime.Now;
        public double SecondsLeft = -1;
        public int Pos;             // align jobs: where the viewer is in the film (ms), done first
        public int Offset;          // align jobs: how far the subtitles were shifted to fit the film (ms)
        public double Scale = 1;    // ... and stretched (frame-rate mismatch)

        public static Job Parse(string file)
        {
            string text;
            try { text = File.ReadAllText(file, Encoding.UTF8); } catch { return null; }
            var d = new Dictionary<string, string>();
            foreach (var raw in text.Split('\n'))
            {
                string l = raw.TrimEnd('\r');
                int eq = l.IndexOf('=');
                if (eq > 0) d[l.Substring(0, eq)] = l.Substring(eq + 1);
            }
            string v;
            if (!d.TryGetValue("end", out v)) return null; // still being written
            Func<string, string> g = k => d.TryGetValue(k, out v) ? v : null;
            var j = new Job { Name = Path.GetFileName(file), Id = g("id"), Task = g("task"), Video = g("video"), Dir = g("dir"), Base = g("base"), Title = g("title"), Out = g("out") };
            int pos; if (int.TryParse(g("pos") ?? "", out pos)) j.Pos = pos;
            if (j.Task == null || j.Video == null) return null;
            if (string.IsNullOrEmpty(j.Title)) j.Title = Path.GetFileNameWithoutExtension(j.Video);
            else j.Title = Path.GetFileNameWithoutExtension(j.Title);
            return j;
        }
    }

    class Result
    {
        public string Base, Title;
        public int Synced, Count;
        public bool Cached;
    }

    class JobRunner
    {
        public event Action<Job> Changed;               // progress / phase of the running speech job
        public event Action<Job, bool, string> Finished; // job, ok, short message
        public event Action<Result> ResultArrived;

        readonly BlockingCollection<Job> speech = new BlockingCollection<Job>();
        readonly BlockingCollection<Job> extract = new BlockingCollection<Job>();
        readonly HashSet<string> seen = new HashSet<string>();
        FileSystemWatcher watcher;
        Timer poll, beat;
        public volatile Job Current;
        public int Queued { get { return speech.Count; } }

        public void Start()
        {
            Directory.CreateDirectory(Paths.Jobs);
            beat = new Timer(_ => Heartbeat(), null, 0, 2000);
            new Thread(() => Worker(speech)) { IsBackground = true, Name = "speech" }.Start();
            new Thread(() => Worker(extract)) { IsBackground = true, Name = "extract" }.Start();
            try
            {
                watcher = new FileSystemWatcher(Paths.Jobs) { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite };
                FileSystemEventHandler h = (s, e) => Scan();
                watcher.Created += h; watcher.Changed += h; watcher.Renamed += (s, e) => Scan();
                watcher.EnableRaisingEvents = true;
            }
            catch { }
            poll = new Timer(_ => Scan(), null, 300, 1500); // the watcher can miss events
        }

        public void Stop()
        {
            try { File.Delete(Paths.Alive); } catch { }
        }

        void Heartbeat()
        {
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds;
            // "align" tells VLC that this app can match words to speech with the speech model.
            // Written to a temp file and swapped in, so VLC never reads it half-written.
            try
            {
                string tmp = Paths.Alive + ".tmp";
                File.WriteAllText(tmp, now.ToString(CultureInfo.InvariantCulture) + (Aligner.Available ? " align" : ""));
                if (File.Exists(Paths.Alive)) File.Replace(tmp, Paths.Alive, null); else File.Move(tmp, Paths.Alive);
            }
            catch { }
        }

        readonly object scanLock = new object();
        void Scan()
        {
            if (!Monitor.TryEnter(scanLock)) return;
            try
            {
                foreach (var f in SafeList("*.job"))
                {
                    var j = Job.Parse(f);
                    if (j == null) continue;
                    try { File.Delete(f); } catch { continue; } // claim it
                    string key = j.Name + "|" + j.Id;
                    lock (seen) { if (!seen.Add(key)) continue; }
                    if (j.Task == "extract") extract.Add(j); else speech.Add(j);
                }
                foreach (var f in SafeList("*.result"))
                {
                    var r = ReadResult(f);
                    if (r == null) continue;
                    try { File.Delete(f); } catch { }
                    var h = ResultArrived; if (h != null) h(r);
                }
            }
            finally { Monitor.Exit(scanLock); }
        }

        static string[] SafeList(string pattern)
        {
            try { return Directory.GetFiles(Paths.Jobs, pattern); } catch { return new string[0]; }
        }

        static Result ReadResult(string f)
        {
            string text;
            try { text = File.ReadAllText(f, Encoding.UTF8); } catch { return null; }
            if (!text.Contains("end=1")) return null;
            var r = new Result();
            foreach (var raw in text.Split('\n'))
            {
                string l = raw.TrimEnd('\r'); int eq = l.IndexOf('='); if (eq < 0) continue;
                string k = l.Substring(0, eq), v = l.Substring(eq + 1);
                if (k == "base") r.Base = v;
                else if (k == "title") r.Title = Path.GetFileNameWithoutExtension(v);
                else if (k == "synced") int.TryParse(v, out r.Synced);
                else if (k == "count") int.TryParse(v, out r.Count);
                else if (k == "cached") r.Cached = v == "1";
            }
            return r.Base == null ? null : r;
        }

        void Worker(BlockingCollection<Job> q)
        {
            foreach (var j in q.GetConsumingEnumerable())
            {
                bool ok = false; string msg = "";
                try
                {
                    if (j.Task == "extract") ok = RunExtract(j, out msg);
                    else if (j.Task == "align") { Current = j; Raise(j); ok = RunAlign(j, out msg); }
                    else { Current = j; Raise(j); ok = RunSpeech(j, out msg); }
                }
                catch (Exception e) { msg = e.Message; }
                if (j.Task != "extract") Current = null;
                var h = Finished; if (h != null) h(j, ok, msg);
            }
        }

        void Raise(Job j) { var h = Changed; if (h != null) h(j); }

        // ---- ffmpeg -------------------------------------------------------------------------
        static readonly Regex DurationRe = new Regex(@"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)");
        static readonly Regex AudioRe = new Regex(@"Stream #\d+:\d+.*?: Audio: (.*)");

        static string Probe(string video)
        {
            return Tools.RunHidden(Paths.Ffmpeg(), "-hide_banner -nostdin -i \"" + video + "\"", null, 60000);
        }

        // Must stay identical to FILTER_TAIL in vlc/spoilaint.lua.
        const string FilterTail = "aresample=16000,highpass=f=250,lowpass=f=3500,asetnsamples=n=320:p=0," +
            "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level," +
            "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=";

        bool RunSpeech(Job j, out string msg)
        {
            string dir = j.Dir, b = j.Base;
            string tmp = b + ".speech.tmp", final = Path.Combine(dir, b + ".speech.txt");
            string done = Path.Combine(dir, b + ".speech.done"), err = Path.Combine(dir, b + ".speech.err");
            j.Phase = "Getting ready"; Raise(j);
            string probe = Probe(j.Video);
            double total = 0;
            var dm = DurationRe.Match(probe);
            if (dm.Success)
                total = (int.Parse(dm.Groups[1].Value) * 3600 + int.Parse(dm.Groups[2].Value) * 60) +
                        double.Parse(dm.Groups[3].Value, CultureInfo.InvariantCulture);
            // Dialogue lives in the centre channel of 5.1/7.1; in stereo it sits in the middle.
            string pan = "pan=mono|c0=0.5*FL+0.5*FR";
            var am = AudioRe.Match(probe);
            if (am.Success)
            {
                string a = am.Groups[1].Value;
                if (Regex.IsMatch(a, @"\b[5-7]\.1\b")) pan = "pan=mono|c0=FC";
                else if (a.Contains("mono")) pan = "anull";
            }
            else if (!probe.Contains("Stream"))
            {
                msg = "ffmpeg couldn't read the file";
                try { File.WriteAllText(err, probe); File.WriteAllText(done, "done"); } catch { }
                return false;
            }

            j.Phase = "Listening to the dialogue"; j.Progress = 0; Raise(j);
            string args = "-nostdin -v error -y -progress pipe:1 -nostats -i \"" + j.Video + "\" -map 0:a:0 -vn -sn -dn -af \"" +
                pan + "," + FilterTail + tmp + "\" -f null -";
            var psi = new ProcessStartInfo(Paths.Ffmpeg(), args)
            {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardError = true, RedirectStandardOutput = true, WorkingDirectory = dir,
                StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = Encoding.UTF8
            };
            var errText = new StringBuilder();
            var sw = Stopwatch.StartNew();
            long lastRaise = 0;
            int code;
            using (var p = new Process { StartInfo = psi })
            {
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (errText) errText.AppendLine(e.Data); };
                p.OutputDataReceived += (s, e) =>
                {
                    if (e.Data == null || total <= 0) return;
                    string l = e.Data;
                    if (!(l.StartsWith("out_time_us=") || l.StartsWith("out_time_ms="))) return;
                    long us;
                    if (!long.TryParse(l.Substring(12), out us) || us < 0) return;
                    float prog = (float)Math.Min(1.0, us / 1e6 / total);
                    j.Progress = prog;
                    double el = sw.Elapsed.TotalSeconds;
                    j.SecondsLeft = prog > 0.03 ? el / prog * (1 - prog) : -1;
                    if (sw.ElapsedMilliseconds - lastRaise > 200) { lastRaise = sw.ElapsedMilliseconds; Raise(j); }
                };
                p.Start();
                Gentle.Apply(p, true); // never stutter playback
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                if (!p.WaitForExit(30 * 60 * 1000)) { try { p.Kill(); } catch { } }
                p.WaitForExit();
                code = p.ExitCode;
            }
            string tmpPath = Path.Combine(dir, tmp);
            try
            {
                lock (errText) File.WriteAllText(err, errText.ToString());
                if (File.Exists(tmpPath))
                {
                    if (File.Exists(final)) File.Delete(final);
                    File.Move(tmpPath, final);
                }
                File.WriteAllText(done, "done");
            }
            catch (Exception e) { msg = e.Message; return false; }
            j.Progress = 1; j.Phase = "Done"; Raise(j);
            bool ok = File.Exists(final) && new FileInfo(final).Length > 100;
            msg = ok ? string.Format("{0:0} s of audio in {1:0} s", total, sw.Elapsed.TotalSeconds) : "No speech track found";
            return ok;
        }

        static string PanFor(string probe)
        {
            // Dialogue lives in the centre channel of 5.1/7.1; in stereo it sits in the middle.
            var am = AudioRe.Match(probe);
            if (am.Success)
            {
                string a = am.Groups[1].Value;
                if (Regex.IsMatch(a, @"\b[5-7]\.1\b")) return "pan=mono|c0=FC";
                if (a.Contains("mono")) return "anull";
            }
            return "pan=mono|c0=0.5*FL+0.5*FR";
        }

        // Matches every subtitle word to the moment it is spoken (speech model). Words file in j.Out.
        bool RunAlign(Job j, out string msg)
        {
            string resultPath = Path.Combine(j.Dir, j.Base + ".align.txt");
            string done = Path.Combine(j.Dir, j.Base + ".align.done"), err = Path.Combine(j.Dir, j.Base + ".align.err");
            try { File.Delete(done); File.Delete(err); } catch { }
            var sw = Stopwatch.StartNew();
            var proc = Process.GetCurrentProcess();
            Gentle.Apply(proc, true); // never stutter playback
            try
            {
                j.Phase = "Getting ready"; Raise(j);
                string hash;
                var lines = Aligner.ReadWords(j.Out, out hash);
                string probe = Probe(j.Video);
                if (!probe.Contains("Audio:")) throw new Exception("no sound track found");
                var tok = new Tokenizer(Path.Combine(Aligner.ModelDir, "tokens.txt"));
                // At most half the logical cores (and 4); with Idle priority and no spinning they only take spare time.
                int threads = Math.Max(1, Math.Min(4, Environment.ProcessorCount / 2));
                using (var model = new Ort(Path.Combine(Aligner.ModelDir, "model.int8.onnx"), threads))
                {
                    // Are these subtitles shifted against this film? (Downloaded .srt files often are.)
                    j.Phase = "Checking the subtitles are in sync"; j.Progress = 0; Raise(j);
                    string pan = PanFor(probe);
                    double scale;
                    int offset = Aligner.DetectOffset(lines, (startMs, durMs) => ReadClip(j.Video, pan, startMs, durMs), model, tok, f => { j.Progress = f; Raise(j); }, out scale);
                    if (offset != 0 || scale != 1) Aligner.Shift(lines, offset, scale);
                    j.Offset = offset; j.Scale = scale;
                    // Start where the viewer is (VLC may resume a film midway): that stretch first, a partial
                    // result once the next 5 minutes are matched, then the rest of the film from the start.
                    string panF = PanFor(probe);
                    int pos = Math.Max(0, j.Pos - 10000);
                    if (pos < 60000) pos = 0;
                    var first = new List<LineWords>(); var rest = new List<LineWords>();
                    foreach (var l in lines) (l.Start >= pos ? first : rest).Add(l);
                    string partPath = Path.Combine(j.Dir, j.Base + ".align.part.txt"), partDone = Path.Combine(j.Dir, j.Base + ".align.part.done");
                    try { File.Delete(partDone); } catch { }
                    bool published = false;
                    int total = lines.Count, before = 0;
                    j.Phase = "Matching words to speech"; j.Progress = 0; Raise(j);
                    long lastRaise = 0;
                    Action<List<LineWords>, int, int> pass = (subset, fromMs, toMs) =>
                    {
                        if (subset.Count == 0) return;
                        int baseCount = before;
                        DecodeAndAlign(j, panF, fromMs, toMs, subset, model, tok, err, f =>
                        {
                            float all = (baseCount + f * subset.Count) / total;
                            j.Progress = all;
                            j.SecondsLeft = all > 0.03 ? sw.Elapsed.TotalSeconds / all * (1 - all) : -1;
                            if (sw.ElapsedMilliseconds - lastRaise > 250) { lastRaise = sw.ElapsedMilliseconds; Raise(j); }
                        }, lineStart =>
                        {
                            if (!published && subset == first && lineStart > pos + 300000)
                            {
                                published = true;
                                Aligner.WriteResult(partPath, hash, lines, j.Offset, j.Scale);
                                File.WriteAllText(partDone, "ok\r\nid=" + j.Id + "\r\n");
                            }
                        });
                        before += subset.Count;
                    };
                    pass(first, pos, -1);
                    if (rest.Count > 0 && !published && pos > 0)
                    {
                        Aligner.WriteResult(partPath, hash, lines, j.Offset, j.Scale);
                        File.WriteAllText(partDone, "ok\r\nid=" + j.Id + "\r\n");
                    }
                    int restEnd = pos;
                    foreach (var l in rest) restEnd = Math.Max(restEnd, l.End);
                    pass(rest, 0, restEnd + 1500); // through the end of the last line before the split
                }
                Aligner.WriteResult(resultPath, hash, lines, j.Offset, j.Scale);
                int ok = 0;
                foreach (var l in lines) if (l.Confidence >= Aligner.MinConfidence) ok++;
                File.WriteAllText(done, "ok\r\nid=" + j.Id + "\r\n");
                j.Progress = 1; j.Phase = "Done"; Raise(j);
                msg = string.Format("{0} of {1} lines matched in {2:0} s", ok, lines.Count, sw.Elapsed.TotalSeconds) +
                      (j.Scale != 1 ? " · subtitles drifted (made for another frame rate), fixed" :
                       j.Offset != 0 ? string.Format(" · subtitles were {0:0.0} s {1}, fixed", Math.Abs(j.Offset) / 1000.0, j.Offset > 0 ? "early" : "late") : "");
                return ok > 0;
            }
            catch (Exception e)
            {
                msg = e.Message;
                try { File.AppendAllText(err, "\r\n" + e); File.WriteAllText(done, "fail\r\nid=" + j.Id + "\r\n"); } catch { }
                return false;
            }
            finally { Gentle.Apply(proc, false); }
        }

        // Decodes the film's dialogue from fromMs (to toMs, or the end) with ffmpeg, gently, and aligns the lines in it.
        static void DecodeAndAlign(Job j, string pan, int fromMs, int toMs, List<LineWords> subset, Ort model, Tokenizer tok, string err,
            Action<float> progress, Action<int> afterLine)
        {
            string range = (fromMs > 0 ? string.Format(CultureInfo.InvariantCulture, "-ss {0:0.000} ", fromMs / 1000.0) : "") +
                           (toMs > 0 ? string.Format(CultureInfo.InvariantCulture, "-t {0:0.000} ", (toMs - fromMs) / 1000.0) : "");
            var psi = new ProcessStartInfo(Paths.Ffmpeg(), "-nostdin -v error " + range + "-i \"" + j.Video + "\" -map 0:a:0 -vn -sn -dn -af \"" +
                pan + ",aresample=16000\" -ac 1 -f s16le -")
            {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true, StandardErrorEncoding = Encoding.UTF8
            };
            var errText = new StringBuilder();
            using (var p = new Process { StartInfo = psi })
            {
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (errText) errText.AppendLine(e.Data); };
                p.Start();
                Gentle.Apply(p, true);
                p.BeginErrorReadLine();
                var st = p.StandardOutput.BaseStream;
                var bytes = new byte[32000];
                Func<float[], int, int> read = (dst, max) =>
                {
                    int want = Math.Min(max * 2, bytes.Length), got = 0;
                    while (got < want) { int r = st.Read(bytes, got, want - got); if (r <= 0) break; got += r; }
                    int n = got / 2;
                    for (int i = 0; i < n; i++) dst[i] = (short)(bytes[2 * i] | (bytes[2 * i + 1] << 8)) / 32768f;
                    return n;
                };
                Aligner.Run(subset, read, model, tok, progress, fromMs, afterLine);
                try { if (!p.HasExited) p.Kill(); } catch { }
                p.WaitForExit(5000);
                lock (errText) File.AppendAllText(err, errText.ToString());
            }
        }

        // A stretch of the film's dialogue at 16 kHz mono (null if it can't be read).
        static float[] ReadClip(string video, string pan, int startMs, int durMs)
        {
            var psi = new ProcessStartInfo(Paths.Ffmpeg(), string.Format(CultureInfo.InvariantCulture,
                "-nostdin -v error -ss {0:0.000} -t {1:0.000} -i \"{2}\" -map 0:a:0 -vn -sn -dn -af \"{3},aresample=16000\" -ac 1 -f s16le -",
                startMs / 1000.0, durMs / 1000.0, video, pan))
            { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true };
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.ErrorDataReceived += (s, e) => { };
                    p.Start(); Gentle.Apply(p, true); p.BeginErrorReadLine();
                    var ms = new MemoryStream();
                    p.StandardOutput.BaseStream.CopyTo(ms);
                    p.WaitForExit(30000);
                    var b = ms.ToArray();
                    var f = new float[b.Length / 2];
                    for (int i = 0; i < f.Length; i++) f[i] = (short)(b[2 * i] | (b[2 * i + 1] << 8)) / 32768f;
                    return f;
                }
            }
            catch { return null; }
        }

        static readonly HashSet<string> TextCodecs = new HashSet<string> { "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text" };
        static readonly Regex SubRe = new Regex(@"Stream #0:(\d+)(?:\((\w*)\))?[^:]*: Subtitle: (\w+)");

        // Same choice as the VLC script made: English first, forced tracks last.
        bool RunExtract(Job j, out string msg)
        {
            string marker = j.Out + ".done";
            string probe = Probe(j.Video);
            string best = null; int bestScore = -1;
            foreach (var line in probe.Split('\n'))
            {
                var m = SubRe.Match(line);
                if (!m.Success || !TextCodecs.Contains(m.Groups[3].Value)) continue;
                int s = 1;
                string lang = m.Groups[2].Value;
                if (lang == "eng" || lang == "en") s += 10;
                if (line.ToLowerInvariant().Contains("forced")) s -= 5;
                if (s > bestScore) { best = m.Groups[1].Value; bestScore = s; }
            }
            bool ok = false;
            if (best != null)
            {
                Tools.RunHidden(Paths.Ffmpeg(), "-hide_banner -nostdin -v error -y -i \"" + j.Video + "\" -map 0:" + best + " -c:s srt \"" + j.Out + "\"", null, 120000);
                ok = File.Exists(j.Out) && new FileInfo(j.Out).Length > 0;
            }
            msg = best == null ? "no text subtitles inside" : (ok ? "subtitles read" : "couldn't read subtitles");
            try { File.WriteAllText(marker, "id=" + j.Id + "\r\nok=" + (ok ? "1" : "0") + "\r\n"); } catch { }
            return ok;
        }
    }

    class RecentItem
    {
        public string Base, Title, Detail;
        public DateTime When;
        public bool Ok;
    }

    static class RecentStore
    {
        public static List<RecentItem> Load()
        {
            var list = new List<RecentItem>();
            try
            {
                if (!File.Exists(Paths.Recent)) return list;
                foreach (var l in File.ReadAllLines(Paths.Recent, Encoding.UTF8))
                {
                    var p = l.Split('\t');
                    if (p.Length < 5) continue;
                    long ticks;
                    if (!long.TryParse(p[0], out ticks)) continue;
                    list.Add(new RecentItem { When = new DateTime(ticks), Base = p[1], Title = p[2], Ok = p[3] == "1", Detail = p[4] });
                }
            }
            catch { }
            return list;
        }
        public static void Save(List<RecentItem> list)
        {
            try
            {
                var lines = new List<string>();
                foreach (var r in list)
                    lines.Add(r.When.Ticks + "\t" + r.Base + "\t" + Clean(r.Title) + "\t" + (r.Ok ? "1" : "0") + "\t" + Clean(r.Detail));
                Directory.CreateDirectory(Paths.Data);
                File.WriteAllLines(Paths.Recent, lines.ToArray(), new UTF8Encoding(false));
            }
            catch { }
        }
        static string Clean(string s) { return (s ?? "").Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' '); }
    }
}
