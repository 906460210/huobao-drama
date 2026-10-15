# 第一期：DeepSeek 与 RunningHub V2

## 配置 DeepSeek 文本模型

在「设置 → AI 服务」新增文本配置，选择 DeepSeek，填入 API Key、Base URL 与模型 ID。默认 Base URL 为 `https://api.deepseek.com`；也支持自定义兼容地址。模型 ID 可以自行输入，不依赖固定预设；可通过 DeepSeek 官方只读 [`GET /models`](https://api-docs.deepseek.com/api/list-models/) 查询账户可用模型。连接测试只请求模型列表，不发起文本生成。

在「设置 → Agent」可为每个 Agent 单独选择文本服务配置和模型 ID。请求指定的配置或模型优先于 Agent 默认值。Agent 与 Skill 的路由元数据集中在 `backend/src/agents/dispatch.ts`，为后续 ZenStory drama-skills 增加调度入口。

## 配置 RunningHub 图片与视频

在「设置 → AI 服务」新增图片或视频配置，选择 RunningHub。两种调用方式均需填写 API Key；密钥保存在本地数据库的服务配置中，不写入仓库文件。

- **ComfyUI 工作流**：初始 Workflow ID 为 `2109907990638850050`。至少添加一条节点参数映射：节点 ID、节点字段名、任务素材字段。节点 ID 和字段名必须取自该工作流的 API 格式 JSON；本项目不预填未核实的节点。可填输出节点 ID，以免把预览图或其他节点输出误当最终结果。
- **模型 API**：填入该模型官方文档给出的 `/openapi/v2/...` 路径，并逐项配置请求字段与任务素材字段。不同模型没有统一创建参数；模型 API 需要符合 RunningHub 对 Enterprise Shared Key 的要求。字段名支持点路径，例如 `input.prompt` 与 `parameters.duration`。

常用任务素材字段有 `prompt`、`size`、`referenceImages[0]`、`imageUrl`、`firstFrameUrl`、`lastFrameUrl`、`referenceImageUrls[0]`、`referenceVideoUrls[0]`、`referenceAudioUrls[0]`、`referenceFileUrl`、`duration`、`aspectRatio`、`resolution`、`seed`。映射源写 `$constant` 可设置固定值。每行可指定值类型，并填写 JSON 值映射；例如 `{"1080p":"1080P"}` 能对齐官方枚举，`duration` 可转成文本。模型字段名支持官方示例中的 `272##image` 等键。需要传入工作流文件名或模型上传 URL 时，勾选该映射行的「上传素材」；适配器会先调用官方上传接口，也可安全读取本地 `static/` 素材，无需为 RunningHub 配置 `PUBLIC_BASE_URL`。保存配置不会创建生成任务，RunningHub 也没有会产生费用的连接测试按钮。

RunningHub 官方资料：[V2 查询](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306)、[媒体上传](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007)、[工作流节点映射](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287336)、[按 ID 读取 API 格式 JSON](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014)、[已发布工作流接口示例](https://www.runninghub.ai/call-api/api-detail/1923539279828742146?apiType=5)。读取工作流 JSON 的接口是只读操作；获取上述指定工作流的实际节点仍需用户账户授权或用户导出的 JSON。

## 任务与恢复

图片和视频继续使用原有 `sys_task` 队列。上游返回的任务 ID 及原配置 ID 会持久化；服务重启后仅查询已有任务，取得结果 URL 后及时下载到本地。下载失败可通过 `POST /api/v1/tasks/:id/resume` 重试下载；已取得上游任务 ID 的任务可用同一接口恢复查询。工作台任务列表有「恢复」按钮；RunningHub 视频的失败重试也会优先复用已有任务。提交结果不明且没有上游 ID 时，系统不会自动重复提交，须先到 RunningHub 控制台核对，以免重复计费。官方说明结果 URL 有时效，恢复下载应及时进行。

本期自动化测试只使用模拟 HTTP 响应，未使用真实 API Key，也未发起付费生成任务。
