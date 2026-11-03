// Embedding provider — reuses the auxiliary model from settings to generate
// embeddings via OpenAI SDK. Results are cached by content hash to avoid
// redundant API calls. The vec0 table dimension is discovered dynamically
// from the model's actual output (not hardcoded) — see ensureVecTable.

import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { readSettings } from '../settings'
import { getCachedEmbedding, cacheEmbedding, ensureVecTable, getVecTableDims } from './memory-db'

export async function getEmbedding(text: string): Promise<number[]> {
  if (!text.trim()) return []

  const hash = sha256(text)

  // Check cache first — but only trust it if its dimension matches the vec0
  // table. A mismatch means the user switched embedding models and the cache
  // entry is from the old model (wrong dimension); fall through to the API
  // call, which will trigger ensureVecTable to rebuild the table.
  const cached = getCachedEmbedding(hash)
  if (cached && cached.length > 0) {
    const vecDims = getVecTableDims()
    if (vecDims === cached.length) {
      // Dimensions match — cache is valid
      return cached
    }
    // vecDims is null (table doesn't exist yet) — create it with the cached
    // embedding's dimension so insertVector's vecTableReady() check passes.
    // Without this, a cache hit would return without ever creating the vec
    // table, and all subsequent insertVector calls would silently skip.
    if (vecDims === null) {
      if (ensureVecTable(cached.length)) {
        return cached
      }
      // Table creation failed — return cached anyway (vector search won't
      // work, but FTS search still will)
      return cached
    }
    // Dimension mismatch — fall through to API call
  }

  // Get auxiliary model from settings
  const settings = readSettings()
  const auxModel = settings.auxiliary.find((m) => m.active) ?? settings.auxiliary[0]
  if (!auxModel) {
    console.error('[Memory] No auxiliary model configured for embeddings')
    return []
  }

  try {
    const client = new OpenAI({
      baseURL: auxModel.endpoint,
      apiKey: auxModel.apiKey || 'empty',
      timeout: 30000,
      maxRetries: 1
    })

    const response = await client.embeddings.create({
      model: auxModel.name,
      input: text
    })

    const embedding = response.data[0]?.embedding
    if (!embedding || embedding.length === 0) {
      console.error('[Memory] Empty embedding from API')
      return []
    }

    // Ensure the vec0 table exists with the model's actual output dimension.
    // On first call this creates the table; if the user switched models and
    // the dimension changed, this drops + rebuilds the table and clears the
    // embedding cache so stale entries don't leak old-dimension vectors.
    ensureVecTable(embedding.length)

    // Cache the result
    cacheEmbedding(hash, embedding)
    return embedding
  } catch (e) {
    console.error('[Memory] getEmbedding API call failed:', e)
    return []
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
