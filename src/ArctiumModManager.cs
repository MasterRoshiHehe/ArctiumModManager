// Arctium Mod Manager - local helper (by MasterRoshiHehe)
// A desktop app: the interface (packed inside this .exe) runs in its own window (Microsoft Edge in app mode,
// which every Windows 10/11 PC has). A small local server inside the app gives that window read access to the
// game data, the mod folders and the Arctium config. It writes only inside this program's own folder.
// Written for C# 5 / .NET Framework 4 so it compiles with the csc.exe that comes with Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Arctium Mod Manager")]
[assembly: AssemblyProduct("Arctium Mod Manager")]
[assembly: AssemblyCompany("MasterRoshiHehe")]
[assembly: AssemblyDescription("Load order, preview and build tool for Arctium model mods")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class App
{
    const string Name = "Arctium Mod Manager";
    static string AppDir, SettingsFile, OutputDir, BackupDir, ConfigFile, FileMapping, LogFile;
    static string WowRoot = "", Product = "", ModsRoot = "", ArctiumState = "";
    static readonly char Sep = Path.DirectorySeparatorChar;
    static volatile bool running = true;
    static HttpListener listener;
    static string Url;
    static Process window;
    static NotifyIcon tray;
    static Form ui; // hidden, only to run things on the UI thread
    static void OnUi(Action a) { try { if (ui != null && ui.IsHandleCreated) ui.BeginInvoke(a); } catch { } }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var mutex = new Mutex(true, "ArctiumModManager_" + Path.GetDirectoryName(Application.ExecutablePath).ToLowerInvariant().GetHashCode(), out first))
        {
            AppDir = Path.GetDirectoryName(Path.GetFullPath(Application.ExecutablePath));
            SettingsFile = Path.Combine(AppDir, "settings.json");
            LogFile = Path.Combine(AppDir, "log.txt");
            if (!first)
            {
                // already running: just bring up its window
                string u = ReadUrlFile();
                if (u != null) OpenWindow(u, false);
                return;
            }
            try { Run(args); }
            catch (Exception e) { Log("fatal: " + e); MessageBox.Show(e.Message, Name, MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { try { File.Delete(Path.Combine(AppDir, "url.txt")); } catch { } }
        }
    }

    static Icon AppIcon() { try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; } }

    static void Run(string[] args)
    {
        try { File.WriteAllText(LogFile, Name + " started " + DateTime.Now + "\r\n"); } catch { }
        bool setup = args.Any(a => a.Trim('-', '/').Equals("setup", StringComparison.OrdinalIgnoreCase));
        if (!LoadSettings(setup)) return;

        ConfigFile = Path.Combine(ArctiumState, @"config\appsettings.Mods.json");
        FileMapping = Path.Combine(ArctiumState, @"apps\704159964\mappings\filemapping.txt");
        if (!File.Exists(FileMapping))
        {
            try
            {
                string apps = Path.Combine(ArctiumState, "apps");
                if (Directory.Exists(apps)) { string f = Directory.EnumerateFiles(apps, "filemapping.txt", SearchOption.AllDirectories).FirstOrDefault(); if (f != null) FileMapping = f; }
            }
            catch { }
        }
        OutputDir = Path.Combine(AppDir, "Output");
        BackupDir = Path.Combine(AppDir, "backups");
        Directory.CreateDirectory(OutputDir); Directory.CreateDirectory(BackupDir);

        int port = 0;
        for (int p = 8765; p < 8785; p++)
        {
            try { listener = new HttpListener(); listener.Prefixes.Add("http://localhost:" + p + "/"); listener.Start(); port = p; break; }
            catch { listener = null; }
        }
        if (port == 0) { MessageBox.Show("Could not open a local port (8765-8784).", Name, MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        Url = "http://localhost:" + port + "/";
        try { File.WriteAllText(Path.Combine(AppDir, "url.txt"), Url); } catch { }
        Log("serving " + Url);
        var server = new Thread(Serve) { IsBackground = true, Name = "server" };
        server.Start();

        ui = new Form { ShowInTaskbar = false, Opacity = 0 }; IntPtr h = ui.Handle;
        // tray icon: reopen the window, change folders, quit
        tray = new NotifyIcon { Icon = AppIcon(), Text = Name, Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open window", null, (o, e) => OpenWindow(Url, true));
        menu.Items.Add("Change folders...", null, (o, e) => ChangeFolders());
        menu.Items.Add("Open program folder", null, (o, e) => { try { Process.Start("explorer.exe", "\"" + AppDir + "\""); } catch { } });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (o, e) => Quit());
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (o, e) => OpenWindow(Url, true);

        OpenWindow(Url, true);
        Application.Run();
        running = false;
        try { listener.Stop(); } catch { }
        tray.Visible = false; tray.Dispose();
    }

    static void Quit()
    {
        running = false;
        try { listener.Stop(); } catch { }
        try { if (window != null && !window.HasExited) window.CloseMainWindow(); } catch { }
        Application.ExitThread();
    }

    static void ChangeFolders()
    {
        if (!ShowSetup(false)) return;
        if (MessageBox.Show("Folders saved. Restart " + Name + " now to use them?", Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
        {
            try { if (window != null && !window.HasExited) window.CloseMainWindow(); } catch { }
            running = false; try { listener.Stop(); } catch { }
            tray.Visible = false;
            Process.Start(Application.ExecutablePath);
            Application.ExitThread();
        }
    }

    static string ReadUrlFile() { try { return File.ReadAllText(Path.Combine(AppDir, "url.txt")).Trim(); } catch { return null; } }

    // ------------------------------------------------------------------ the app window (Edge or Chrome in app mode)
    static string FindBrowser()
    {
        var c = new List<string>();
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        {
            if (string.IsNullOrEmpty(root)) continue;
            c.Add(Path.Combine(root, @"Microsoft\Edge\Application\msedge.exe"));
            c.Add(Path.Combine(root, @"Google\Chrome\Application\chrome.exe"));
        }
        foreach (string k in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" })
        {
            try
            {
                using (var r = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(k))
                    if (r != null && r.GetValue("") != null) c.Add(r.GetValue("").ToString());
            }
            catch { }
        }
        return c.FirstOrDefault(File.Exists);
    }

    static void OpenWindow(string url, bool track)
    {
        try
        {
            string b = FindBrowser();
            if (b == null) { Process.Start(url); return; }
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArctiumModManager", "window");
            Directory.CreateDirectory(profile);
            var psi = new ProcessStartInfo(b, "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --window-size=1600,950 --no-first-run --no-default-browser-check --disable-features=Translate")
            { UseShellExecute = false };
            var p = Process.Start(psi);
            if (track && (window == null || window.HasExited))
            {
                window = p;
                if (p != null)
                {
                    p.EnableRaisingEvents = true;
                    // closing the app window closes the app (the window process keeps running while it is open)
                    p.Exited += (o, e) => WatchWindowClosed();
                }
            }
        }
        catch (Exception e) { Log("window: " + e.Message); try { Process.Start(url); } catch { } }
    }

    static void WatchWindowClosed()
    {
        // the browser can hand the window to another of its processes; only quit when no app window is left
        Thread.Sleep(1500);
        bool stillOpen = false;
        try
        {
            foreach (var p in Process.GetProcessesByName("msedge").Concat(Process.GetProcessesByName("chrome")))
            {
                try { if (p.MainWindowHandle != IntPtr.Zero && p.MainWindowTitle.IndexOf(Name, StringComparison.OrdinalIgnoreCase) >= 0) { stillOpen = true; window = p; p.EnableRaisingEvents = true; p.Exited += (o, e) => WatchWindowClosed(); break; } } catch { }
            }
        }
        catch { }
        if (!stillOpen && tray != null)
            OnUi(Quit);
    }

    static void Log(string t) { try { lock (Json) File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + t + "\r\n"); } catch { } }

    // ------------------------------------------------------------------ settings
    static bool LoadSettings(bool setup)
    {
        Dictionary<string, object> s = null;
        if (File.Exists(SettingsFile))
        {
            try { s = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsFile)); } catch { s = null; }
        }
        Func<string, string> get = k => s != null && s.ContainsKey(k) && s[k] != null ? s[k].ToString() : "";
        WowRoot = get("WowRoot"); Product = get("Product"); ModsRoot = get("ModsRoot"); ArctiumState = get("ArctiumState");
        if (!setup && WowRoot != "" && ModsRoot != "" && ArctiumState != "") { if (Product == "") Product = "_retail_"; return true; }
        return ShowSetup(true);
    }

    // Setup window: found folders, a Browse button for each, game version
    static bool ShowSetup(bool firstRun)
    {
        if (firstRun || WowRoot == "" || ModsRoot == "" || ArctiumState == "")
        {
            string w = WowRoot, m = ModsRoot, a = ArctiumState, pr = Product;
            FindSettings();
            if (w != "") WowRoot = w;
            if (m != "") ModsRoot = m;
            if (a != "") ArctiumState = a;
            if (pr != "") Product = pr;
        }
        var f = new Form
        {
            Text = Name + " - folders", Icon = AppIcon(), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen, ClientSize = new Size(640, 330), Font = new Font("Segoe UI", 9.5f), TopMost = true
        };
        var intro = new Label
        {
            Left = 16, Top = 12, Width = 608, Height = 44,
            Text = firstRun ? "Welcome! These are the folders the tool found from your Arctium app. Check them, change any that are wrong, then press Start."
                            : "Change the folders the tool uses, then press Save."
        };
        f.Controls.Add(intro);
        Func<string, string, int, TextBox> row = (label, value, y) =>
        {
            f.Controls.Add(new Label { Left = 16, Top = y, Width = 600, Height = 20, Text = label });
            var tb = new TextBox { Left = 16, Top = y + 22, Width = 510, Text = value };
            var bt = new Button { Left = 534, Top = y + 20, Width = 90, Height = 28, Text = "Browse..." };
            bt.Click += (o, e) => { string x = PickFolder(label, tb.Text, f); if (x != null) tb.Text = x; };
            f.Controls.Add(tb); f.Controls.Add(bt);
            return tb;
        };
        var tbW = row("World of Warcraft folder (holds the \"Data\" folder)", WowRoot, 62);
        var tbM = row("Folder that holds your Arctium mod folders", ModsRoot, 122);
        var tbA = row("Arctium app data folder (LocalState, holds a \"config\" folder)", ArctiumState, 182);
        f.Controls.Add(new Label { Left = 16, Top = 245, Width = 110, Height = 22, Text = "Game version" });
        var cb = new ComboBox { Left = 130, Top = 242, Width = 180, DropDownStyle = ComboBoxStyle.DropDown };
        Action fillProducts = () =>
        {
            string keep = cb.Text == "" ? Product : cb.Text;
            cb.Items.Clear(); foreach (string x in Products(tbW.Text)) cb.Items.Add(x);
            cb.Text = keep != "" ? keep : cb.Items.Count > 0 ? cb.Items[0].ToString() : "_retail_";
        };
        fillProducts(); tbW.TextChanged += (o, e) => fillProducts();
        f.Controls.Add(cb);
        var ok = new Button { Text = firstRun ? "Start" : "Save", Left = 430, Top = 284, Width = 94, Height = 30, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", Left = 530, Top = 284, Width = 94, Height = 30, DialogResult = DialogResult.Cancel };
        f.Controls.Add(ok); f.Controls.Add(cancel); f.AcceptButton = ok; f.CancelButton = cancel;
        while (true)
        {
            if (f.ShowDialog() != DialogResult.OK) return false;
            string err = null;
            if (!Directory.Exists(Path.Combine(tbW.Text, "Data"))) err = "The World of Warcraft folder must contain a \"Data\" folder.";
            else if (!Directory.Exists(tbM.Text)) err = "The mods folder doesn't exist.";
            else if (!File.Exists(Path.Combine(tbA.Text, @"config\appsettings.Mods.json"))) err = "The Arctium folder must contain config\\appsettings.Mods.json.";
            if (err != null) { MessageBox.Show(f, err, Name, MessageBoxButtons.OK, MessageBoxIcon.Warning); continue; }
            break;
        }
        WowRoot = tbW.Text.TrimEnd('\\'); ModsRoot = tbM.Text.TrimEnd('\\'); ArctiumState = tbA.Text.TrimEnd('\\'); Product = cb.Text.Trim() == "" ? "_retail_" : cb.Text.Trim();
        var o2 = new Dictionary<string, object>();
        o2["WowRoot"] = WowRoot; o2["Product"] = Product; o2["ModsRoot"] = ModsRoot; o2["ArctiumState"] = ArctiumState;
        File.WriteAllText(SettingsFile, Json.Serialize(o2), new UTF8Encoding(false));
        return true;
    }

    static string[] Products(string root)
    {
        try { return Directory.GetDirectories(root, "_*_").Select(d => Path.GetFileName(d)).ToArray(); }
        catch { return new string[0]; }
    }

    static IEnumerable<string> JsonPaths(string file)
    {
        string t = File.ReadAllText(file);
        foreach (Match m in Regex.Matches(t, "\"Path\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\""))
        {
            string v;
            try { v = Json.Deserialize<string>("\"" + m.Groups[1].Value + "\""); } catch { v = m.Groups[1].Value.Replace("\\\\", "\\"); }
            yield return v;
        }
    }

    static void FindSettings()
    {
        WowRoot = ""; Product = ""; ModsRoot = ""; ArctiumState = "";
        try
        {
            string pk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Packages");
            foreach (string d in Directory.GetDirectories(pk, "*Arctium*"))
                if (Directory.Exists(Path.Combine(d, @"LocalState\config"))) { ArctiumState = Path.Combine(d, "LocalState"); break; }
        }
        catch { }
        string cfg = ArctiumState == "" ? "" : Path.Combine(ArctiumState, "config");
        // game folder: the Wow.exe the Arctium app launches
        try
        {
            string gc = Path.Combine(cfg, "appsettings.GameClients.json");
            if (cfg != "" && File.Exists(gc))
                foreach (string exe in JsonPaths(gc))
                {
                    if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                    string dir = Path.GetDirectoryName(exe), root = Path.GetDirectoryName(dir);
                    if (root != null && Directory.Exists(Path.Combine(root, "Data"))) { WowRoot = root; Product = Path.GetFileName(dir); if (Product == "_forever_") break; }
                }
        }
        catch { }
        if (WowRoot != "" && Product == "")
        {
            string[] ps = Products(WowRoot);
            Product = ps.Contains("_forever_") ? "_forever_" : ps.Length > 0 ? ps[0] : "_retail_";
        }
        // mods folder: the common parent of the mod folders added in the Arctium app
        try
        {
            string mj = Path.Combine(cfg, "appsettings.Mods.json");
            if (cfg != "" && File.Exists(mj))
            {
                var paths = JsonPaths(mj).Where(p => Directory.Exists(p)).Select(p => p.TrimEnd('\\')).ToList();
                if (paths.Count > 0)
                {
                    string common = paths[0];
                    foreach (string p in paths)
                        while (!string.IsNullOrEmpty(common) && !(p + "\\").StartsWith(common + "\\", StringComparison.OrdinalIgnoreCase))
                            common = Path.GetDirectoryName(common);
                    if (paths.Count == 1 || string.IsNullOrEmpty(common) || common.Length <= 3) common = Path.GetDirectoryName(paths[0]);
                    if (!string.IsNullOrEmpty(common) && common.Length > 3) ModsRoot = common;
                }
            }
        }
        catch { }
    }

    static string PickFolder(string title, string start, IWin32Window owner)
    {
        using (var d = new FolderBrowserDialog())
        {
            d.Description = title; d.ShowNewFolderButton = false;
            if (!string.IsNullOrEmpty(start) && Directory.Exists(start)) d.SelectedPath = start;
            return d.ShowDialog(owner) == DialogResult.OK ? d.SelectedPath : null;
        }
    }

    static void Serve()
    {
        while (running && listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); } catch { break; }
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    // ------------------------------------------------------------------ access rules
    static string Norm(string p) { if (string.IsNullOrEmpty(p)) return ""; return Path.GetFullPath(p).TrimEnd(Sep); }

    static List<string> rootsCache; static DateTime rootsTime = DateTime.MinValue; static readonly object rootsLock = new object();
    static List<string> ReadRoots()
    {
        lock (rootsLock)
        {
            if (rootsCache != null && (DateTime.Now - rootsTime).TotalSeconds < 5) return rootsCache;
            var r = new List<string>();
            foreach (string p in new[] { WowRoot, ModsRoot, AppDir, ArctiumState }) if (!string.IsNullOrEmpty(p)) r.Add(Norm(p));
            try
            {
                if (File.Exists(ConfigFile))
                    foreach (string v in JsonPaths(ConfigFile))
                        if (Regex.IsMatch(v, @"^[A-Za-z]:\\")) { try { r.Add(Norm(v)); } catch { } }
            }
            catch { }
            rootsCache = r; rootsTime = DateTime.Now;
            return r;
        }
    }
    static bool Under(string path, IEnumerable<string> roots)
    {
        string n;
        try { n = Norm(path); } catch { return false; }
        foreach (string root in roots) if (n.Equals(root, StringComparison.OrdinalIgnoreCase) || n.StartsWith(root + Sep, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
    static bool Writable(string path)
    {
        string n;
        try { n = Norm(path); } catch { return false; }
        foreach (string f in new[] { "profile.json", "extra-mappings.txt", "LoadOrder-mappings.txt", "build-report.txt" })
            if (n.Equals(Norm(Path.Combine(AppDir, f)), StringComparison.OrdinalIgnoreCase)) return true;
        return Under(n, new[] { Norm(OutputDir), Norm(BackupDir) });
    }
    static bool ArctiumRunning()
    {
        try { return Process.GetProcesses().Any(p => p.ProcessName.IndexOf("rctium", StringComparison.OrdinalIgnoreCase) >= 0); } catch { return false; }
    }

    // ------------------------------------------------------------------ http
    static readonly Dictionary<string, string> Mime = new Dictionary<string, string> {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json" }, { ".png", "image/png" }, { ".svg", "image/svg+xml" } };

    static void Send(HttpListenerContext ctx, int code, byte[] bytes, string type)
    {
        var res = ctx.Response;
        try
        {
            res.StatusCode = code; res.ContentType = type; res.Headers.Add("Cache-Control", "no-store");
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
        }
        catch { }
        finally { try { res.OutputStream.Close(); } catch { } }
    }
    static void Text(HttpListenerContext ctx, int code, string text, string type = "text/plain; charset=utf-8") { Send(ctx, code, Encoding.UTF8.GetBytes(text), type); }
    static void SendStream(HttpListenerContext ctx, Stream s, string type)
    {
        var res = ctx.Response;
        try
        {
            res.StatusCode = 200; res.ContentType = type; res.Headers.Add("Cache-Control", "no-store");
            res.ContentLength64 = s.Length;
            s.CopyTo(res.OutputStream, 1048576);
        }
        catch { }
        finally { s.Dispose(); try { res.OutputStream.Close(); } catch { } }
    }
    static void SendFile(HttpListenerContext ctx, string path, string type) { SendStream(ctx, new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), type); }
    static byte[] Body(HttpListenerContext ctx) { using (var ms = new MemoryStream()) { ctx.Request.InputStream.CopyTo(ms); return ms.ToArray(); } }

    static Dictionary<string, string> Query(HttpListenerContext ctx)
    {
        // decoded as UTF-8 by hand: paths may contain non-English letters
        var q = new Dictionary<string, string>();
        string raw = ctx.Request.Url.Query;
        if (raw.Length > 1)
            foreach (string pair in raw.Substring(1).Split('&'))
            {
                string[] kv = pair.Split(new[] { '=' }, 2);
                q[Uri.UnescapeDataString(kv[0].Replace('+', ' '))] = kv.Length > 1 ? Uri.UnescapeDataString(kv[1].Replace('+', ' ')) : "";
            }
        return q;
    }
    static string Q(Dictionary<string, string> q, string k) { string v; return q.TryGetValue(k, out v) ? v : ""; }

    static void Handle(HttpListenerContext ctx)
    {
        string path = ctx.Request.Url.AbsolutePath;
        try
        {
            var q = Query(ctx);
            if (path == "/" || path == "/index.html") path = "/web/index.html";
            if (path.StartsWith("/web/"))
            {
                string rel = Uri.UnescapeDataString(path.Substring(5));
                // next to the .exe first (for development), then the copy packed inside the .exe
                string web = Path.Combine(AppDir, "web"), f = Norm(Path.Combine(web, rel.Replace('/', Sep)));
                string ext = Path.GetExtension(rel).ToLowerInvariant(), t;
                if (!Mime.TryGetValue(ext, out t)) t = "application/octet-stream";
                if (f.StartsWith(Norm(web) + Sep, StringComparison.OrdinalIgnoreCase) && File.Exists(f)) { SendFile(ctx, f, t); return; }
                Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + rel);
                if (s == null) { Text(ctx, 404, "not found"); return; }
                SendStream(ctx, s, t); return;
            }
            switch (path)
            {
                case "/api/info":
                    {
                        var o = new Dictionary<string, object>();
                        o["wowRoot"] = WowRoot; o["product"] = Product; o["modsRoot"] = ModsRoot; o["configFile"] = ConfigFile; o["fileMapping"] = FileMapping;
                        o["appDir"] = AppDir; o["outputDir"] = OutputDir; o["arctiumRunning"] = ArctiumRunning();
                        Text(ctx, 200, Json.Serialize(o), "application/json"); break;
                    }
                case "/api/config":
                    SendFile(ctx, ConfigFile, "application/json"); break;
                case "/api/ls":
                    {
                        string d = Q(q, "p");
                        if (!Directory.Exists(d)) { Text(ctx, 404, "no such folder"); break; }
                        var sb = new StringBuilder();
                        foreach (string x in Directory.EnumerateDirectories(d)) sb.Append("D\t").Append(Path.GetFileName(x)).Append('\n');
                        if (Under(d, ReadRoots()))
                            foreach (string x in Directory.EnumerateFiles(d)) sb.Append("F\t").Append(Path.GetFileName(x)).Append('\t').Append(new FileInfo(x).Length).Append('\n');
                        Text(ctx, 200, sb.ToString()); break;
                    }
                case "/api/tree":
                    {
                        string d = Norm(Q(q, "p"));
                        if (!Under(d, ReadRoots())) { Text(ctx, 403, "folder not allowed"); break; }
                        if (!Directory.Exists(d)) { Text(ctx, 404, "no such folder"); break; }
                        var sb = new StringBuilder(); int cut = d.Length + 1;
                        foreach (string x in Directory.EnumerateFiles(d, "*", SearchOption.AllDirectories))
                            sb.Append(x.Substring(cut).Replace(Sep, '/')).Append('\t').Append(new FileInfo(x).Length).Append('\n');
                        Text(ctx, 200, sb.ToString()); break;
                    }
                case "/api/read":
                    {
                        string f = Q(q, "p");
                        if (f == "FILEMAPPING") f = FileMapping;
                        if (!Under(f, ReadRoots())) { Text(ctx, 403, "file not allowed"); break; }
                        if (!File.Exists(f)) { Text(ctx, 404, "no such file"); break; }
                        if (Q(q, "o") != "")
                        {
                            long o = long.Parse(Q(q, "o")); int n = int.Parse(Q(q, "n"));
                            var buf = new byte[n]; int got = 0;
                            using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                            {
                                fs.Seek(o, SeekOrigin.Begin);
                                while (got < n) { int r = fs.Read(buf, got, n - got); if (r <= 0) break; got += r; }
                            }
                            if (got < n) Array.Resize(ref buf, got);
                            Send(ctx, 200, buf, "application/octet-stream");
                        }
                        else SendFile(ctx, f, "application/octet-stream");
                        break;
                    }
                case "/api/copy":
                    {
                        string from = Q(q, "from"), to = Q(q, "to");
                        if (!Under(from, ReadRoots())) { Text(ctx, 403, "source not allowed"); break; }
                        if (!Writable(to)) { Text(ctx, 403, "target not allowed"); break; }
                        Directory.CreateDirectory(Path.GetDirectoryName(to));
                        if (File.Exists(to)) File.Delete(to);
                        File.Copy(from, to);
                        Text(ctx, 200, "ok"); break;
                    }
                case "/api/write":
                    {
                        string to = Q(q, "p");
                        if (!Writable(to)) { Text(ctx, 403, "target not allowed"); break; }
                        Directory.CreateDirectory(Path.GetDirectoryName(to));
                        byte[] body = Body(ctx);
                        // never write through an existing file: in Output it can be a hard link to a mod's own file
                        if (File.Exists(to)) File.Delete(to);
                        File.WriteAllBytes(to, body);
                        Text(ctx, 200, "ok"); break;
                    }
                case "/api/delete":
                    {
                        string to = Q(q, "p");
                        if (!Writable(to) || Norm(to).Equals(Norm(ConfigFile), StringComparison.OrdinalIgnoreCase)) { Text(ctx, 403, "not allowed"); break; }
                        if (File.Exists(to)) File.Delete(to);
                        Text(ctx, 200, "ok"); break;
                    }
                case "/api/build":
                    Build(ctx); break;
                case "/api/quit":
                    Text(ctx, 200, "bye");
                    OnUi(Quit);
                    break;
                default:
                    Text(ctx, 404, "unknown"); break;
            }
        }
        catch (Exception e)
        {
            try { Text(ctx, 500, e.Message); } catch { }
            Log("error on " + path + ": " + e.Message);
        }
    }

    static readonly object buildLock = new object();
    // body: lines "L<TAB>source file<TAB>relative target" (hard link, or copy if linking fails)
    //       or "K<TAB><TAB>relative target" (keep: file already written by the page)
    static void Build(HttpListenerContext ctx)
    {
        lock (buildLock)
        {
            string[] lines = Encoding.UTF8.GetString(Body(ctx)).Split('\n');
            var roots = ReadRoots();
            var want = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int linked = 0, copied = 0, kept = 0, removed = 0;
            var errors = new List<string>();
            string outN = Norm(OutputDir);
            foreach (string raw in lines)
            {
                string ln = raw.TrimEnd('\r');
                if (ln.Trim() == "") continue;
                string[] parts = ln.Split('\t');
                if (parts.Length < 3) continue;
                string rel = parts[2].Replace('/', Sep), dst;
                try { dst = Norm(Path.Combine(OutputDir, rel)); } catch { continue; }
                if (!dst.StartsWith(outN + Sep, StringComparison.OrdinalIgnoreCase)) continue;
                want.Add(dst);
                if (parts[0] == "K") { kept++; continue; }
                string src = parts[1];
                if (!Under(src, roots)) { errors.Add("not allowed: " + src); continue; }
                try
                {
                    var si = new FileInfo(src);
                    if (File.Exists(dst))
                    {
                        var di = new FileInfo(dst);
                        if (di.Length == si.Length && di.LastWriteTimeUtc == si.LastWriteTimeUtc) { kept++; continue; }
                        File.Delete(dst);
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dst));
                    if (CreateHardLink(dst, src, IntPtr.Zero)) linked++;
                    else { File.Copy(src, dst, true); File.SetLastWriteTimeUtc(dst, si.LastWriteTimeUtc); copied++; }
                }
                catch (Exception e) { errors.Add(rel + " : " + e.Message); }
            }
            foreach (string x in Directory.EnumerateFiles(OutputDir, "*", SearchOption.AllDirectories).ToList())
                if (!want.Contains(Norm(x))) { try { File.Delete(x); removed++; } catch (Exception e) { errors.Add(x + " : " + e.Message); } }
            foreach (string d in Directory.EnumerateDirectories(OutputDir, "*", SearchOption.AllDirectories).OrderByDescending(d => d.Length).ToList())
                try { if (!Directory.EnumerateFileSystemEntries(d).Any()) Directory.Delete(d); } catch { }
            var o = new Dictionary<string, object>();
            o["linked"] = linked; o["copied"] = copied; o["unchanged"] = kept; o["removed"] = removed; o["errors"] = errors;
            Text(ctx, 200, Json.Serialize(o), "application/json");
        }
    }
}
