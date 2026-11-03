// skill_hub tools — let the agent search and install skills from ClawHub.
// When a user asks to install a skill via natural language, the agent uses
// skill_hub_search to find it, then skill_hub_install to download and install it.

import { hubSearch, hubInstall, loadSkillBySlug } from '../../skills'
import type { ToolDef, ToolExecContext } from '../tool-def'

// --- skill_hub_search ---

const SEARCH_DEF = {
  type: 'function' as const,
  function: {
    name: 'skill_hub_search',
    description:
      '搜索 ClawHub 技能市场。当用户要求安装、查找或下载技能时使用此工具搜索可用技能。\n' +
      '返回匹配的技能列表，包含 slug、name 和 description。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，如 "翻译"、"代码审查"、"写作" 等'
        }
      },
      required: ['query']
    }
  }
}

async function executeSearch(argsStr: string, _ctx: ToolExecContext): Promise<string> {
  let args: { query?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return JSON.stringify({ error: 'query is required' })
  }

  try {
    const results = await hubSearch(query)
    return JSON.stringify({
      success: true,
      query,
      count: results.length,
      results: results.map((r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        emoji: r.emoji
      }))
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `ClawHub search failed: ${msg}` })
  }
}

export const skillHubSearchTool: ToolDef = {
  name: 'skill_hub_search',
  openai: SEARCH_DEF,
  execute: executeSearch
}

// --- skill_hub_install ---

const INSTALL_DEF = {
  type: 'function' as const,
  function: {
    name: 'skill_hub_install',
    description:
      '从 ClawHub 安装技能。当用户要求安装某个技能时，先用 skill_hub_search 搜索找到技能的 slug，再用此工具安装。\n' +
      '安装后技能会出现在技能选择器中，可以在对话中选用。',
    parameters: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: '要安装的技能 slug（从 skill_hub_search 结果中获取）'
        }
      },
      required: ['slug']
    }
  }
}

async function executeInstall(argsStr: string, _ctx: ToolExecContext): Promise<string> {
  let args: { slug?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const slug = typeof args.slug === 'string' ? args.slug.trim() : ''
  if (!slug) {
    return JSON.stringify({ error: 'slug is required' })
  }

  // Check if already installed
  const existing = loadSkillBySlug(slug)
  if (existing) {
    return JSON.stringify({
      success: true,
      already_installed: true,
      slug: existing.slug,
      name: existing.name,
      message: `技能「${existing.name}」已安装，无需重复安装`
    })
  }

  try {
    const skill = await hubInstall(slug)
    return JSON.stringify({
      success: true,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      message: `技能「${skill.name}」已成功安装`
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to install skill: ${msg}` })
  }
}

export const skillHubInstallTool: ToolDef = {
  name: 'skill_hub_install',
  openai: INSTALL_DEF,
  execute: executeInstall
}
