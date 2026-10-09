// Chromium browsers on this PC: which are installed, which is the default, opening their extensions page,
// and whether Spoilaint's extension folder is loaded in any of their profiles.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Spoilaint
{
    class Browser
    {
        public string Key;        // chrome, brave, edge
        public string Name;       // Chrome
        public string Exe;        // full path, or null if not installed
        public string Scheme;     // chrome://, brave://, edge://
        public string UserData;   // %LOCALAPPDATA%\...\User Data
        public string ProgId;     // default-browser ProgId prefix
        public bool Installed { get { return Exe != null; } }
        public string ExtensionsUrl { get { return Scheme + "extensions/"; } }
    }

    static class Browsers
    {
        static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        public static string ExtensionDir { get { return Path.Combine(Paths.AppDir, "extension"); } }

        public static List<Browser> All()
        {
            var list = new List<Browser>
            {
                new Browser { Key = "chrome", Name = "Chrome", Scheme = "chrome://", ProgId = "ChromeHTML",
                    UserData = Path.Combine(Local, @"Google\Chrome\User Data"), Exe = Find("chrome.exe", @"Google\Chrome\Application\chrome.exe") },
                new Browser { Key = "brave", Name = "Brave", Scheme = "brave://", ProgId = "BraveHTML",
                    UserData = Path.Combine(Local, @"BraveSoftware\Brave-Browser\User Data"), Exe = Find("brave.exe", @"BraveSoftware\Brave-Browser\Application\brave.exe") },
                new Browser { Key = "edge", Name = "Edge", Scheme = "edge://", ProgId = "MSEdgeHTM",
                    UserData = Path.Combine(Local, @"Microsoft\Edge\User Data"), Exe = Find("msedge.exe", @"Microsoft\Edge\Application\msedge.exe") },
            };
            return list;
        }

        public static List<Browser> Installed() { return All().Where(b => b.Installed).ToList(); }

        // App Paths (how Windows itself finds chrome.exe), then the usual install folders.
        static string Find(string exe, string rel)
        {
            foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (var k = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                    {
                        var v = k == null ? null : k.GetValue("") as string;
                        if (!string.IsNullOrEmpty(v)) { v = v.Trim('"'); if (File.Exists(v)) return v; }
                    }
                }
                catch { }
            }
            foreach (var root in new[] {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                Local })
            {
                if (string.IsNullOrEmpty(root)) continue;
                var p = Path.Combine(root, rel);
                if (File.Exists(p)) return p;
            }
            return null;
        }

        // The browser Windows opens links in, if it's one of ours.
        public static string DefaultKey()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"))
                {
                    var id = k == null ? "" : (k.GetValue("ProgId") as string ?? "");
                    foreach (var b in All()) if (id.StartsWith(b.ProgId, StringComparison.OrdinalIgnoreCase)) return b.Key;
                }
            }
            catch { }
            return null;
        }

        // Browsers ignore chrome://, brave:// and edge:// addresses passed on the command line (only web
        // addresses get through), and web pages can't link to them either. So: open a new browser window,
        // wait until it is in front, then type the address into its address bar (Ctrl+L, address, Enter).
        // Runs on a background thread; returns false if the window never came to the front.
        public static bool OpenExtensionsPage(Browser b)
        {
            if (b == null || !b.Installed) return false;
            string proc = Path.GetFileNameWithoutExtension(b.Exe);
            IntPtr before = Native.GetForegroundWindow();
            try { Process.Start(new ProcessStartInfo(b.Exe, "--new-window") { UseShellExecute = false }); }
            catch { return false; }
            // A fresh start can take a few seconds; a running browser opens its window almost at once.
            IntPtr win = IntPtr.Zero;
            var until = DateTime.Now.AddSeconds(12);
            while (DateTime.Now < until)
            {
                System.Threading.Thread.Sleep(150);
                var fg = Native.GetForegroundWindow();
                if (fg != IntPtr.Zero && fg != before && Native.IsBrowserWindow(fg, proc)) { win = fg; break; }
            }
            if (win == IntPtr.Zero) return false;
            System.Threading.Thread.Sleep(700); // let the new tab page settle so the address bar takes the keys
            if (Native.GetForegroundWindow() != win) return false;
            Native.KeyCombo(0x11, 0x4C);              // Ctrl+L: focus the address bar
            System.Threading.Thread.Sleep(120);
            if (Native.GetForegroundWindow() != win) return false;
            Native.TypeText(b.ExtensionsUrl);
            System.Threading.Thread.Sleep(80);
            Native.KeyCombo(0, 0x2E);                 // Delete: drop any inline autocomplete (e.g. an old ?id= address)
            System.Threading.Thread.Sleep(40);
            Native.KeyCombo(0, 0x0D);                 // Enter
            return true;
        }

        // Where a Spoilaint extension is loaded in this browser (any profile), or null.
        // Each profile's Secure Preferences / Preferences lists extensions with a "path": a full folder for
        // unpacked ones (Load unpacked), or "<id>\<version>" under the profile's Extensions folder for store
        // installs. A path counts if its manifest.json is named Spoilaint, so a copy loaded from any folder
        // (for example a development build) is found too. Cached by file time: polling costs next to nothing.
        static readonly Dictionary<string, KeyValuePair<DateTime, string>> cache = new Dictionary<string, KeyValuePair<DateTime, string>>();
        static readonly Regex PathRe = new Regex("\"path\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        static readonly Regex NameRe = new Regex("\"name\"\\s*:\\s*\"Spoilaint", RegexOptions.IgnoreCase);

        public static string FindSpoilaint(Browser b)
        {
            if (b == null || !Directory.Exists(b.UserData)) return null;
            try
            {
                foreach (var dir in Directory.GetDirectories(b.UserData))
                {
                    string name = Path.GetFileName(dir);
                    if (name != "Default" && !name.StartsWith("Profile ")) continue;
                    foreach (var f in new[] { "Secure Preferences", "Preferences" })
                    {
                        string hit = Scan(Path.Combine(dir, f), dir);
                        if (hit != null) return hit;
                    }
                }
            }
            catch { }
            return null;
        }
        public static bool HasSpoilaint(Browser b) { return FindSpoilaint(b) != null; }

        static string Scan(string file, string profileDir)
        {
            try
            {
                if (!File.Exists(file)) return null;
                var t = File.GetLastWriteTimeUtc(file);
                KeyValuePair<DateTime, string> c;
                lock (cache) if (cache.TryGetValue(file, out c) && c.Key == t) return c.Value;
                string text;
                using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new StreamReader(fs, Encoding.UTF8)) text = r.ReadToEnd();
                string found = null;
                foreach (Match m in PathRe.Matches(text))
                {
                    string p = Unescape(m.Groups[1].Value);
                    if (p.Length == 0 || p.Length > 400 || p.IndexOfAny(Path.GetInvalidPathChars()) >= 0) continue;
                    string full = Path.IsPathRooted(p) ? p : Path.Combine(profileDir, "Extensions", p);
                    if (IsSpoilaint(full)) { found = full; break; }
                }
                lock (cache) cache[file] = new KeyValuePair<DateTime, string>(t, found);
                return found;
            }
            catch { return null; }
        }

        static bool IsSpoilaint(string dir)
        {
            try
            {
                string mf = Path.Combine(dir, "manifest.json");
                if (!File.Exists(mf)) return false;
                var fi = new FileInfo(mf);
                if (fi.Length > 200000) return false;
                return NameRe.IsMatch(File.ReadAllText(mf));
            }
            catch { return false; }
        }

        static string Unescape(string s)
        {
            if (s.IndexOf('\\') < 0) return s;
            var sb = new StringBuilder();
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
                char n = s[++i];
                if (n == 'u' && i + 4 < s.Length)
                {
                    int code;
                    if (int.TryParse(s.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code)) { sb.Append((char)code); i += 4; }
                }
                else if (n == 'n') sb.Append('\n');
                else if (n == 't') sb.Append('\t');
                else sb.Append(n); // \\ \" \/
            }
            return sb.ToString();
        }

        public static bool SamePath(string a, string b)
        {
            if (a == null || b == null) return false;
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        // Names of the browsers that have it, e.g. "Chrome and Brave".
        public static string AddedIn()
        {
            var names = Installed().Where(HasSpoilaint).Select(b => b.Name).ToList();
            if (names.Count == 0) return null;
            if (names.Count == 1) return names[0];
            return string.Join(", ", names.Take(names.Count - 1).ToArray()) + " and " + names.Last();
        }
    }
}
