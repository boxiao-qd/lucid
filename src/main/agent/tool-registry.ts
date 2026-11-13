// Tool registry — register all agent tools and dispatch by name.
// v1: TodoWrite + web_search + web_fetch. All execute serially.

import type { ToolDef, ToolExecContext, OpenAIToolDef } from './tool-def'
import { todoWriteTool } from './tools/todo-write'
import { webSearchTool } from './tools/web-search'
import { webFetchTool } from './tools/web-fetch'
import { visionTool } from './tools/vision'
import { saveProductTool } from './tools/save-product'
import { saveSkillTool } from './tools/save-skill'
import { readTool } from './tools/read'
import { writeTool } from './tools/write'
import { deleteTool } from './tools/delete'
import { skillHubSearchTool, skillHubInstallTool } from './tools/skill-hub'
import { codeExecuteTool } from './tools/code-execute'
import { terminalTool } from './tools/terminal'
import { memorySearchTool } from './tools/memory-search'
import { saveMemoryTool } from './tools/save-memory'
import { scheduleTaskTool } from './tools/schedule-task'
import { askUserTool } from './tools/ask-user'
import { sessionSpawnTool } from './tools/session-spawn'
import { getCurrentTimeTool } from './tools/get-current-time'
import { fileReadTool } from './tools/file-read'
import { generateImageTool } from './tools/generate-image'
import { editImageTool } from './tools/edit-image'
import { browserUseTool } from './tools/browser-use'

const ALL_TOOLS: ToolDef[] = [
  todoWriteTool,
  webSearchTool,
  webFetchTool,
  visionTool,
  saveProductTool,
  saveSkillTool,
  readTool,
  writeTool,
  deleteTool,
  skillHubSearchTool,
  skillHubInstallTool,
  codeExecuteTool,
  terminalTool,
  memorySearchTool,
  saveMemoryTool,
  scheduleTaskTool,
  askUserTool,
  sessionSpawnTool,
  getCurrentTimeTool,
  fileReadTool,
  generateImageTool,
  editImageTool,
  browserUseTool
]

// Build the registry once. Returns a Map for dispatch + the OpenAI function defs
// array to hand to the LLM (optionally filtered, e.g. to drop TodoWrite when all
// todos are done).
export function registerTools(): {
  byName: Map<string, ToolDef>
  openaiDefs: OpenAIToolDef[]
} {
  const byName = new Map<string, ToolDef>()
  const openaiDefs: OpenAIToolDef[] = []
  for (const t of ALL_TOOLS) {
    byName.set(t.name, t)
    openaiDefs.push(t.openai)
  }
  return { byName, openaiDefs }
}

// OpenAI defs filtered by an exclusion set (used to drop TodoWrite when the plan
// is fully complete, so the LLM stops calling it and gives a final answer).
export function filterToolDefs(openaiDefs: OpenAIToolDef[], exclude: Set<string>): OpenAIToolDef[] {
  return openaiDefs.filter((d) => !exclude.has(d.function.name))
}

// Dispatch a tool call. Returns the tool result string (always JSON) or an
// error string if the tool name is unknown / execution throws.
// Wraps execution in a 120s catch-all timeout — prevents any single tool
// (e.g. web_fetch on a hung URL, terminal on a blocking command) from
// stalling the agent loop indefinitely.
//
// session_spawn is exempt: it runs entire expert panels (5 members doing
// research, drafting, review, revision) which can take 10+ minutes. It
// manages its own lifecycle via the parent abort signal.
const TOOL_EXEC_TIMEOUT_MS = 120_000
const NO_TIMEOUT_TOOLS = new Set(['session_spawn'])

export async function executeTool(
  name: string,
  argsStr: string,
  ctx: ToolExecContext,
  byName: Map<string, ToolDef>
): Promise<string> {
  const tool = byName.get(name)
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
  try {
    if (NO_TIMEOUT_TOOLS.has(name)) {
      // Long-running tools manage their own lifecycle — no catch-all timeout.
      const result = await tool.execute(argsStr, ctx)
      return result
    }
    const result = await Promise.race([
      tool.execute(argsStr, ctx),
      new Promise<string>((resolve) => {
        setTimeout(
          () =>
            resolve(
              JSON.stringify({
                error: `Tool ${name} timed out after ${TOOL_EXEC_TIMEOUT_MS / 1000}s`
              })
            ),
          TOOL_EXEC_TIMEOUT_MS
        )
      })
    ])
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Tool ${name} failed: ${msg}` })
  }
}
