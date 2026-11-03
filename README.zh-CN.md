# Lucid

[English](./README.md)

基于 Electron、React 和 TypeScript 构建的本地优先 AI 智能体桌面应用。接入你自己的 OpenAI 兼容模型端点，即可运行具备 22 个内置工具、MCP 扩展、长期记忆与多智能体编排能力的全自主智能体。

---

## 宗旨

**Lucid** 意为清澈、明白。两条原则贯穿设计始终：

- **知行合一** — 智能体采用 ReAct 模式：先推理，再行动，观察结果，再次推理。不会盲目行动，也不会空想不动。思考与执行是同一个循环，而非割裂的两个阶段。
- **澄澈清明** — 智能体的每一步执行都清晰可见：推理实时流式呈现，工具调用展示参数与结果，完整时间线由 Agent Trace 记录。安全防护（Guard）以沙箱约束脚本执行，让智能体始终在你设定的边界内运行。

---

## 特点与优势

### 智能体能力

- **自主智能体循环** — 流式推理 + 工具调用，支持上下文压缩、中途取消/补充引导、token 用量追踪。
- **22 个内置工具** — 网页搜索、网页抓取、视觉理解、文件读写删除、代码执行、终端、图像生成/编辑、记忆搜索/保存、任务调度、询问用户、子智能体派生、技能中心等。
- **MCP 支持** — 接入外部 MCP 服务（Notion、数据库、API 等），扩展智能体的工具能力。
- **长期记忆** — SQLite + 向量搜索（sqlite-vec），支持跨会话的记忆抽取、整合与检索。
- **技能系统** — 安装预置技能或创建自定义技能；技能将领域知识注入智能体的系统提示词。
- **多智能体编排** — 定义专家智能体并分配专门角色；主智能体派发子任务并汇总结果。
- **任务调度器** — 通过 cron 表达式调度周期性或一次性智能体任务。
- **执行追踪** — 可视化执行时间线，展示每一轮迭代的推理、工具调用、token 数量和耗时。
- **安全防护** — 沙箱化脚本执行，可配置安全模式 / 无限制模式。

### 为什么选择 Lucid？

- **自带模型** — 不绑定任何模型供应商。任何 OpenAI 兼容端点均可使用（DashScope、vLLM、Ollama、本地模型等）。
- **完全本地** — 数据不离开你的机器。会话、记忆和文件都存储在 `~/.lucid/`。
- **4 类模型** — 分别配置主对话、多模态/视觉、嵌入和图像生成模型。
- **极简架构** — 不依赖任何 agent 框架（无 LangChain、无 LlamaIndex）。智能体循环就是「构建提示词 → 流式调用 → 执行工具 → 持久化」的直线流程。新增工具只需定义一个 3 字段的 `ToolDef` 对象并放入数组，没有继承、工厂和样板代码。
- **清晰的模块边界** — 主进程按领域拆分（`agent`、`mcp`、`memory`、`scheduler`、`subagent`），每个模块职责单一。渲染层用 7 个轻量 Zustand store 替代全局 reducer。消息持久化用增量 JSONL — 无 ORM、无数据库抽象层。
- **可读的代码** — 整个智能体运行时就在一个文件里。从 UI 点击到模型响应到工具执行，不需要穿越层层抽象就能追踪一条完整请求。
- **中文优化** — 记忆分词器和 UI 针对中文内容优化。

---

## 前置条件

- **Node.js >= 20**（推荐 22）
- **npm >= 10**
- 打包需要平台相关构建工具（参见 [electron-builder 文档](https://www.electron.build/)）

---

## 首次启动前配置

Lucid 不预置任何默认模型凭证。首次使用前，请配置你自己的模型端点和 API Key。

### 1. 模型配置

**在哪里配置**：应用内 **Settings → Models** 页面，或直接编辑 `~/.lucid/setting.json`。

需要配置 **4 类模型**：

| 类别 | 用途 | 示例模型 |
|------|------|----------|
| **Main（主对话）** | 主要对话与推理 | `deepseek-v4-pro`、`gpt-4o`、`qwen-max` |
| **Multimodal（多模态）** | 视觉 / 图像理解 | `qwen-vl-max`、`gpt-4o` |
| **Auxiliary（辅助）** | 记忆与搜索的文本嵌入 | `text-embedding-3-small`、`Qwen3-Embedding-4B` |
| **Image Gen（生图）** | 图像生成 | `dall-e-3`、`Qwen-Image-2.1-Turbo` |

每个模型条目需要：

```json
{
  "id": "唯一ID",
  "endpoint": "https://你的API端点/v1",
  "name": "模型名称",
  "apiKey": "你的API Key",
  "active": true
}
```

> 所有 OpenAI 兼容的端点均可使用，`endpoint` 字段即传入 OpenAI SDK 的 `baseURL`。

### 2. 网页搜索（阿里云 IQS）

`web_search` 工具使用阿里云 IQS（阿里云智能查询服务）。在项目根目录创建 `.env` 文件：

```env
ALIYUN_ACCESS_KEY=你的AccessKey
ALIYUN_ACCESS_SECRET=你的AccessSecret
```

> 在[阿里云 RAM 控制台](https://ram.console.aliyun.com/)获取 AccessKey，并确保已开通 IQS 服务。

### 3. MCP 服务（可选）

**在哪里配置**：应用内 **MCP Server Editor**，或编辑 `~/.lucid/mcp.json`。

默认为空。通过应用内 UI 添加 MCP 服务（如 Notion、文件系统、自定义 API 等）。

---

## 本地开发

```bash
# 安装依赖
npm install

# 启动开发模式（热重载）
npm run dev
```

应用窗口会自动打开。首次启动会创建 `~/.lucid/` 目录和空配置文件，请在 Settings 里配置模型。

### 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Electron + Vite 开发服务器，支持热重载 |
| `npm run build` | 类型检查 + 构建生产包 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm run lint` | 运行 ESLint |
| `npm run format` | 使用 Prettier 格式化代码 |

---

## 打包

构建三个平台的分发包：

```bash
# Windows（生成 .exe NSIS 安装包）
npm run build:win

# macOS（生成 .dmg）
npm run build:mac

# Linux（生成 .AppImage + .deb）
npm run build:linux
```

产物输出到 `dist/` 目录。

> **跨平台注意事项**：
> - 打包 macOS 应用需要在 macOS 上进行。
> - 打包 Windows 应用需要 Windows 或 Wine。
> - 打包 Linux 应用可在任意平台进行。
> - 详见 [electron-builder 跨平台打包文档](https://www.electron.build/multi-platform-build)。

---

## 项目结构

```
lucid/
├── src/
│   ├── main/              # Electron 主进程（智能体运行时、工具、MCP、记忆、调度器）
│   ├── preload/           # Electron preload 桥接
│   ├── renderer/          # React UI（对话、设置、追踪、智能体视图）
│   └── shared/            # 共享类型与契约
├── resources/
│   ├── skills/            # 内置技能提示词
│   └── subagent/          # 专家智能体定义与图配置
├── build/                 # 应用图标与授权文件
├── electron-builder.yml   # 打包配置
└── electron.vite.config.ts
```

---

## 许可证

[MIT](./LICENSE)
