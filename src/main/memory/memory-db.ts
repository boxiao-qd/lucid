// Memory database — SQLite storage layer with FTS5 (BM25) and vec0 (vector).
// Schema: memories (main) + memories_fts (FTS5) + memories_vec (vec0) +
// embedding_cache + memory_meta. Graceful degradation when sqlite-vec fails.

import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { Memory, MemoryTier, ExtractionTrigger } from '../../shared/types'

const MEMORY_DIR = join(homedir(), '.lucid', 'memory')
const DB_PATH = join(MEMORY_DIR, 'memory.db')

let db: Database.Database | null = null
let vecAvailable = false
let dbAvailable = false

export function initMemoryDb(): void {
  if (db) return
  try {
    mkdirSync(MEMORY_DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')

    // Try loading sqlite-vec extension
    try {
      const vecPath = sqliteVec.getLoadablePath()
      db.loadExtension(vecPath)
      vecAvailable = true
    } catch (e) {
      console.error('[Memory] sqlite-vec extension load failed, falling back to BM25 only:', e)
      vecAvailable = false
    }

    createSchema()

    // Rebuild FTS with bigrams if not yet done (version check)
    const ftsVersion = db
      .prepare(`SELECT value FROM memory_meta WHERE key = 'fts_version'`)
      .get() as { value?: string } | undefined
    if (ftsVersion?.value !== '2') {
      rebuildFts()
      db.prepare(
        `INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('fts_version', '2')`
      ).run()
    }

    dbAvailable = true
    console.log(`[Memory] Database initialized at ${DB_PATH} (vec: ${vecAvailable})`)
  } catch (e) {
    console.error('[Memory] Database initialization failed, memory disabled:', e)
    dbAvailable = false
  }
}

function createSchema(): void {
  if (!db) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      content TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      extraction_trigger TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
    CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(tier, hash);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      id UNINDEXED,
      tier UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // NOTE: The memories_vec (vec0) table is NOT created here. Its dimension
  // depends on the embedding model's actual output size, which we don't know
  // until the first embedding API call. ensureVecTable() creates it lazily
  // with the correct dimension, and rebuilds it if the user switches models.
}

// ── Availability checks ──

export function isDbAvailable(): boolean {
  return dbAvailable
}

export function isVecAvailable(): boolean {
  return vecAvailable
}

// Count vectors in the vec table. Returns 0 if vec table isn't ready.
export function getVectorCount(): number {
  if (!db || !dbAvailable || !vecTableReady()) return 0
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM memories_vec`).get() as { c: number }
    return row.c
  } catch {
    return 0
  }
}

// Get all memories that don't have a corresponding vector in memories_vec.
// Returns array of { id, content } for backfilling.
export function getMemoriesNeedingVectors(): Array<{ id: string; content: string }> {
  if (!db || !dbAvailable || !vecTableReady()) return []
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         LEFT JOIN memories_vec v ON m.id = v.id
         WHERE v.id IS NULL`
      )
      .all() as Array<{ id: string; content: string }>
    return rows
  } catch {
    return []
  }
}

// ── CRUD ──

