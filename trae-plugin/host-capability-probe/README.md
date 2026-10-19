# Windows 人工配合：插件宿主能力探针

这是“目标 Trae 插件表单与私有会话的宿主能力验证”的合成测试材料。核心探针验证 Webview、消息桥、HTTP Cookie-CSRF、SecretStorage 和窗口事件；业务插件认证、真实平台注册登录及 Hook 安装属于后续验证。

## 准备电脑

1. 使用专用 Windows 本地测试用户，并在该用户下打开 Trae。这样个人 `~/.trae-cn` 与业务用户隔离；单独编辑器 profile 本身不能证明 Trae 私有账号和 Hook 目录已经隔离。
2. 记录 Trae 的完整产品名和“关于”页面版本。本轮目标是 Trae CN；若安装的是国际版，请先说明产品与版本，单独记录验证结果。使用原生 Windows，不在 WSL 中运行本轮探针。
3. 将 `adi-host-probe-manual-0.0.1.zip` 解压到独立文件夹。包内有探针 VSIX、预检脚本，以及 `window-a/adi-host-probe-workspace` 和 `window-b/adi-host-probe-workspace` 两个合成工作区文件夹。探针 VSIX 内带仅监听 `127.0.0.1` 的测试服务，无需安装 Node、Python 或 clone 主项目。
4. 核心宿主测试不需要 Git。后续仓库观测测试才需要 Windows 原生 `git.exe` 和合成测试仓库；已安装 Git 的电脑直接记录版本即可。

## 运行预检

在测试材料文件夹打开 Windows PowerShell，执行：

```powershell
powershell -NoProfile -File .\windows-preflight.ps1
```

安装在自定义目录时，可明确传入可执行文件：

```powershell
powershell -NoProfile -File .\windows-preflight.ps1 -TraeExecutable 'D:\TestApps\Trae CN\Trae CN.exe'
```

脚本读取 Windows 版本、构建号、架构、PowerShell 版本、可见 `git.exe` 的版本，以及有限候选路径中的 Trae 文件版本。它只执行 `git.exe --version`，不会启动 Trae、安装材料或更改配置；报告写入脚本同目录的 `synthetic-host-preflight.json`。重复运行会更新该报告。

预检脚本不会查询平台地址。平台根 `web_url` 的连接与真实 API 契约需后续独立验证，核心探针只访问自带 loopback 服务。

若系统策略阻止脚本，将错误文字返回本会话，由维护人员提供替代预检方式。报告中的 Git 和 Trae 路径用 `%USERPROFILE%`、`%LOCALAPPDATA%` 等占位符显示，不记录用户名或电脑名；这些是展示标签。打开报告核对自定义路径后再回传。文件版本是静态信息，仍应对照 Trae“关于”页面。

## 安装与运行核心探针

在专用测试用户的 Trae 扩展面板选择“从 VSIX 安装”，选包内的宿主探针 VSIX。用窗口 A 打开 `window-a/adi-host-probe-workspace`，在命令面板搜索 `ADI Probe`。

1. 运行 **ADI Probe: Open**，打开活动栏的 **ADI Probe** 侧栏。若打开命令无法聚焦，直接点击活动栏的测试瓶子图标。只使用侧栏提供的合成表单值。
2. 运行 **ADI Probe: Run**，确认合成表单提交、消息往返和 loopback Cookie-CSRF 检查结果。运行 **ADI Probe: Export Report** 保存窗口 A 的报告。
3. 运行 **ADI Probe: Open Probe Settings** 查看探针设置。`adiHostProbe.platformUrl` 和 `adiHostProbe.enabled` 是 Application 级测试设置；地址用于测试显示和配置事件，不向填写的地址请求，也不控制真实采集。记录修改设置后的事件与读回。
4. 在同一测试 profile 中新建窗口 B，打开 `window-b/adi-host-probe-workspace`，打开 ADI Probe 侧栏，先记录两窗的 `secret_events`。
5. 在窗口 A 运行 **ADI Probe: SecretStorage Write**，写入探针专用合成值。在窗口 B 查看 `secret_events` 变化，运行 **ADI Probe: SecretStorage Verify**；在 A 也执行 Verify，比较两窗报告中的 `fingerprint`，并分别 Export Report。
6. 在测试窗口执行扩展宿主重启或窗口重载，再执行 Verify 并导出报告；记录实际使用的重载方式。随后由人工完全退出本次测试 IDE，重新打开测试工作区，再 Verify 并导出报告。只退出专用测试用户的测试 IDE，保留业务窗口；无法确认窗口所属用户时，先记录该步骤未执行。
7. 运行 **ADI Probe: SecretStorage Clear** 清除探针专用合成值，在两窗分别 Verify，记录缺失结果与清除事件，导出最终报告。

跨窗口判断依据是 SecretStorage 事件和实际读回的指纹；普通 `globalState` 中的 hash 是否即时同步不作为 API 保证或通过条件。报告不包含秘密原值。

命令的 ID 前缀是 `adiHostProbe.`；人工操作使用上述显示标题即可。每个步骤记录“通过、失败或未执行”及错误文字；单窗口读回不能替代重载、重启和多窗口验收。

## 回传材料

- `synthetic-host-preflight.json`，以及 Trae“关于”页的产品名和版本文字。
- 核心探针导出的合成报告，包括平台/架构、实际宿主版本、逐项结果、执行时间和错误码。
- 多窗口、重载、完整重启和 Clear 的实际操作顺序；未执行的步骤保持未执行。

本轮先完成核心宿主能力验证。HTTPS、真实平台注册登录、Hook 安装与启用、运行方式及真实事件入库均记录为 `not_run`，需要后续独立材料与步骤。

## 材料准备验证与当前环境

用户提供的目标环境：Windows 10 x64、Trae CN 3.4.1。实际编辑器API底座版本以探针runtime.editor_api_version为准，产品版本号不能直接替代它；包声明与现项目一致的 ^1.107.0 engine，如安装拒绝则保留错误，不绕过限制。

2026-10-09准备检查：JavaScript语法、Node本机回环HTTP冒烟、工作区门禁/报告过滤的SDK替身测试、ZIP CRC及manifest XML检查。它们不证明真实Trae或Windows已经通过。PowerShell脚本仅静态审阅，尚未在Windows运行。

构建机器可用标准库命令 `python3 trae-plugin/host-capability-probe/build.py` 重建交付包；Windows测试者无需执行构建。Node冒烟命令 `node trae-plugin/host-capability-probe/smoke.cjs` 只用于准备材料，不算宿主验收。
