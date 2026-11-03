// Hybrid search — 20% BM25 (FTS5) + 80% vector (vec0 KNN).
// Hybrid search approach: query both indexes,
// normalize scores, merge with weights, return top results.

import type { MemorySearchResult } from '../../shared/types'
import {
  isDbAvailable,
  isVecAvailable,
  searchVector,
  searchFts,
  getMemoryById,
  getMemoriesNeedingVectors,
  getVectorCount,
  insertVector
} from './memory-db'
import { getEmbedding } from './embedding-provider'

const DEFAULT_VECTOR_WEIGHT = 0.8
const DEFAULT_TEXT_WEIGHT = 0.2

// Backfill missing vectors for memories that don't have one yet.
// Called lazily before each search to self-heal the vec table.
async function backfillMissingVectors(): Promise<void> {
  if (!isVecAvailable()) return
  const missing = getMemoriesNeedingVectors()
  if (missing.length === 0) return
  console.log(`[Memory] Backfilling ${missing.length} missing vectors...`)
  for (const { id, content } of missing) {
    const embedding = await getEmbedding(content)
    if (embedding.length > 0) {
      insertVector(id, embedding)
    }
  }
  const after = getVectorCount()
  console.log(`[Memory] Backfill complete: ${after} vectors total`)
}

export async function hybridSearch(
  query: string,
  limit: number,
  weights?: { vector: number; text: number }
): Promise<MemorySearchResult[]> {
  if (!isDbAvailable() || !query.trim()) return []

  // Self-heal: backfill any missing vectors before searching.
  // This fixes memories that were extracted when vec insertion failed.
  await backfillMissingVectors()

  const vw = weights?.vector ?? DEFAULT_VECTOR_WEIGHT
  const tw = weights?.text ?? DEFAULT_TEXT_WEIGHT

  // Gather candidates from both indexes (2x limit for better merge coverage)
  const fetchLimit = limit * 2

  // 1. Vector search
  let vecResults: Array<{ id: string; distance: number }> = []
  if (isVecAvailable()) {
    const queryVec = await getEmbedding(query)
    if (queryVec.length > 0) {
      vecResults = searchVector(queryVec, fetchLimit)
    }
  }

  // 2. BM25 search
  const ftsResults = searchFts(query, fetchLimit)

  // 3. Merge scores
  const scoreMap = new Map<
    string,
    { score: number; vecScore: number; textScore: number; hasVec: boolean; hasText: boolean }
  >()

  // Vector results: distance → score = 1 / (1 + distance)
  for (const r of vecResults) {
    const score = 1 / (1 + r.distance)
    scoreMap.set(r.id, {
      score: vw * score,
      vecScore: score,
      textScore: 0,
      hasVec: true,
      hasText: false
    })
  }

  // BM25 results: rank → score = 1 / (1 + rank) for positive,
  // -rank / (1 + -rank) for negative
  for (const r of ftsResults) {
    const rank = r.rank
    const textScore = rank >= 0 ? 1 / (1 + rank) : -rank / (1 + -rank)
    const existing = scoreMap.get(r.id)
    if (existing) {
      // Both indexes hit — combine weighted scores
      existing.score = vw * existing.vecScore + tw * textScore
      existing.textScore = textScore
      existing.hasText = true
    } else {
      // Only BM25 hit
      scoreMap.set(r.id, {
        score: tw * textScore,
        vecScore: 0,
        textScore,
        hasVec: false,
        hasText: true
      })
    }
  }

  // 4. Sort by score, take top limit
  const sorted = [...scoreMap.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)

  // 5. Load full Memory objects
  const results: MemorySearchResult[] = []
  for (const [id, scoreInfo] of sorted) {
    const mem = getMemoryById(id)
    if (mem) {
      results.push({ memory: mem, score: scoreInfo.score })
    }
  }

  console.log(
    `[Memory] hybridSearch: query="${query.slice(0, 50)}", ` +
      `vec=${vecResults.length}, fts=${ftsResults.length}, results=${results.length}`
  )

  return results
}
