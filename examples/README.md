# 三组可编辑示例

这些文件由本仓库模型代码构建，只使用虚构内容，**不是软件截图、Computer Use 录像或 AI 实际操作记录**。生成过程没有读取真实会话或白板。

| 示例 | 可编辑源文件 | AI 增量操作参考 | 用途 |
| --- | --- | --- | --- |
| 演示·流程 | [reading-flow.excalidraw](reading-flow.excalidraw) | [operations](reading-flow.operations.json) | 输入 → 校验 → 完成；备注未连接，便于对照一跳关系。 |
| 演示·架构 | [system-architecture.excalidraw](system-architecture.excalidraw) | [operations](system-architecture.operations.json) | 界面、服务、存储、后台任务；包含直线、折线和曲线。 |
| 演示·接力编辑 | [human-ai-starter.excalidraw](human-ai-starter.excalidraw) | [operations](human-ai-starter.operations.json) | 单个“需求”节点，供人和 AI 继续补充。 |

## 怎么使用

- `.excalidraw` 是标准源文件，可在支持该格式的 Excalidraw 编辑器打开。这里仅通过模型校验；本轮没有浏览器导入实测。
- 在 DSH 内演示，请使用**新的独立会话/白板**，让 AI 先 `whiteboard_list`、读取目标白板，确认空白后再将 operations 数组作为 `whiteboard_patch` 的 `operations`。参数中仍需带目标 `boardId` 和刚读取的 `baseRevision`；不要粘贴成整场景替换，也不要盲目重试。
- 不要将示例拖到正在编辑的真实项目里；DSH 原生文件导入行为尚未完成 GUI 验收。
- 操作 JSON 是示例数据，不是已经发生过的 AI 调用，也没有模拟人的鼠标动作。

## 接力编辑提示词

> 先读取这张新建的演示白板，保留已有“需求”节点，补充“设计”和“验收”，并用箭头连接。只编辑这张演示白板，不要碰其他白板。

若需要演示“人先画”，必须在真实 GUI 中手动画“需求”，不能把这个预置源文件当作人工操作录像。

## 复现

生成定义和脚本：[generate-examples.mjs](../scripts/generate-examples.mjs)。输出元素的随机字段已转为确定值；重新构建结果可自动比较。脚本默认拒绝覆盖已存在的文件，防止误写。

真实录屏分镜见 [录制方案](../docs/demo-recording.md)。
