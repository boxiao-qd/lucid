# Lucid

[中文文档](./README.zh-CN.md)

A local-first AI agent desktop application built with Electron, React, and TypeScript. Connect your own OpenAI-compatible model endpoints and run a fully autonomous agent with 22 built-in tools, MCP extensibility, long-term memory, and multi-agent orchestration.

---

## Mission

The name **Lucid** means clear and transparent. Two principles guide the design:

- **Unity of thought and action (知行合一)** — the agent follows the ReAct pattern: it reasons about each step, acts, observes the result, then reasons again. It never acts blindly, and it never over-thinks without acting. Thinking and doing are one loop, not separate phases.
- **Transparent and safe execution (澄澈清明)** — every step of the agent's execution is visible: reasoning streams in real time, tool calls show their arguments and results, and the full timeline is captured in Agent Trace. A security guard sandbox constrains script execution so the agent stays within boundaries you define.

---

## Features & Advantages

### Agent Capabilities

- **Autonomous agent loop** — streaming reasoning + tool calls with context compaction, abort/steer mid-stream, and token usage tracking.
- **22 built-in tools** — web search, web fetch, vision, file read/write/delete, code execution, terminal, image generation/editing, memory search/save, task scheduling, ask-user, sub-agent spawning, skill hub, and more.
- **MCP support** — connect external MCP servers (Notion, databases, APIs...) to extend the agent's toolset.
- **Long-term memory** — SQLite + vector search (sqlite-vec) for cross-session memory extraction, consolidation, and retrieval.
- **Skills system** — install pre-built skills or create your own; skills inject domain knowledge into the agent's system prompt.
- **Multi-agent orchestration** — define expert agents with specialized roles; the leader agent delegates sub-tasks and synthesizes results.
- **Task scheduler** — schedule recurring or one-shot agent tasks via cron expressions.
- **Agent Trace** — visual execution timeline showing reasoning, tool calls, token counts, and timing for every iteration.
- **Security guard** — sandboxed script execution with configurable safe / unrestricted modes.

### Why Lucid?

- **Bring your own models** — no vendor lock-in. Any OpenAI-compatible endpoint works (DashScope, vLLM, Ollama, local models, etc.).
- **Fully local** — your data never leaves your machine. Sessions, memory, and files stay in `~/.lucid/`.
- **4 model categories** — configure separate models for main chat, multimodal/vision, embedding, and image generation.
- **Minimal architecture** — no agent framework dependency (no LangChain, no LlamaIndex). The agent loop is a straightforward build-prompt → stream → execute → persist cycle. Adding a tool means defining one 3-field `ToolDef` object and pushing it to an array — no inheritance, no factories, no boilerplate.
- **Clean module boundaries** — the main process is split by domain (`agent`, `mcp`, `memory`, `scheduler`, `subagent`), each with a single responsibility. The renderer uses 7 lightweight Zustand stores instead of a global reducer. Message persistence is incremental JSONL — no ORM, no database abstraction layer.
- **Readable codebase** — the entire agent runtime lives in a single file. You can trace a request from UI click to model response to tool execution without jumping through abstraction layers.
- **CJK-friendly** — memory tokenizer and UI optimized for Chinese content.

---

## Prerequisites

- **Node.js >= 20** (22 recommended)
- **npm >= 10**
- For packaging: platform-specific build tools (see [electron-builder docs](https://www.electron.build/))

---

## Configuration Before First Launch

Lucid does not ship with any default model credentials. Before you can chat with the agent, configure your own model endpoints and API keys.

### 1. Model Configuration

**Where**: In-app **Settings → Models** panel, or directly edit `~/.lucid/setting.json`.

You need to configure **4 model categories**:

| Category | Purpose | Example Models |
|----------|---------|----------------|
| **Main** | Primary conversation & reasoning | `deepseek-v4-pro`, `gpt-4o`, `qwen-max` |
| **Multimodal** | Vision / image understanding | `qwen-vl-max`, `gpt-4o` |
| **Auxiliary** | Text embedding for memory & search | `text-embedding-3-small`, `Qwen3-Embedding-4B` |
| **Image Gen** | Image generation | `dall-e-3`, `Qwen-Image-2.1-Turbo` |

Each model entry requires:

```json
{
  "id": "any-unique-id",
  "endpoint": "https://your-api-endpoint/v1",
  "name": "model-name",
  "apiKey": "your-api-key",
  "active": true
}
```

> Any OpenAI-compatible endpoint works. The `endpoint` field is the `baseURL` passed to the OpenAI SDK.

### 2. Web Search (Aliyun IQS)

The `web_search` tool uses Aliyun IQS (Alibaba Cloud Intelligence Query Service). Create a `.env` file in the project root:

```env
ALIYUN_ACCESS_KEY=your-access-key
ALIYUN_ACCESS_SECRET=your-access-secret
```

> Get these from the [Aliyun RAM console](https://ram.console.aliyun.com/). The IQS service must be activated for your account.

### 3. MCP Servers (Optional)

**Where**: In-app **MCP Server Editor**, or edit `~/.lucid/mcp.json`.

Default is empty. Add MCP servers (e.g., Notion, filesystem, custom APIs) through the UI.

---

## Local Development

```bash
# Install dependencies
npm install

# Start dev mode (hot reload)
npm run dev
```

The app window opens automatically. On first launch, `~/.lucid/` is created with empty config files — go to Settings to configure your models.

### Useful Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Electron + Vite dev server with hot reload |
| `npm run build` | Type-check + build production bundle |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |

---

## Packaging

Build distributable installers for all three platforms:

```bash
# Windows (produces .exe NSIS installer)
npm run build:win

# macOS (produces .dmg)
npm run build:mac

# Linux (produces .AppImage + .deb)
npm run build:linux
```

Output goes to the `dist/` directory.

> **Cross-platform notes**:
> - Building for macOS requires macOS.
> - Building for Windows requires Windows or Wine.
> - Building for Linux works on any platform.
> - See [electron-builder multi-platform build docs](https://www.electron.build/multi-platform-build) for details.

---

## Project Structure

```
lucid/
├── src/
│   ├── main/              # Electron main process (agent runtime, tools, MCP, memory, scheduler)
│   ├── preload/           # Electron preload bridge
│   ├── renderer/          # React UI (chat, settings, trace, agent views)
│   └── shared/            # Shared types and contracts
├── resources/
│   ├── skills/            # Built-in skill prompts
│   └── subagent/          # Expert agent definitions & graph config
├── build/                 # App icons and entitlements
├── electron-builder.yml   # Packaging config
└── electron.vite.config.ts
```

---

## License

[MIT](./LICENSE)
