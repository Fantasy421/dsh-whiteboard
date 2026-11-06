# DSH 协作白板 · dsh-whiteboard

Excalidraw 风格的 DeepSeek Harness 插件：右侧画板由人和当前会话的 AI 共用。图形、连线、文字都可继续编辑，不调用图像生成服务。

> **0.1.1 开发版**。针对 DSH `0.2.1-rc.3` 的公开接口开发；59 项自动化测试及构建通过，已完成桌面 profile 安装和实际白板读取工具调用验证。侧栏画布、手绘、导出等 GUI 交互尚未完整验收；不要把构建或后端工具调用成功等同于 GUI 联调通过。

## 首版功能

- 右侧栏的「协作白板」入口；每个会话一个独立画板，可放大编辑。
- Excalidraw 原生选择、拖动、缩放、图形、箭头、文字、自由笔、撤销/重做。
- AI 通过 `whiteboard_read` / `whiteboard_patch` 读取当前会话画板并增量编辑。
- 活跃画板约每秒同步，停止输入后约 550ms 尝试自动保存；网络和操作耗时不计在内。
- 按会话保存到本机，关闭重开后恢复；内嵌 PNG/JPEG/WebP 图片也可保存。
- 导出 PNG、SVG 和 `.excalidraw` 可编辑源文件。
- 版本号 CAS + 三方合并：不同对象的并发修改可合并；同一对象冲突时暂停同步，保留本地修改，不静默覆盖。
- 浏览器本地恢复备份（容量受浏览器限制）；冲突时可先下载源文件，再明确选择加载服务器版本。
- 字体随插件打包并由现有 DSH 已认证 `/api` 端点提供，不新增端口。

## 开发与打包

环境：Node 20+、npm。使用 npm 的 `--legacy-peer-deps` 是因为 DSH 专用 peer 模块由宿主提供，不应另行安装一份。

```bash
npm ci --legacy-peer-deps --ignore-scripts
npm run check
npm pack
```

`check` 运行测试并生成插件产物。`pack` 再次检查后创建 `dsh-whiteboard-0.1.1.tgz`。

## 安装到桌面 DSH

先保存工作并备份 profile；不要修改应用程序 ASAR。常见 desktop profile 位于 `~/.dsh/profiles/desktop`，以实际配置为准。

1. 在源码目录完成 `npm pack`，记下生成 tarball 的绝对路径，然后使用 profile 原本的包管理器安装；不要混写 npm/pnpm 锁文件。以下示例针对 pnpm profile：

```bash
cd ~/.dsh/profiles/desktop
# 时间戳备份，不覆盖既有备份。
cp -p package.json "package.json.whiteboard-backup.$(date +%Y%m%d-%H%M%S)"
cp -p pnpm-lock.yaml "pnpm-lock.yaml.whiteboard-backup.$(date +%Y%m%d-%H%M%S)"
# 替换为实际 tarball 绝对路径。DSH 专用 peer 模块由宿主提供。
pnpm add --ignore-scripts --config.auto-install-peers=false --config.strict-peer-dependencies=false /absolute/path/to/dsh-whiteboard-0.1.1.tgz
```

若 profile 原本由 npm 管理，备份其锁文件后使用 `npm install --legacy-peer-deps --ignore-scripts /absolute/path/to/dsh-whiteboard-0.1.1.tgz`。

2. 在该 profile 的 `package.json` → `dsh.profile.bundles` 数组末尾追加 `"dsh-whiteboard"`，保留其余所有项；不要替换整个数组。插件自带 bundle patch，会挂载 host 和 client 两侧。
3. 重启原来的 DSH 桌面应用，在现有 GUI 打开会话、展开右侧栏，在入口页选择「协作白板」。如果有旧页面缓存，刷新该页面。
4. 开启一个新 AI 会话，确认工具列表中存在 `whiteboard_read`、`whiteboard_patch`。若预设限制了工具，需要在该预设允许它们。

不要启动另一个 Web 服务器来替代原 GUI。开发时生成的文件不会自动更新当前 GUI；需要重新打包安装并重启/刷新。使用 pnpm 管理 profile 时，应保持其原来的包管理方式，不要混写锁文件。

卸载时：关闭 DSH，从 profile 的 `dsh.profile.bundles` 移除 `dsh-whiteboard`，按原包管理方式卸载该包，再重启。卸载不自动删除画板数据。

## 怎么用

打开白板后，直接在 DSH 原来的聊天输入框里告诉 AI：

- “用白板画一个登录流程：用户输入 → 校验 → 成功/失败。”
- “保留当前图，只给 API 模块加一个数据库。”
- “把我选中的模块改成蓝色，解释这几条连接。”
- “先读取当前白板，再把整个架构按从左到右排列。”

人工绘图使用画板原生工具栏。撤销/重做使用画板内原生按钮/快捷键，键盘事件只在画板聚焦时处理，不全局抢占 DSH 快捷键。窄侧栏右上角提供醒目的「大屏编辑」，打开后点「返回侧栏」收起；空闲状态按 Esc 也可返回，正在编辑文字、绘图、选择对象或打开原生菜单时，Esc 优先交给画板处理。顶部始终显示 `− / 百分比 / ＋ / 适应` 控件，点击百分比恢复 100%；缩放以视口中心为锚点，不改变共享图形。大屏使用稳定的页面级容器，切换时不重建编辑器、不清空撤销历史，也不自动重置缩放或平移。