export function insertMemory(
  tier: MemoryTier,
  content: string,
  sourceSessionId: string,
  trigger: ExtractionTrigger
): Memory | null {
  if (!db || !dbAvailable) return null
  const hash = sha256(content)
  const now = Date.now()
  const id = randomUUID()
  const mem: Memory = {
    id,
    tier,
    content,
    sourceSessionId,
    extractionTrigger: trigger,
    hash,
    createdAt: now,
    updatedAt: now
  }

  try {
    db.prepare(
      `INSERT INTO memories (id, tier, content, source_session_id, extraction_trigger, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tier, content, sourceSessionId, trigger, hash, now, now)

    db.prepare(`INSERT INTO memories_fts (content, id, tier) VALUES (?, ?, ?)`).run(
      toBigrams(content),
      id,
      tier
    )

    return mem
  } catch (e) {
    console.error('[Memory] insertMemory failed:', e)
    return null
  }
}

export function getMemoryByHash(tier: MemoryTier, hash: string): Memory | null {
  if (!db || !dbAvailable) return null
  const row = db
    .prepare(`SELECT * FROM memories WHERE tier = ? AND hash = ? LIMIT 1`)
    .get(tier, hash) as MemoryRow | undefined
  return row ? rowToMemory(row) : null
}

/** Check both short and long tiers for an exact hash match. */
export function getMemoryByHashAny(hash: string): Memory | null {
  if (!db || !dbAvailable) return null
  const row = db.prepare(`SELECT * FROM memories WHERE hash = ? LIMIT 1`).get(hash) as
    MemoryRow | undefined
  return row ? rowToMemory(row) : null
}

export function getAllShortTermMemories(): Memory[] {
  if (!db || !dbAvailable) return []
  const rows = db
    .prepare(`SELECT * FROM memories WHERE tier = 'short' ORDER BY created_at DESC`)
    .all() as MemoryRow[]
  return rows.map(rowToMemory)
}

export function getAllMemories(): Memory[] {
  if (!db || !dbAvailable) return []
  const rows = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`).all() as MemoryRow[]
  return rows.map(rowToMemory)
}

export function getMemoryById(id: string): Memory | null {
  if (!db || !dbAvailable) return null
  const row = db.prepare(`SELECT * FROM memories WHERE id = ? LIMIT 1`).get(id) as
    MemoryRow | undefined
  return row ? rowToMemory(row) : null
}

export function updateMemoryTier(id: string, tier: MemoryTier): void {
  if (!db || !dbAvailable) return
  db.prepare(`UPDATE memories SET tier = ?, updated_at = ? WHERE id = ?`).run(tier, Date.now(), id)
}

// Update a memory's content (and optionally tier). Regenerates the hash,
// refreshes the FTS index, and deletes the stale vector — the old embedding
// is invalid for the new content, so it's removed and will be backfilled by
// the next vector pass.
export function updateMemoryContent(id: string, content: string, tier?: MemoryTier): Memory | null {
  if (!db || !dbAvailable) return null
  const hash = sha256(content)
  const now = Date.now()

  try {
    if (tier !== undefined) {
      db.prepare(
        `UPDATE memories SET content = ?, hash = ?, tier = ?, updated_at = ? WHERE id = ?`
      ).run(content, hash, tier, now, id)
    } else {
      db.prepare(`UPDATE memories SET content = ?, hash = ?, updated_at = ? WHERE id = ?`).run(
        content,
        hash,
        now,
        id
      )
    }

    // Refresh FTS: delete old entry, insert new bigram-segmented content.
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id)
    const row = db.prepare(`SELECT tier FROM memories WHERE id = ?`).get(id) as
      { tier: string } | undefined
    if (row) {
      db.prepare(`INSERT INTO memories_fts (content, id, tier) VALUES (?, ?, ?)`).run(
        toBigrams(content),
        id,
        row.tier
      )
    }

    // Delete stale vector (content changed → old embedding is invalid)
    if (vecTableReady()) {
      db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id)
    }

    return getMemoryById(id)
  } catch (e) {
    console.error('[Memory] updateMemoryContent failed:', e)
    return null
  }
}

export function deleteMemory(id: string): void {
  if (!db || !dbAvailable) return
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
  db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id)
  if (vecTableReady()) {
    db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id)
  }
}

// ── Vector table lifecycle ──

// Read the dimension of the existing memories_vec table from sqlite_master.
// Returns null if the table doesn't exist yet (or sqlite-vec isn't available).
export function getVecTableDims(): number | null {
  if (!db || !vecAvailable) return null
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`)
    .get() as { sql?: string } | undefined
  if (!row?.sql) return null
  const m = row.sql.match(/FLOAT\[(\d+)\]/)
  return m ? parseInt(m[1], 10) : null
}

// Ensure the memories_vec table exists with the given dimension. If an existing
// table has a different dimension (user switched embedding model), drop it
// and rebuild — old vectors are invalid under the new model anyway, and the
// embedding_cache is purged so stale entries don't leak old-dimension vectors.
// Returns true if the table is usable with `dims` after the call.
export function ensureVecTable(dims: number): boolean {
  if (!db || !dbAvailable || !vecAvailable || dims <= 0) return false
  const existing = getVecTableDims()
  if (existing === dims) return true
  if (existing !== null) {
    console.warn(
      `[Memory] vec0 dimension mismatch (table=${existing}, model=${dims}); rebuilding memories_vec + clearing embedding cache`
    )
    db.exec(`DROP TABLE IF EXISTS memories_vec`)
    db.exec(`DELETE FROM embedding_cache`)
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dims}]
      );
    `)
    return true
  } catch (e) {
    console.error('[Memory] ensureVecTable create failed:', e)
    vecAvailable = false
    return false
  }
}

// Whether the memories_vec table is currently usable (exists + sqlite-vec loaded).
function vecTableReady(): boolean {
  return vecAvailable && getVecTableDims() !== null
}

// ── Vector operations ──

