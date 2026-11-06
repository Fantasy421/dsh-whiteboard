# 安装与升级

[返回首页](../README.md) · [开发与打包](development.md) · [实机验证状态](verification.md)

## 兼容性与安装来源

当前版本为 **0.3.0 开发版**，针对 DSH `0.2.1-rc.3` 的公开接口开发。现有文档记录了自动化测试与构建通过，但真实 GUI 交互尚未完整验收，详见[验证状态](verification.md)。

> **不要在添加插件时只填写 `dsh-whiteboard`。** npm 上有另一位作者的同名 **0.0.1** 占位包，没有声明 `dsh.bundle`，会触发「这个包没有声明组合包，无法作为插件安装」。本仓库尚未发布到 npm；包名相同不代表来源相同。

## 推荐：GitHub Release 预构建包

在 DSH 的「设置 → 插件 → 添加插件」中填写以下**完整下载地址**，不要填写 Release 展示页、GitHub ZIP 源码下载页或裸包名：

```text
https://github.com/Fantasy421/dsh-whiteboard/releases/download/v0.3.0/dsh-whiteboard-0.3.0.tgz
```

如果有可用的 DSH CLI，同样可以执行：

```bash
dsh plugin --profile desktop add https://github.com/Fantasy421/dsh-whiteboard/releases/download/v0.3.0/dsh-whiteboard-0.3.0.tgz
```

也可以从 [v0.3.0 Release](https://github.com/Fantasy421/dsh-whiteboard/releases/tag/v0.3.0) 的 **Assets** 下载 `dsh-whiteboard-0.3.0.tgz`，再把下载文件的绝对路径填到添加插件入口。

不要选择 GitHub 自动生成的 Source code ZIP / tar.gz：源码仓库不提交 `lib/`，直接安装源码不等于安装预构建产物。预构建包包含[包配置](../package.json)中的 `dsh.bundle.patch`、对应补丁、编译后的 host/client 和字体。

安装完成后**重启原来的 DSH**；如有旧页面缓存，再刷新该页面。

## 升级已有安装

v0.3.0 预构建包包含阅读模式、多白板、线型编辑、紧凑顶部及网页嵌入误操作白屏修复。已安装旧版的用户需要重新安装新版，并刷新或重启原 DSH；仅更新源码或刷新旧包不会增加新功能。

此版本并未增加网页嵌入支持。当前存储和安全策略仍不接受 iframe/网页，详见[数据与安全](data-and-safety.md)。

## 开发者：本地构建与手动 profile 安装

先保存工作并备份 profile；**不要修改应用程序 ASAR**。常见 desktop profile 位于 `~/.dsh/profiles/desktop`，以实际配置为准。

1. 按[开发与打包](development.md)完成 `npm pack`，记下生成 tarball 的绝对路径。
2. 使用 profile 原本的包管理器安装；不要混写 npm/pnpm 锁文件。以下示例针对原本使用 pnpm 的 profile：

```bash
cd ~/.dsh/profiles/desktop
# 时间戳备份，不覆盖既有备份。
cp -p package.json "package.json.whiteboard-backup.$(date +%Y%m%d-%H%M%S)"
cp -p pnpm-lock.yaml "pnpm-lock.yaml.whiteboard-backup.$(date +%Y%m%d-%H%M%S)"
# 替换为实际 tarball 绝对路径。DSH 专用 peer 模块由宿主提供。
pnpm add --ignore-scripts --config.auto-install-peers=false --config.strict-peer-dependencies=false /absolute/path/to/dsh-whiteboard-0.3.0.tgz
```

若 profile 原本由 npm 管理，备份其锁文件后使用：

```bash
npm install --legacy-peer-deps --ignore-scripts /absolute/path/to/dsh-whiteboard-0.3.0.tgz
```

3. 在该 profile 的 `package.json` → `dsh.profile.bundles` 数组末尾追加 `"dsh-whiteboard"`，保留其余所有项；**不要替换整个数组**。插件自带 bundle patch，会挂载 host 和 client 两侧。
4. 重启原来的 DSH 桌面应用，在现有 GUI 打开会话、展开右侧栏，在入口页选择「协作白板」。如有旧页面缓存，刷新该页面。
5. 开启一个新 AI 会话，确认工具列表中存在 `whiteboard_list`、`whiteboard_manage`、`whiteboard_read`、`whiteboard_patch`。若预设限制了工具，需要在该预设允许它们。

不要启动另一个 Web 服务器来替代原 GUI。开发时生成的文件不会自动更新当前 GUI；需要重新打包安装并重启/刷新。使用 pnpm 管理 profile 时，应保持其原来的包管理方式，不要混写锁文件。

## 卸载

关闭 DSH，从 profile 的 `dsh.profile.bundles` 移除 `dsh-whiteboard`，按原包管理方式卸载该包，再重启。卸载**不自动删除画板数据**。删除或分享数据前请阅读[数据与安全](data-and-safety.md)。

## 报错时提供什么

针对 DSH `0.2.1-rc.3` 开发；其他版本如有报错，请同时提供：

- DSH 版本；
- 原样安装输入，尤其是完整包来源；
- 完整错误信息，分享前移除令牌、个人路径及白板敏感内容。

安装成功、工具调用成功、自动化测试成功，都不能单独证明真实 GUI 已验收。请按[验证清单](verification.md)记录实际结果。
