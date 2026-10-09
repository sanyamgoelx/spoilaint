// mono FuzzWords.exe TOKENS WORDSDIR -> every words file (written by fuzz.lua from the fuzz cases, plus hand-made broken
// ones) through the app's reader and tokenizer, as the app does before aligning. Exits 1 on any crash.
using System; using System.IO; using System.Collections.Generic; using System.Linq;
namespace Spoilaint {
static class FuzzWords {
    static int Main(string[] a) {
        var tok = new Tokenizer(a[0]);
        var files = Directory.GetFiles(a[1]).OrderBy(f => f).ToList();
        string extra = Path.Combine(Path.GetTempPath(), "sp_words_extra"); Directory.CreateDirectory(extra);
        var junk = new[] { "", "hash=\n", "hash=ab\n1\t2\n", "hash=ab\nx\ty\t0\tword\n", "hash=ab\n99999999999\t1\t0\tw\n", "hash=ab\n-5\t-1\t\t\n",
                           "hash=ab\n0\t1000\t111111111\ta\u001fb\n", "hash=ab\n0\t1000\t0\t٣ ३ ௩ 1999 ½ ⅷ\n", "hash=ab\n0\t1000\t0\t" + new string('9', 400) + "\n" };
        for (int i = 0; i < junk.Length; i++) { var p = Path.Combine(extra, "junk" + i + ".words.txt"); File.WriteAllText(p, junk[i]); files.Add(p); }
        int bad = 0, lines = 0, toks = 0;
        foreach (var f in files) {
            try {
                string hash;
                var ls = Aligner.ReadWords(f, out hash);
                foreach (var l in ls) {
                    lines++;
                    if (l.End < l.Start) throw new Exception("end before start");
                    foreach (var w in l.Words) foreach (var s in Tokenizer.Spoken(w)) toks += tok.Encode(s).Count;
                }
            } catch (Exception e) {
                bool expected = Path.GetFileName(f).StartsWith("junk");   // the app catches these and reports "couldn't read"
                if (!expected || f.Contains("junk7") || f.Contains("junk8") || f.Contains("junk6")) { bad++; Console.WriteLine("  " + Path.GetFileName(f) + ": " + e.GetType().Name + " " + e.Message); }
            }
        }
        Console.WriteLine(string.Format("app words reader: {0} files, {1} lines, {2} tokens, {3} problems", files.Count, lines, toks, bad));
        return bad > 0 ? 1 : 0;
    }
}}