export function insertVector(id: string, embedding: number[]): void {
  if (!db || !dbAvailable || !vecTableReady() || embedding.length === 0) return
  try {
    const buf = Buffer.from(new Float32Array(embedding).buffer)
    db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(id, buf)
  } catch (e) {
    console.error('[Memory] insertVector failed:', e)
  }
}

export function searchVector(
  embedding: number[],
  k: number
): Array<{ id: string; distance: number }> {
  if (!db || !dbAvailable || !vecTableReady() || embedding.length === 0) return []
  try {
    const buf = Buffer.from(new Float32Array(embedding).buffer)
    const rows = db
      .prepare(
        `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(buf, k) as Array<{ id: string; distance: number }>
    return rows
  } catch (e) {
    console.error('[Memory] searchVector failed:', e)
    return []
  }
}

// ── FTS operations ──

export function searchFts(query: string, limit: number): Array<{ id: string; rank: number }> {
  if (!db || !dbAvailable || !query.trim()) return []
  try {
    const ftsQuery = sanitizeFtsQuery(query)
    if (!ftsQuery) return []
    const rows = db
      .prepare(`SELECT id, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(ftsQuery, limit) as Array<{ id: string; rank: number }>
    return rows
  } catch (e) {
    console.error('[Memory] searchFts failed:', e)
    return []
  }
}

// FTS5 treats special characters as operators. For CJK text, the default
// unicode61 tokenizer treats entire CJK strings as one token, so "青岛"
// won't match "用户所在城市是青岛". We solve this by bigram-segmenting both
// stored content and search queries: "用户所在城市是青岛" → "用户 户所
// 在所 在城 城市 市是 是青 青岛" (space-separated 2-char tokens). Then
// searching for "青岛" matches the "青岛" bigram token in the stored content.
function sanitizeFtsQuery(query: string): string {
  const bigrams = toBigrams(query)
    .split(' ')
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  return bigrams.length > 0 ? bigrams.join(' OR ') : ''
}

// Segment text into overlapping 2-character bigrams, space-separated.
// CJK characters are individually meaningless as 1-char tokens, so we
// always produce 2-char windows. For non-CJK (ASCII, numbers), the text
// stays as-is within each bigram window.
// Example: "青岛天气" → "青岛 岛天 天气"
function toBigrams(text: string): string {
  const clean = text.replace(/\s+/g, '')
  if (clean.length < 2) return clean
  const bigrams: string[] = []
  for (let i = 0; i < clean.length - 1; i++) {
    bigrams.push(clean.slice(i, i + 2))
  }
  return bigrams.join(' ')
}

// Rebuild the FTS table with bigram-segmented content for all existing
// memories. Called on startup when the FTS version is outdated.
export function rebuildFts(): void {
  if (!db || !dbAvailable) return
  db.exec(`DROP TABLE IF EXISTS memories_fts`)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      id UNINDEXED,
      tier UNINDEXED
    );
  `)
  const rows = db.prepare(`SELECT id, content, tier FROM memories`).all() as MemoryRow[]
  const stmt = db.prepare(`INSERT INTO memories_fts (content, id, tier) VALUES (?, ?, ?)`)
  for (const row of rows) {
    stmt.run(toBigrams(row.content), row.id, row.tier)
  }
  console.log(`[Memory] FTS rebuilt with bigrams: ${rows.length} memories`)
}

// ── Embedding cache ──

export function getCachedEmbedding(hash: string): number[] | null {
  if (!db || !dbAvailable) return null
  const row = db.prepare(`SELECT embedding FROM embedding_cache WHERE hash = ?`).get(hash) as
    { embedding: string } | undefined
  if (!row) return null
  try {
    const arr = JSON.parse(row.embedding) as number[]
    return arr
  } catch {
    return null
  }
}

export function cacheEmbedding(hash: string, embedding: number[]): void {
  if (!db || !dbAvailable) return
  try {
    db.prepare(
      `INSERT OR REPLACE INTO embedding_cache (hash, embedding, updated_at) VALUES (?, ?, ?)`
    ).run(hash, JSON.stringify(embedding), Date.now())
  } catch (e) {
    console.error('[Memory] cacheEmbedding failed:', e)
  }
}

// ── Helpers ──

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

interface MemoryRow {
  id: string
  tier: string
  content: string
  source_session_id: string
  extraction_trigger: string
  hash: string
  created_at: number
  updated_at: number
  metadata: string | null
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    tier: row.tier as MemoryTier,
    content: row.content,
    sourceSessionId: row.source_session_id,
    extractionTrigger: row.extraction_trigger as ExtractionTrigger,
    hash: row.hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {})
  }
}
