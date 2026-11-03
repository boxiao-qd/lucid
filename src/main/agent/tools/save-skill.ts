// save_skill tool — creates a new skill from agent-generated content.
// Used by the skill-creator skill to let the agent create skills in chat.
// Writes to ~/.lucid/workspace/skills/{slug}/SKILL.md.

import { createSkill } from '../../skills'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'save_skill',
    description:
      '创建一个新技能并保存到磁盘。技能创建后会出现在技能选择器中，可以在对话中选用。' +
      '参数：name（技能名称）、description（技能描述）、emoji（可选图标）、content（技能 prompt 内容，markdown 格式）。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名称，简短易记，如「翻译官」「代码审查」'
        },
        description: {
          type: 'string',
          description: '技能描述，一句话说明何时使用此技能'
        },
        emoji: {
          type: 'string',
          description: '可选的 emoji 图标，如 🔍、📋、✍️'
        },
        content: {
          type: 'string',
          description: '技能的 prompt 内容（markdown 格式），会注入到 agent 的 system prompt 中'
        }
      },
      required: ['name', 'description', 'content']
    }
  }
}

async function execute(argsStr: string, _ctx: ToolExecContext): Promise<string> {
  let args: { name?: unknown; description?: unknown; emoji?: unknown; content?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const description = typeof args.description === 'string' ? args.description.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''
  const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : undefined

  if (!name) {
    return JSON.stringify({ error: 'name is required' })
  }
  if (!description) {
    return JSON.stringify({ error: 'description is required' })
  }
  if (!content) {
    return JSON.stringify({ error: 'content is required' })
  }

  try {
    const skill = createSkill({ name, description, emoji: emoji || undefined, content })
    return JSON.stringify({
      success: true,
      slug: skill.slug,
      name: skill.name,
      message: `技能「${skill.name}」已创建，slug: ${skill.slug}`
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to create skill: ${msg}` })
  }
}

export const saveSkillTool: ToolDef = {
  name: 'save_skill',
  openai: TOOL_DEF,
  execute
}