### 安装后的交互验收清单（尚待实机执行）

- [ ] 在原 GUI 出现侧栏入口；打开后画布可见、无重复 React 报错。
- [ ] 手画矩形、箭头、自由笔和中文文字；等到状态“已保存”。
- [ ] 删除对象后撤销，再刷新，恢复后的对象仍存在。
- [ ] 让 AI 画三个带标签节点和两条箭头，约一秒看到变化。
- [ ] 选择对象，AI 读取选区并仅修改该对象。
- [ ] 人工和 AI 修改不同对象可合并；同时修改同对象出现冲突，不覆盖。
- [ ] 下载本地源文件后，确认加载服务器版本可以解除冲突。
- [ ] 切换会话不串图；关闭重开、重启应用后恢复。
- [ ] 中文字体、PNG / SVG / 源文件导出均正常。
- [ ] 在窄侧栏及大屏模式下，缩放控件和「大屏编辑 / 返回侧栏」可见；反复切换不丢失绘图、选区和撤销历史。
- [ ] 空闲 Esc 返回侧栏；文字编辑、对象选择、原生菜单和对话框优先处理 Esc。
- [ ] 大屏内清空确认对话框正常显示；隐藏、关闭或切换会话后，不留下大屏遮罩。

组件回归测试以原生编辑器桩验证挂载次数、同步会话、视图控件和生命周期；它不替代实际浏览器的布局、焦点、撤销行为及第三方对话框验收。

## AI 工具示例

先读 `whiteboard_read`，取其 `revision`。例如读到 0 后：

```json
{
  "baseRevision": 0,
  "operations": [
    { "op": "add", "id": "input", "type": "rectangle", "x": 0, "y": 60, "width": 180, "height": 90, "text": "用户输入" },
    { "op": "add", "id": "check", "type": "diamond", "x": 300, "y": 40, "width": 180, "height": 130, "text": "校验" },
    { "op": "add", "id": "input-check", "type": "arrow", "startId": "input", "endId": "check" }
  ]
}
```

支持 `add / update / delete`；节点类型 `rectangle / diamond / ellipse / text / arrow / line`。添加节点时 `text` 生成原生绑定文字，移动节点会更新其绑定箭头。删除会保留墓碑、清理依赖，AI 不能复用已删除 ID。操作按数组顺序执行，先节点后连线。每批最多 100 条，失败则整批不落盘。

冲突后 AI 必须重新读取，考虑人的最新修改，再形成新操作；不能盲目把旧意图改成新版本号重试。

## 数据与边界

- 服务器默认存储：`~/.dsh/whiteboards/<SHA256(sessionId)>.json`，文件权限 0600；会话 ID 不作为路径片段。
- 同步复用 DSH 已认证接口；不创建公网无鉴权 API。画板内容可能含敏感信息，导出/分享需自行检查。
- 不执行画板内文字，不接受 iframe/网页嵌入、活动脚本链接、SVG 图片或远程图片引用。文本里可以正常讨论代码，文本不会成为指令。
- 最大 2000 个元素（含标签及删除墓碑），每个场景 JSON 8MiB。超出会显示保存失败，保留本地内容供导出；重试不能突破限制。
- 首版不持久化缩放、背景色、网格等个人视图状态；保存的是元素、内嵌图片和选区。撤销历史只在本次打开的画板中有效。
- 首版不含多人远程协作、跨进程分布式锁、无限历史和模型 token 级动画。单个 DSH 服务进程管理这个数据目录；不要让多个进程共享写入。
- 同步是对象级三方合并，不是字符级 CRDT。一个对象的不同字段同时变化也可能触发冲突，以避免误覆盖。
- 默认包含浏览器所需字体（含中文），首次包体较大。旧版 Liberation 1.05 属于上游服务端渲染字体，其历史授权尚待核实，本包不分发该字体。字体本地不可用时，上游库可能尝试自己的 CDN fallback；不应把本插件称为严格断网模式。

## 源码结构

- [host 和工具](src/index.mjs)：工具注册、会话身份绑定、认证载体路由、字体服务。
- [模型](src/model.mjs)：原生 Excalidraw 元素、图形/绑定/安全校验、原子增量操作。
- [存储](src/store.mjs)：按会话串行、版本比较、原子写入、磁盘恢复。
- [同步](src/sync.mjs)：三方合并、恢复备份、并发和冲突状态。
- [界面](src/Whiteboard.jsx) / [客户端注册](src/client.jsx)：画板、导出、侧栏插槽。
- [构建](scripts/build.mjs)：Host ESM + DSH lazy CJS 客户端，共用宿主 React，不重复打包 React。

## 许可证

本插件 MIT。Excalidraw 及其依赖保留各自许可证，构建保留第三方法律注释并随包带字体许可证。详情见 [第三方说明](THIRD_PARTY_NOTICES.md)。
