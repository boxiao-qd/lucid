// Memory consolidation — dedup, contradiction resolution.
// Called by the system scheduled task (system-memory-consolidate) at 3am daily.
// Short → long promotion is NOT automatic — it only happens through this
// scheduled task. This module handles dedup + contradiction removal only.

import OpenAI from 'openai'
import {
  getAllMemories,
  updateMemoryTier,
  deleteMemory,
  isDbAvailable,
  isVecAvailable,
  searchVector
} from './memory-db'
import { getEmbedding } from './embedding-provider'
import { readSettings } from '../settings'

const SIMILARITY_THRESHOLD = 0.95 // cosine similarity above this → duplicate
const CONTRADICTION_CHECK_THRESHOLD = 0.6 // above this but below dedup → check for contradiction

// Main entry — called by the scheduled task.
export async function consolidateMemories(): Promise<void> {
  if (!isDbAvailable()) return

  try {
    await deduplicateMemories()
    await resolveContradictions()
    await promoteShortTermMemories()
    console.log('[Memory] Consolidation complete')
  } catch (e) {
    console.error('[Memory] Consolidation failed:', e)
  }
}

// ── Deduplication ──
// For each memory, find semantically similar ones (cosine similarity > threshold).
// If similar, keep the one with the latest updatedAt (conflict resolution:
// latest timestamp wins), delete the others.

async function deduplicateMemories(): Promise<void> {
  if (!isVecAvailable()) return // need vectors for similarity

  const all = getAllMemories()
  const toDelete = new Set<string>()

  for (const mem of all) {
    if (toDelete.has(mem.id)) continue

    const embedding = await getEmbedding(mem.content)
    if (embedding.length === 0) continue

    // Find similar memories via KNN
    const candidates = searchVector(embedding, 10)
    for (const candidate of candidates) {
      if (candidate.id === mem.id) continue
      if (toDelete.has(candidate.id)) continue

      // Check cosine similarity
      const other = all.find((m) => m.id === candidate.id)
      if (!other) continue

      const sim = cosineSimilarity(embedding, await getEmbedding(other.content))
      if (sim >= SIMILARITY_THRESHOLD) {
        // Conflict resolution: keep the one with the latest updatedAt
        if (mem.updatedAt >= other.updatedAt) {
          toDelete.add(other.id)
        } else {
          toDelete.add(mem.id)
          break // this memory is deleted, move to next
        }
      }
    }
  }

  for (const id of toDelete) {
    deleteMemory(id)
  }

  if (toDelete.size > 0) {
    console.log(`[Memory] Deduplication: removed ${toDelete.size} duplicates`)
  }
}

// ── Contradiction resolution ──
// For each memory, find semantically related ones (similarity ≥ threshold but
// below dedup threshold). Ask LLM if they contradict each other. If so, keep
// the newer one, delete the older.

async function resolveContradictions(): Promise<void> {
  if (!isVecAvailable()) return

  const all = getAllMemories()
  if (all.length < 2) return

  const toDelete = new Set<string>()
  const checked = new Set<string>() // avoid checking the same pair twice

  for (const mem of all) {
    if (toDelete.has(mem.id)) continue

    const embedding = await getEmbedding(mem.content)
    if (embedding.length === 0) continue

    // Find semantically related memories via KNN
    const candidates = searchVector(embedding, 10)
    for (const candidate of candidates) {
      if (candidate.id === mem.id || toDelete.has(candidate.id)) continue

      // Avoid checking the same pair twice
      const pairKey = [mem.id, candidate.id].sort().join('|')
      if (checked.has(pairKey)) continue
      checked.add(pairKey)

      const other = all.find((m) => m.id === candidate.id)
      if (!other) continue

      const otherEmbedding = await getEmbedding(other.content)
      const sim = cosineSimilarity(embedding, otherEmbedding)

      // Only check for contradictions if semantically related but not duplicates
      // (duplicates are already handled by dedup)
      if (sim >= CONTRADICTION_CHECK_THRESHOLD && sim < SIMILARITY_THRESHOLD) {
        const contradicts = await checkContradiction(mem.content, other.content)
        if (contradicts) {
          // Keep the newer one, delete the older
          if (mem.updatedAt >= other.updatedAt) {
            toDelete.add(other.id)
            console.log(
              `[Memory] Contradiction: removed older memory "${other.content.slice(0, 50)}..."`
            )
          } else {
            toDelete.add(mem.id)
            console.log(
              `[Memory] Contradiction: removed older memory "${mem.content.slice(0, 50)}..."`
            )
            break // this memory is deleted, move to next
          }
        }
      }
    }
  }

  for (const id of toDelete) {
    deleteMemory(id)
  }

  if (toDelete.size > 0) {
    console.log(
      `[Memory] Contradiction resolution: removed ${toDelete.size} contradictory memories`
    )
  }
}

// ── Promote short → long ──
// Promote ALL remaining short-term memories to long-term after dedup + contradiction
// resolution. This is the only path for short → long promotion.

async function promoteShortTermMemories(): Promise<void> {
  const all = getAllMemories()
  let promoted = 0
  for (const mem of all) {
    if (mem.tier === 'short') {
      updateMemoryTier(mem.id, 'long')
      promoted++
    }
  }

  if (promoted > 0) {
    console.log(`[Memory] Promoted ${promoted} short-term → long-term`)
  }
}

// ── LLM contradiction check ──

async function checkContradiction(contentA: string, contentB: string): Promise<boolean> {
  const settings = readSettings()
  const mainModel = settings.main.find((m) => m.active) ?? settings.main[0]
  if (!mainModel) return false

  const client = new OpenAI({
    baseURL: mainModel.endpoint,
    apiKey: mainModel.apiKey || 'empty',
    timeout: 15000,
    maxRetries: 1
  })

  try {
    const response = await client.chat.completions.create({
      model: mainModel.name,
      messages: [{ role: 'user', content: buildContradictionPrompt(contentA, contentB) }],
      temperature: 0.1,
      max_tokens: 10
    })
    const answer = response.choices[0]?.message?.content?.trim().toLowerCase() ?? ''
    return answer.startsWith('yes')
  } catch (e) {
    console.error('[Memory] Contradiction check LLM call failed:', e)
    return false
  }
}

function buildContradictionPrompt(contentA: string, contentB: string): string {
  return `判断以下两条记忆是否相互矛盾（即它们不能同时为真）。

记忆A：${contentA}
记忆B：${contentB}

只回答 "yes" 或 "no"。`
}

// ── Helpers ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
