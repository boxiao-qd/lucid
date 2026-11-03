// ask_user tool — human-in-the-loop choice selection.
// When the agent needs the user to make a decision among multiple options,
// it calls this tool with a question and an ordered list of choices
// (most recommended first). The tool emits a tool_confirm_request event with
// structured choices; the UI renders each as a row (title + detail).
// The user picks one (or rejects all), and the selected choice is returned
// to the LLM as the tool result.

import { requestConfirmation, isToolApproved } from '../tool-confirmation'
import type { ToolConfirmChoice } from '../../../shared/agent-events'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'ask_user',
    description:
      '向用户提问并给出多个选择项，让用户做出决策。适用于需要人类判断的场景。\n' +
      '选择项按推荐程度从高到低排序（第一个最推荐）。\n' +
      '用户可以选择其中一个选项，也可以拒绝所有选项。\n' +
      '返回用户选中的选项内容，或拒绝原因。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题或需要用户决策的场景描述'
        },
        choices: {
          type: 'array',
          description: '供用户选择的选项列表，按推荐程度从高到低排序',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: '选项的概要标题（简短，10-30字）'
              },
              detail: {
                type: 'string',
                description: '选项的详细说明（可包含理由、风险、预期效果等）'
              }
            },
            required: ['title', 'detail']
          },
          minItems: 2,
          maxItems: 6
        }
      },
      required: ['question', 'choices']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { question?: unknown; choices?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (!question) {
    return JSON.stringify({ error: 'question is required' })
  }

  if (!Array.isArray(args.choices) || args.choices.length < 2) {
    return JSON.stringify({ error: 'at least 2 choices are required' })
  }

  // Validate and normalize choices
  const choices: ToolConfirmChoice[] = []
  for (let i = 0; i < Math.min(args.choices.length, 6); i++) {
    const c = args.choices[i] as { title?: unknown; detail?: unknown }
    const title = typeof c?.title === 'string' ? c.title.trim() : ''
    const detail = typeof c?.detail === 'string' ? c.detail.trim() : ''
    if (!title) {
      return JSON.stringify({ error: `choice[${i}].title is required` })
    }
    choices.push({ title, detail })
  }

  // Request user confirmation with structured choices.
  // The content field carries the question text; the choices array carries
  // the structured options. The UI renders choices as rows.
  const content = question
  if (!isToolApproved(ctx.sessionId, 'ask_user')) {
    const confirm = await requestConfirmation(
      ctx.sessionId,
      'ask_user',
      content,
      ctx.toolCallId,
      ctx.emit,
      ctx.abortSignal,
      choices,
      undefined,
      !!ctx.parentSessionId
    )

    if (confirm.action === 'reject') {
      return JSON.stringify({
        result: 'rejected',
        message: confirm.text ?? '用户拒绝了所有选项'
      })
    }

    // User selected a choice — return it to the LLM
    if (confirm.choiceIndex !== undefined && confirm.choiceIndex >= 0) {
      const selected = choices[confirm.choiceIndex]
      return JSON.stringify({
        result: 'selected',
        choice_index: confirm.choiceIndex,
        choice_title: selected.title,
        choice_detail: selected.detail
      })
    }

    // Fallback: if text was provided (e.g. user typed a custom response)
    return JSON.stringify({
      result: 'text',
      message: confirm.text ?? ''
    })
  }

  // If ask_user is already approved for the session, auto-select the first (most recommended)
  return JSON.stringify({
    result: 'auto_selected',
    choice_index: 0,
    choice_title: choices[0].title,
    choice_detail: choices[0].detail,
    message: '已自动选择推荐选项（本次会话已授权自动选择）'
  })
}

export const askUserTool: ToolDef = {
  name: 'ask_user',
  openai: TOOL_DEF,
  execute
}
