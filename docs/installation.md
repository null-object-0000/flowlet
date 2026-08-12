# Flowlet 安装与使用手册

Flowlet 桌面端支持 Windows、macOS 和 Linux；Android APK 是实验性的移动辅助端，
不能替代桌面端的本地代理与账号管理能力。请只从
[Flowlet GitHub Releases](https://github.com/null-object-0000/flowlet/releases) 下载。

## 选择安装包

| 系统 | 推荐安装包 | 说明 |
| --- | --- | --- |
| Windows x64 | `windows_x64-setup.exe` | 常规安装首选；也提供 MSI 和便携版 ZIP |
| macOS Apple Silicon | `darwin_aarch64.dmg` | 适用于 M1、M2、M3、M4 等 Apple 芯片 Mac |
| macOS Intel | `darwin_x64.dmg` | 适用于 Intel 芯片 Mac |
| Linux x64 | `linux_amd64.AppImage` | 免安装运行；也提供 Debian DEB |
| Android arm64 | `arm64.apk` | 实验性移动辅助端 |

## Windows

1. 下载 EXE 安装版并运行；
2. 如果 SmartScreen 显示未知发布者，请先确认文件来自官方 Release，再选择“更多信息 → 仍要运行”；
3. 按安装向导完成安装并启动 Flowlet。

便携版 ZIP 解压后即可运行，程序配置和数据会保存在便携目录中。不要在压缩包内直接启动。

## macOS

### 确认芯片架构

在终端执行：

```bash
uname -m
```

- 输出 `arm64`：下载 Apple Silicon / `darwin_aarch64.dmg`；
- 输出 `x86_64`：下载 Intel / `darwin_x64.dmg`。

### 安装

1. 打开下载的 DMG；
2. 将 `Flowlet` 拖入右侧的 `Applications` 文件夹；
3. 弹出 DMG；
4. 从“应用程序”启动 Flowlet。

### 首次启动放行

Flowlet 的 macOS DMG 使用 ad-hoc 签名，但尚未经过 Apple 公证。首次启动时如果 macOS
阻止运行，请打开“系统设置 → 隐私与安全性”，在“安全性”区域找到 Flowlet 的拦截提示，
点击“仍要打开”，然后使用密码或 Touch ID 确认。

如果仍显示“已损坏，无法打开”，先使用 Release 页面给出的 SHA-256 校验值确认下载文件
完整且来源正确，再执行：

```bash
xattr -dr com.apple.quarantine /Applications/Flowlet.app
open /Applications/Flowlet.app
```

这项操作通常只需执行一次。不要对来源不明或校验值不一致的应用移除隔离属性。

计算 DMG 校验值的示例：

```bash
shasum -a 256 ~/Downloads/Flowlet_<版本号>_darwin_aarch64.dmg
```

## Linux

AppImage：

```bash
chmod +x Flowlet_<版本号>_linux_amd64.AppImage
./Flowlet_<版本号>_linux_amd64.AppImage
```

Debian / Ubuntu：

```bash
sudo apt install ./Flowlet_<版本号>_linux_amd64.deb
```

Linux 产物由 CI 自动构建，目前尚未完成作者完整真机回归。

## Android 移动辅助端

下载 arm64 APK 后，按照 Android 系统提示允许当前文件来源安装应用。移动端用于通过自有
S3 或局域网查看多设备用量、会话和 Agent 状态，并执行部分轻量操作；渠道账号、本地代理
和完整配置仍需在桌面端管理。

## 首次使用

1. 启动 Flowlet。桌面前端初始化后会自动尝试启动本地代理；
2. 添加渠道账号，填写连接信息并拉取上游模型列表；
3. 明确勾选需要对外开放的模型并保存；
4. 在概览页选择 Claude Code、Codex、OpenCode 或 Pi，查看说明或一键写入配置；
5. 回到 Agent 正常使用，并在 Flowlet 中查看请求、会话、Token 和费用。

即使尚未添加账号或开放模型，本地代理仍可运行；此时具体模型请求会提示尚未完成配置。

## 获取帮助

- 支持范围：[渠道、模型、协议与 Agent](support-matrix.md)
- 配置说明：[config.json 与运行时行为](config.md)
- 问题反馈：[GitHub Issues](https://github.com/null-object-0000/flowlet/issues)

反馈安装问题时，请附上操作系统版本、芯片架构、安装包文件名、完整错误提示和复现步骤，
但不要公开 API Key、Client Token 或包含敏感 Header 的请求日志。
