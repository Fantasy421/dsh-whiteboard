# 开发与打包

[返回首页](../README.md) · [安装](installation.md) · [验证状态](verification.md)

## 环境与命令

环境：Node 20+、npm。DSH 专用 peer 模块由宿主提供，不应另行安装一份；因此使用 npm 的 `--legacy-peer-deps`。

```bash
npm ci --legacy-peer-deps --ignore-scripts
npm run check
npm pack
```

[包配置](../package.json)中的脚本：

| 命令 | 实际执行 |
| --- | --- |
| `npm test` | `node --test test/*.test.mjs` |
| `npm run build` | `node scripts/build.mjs` |
| `npm run check` | `npm test && npm run build` |
| `npm pack` | 先经 `prepack` 再次运行 `npm run check`，然后创建 `dsh-whiteboard-0.3.0.tgz` |

`check` 运行测试并生成插件产物。当前包版本为 `0.3.0`，针对 DSH `0.2.1-rc.3` 的公开接口开发；宿主 peer 依赖使用 `^0.2.1-rc.3`。原生编辑器为 Excalidraw `0.18.0`，构建工具为 esbuild `0.25.12`。实际依赖与导出入口以[包配置](../package.json)为准。

测试与构建成功不代表当前桌面 GUI 已更新，也不等于真实浏览器验收。完整状态和待测项见[验证文档](verification.md)。

## 本地安装与 GUI 更新

按[安装文档](installation.md#开发者本地构建与手动-profile-安装)安装本地产出的 tarball。先备份 profile，保持原包管理器与锁文件，不修改应用 ASAR。

开发生成的文件不会自动更新已安装的 GUI。需要重新打包、安装，再重启/刷新原 DSH。不要另起一个 Web 服务器替代原 GUI，也不要用源码下载包代替预构建插件包。

## 源码结构

| 模块 | 作用 |
| --- | --- |
| [host 与工具](../src/index.mjs) | 工具注册、会话身份绑定、认证载体路由、字体服务 |
| [模型](../src/model.mjs) | 原生 Excalidraw 元素、图形/绑定/安全校验、原子增量操作 |
| [存储](../src/store.mjs) | 按会话串行、版本比较、原子写入、磁盘恢复 |
| [多白板存储](../src/workspace.mjs) | 独立目录 CAS、旧图兼容、目录管理 |
| [白板导航](../src/Boards.jsx) | 搜索、管理与安全切换 |
| [恢复备份](../src/recovery.mjs) | 按会话/白板隔离，保留旧 default 的浏览器备份键 |
| [同步](../src/sync.mjs) | 三方合并、恢复备份、并发与冲突状态 |
| [界面](../src/Whiteboard.jsx) / [客户端注册](../src/client.jsx) | 画板、导出、侧栏插槽 |
| [阅读关系与命中](../src/reading.mjs) / [高亮覆盖层](../src/ReadingOverlay.jsx) | 一跳邻居、旋转/画框裁剪、仅本地的阅读视图 |
| [构建](../scripts/build.mjs) | Host ESM + DSH lazy CJS 客户端，共用宿主 React，不重复打包 React |

## 需要保留的实现边界

- 两套版本：目录 CAS 与场景 CAS 分离。AI 写操作需显式保留目标 `boardId` 和对应场景版本，见[工具文档](ai-tools.md)。
- 阅读模式：双阶段原生切换生命周期、只读图片缓存隔离与画框裁剪属于回归重点。覆盖层是本地视图，不应改写共享元素或导出内容。
- 网页嵌入拒绝：原生编辑器父组件更新可能再次通知场景变化。反复创建提示状态曾在回退微任务前触发 React 更新深度限制；回退须有重入保护、合并提示并限定到原画板实例。修复不能变成允许网页嵌入或清空撤销历史。
- 紧凑顶部：管理与“更多”互斥；展开/收起不重建编辑器。错误/草稿提示保留在独立区域，菜单不能遮住。大屏用稳定的页面级容器，不自动重置缩放/平移，不因大屏切换清空撤销历史。
- 原生线型：原生圆角转换不为两点线生成可见弯曲，普通线也没有箭头式自动折线路由；自定义转换保留用于可见弯曲和多拐点。旋转补偿与标签布局采用理想几何，不承诺与随机手绘笔触像素级重合。
- 同步与恢复：未知写入结果应先读确认；不能盲目覆盖、重复目录操作或丢弃人的草稿。容量、安全、进程和恢复边界见[数据文档](data-and-safety.md)。

## 发布检查

1. 在目标版本完成 `npm run check` 与 `npm pack`，记录实际结果，不沿用旧测试数量冒充新运行。
2. 确认包中存在 `dsh.bundle.patch` 指向的补丁、编译后的 host/client 和字体；不要分发仅有源码且缺少 `lib/` 的安装包。
3. 在原 DSH 安装预构建包，按[实机清单](verification.md)记录已验证与未验证项。
4. README 若引用文档或媒体，检查发布 tarball 的 `files` 白名单是否包含它们；仓库相对链接可用不代表解包后仍存在。
5. 保留[安装文档](installation.md)的 npm 同名警告与 pinned Release URL。当前仓库未发布 npm，同名包属于他人，不能把裸包名宣传为安装入口。
6. 保留第三方法律注释与字体许可，参阅[第三方说明](../THIRD_PARTY_NOTICES.md)。

发布与安装成功不能替代 GUI 功能验收；演示录像只能证明实际录到的那条操作路径。
