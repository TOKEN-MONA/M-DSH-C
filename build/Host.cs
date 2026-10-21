using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("MCLauncher")]
[assembly: AssemblyDescription("Minecraft launcher")]
[assembly: AssemblyProduct("MCLauncher")]
[assembly: AssemblyCompany("")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace MCLauncherHost
{
    /// <summary>
    /// MCLauncher 的单文件宿主。
    /// 内嵌 payload.zip（node.exe + src/** + WebView2 组件），首次运行时解到 LocalAppData，
    /// 然后拉起本地服务，用 WebView2 内嵌浏览器显示界面。
    /// </summary>
    internal static class Program
    {
        // build.ps1 会按 payload.zip 的哈希生成 BuildInfo.Id，payload 一变就自动重建引擎目录
        private static string BuildId
        {
            get { return BuildInfo.Id; }
        }
        private const string Title = "M-DSH-C";

        private static string _exeDir;
        private static string _localRoot;
        private static string _engineDir;
        private static string _dataDir;
        private static string _logPath;
        private static string _baseUrl;

        private static Process _node;
        private static Mutex _mutex;
        private static int _homeChoice;
        private static bool _testMode;
        private static readonly System.Collections.Generic.List<string> _homeErrors = new System.Collections.Generic.List<string>();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        [STAThread]
        private static int Main(string[] args)
        {
            bool noWindow = HasFlag(args, "--no-window");
            bool startOnly = HasFlag(args, "--start-only");
            bool probe = HasFlag(args, "--probe");
            bool uiTest = HasFlag(args, "--ui-test");
            _testMode = uiTest || noWindow;

            // 必须放在最前面：一旦创建过任何窗口（比如解包时的加载框），
            // 再调 SetCompatibleTextRenderingDefault 就会抛异常。
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _exeDir = Path.GetDirectoryName(Application.ExecutablePath);

            // 运行环境目录：%LOCALAPPDATA% 不可写就依次退到 TEMP、exe 旁边
            _localRoot = ResolveHome();
            _engineDir = Path.Combine(_localRoot, "engine");
            _logPath = Path.Combine(_localRoot, "host.log");

            _dataDir = Path.Combine(_exeDir, ".data");
            try
            {
                Directory.CreateDirectory(_dataDir);
                File.WriteAllText(Path.Combine(_dataDir, ".writetest"), "1");
                File.Delete(Path.Combine(_dataDir, ".writetest"));
            }
            catch
            {
                // exe 所在目录不可写（比如放进 Program Files），退到 LocalAppData
                _dataDir = Path.Combine(_localRoot, "data");
                Directory.CreateDirectory(_dataDir);
            }

            Log("=== 启动 host, BuildId=" + BuildId + " ===");
            Log("exe=" + _exeDir);
            Log("data=" + _dataDir);
            if (_homeChoice > 0) Log("注意：%LOCALAPPDATA% 不可写，运行环境放在 " + _localRoot);
            foreach (string e in _homeErrors) Log("目录不可写: " + e);

            bool ok = false;
            try
            {
                _mutex = new Mutex(true, "M-DSH-C.SingleInstance.v1", out ok);
            }
            catch { ok = true; }

            if (!ok)
            {
                MessageBox.Show("启动器已经在运行了。", Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            // WebView2 的程序集不在 exe 旁边，必须提前挂好解析器
            AppDomain.CurrentDomain.AssemblyResolve += ResolveWebView2Assembly;

            try
            {
                EnsurePayload();

                if (probe) return RunProbe();

                StartNode();
                _baseUrl = WaitForServer(60000);
                Log("服务地址: " + _baseUrl);

                if (noWindow)
                {
                    Console.WriteLine(_baseUrl);
                    if (startOnly) { while (_node != null && !_node.HasExited) Thread.Sleep(1000); }
                    return 0;
                }

                ShowWindow();
                return 0;
            }
            catch (Exception ex)
            {
                Log("致命错误: " + ex);
                KillNode();
                if (_testMode)
                {
                    Console.Error.WriteLine("启动失败: " + ex.Message);
                    return 1;
                }
                MessageBox.Show(DescribeFailure(ex), Title + " 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                try { if (_mutex != null) _mutex.ReleaseMutex(); } catch { }
            }
        }

        /// <summary>
        /// 选一个真的能写的目录。MCL_HOME 优先（便携模式）；
        /// 否则 %LOCALAPPDATA% → %TEMP% → exe 旁边，谁先能用用谁。
        /// </summary>
        private static string ResolveHome()
        {
            string over = Environment.GetEnvironmentVariable("MCL_HOME");
            if (over != null && over.Trim().Length > 0)
            {
                string p = Path.GetFullPath(over.Trim());
                if (!CanWrite(p)) throw new Exception("MCL_HOME 指定的目录不可写：" + p);
                return p;
            }

            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "M-DSH-C"),
                Path.Combine(Path.GetTempPath(), "M-DSH-C"),
                Path.Combine(_exeDir, ".engine-home")
            };

            for (int i = 0; i < candidates.Length; i++)
            {
                if (CanWrite(candidates[i]))
                {
                    _homeChoice = i;
                    return candidates[i];
                }
            }
            throw new Exception("找不到可写的运行目录，这些都试过了：\r\n" + string.Join("\r\n", candidates));
        }

        private static bool CanWrite(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".writetest");
                File.WriteAllText(probe, "1");
                // 删除失败不算失败：杀毒软件可能正扫着这个文件
                try { File.Delete(probe); } catch { }
                return true;
            }
            catch (Exception ex)
            {
                _homeErrors.Add(dir + " → " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        private static bool HasFlag(string[] args, string flag)
        {
            foreach (string a in args)
                if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>自检：确认 WebView2 托管库能加载、本机运行时能取到版本</summary>
        private static int RunProbe()
        {
            try
            {
                Assembly core = typeof(Microsoft.Web.WebView2.Core.CoreWebView2Environment).Assembly;
                string m1 = "WebView2 托管库: " + core.GetName().Version;
                Log(m1);
                Console.WriteLine(m1);

                SetDllDirectory(Path.Combine(_engineDir, "wv2"));
                string ver = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
                string m2 = "WebView2 运行时: " + ver;
                Log(m2);
                Console.WriteLine(m2);
                return 0;
            }
            catch (Exception ex)
            {
                string m = "WebView2 探测失败: " + ex.GetType().Name + ": " + ex.Message;
                Log(m);
                Console.WriteLine(m);
                return 3;
            }
        }

        private static string DescribeFailure(Exception ex)
        {
            string log = "";
            try
            {
                string nodeLog = Path.Combine(_localRoot, "node.log");
                if (File.Exists(nodeLog))
                {
                    string all = File.ReadAllText(nodeLog);
                    log = dgTrim(all, 1200);
                }
            }
            catch { }

            string s = ex.Message;
            if (log.Length > 0) s += "\r\n\r\n--- 服务输出 ---\r\n" + log;
            s += "\r\n\r\n详细日志: " + _logPath;
            return s;
        }

        private static string dgTrim(string s, int max)
        {
            if (s == null) return "";
            if (s.Length <= max) return s;
            return "…" + s.Substring(s.Length - max);
        }

        private static void Log(string msg)
        {
            try
            {
                File.AppendAllText(_logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + msg + "\r\n");
            }
            catch { }
        }

        // ---------- 解包 ----------

        private static void EnsurePayload()
        {
            string marker = Path.Combine(_engineDir, "build.id");
            bool looksComplete =
                File.Exists(Path.Combine(_engineDir, "node.exe")) &&
                File.Exists(Path.Combine(_engineDir, "src", "server.js")) &&
                File.Exists(Path.Combine(_engineDir, "wv2", "Microsoft.Web.WebView2.Core.dll"));

            if (looksComplete && File.Exists(marker))
            {
                try
                {
                    if (File.ReadAllText(marker).Trim() == BuildId) return;
                }
                catch { }
            }

            Log("解包运行环境到 " + _engineDir);

            Splash splash = null;
            try
            {
                if (Environment.UserInteractive)
                {
                    splash = new Splash("第一次启动，正在准备运行环境…");
                    splash.Show();
                    Application.DoEvents();
                }
            }
            catch { }

            try
            {
                TryDeleteDir(_engineDir);
                Directory.CreateDirectory(_engineDir);

                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream("payload.zip"))
                {
                    if (stream == null) throw new Exception("内嵌资源 payload.zip 丢失，这个 exe 可能是坏的。");
                    using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read))
                    {
                        int i = 0;
                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            if (entry.FullName.EndsWith("/")) continue;
                            string dest = Path.Combine(_engineDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            entry.ExtractToFile(dest, true);
                            i++;
                            if (splash != null && (i % 40 == 0))
                            {
                                splash.SetText("正在解包… " + i + " 个文件");
                                Application.DoEvents();
                            }
                        }
                        Log("解包完成，共 " + i + " 个文件");
                    }
                }

                File.WriteAllText(marker, BuildId);
            }
            finally
            {
                if (splash != null)
                {
                    splash.Close();
                    splash.Dispose();
                }
            }
        }

        private static void TryDeleteDir(string dir)
        {
            if (!Directory.Exists(dir)) return;
            try { Directory.Delete(dir, true); }
            catch
            {
                // 可能有残留进程占着文件，改个名字让它失效
                try { Directory.Move(dir, dir + ".old-" + DateTime.Now.Ticks); } catch { }
            }
        }

        // ---------- 启动服务 ----------

        private static void StartNode()
        {
            string nodeExe = Path.Combine(_engineDir, "node.exe");
            if (!File.Exists(nodeExe)) nodeExe = FindOnPath("node.exe");
            if (nodeExe == null) throw new Exception("找不到 node.exe（内嵌的解包失败，系统 PATH 里也没有）。");

            string serverJs = Path.Combine(_engineDir, "src", "server.js");
            if (!File.Exists(serverJs)) throw new Exception("找不到 " + serverJs);

            string urlFile = Path.Combine(_dataDir, "ui-url.txt");
            try { if (File.Exists(urlFile)) File.Delete(urlFile); } catch { }
            try { File.WriteAllText(Path.Combine(_localRoot, "node.log"), ""); } catch { }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "\"" + serverJs + "\" --no-window";
            psi.WorkingDirectory = _engineDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            // node 输出的是 UTF-8，不指定的话 .NET 会按系统代码页解，中文全变乱码
            psi.StandardOutputEncoding = System.Text.Encoding.UTF8;
            psi.StandardErrorEncoding = System.Text.Encoding.UTF8;
            psi.EnvironmentVariables["MCL_DATA"] = _dataDir;
            psi.EnvironmentVariables["MCL_IDLE_EXIT"] = "1";

            _node = new Process();
            _node.StartInfo = psi;
            _node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) NodeLog(e.Data); };
            _node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) NodeLog("[err] " + e.Data); };
            _node.Start();
            _node.BeginOutputReadLine();
            _node.BeginErrorReadLine();
            Log("node 已启动 PID=" + _node.Id + " (" + nodeExe + ")");
        }

        private static void NodeLog(string line)
        {
            try
            {
                File.AppendAllText(Path.Combine(_localRoot, "node.log"), line + "\r\n");
            }
            catch { }
        }

        private static string FindOnPath(string fileName)
        {
            string path = Environment.GetEnvironmentVariable("PATH");
            if (path == null) return null;
            string[] parts = path.Split(';');
            foreach (string p in parts)
            {
                if (p.Trim().Length == 0) continue;
                try
                {
                    string full = Path.Combine(p.Trim(), fileName);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
            return null;
        }

        private static string WaitForServer(int timeoutMs)
        {
            string urlFile = Path.Combine(_dataDir, "ui-url.txt");
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (_node != null && _node.HasExited)
                    throw new Exception("本地服务启动后立刻退出了（退出码 " + _node.ExitCode + "）。");

                try
                {
                    if (File.Exists(urlFile))
                    {
                        string url = File.ReadAllText(urlFile).Trim();
                        if (url.StartsWith("http") && HttpPing(url + "api/state")) return url;
                    }
                }
                catch { }

                Thread.Sleep(250);
            }
            throw new Exception("等了 " + (timeoutMs / 1000) + " 秒，本地服务还没起来。");
        }

        private static bool HttpPing(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 2000;
                req.Proxy = null;
                req.KeepAlive = false;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return (int)res.StatusCode == 200;
                }
            }
            catch { return false; }
        }

        private static bool GameRunning()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(_baseUrl + "api/state");
                req.Timeout = 1500;
                req.Proxy = null;
                req.KeepAlive = false;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream()))
                {
                    string body = sr.ReadToEnd();
                    return body.IndexOf("\"running\":true", StringComparison.Ordinal) >= 0;
                }
            }
            catch { return false; }
        }

        private static void KillNode()
        {
            try
            {
                if (_node != null && !_node.HasExited)
                {
                    _node.Kill();
                    _node.WaitForExit(3000);
                }
            }
            catch { }
            _node = null;
        }

        // ---------- 界面 ----------

        private static Assembly ResolveWebView2Assembly(object sender, ResolveEventArgs args)
        {
            try
            {
                string simple = new AssemblyName(args.Name).Name;
                string candidate = Path.Combine(_engineDir, "wv2", simple + ".dll");
                if (File.Exists(candidate))
                {
                    // 用字节加载：LoadFrom 在某些环境下会被拒（HRESULT 0x80131515）
                    return Assembly.Load(File.ReadAllBytes(candidate));
                }
            }
            catch (Exception ex)
            {
                Log("加载 " + args.Name + " 失败: " + ex.Message);
            }
            return null;
        }

        private static void ShowWindow()
        {
            Form form = new Form();
            form.Text = Title;
            try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            form.Width = 1220;
            form.Height = 820;
            form.MinimumSize = new Size(900, 600);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.BackColor = Color.FromArgb(242, 244, 247);
            form.FormClosing += OnFormClosing;

            if (_testMode)
            {
                // 自检模式：窗口起来后 8 秒自动关，不留窗口
                System.Windows.Forms.Timer autoClose = new System.Windows.Forms.Timer();
                autoClose.Interval = 8000;
                autoClose.Tick += delegate
                {
                    autoClose.Stop();
                    Log("自检：窗口存活 8 秒，自动关闭");
                    form.Close();
                };
                form.Shown += delegate { autoClose.Start(); };
            }

            Microsoft.Web.WebView2.WinForms.WebView2 view = new Microsoft.Web.WebView2.WinForms.WebView2();
            view.Dock = DockStyle.Fill;
            form.Controls.Add(view);

            form.Shown += async delegate
            {
                bool ready = false;

                // 第一次：自己建环境（指定用户数据目录）
                try
                {
                    SetDllDirectory(Path.Combine(_engineDir, "wv2"));
                    string udf = Path.Combine(_localRoot, "webview");
                    Directory.CreateDirectory(udf);
                    Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", udf);
                    Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                        await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, udf);
                    await view.EnsureCoreWebView2Async(env);
                    ready = true;
                }
                catch (Exception ex1)
                {
                    Log("WebView2 初始化失败(1): " + ex1.GetType().Name + ": " + ex1.Message);
                }

                // 第二次：交给控件用它自己的默认环境
                if (!ready)
                {
                    try
                    {
                        await view.EnsureCoreWebView2Async();
                        ready = true;
                    }
                    catch (Exception ex2)
                    {
                        Log("WebView2 初始化失败(2): " + ex2.GetType().Name + ": " + ex2.Message);
                    }
                }

                if (!ready)
                {
                    Log("WebView2 不可用，回退到外部窗口");
                    FallbackToBrowser(form);
                    return;
                }

                try
                {
                    view.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    view.Source = new Uri(_baseUrl);
                    Log("WebView2 界面已加载");
                }
                catch (Exception ex3)
                {
                    Log("加载界面失败: " + ex3.Message);
                    FallbackToBrowser(form);
                }
            };

            Application.Run(form);
        }

        private static void FallbackToBrowser(Form form)
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            string profile = Path.Combine(_localRoot, "browser");
            foreach (string exe in candidates)
            {
                if (!File.Exists(exe)) continue;
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = exe;
                    psi.Arguments = "--app=" + _baseUrl + " --window-size=1200,800 --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check";
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                    form.Close();
                    return;
                }
                catch { }
            }

            try { Process.Start(_baseUrl); } catch { }

            if (_testMode)
            {
                Log("自检：内嵌浏览器和外部浏览器都起不来（当前环境限制）");
                form.Close();
                return;
            }

            MessageBox.Show(
                "内嵌浏览器启动失败，已在默认浏览器里打开界面：\r\n" + _baseUrl + "\r\n\r\n\r\n如果一直这样，说明系统缺少 WebView2 运行时。",
                Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        private static void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            try
            {
                // 游戏还在跑就留着服务，别切断游戏日志输出；服务端会在空闲后自己退出
                if (GameRunning())
                {
                    Log("游戏仍在运行，保留后台服务");
                    return;
                }
            }
            catch { }
            KillNode();
        }
    }

    internal sealed class Splash : Form
    {
        private readonly Label _label;

        public Splash(string text)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(380, 110);
            BackColor = Color.White;
            ShowInTaskbar = false;
            TopMost = true;

            _label = new Label();
            _label.Text = text;
            _label.AutoSize = false;
            _label.Dock = DockStyle.Fill;
            _label.TextAlign = ContentAlignment.MiddleCenter;
            _label.Font = new Font("Microsoft YaHei UI", 10f);
            _label.ForeColor = Color.FromArgb(60, 66, 76);
            Controls.Add(_label);
        }

        public void SetText(string text)
        {
            _label.Text = text;
        }
    }
}
