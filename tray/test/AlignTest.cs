// mono AlignTest.exe MODEL_DIR media words.txt out.txt  (Linux test of the tray app's aligner)
using System; using System.Diagnostics; using System.IO;
namespace Spoilaint {
static class AlignTest {
    static string Pan = "pan=mono|c0=0.5*FL+0.5*FR";
    static int offset; static double scale = 1;
    static float[] Clip(string media, int st0, int du) {
        var psi = new ProcessStartInfo("ffmpeg", string.Format(System.Globalization.CultureInfo.InvariantCulture, "-v error -nostdin -ss {0:0.000} -t {1:0.000} -i \"{2}\" -map 0:a:0 -vn -sn -dn -af \"" + Pan + ",aresample=16000\" -f s16le -", st0 / 1000.0, du / 1000.0, media)) { UseShellExecute = false, RedirectStandardOutput = true };
        var p = Process.Start(psi); var ms = new MemoryStream(); p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit();
        var b = ms.ToArray(); var f = new float[b.Length / 2]; for (int i = 0; i < f.Length; i++) f[i] = (short)(b[2*i] | (b[2*i+1] << 8)) / 32768f; return f; }
    static void Main(string[] a) {
        var sw = Stopwatch.StartNew();
        var pr = Process.Start(new ProcessStartInfo("ffprobe", "-v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 \"" + a[1] + "\"") { UseShellExecute = false, RedirectStandardOutput = true });
        string ch = pr.StandardOutput.ReadToEnd().Trim(); pr.WaitForExit();
        if (ch == "6" || ch == "8") Pan = "pan=mono|c0=FC"; else if (ch == "1") Pan = "anull";
        string hash; var lines = Aligner.ReadWords(a[2], out hash);
        var tok = new Tokenizer(Path.Combine(a[0], "tokens.txt"));
        int th = int.Parse(Environment.GetEnvironmentVariable("SPOIL_THREADS") ?? "2");
        bool spin = Environment.GetEnvironmentVariable("SPOIL_SPIN") == "1";
        using (var ort = new Ort(Path.Combine(a[0], "model.int8.onnx"), th, spin)) {
            var psi = new ProcessStartInfo("ffmpeg", "-v error -nostdin -i \"" + a[1] + "\" -map 0:a:0 -vn -sn -dn -af \"" + Pan + ",aresample=16000\" -f s16le -") { UseShellExecute = false, RedirectStandardOutput = true };
            var p = Process.Start(psi); var st = p.StandardOutput.BaseStream; var bytes = new byte[32000];
            Func<float[], int, int> read = (dst, max) => {
                int want = Math.Min(max * 2, bytes.Length), got = 0;
                while (got < want) { int r = st.Read(bytes, got, want - got); if (r <= 0) break; got += r; }
                int n = got / 2; for (int i = 0; i < n; i++) dst[i] = (short)(bytes[2*i] | (bytes[2*i+1] << 8)) / 32768f; return n; };
            double sc = 1;
            int off = Environment.GetEnvironmentVariable("SPOIL_NOOFFSET") == "1" ? 0 : Aligner.DetectOffset(lines, (st0, du) => Clip(a[1], st0, du), ort, tok, f => {}, out sc);
            Console.WriteLine("offset " + off + " ms, scale " + sc);
            if (off != 0 || sc != 1) Aligner.Shift(lines, off, sc);
            scale = sc;
            Aligner.Run(lines, read, ort, tok, f => {});
            offset = off;
            try { p.Kill(); } catch { }
        }
        Aligner.WriteResult(a[3], hash, lines, offset, scale);
        int ok = 0; foreach (var l in lines) if (l.Confidence >= Aligner.MinConfidence) ok++;
        Console.WriteLine(Prof.Report());
        Console.WriteLine("aligned " + ok + " of " + lines.Count + " lines in " + sw.Elapsed.TotalSeconds.ToString("0.0") + " s");
    }
}}
