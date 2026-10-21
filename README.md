# M-DSH-C

一个自用的 Minecraft: Java Edition 启动器。参考 PCL2 的操作习惯做的，核心是**下载、搜索、正版登录、一键启动**四件事。

纯 Node.js 标准库实现，零第三方依赖，不需要 `npm install`。

![](https://img.shields.io/badge/Node.js-20%2B-brightgreen) ![](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 功能

| | |
|---|---|
| 版本下载 | 从 Mojang 官方清单直接下载，自动补齐客户端、依赖库、资源、日志配置 |
| Java | 自动检测系统 Java；没有就自动下载 Mojang 官方运行时（8 / 17 / 21 按版本匹配） |
| 模组 | Modrinth + CurseForge 双源搜索，可指定版本安装，自动补 required 前置 |
| 中文搜索 | 内置中英对照词表 + MC百科兜底，搜「钠」「机械动力」「农夫」都能出本体 |
| 整合包 | Modrinth `.mrpack` 在线安装 / 本地导入（`.mrpack` 与 CurseForge `.zip` 都认），装成独立实例 |
| 资源包 / 光影 | 同样是 Modrinth 搜索 + 一键安装到对应目录 |
| 数据包 | Modrinth 搜索，下载到实例的 `datapacks` 目录 |
| 崩溃诊断 | 游戏异常退出后读 `latest.log` 和崩溃报告，给出人话结论（Java 版本 / 内存 / 缺前置 / 模组冲突 …） |
| 模组管理 | 读 jar 元数据拿到真实模组名，支持启用 / 禁用（改名 `.disabled`）和删除 |
| 正版登录 | 微软官方设备码流程，密码只在微软页面输入，启动器接触不到 |
| 启动 | 正确的 classpath / natives / 参数拼装，支持任意版本 |
| 其他 | 版本隔离、内存设置、JVM 参数、下载源切换（官方 / BMCI 镜像）、断点续传 |

## 快速开始

**要求**：Windows + [Node.js 20 或更高版本](https://nodejs.org/)

```bat
双击 启动.bat
```

首次运行会自动认领已有的 `.minecraft` 目录（按 `I:\MC` → `%APPDATA%\.minecraft` 等顺序探测）。

界面会以 Edge 的「应用窗口」模式打开，没有地址栏。

## 打包成单文件 EXE

```powershell
powershell -ExecutionPolicy Bypass -File build\build.ps1
```

需要：
- `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（Windows 自带的 C# 5 编译器）
- `build\wv2\` 下三个 WebView2 文件（从 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) 的 `lib/net462` 和 `runtimes/win-x64/native` 里取）
- 系统装有 Node.js（构建时会把 `node.exe` 一起打进去）

产物是 `M-DSH-C.exe`，约 34 MB，内置 Node 运行时和 WebView2 界面，首次启动自解到 `%LOCALAPPDATA%\M-DSH-C\engine`。

> 没有代码签名证书，Windows SmartScreen 会提示「未知发布者」。点「更多信息 → 仍要运行」即可。

## 正版登录说明

走微软官方的**设备码流程（device code flow）**：

1. 启动器向微软申请一个设备码
2. 你在浏览器里输入这串码并授权
3. 启动器拿到令牌，换取 Xbox Live → XSTS → Minecraft 令牌

密码全程只输在微软自己的页面上。

**关于应用 ID 的现状**：本项目已注册自己的 Azure 应用（client ID `bd0e57f1-…`），
但 Mojang 对 Minecraft API 还有一层**独立于 Azure 的允许列表**，新应用必须先申请才能调用，
否则最后一步会返回 `403 Invalid app registration`。

申请审核中，所以代码里暂时借用了一个公开的应用 ID 顶上。相关逻辑在 `src/core/auth.js`：

```js
export const PROJECT_CLIENT_ID = 'bd0e57f1-…';  // 本项目自己的应用
const TEMP_CLIENT_ID      = 'c36a9fb6-…';      // 获批前临时顶替
const USE_TEMP_CLIENT_ID  = true;              // ← 获批后改成 false
```

想用自己的应用，也可以在「设置 → 高级 → 微软应用 ID」里直接填。

Azure 应用要能用于这条流程，必须同时满足三个条件（缺一个都会在设备码阶段报 AADSTS 错）：

| 配置 | 值 |
|---|---|
| 受支持的账户类型 | 个人 Microsoft 账户 |
| `requestedAccessTokenVersion` | 2 |
| 允许公共客户端流 | 是 |

## 数据位置

```
.data\
├─ settings.json      设置
├─ accounts.json      账号令牌（明文，别外传）
├─ cn-en.json         运行时自动扩充的中英词表
└─ .minecraft\        如果把游戏目录设到这里才有
```

游戏文件默认写在**你自己的**游戏目录里（如 `I:\MC`），不在 `.data` 下。

`accounts.json` 里存的是 OAuth 令牌。拿到它的人可以用你的账号玩 Minecraft，
但**不能**登录你的微软账号。分享启动器前请删掉它，或在「账号」页点「清除全部登录数据」。

## 目录结构

```
├─ 启动.bat            双击运行（走系统 node）
├─ src\
│  ├─ server.js        本地 HTTP 服务 + 接口
│  ├─ core\            各功能模块（下载 / 认证 / 启动 / 模组 …）
│  ├─ data\            内置数据（中英词表）
│  └─ ui\              前端（纯 HTML/CSS/JS，无框架）
└─ build\
   ├─ Host.cs          EXE 宿主（解包 / 拉起服务 / WebView2 内嵌窗口）
   ├─ build.ps1        构建脚本
   └─ app.manifest     应用清单（asInvoker / 高 DPI）
```

### 关于版本锁定（很重要）

MC 的模组是**版本锁死**的，整合包作者经常明确要求「不要升级某个模组」。
所以这个启动器：

- **不会**在后台自动检测/更新任何模组——那在这种生态里是埋雷，不是贴心
- **不会**替玩家自动安装前置。详情页有「前置资源」入口，玩家自己点进去挑版本
- 整合包里的内容由整合包自身定义（`modrinth.index.json`），玩家不需要逐个折腾

**为什么连前置也不自动装**：不少模组后来把前置内置了、或者换了实现方式，
有些版本反而不需要前置；而 Modrinth 上记录的依赖往往是发布当时的快照。
自动装一个"当时指定的版本"经常是错的。实测过 Indium 要求 Sodium `0.5.11`，
而当时的最新版是 `0.6.13`——这种细节只有玩家自己清楚。

## 开发

```powershell
node scripts\smoke-test.mjs          # 纯逻辑冒烟测试（CI 跑的就是这个）
node scripts\smoke-test.mjs --net    # 额外检查 Mojang / Modrinth 可达性
```

冒烟测试覆盖了几个踩过坑的地方：zip 条目名分隔符（反斜杠导致 overrides 静默丢失）、
规则求值（os / features）、依赖库解析、maven 坐标转换、中文词表正查与反查、路径解析。

改完代码先跑这个，再提交。

## 已知限制

- 只支持 Windows
- CurseForge 的 `.zip` 整合包需要先在设置里填 API Key（回源解析每个 mod 的直链）
- Quilt 未支持
- 没有代码签名，SmartScreen 会拦一次

## 许可

MIT
