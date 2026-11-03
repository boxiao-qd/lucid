// graph.yaml read/write for expert_panel agents.
//
// graph.yaml lives alongside AGENT.md at
// ~/.lucid/subagent/agents/{agentId}/graph.yaml and is only present for
// `type: expert_panel` agents. The format is a fixed-shape YAML subset:
//
//   agentId: tech_writer_agent
//   graphType: DAG
//   nodes:
//     - agentId: tech_writer_agent
//       role: leader
//   edges:
//     - from: tech_writer_agent
//       to: content_search_agent
//   execution:
//     mode: serial

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  AgentGraph,
  ExecutionMode,
  GraphNode,
  GraphNodeRole
} from '../../shared/subagent-types'
import { graphYamlPath } from './agent-definition'

// --- Minimal YAML parser for the fixed graph.yaml shape ---

function parseGraphYaml(raw: string): AgentGraph | null {
  const lines = raw.split('\n')
  const result: Partial<AgentGraph> = {}
  const nodes: GraphNode[] = []
  const edges: { from: string; to: string }[] = []
  let executionMode: ExecutionMode | undefined
  let i = 0
  let section: 'root' | 'nodes' | 'edges' | 'execution' = 'root'
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0
    // Top-level keys (indent 0)
    if (indent === 0) {
      const idx = line.indexOf(':')
      if (idx === -1) {
        i++
        continue
      }
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key === 'agentId') {
        result.agentId = stripQuotes(val)
        section = 'root'
      } else if (key === 'graphType') {
        result.graphType = stripQuotes(val) as 'DAG'
        section = 'root'
      } else if (key === 'nodes') {
        section = 'nodes'
      } else if (key === 'edges') {
        section = 'edges'
      } else if (key === 'execution') {
        section = 'execution'
      } else {
        section = 'root'
      }
      i++
      continue
    }
    // Section-specific parsing
    if (section === 'nodes') {
      // Expect either `- agentId: X` (list item start) or continuation `role: Y`
      if (trimmed.startsWith('- ')) {
        const rest = trimmed.slice(2)
        const m = rest.match(/^agentId:\s*(.+)$/)
        if (m) {
          nodes.push({ agentId: stripQuotes(m[1].trim()), role: 'member' })
        }
      } else {
        const m = trimmed.match(/^role:\s*(.+)$/)
        if (m && nodes.length > 0) {
          const role = stripQuotes(m[1].trim()) as GraphNodeRole
          nodes[nodes.length - 1].role = role
        }
      }
    } else if (section === 'edges') {
      if (trimmed.startsWith('- ')) {
        const rest = trimmed.slice(2)
        const m = rest.match(/^from:\s*(.+)$/)
        if (m) {
          edges.push({ from: stripQuotes(m[1].trim()), to: '' })
        }
      } else {
        const m = trimmed.match(/^to:\s*(.+)$/)
        if (m && edges.length > 0) {
          edges[edges.length - 1].to = stripQuotes(m[1].trim())
        }
      }
    } else if (section === 'execution') {
      const m = trimmed.match(/^mode:\s*(.+)$/)
      if (m) {
        executionMode = stripQuotes(m[1].trim()) as ExecutionMode
      }
    }
    i++
  }
  if (!result.agentId || !result.graphType) return null
  return {
    agentId: result.agentId,
    graphType: result.graphType,
    nodes,
    edges,
    execution: { mode: executionMode ?? 'serial' }
  }
}

function stripQuotes(v: string): string {
  return v.replace(/^["']|["']$/g, '').trim()
}

function quote(v: string): string {
  if (v === '' || /[:#\[\]{}&*!|>'"%@`,\s]/.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`
  }
  return v
}

function buildGraphYaml(graph: AgentGraph): string {
  const lines: string[] = [
    `agentId: ${quote(graph.agentId)}`,
    `graphType: ${quote(graph.graphType)}`,
    'nodes:'
  ]
  for (const n of graph.nodes) {
    lines.push(`  - agentId: ${quote(n.agentId)}`)
    lines.push(`    role: ${quote(n.role)}`)
  }
  lines.push('edges:')
  for (const e of graph.edges) {
    lines.push(`  - from: ${quote(e.from)}`)
    lines.push(`    to: ${quote(e.to)}`)
  }
  lines.push('execution:')
  lines.push(`  mode: ${quote(graph.execution.mode)}`)
  return lines.join('\n') + '\n'
}

// --- Public API ---

export function loadAgentGraph(agentId: string): AgentGraph | null {
  const filePath = graphYamlPath(agentId)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return parseGraphYaml(raw)
  } catch {
    return null
  }
}

export function saveAgentGraph(agentId: string, graph: AgentGraph): void {
  // Ensure graph.agentId matches the dir owner for self-consistency
  const normalized: AgentGraph = { ...graph, agentId }
  writeFileSync(graphYamlPath(agentId), buildGraphYaml(normalized), 'utf-8')
}
