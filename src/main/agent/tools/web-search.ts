// web_search tool — v2: Alibaba Cloud IQS UnifiedSearch API.
//
// Uses the @alicloud/iqs20241111 SDK to call the IQS UnifiedSearch
// endpoint with engineType "GenericAdvanced", which returns titles,
// URLs, snippets, mainText (page content), and rerank scores.
//
// Authentication: ALIYUN_ACCESS_KEY + ALIYUN_ACCESS_SECRET env vars.
// Caching: in-memory 15-min TTL cache.
//
// Based on the Haier web search extension in clawbot.

import { createRequire } from 'node:module'
import type { ToolDef, ToolExecContext } from '../tool-def'

// IQS SDK is CommonJS — use createRequire for ESM compatibility
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const $IQS: any = require('@alicloud/iqs20241111')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const $OpenApi: any = require('@alicloud/openapi-client')

const IQS_ENDPOINT = 'iqs.cn-zhangjiakou.aliyuncs.com'
const IQS_TIMEOUT_MS = 30_000

// Max chars of mainText content per result
const CONTENT_CAP = 2000
// Cache TTL: 15 minutes
const CACHE_TTL = 15 * 60 * 1000

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web using Alibaba Cloud IQS. Returns results with titles, ' +
      'URLs, snippets, page content (mainText), and relevance scores. ' +
      'Supports time-range filtering. The mainText content usually provides ' +
      'enough detail to answer questions without needing web_fetch.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (max 1024 characters)' },
        count: {
          type: 'number',
          description: 'Number of results to return (1-10)',
          minimum: 1,
          maximum: 10
        },
        time_range: {
          type: 'string',
          description: 'Filter by time range',
          enum: ['OneDay', 'OneWeek', 'OneMonth', 'OneYear', 'NoLimit']
        }
      },
      required: ['query']
    }
  }
}

interface SearchResult {
  title: string
  url: string
  snippet: string
  content?: string
  score?: number
  siteName?: string
  position: number
}

// ── In-memory cache ──
interface CacheEntry {
  results: SearchResult[]
  timestamp: number
}
const searchCache = new Map<string, CacheEntry>()

function getCached(key: string): SearchResult[] | null {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return entry.results
}

function setCached(key: string, results: SearchResult[]): void {
  searchCache.set(key, { results, timestamp: Date.now() })
}

// ── Credential resolution ──
function resolveCredentials(): { accessKeyId: string; accessKeySecret: string } | null {
  const keyId = process.env['ALIYUN_ACCESS_KEY']
  const keySecret = process.env['ALIYUN_ACCESS_SECRET']
  if (keyId && keySecret) {
    return { accessKeyId: keyId, accessKeySecret: keySecret }
  }
  return null
}

// ── IQS client creation ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createIqsClient(accessKeyId: string, accessKeySecret: string): any {
  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret
  })
  config.endpoint = IQS_ENDPOINT
  config.readTimeout = IQS_TIMEOUT_MS
  config.connectTimeout = 10_000
  return new $IQS.default(config)
}

// Extract site name from URL (e.g. "example.com" from "https://www.example.com/page")
function extractSiteName(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ── IQS UnifiedSearch ──
async function iqsSearch(
  query: string,
  count: number,
  timeRange: string,
  _abortSignal: AbortSignal
): Promise<{ results: SearchResult[] } | { error: string }> {
  const creds = resolveCredentials()
  if (!creds) {
    return {
      error:
        'web_search needs credentials. Set ALIYUN_ACCESS_KEY and ALIYUN_ACCESS_SECRET ' +
        'environment variables. Docs: https://help.aliyun.com/document_detail/475724.html'
    }
  }

  let client: unknown
  try {
    client = createIqsClient(creds.accessKeyId, creds.accessKeySecret)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `Failed to create IQS client: ${msg}` }
  }

  // Build IQS request — engineType "GenericAdvanced" returns richer results
  // with summary and rerank scores.
  const requestBody = new $IQS.UnifiedSearchInput({
    query,
    engineType: 'GenericAdvanced',
    timeRange,
    contents: new $IQS.RequestContents({
      summary: true,
      rerankScore: true
    })
  })

  const request = new $IQS.UnifiedSearchRequest({ body: requestBody })

  try {
    const response = await (
      client as { unifiedSearch: (req: unknown) => Promise<unknown> }
    ).unifiedSearch(request)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (response as any)?.body
    if (!body) {
      return { results: [] }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(body.pageItems) ? body.pageItems : []
    const results: SearchResult[] = items.slice(0, count).map((item, i) => {
      const title = item.title ?? ''
      const snippet = item.snippet ?? ''
      let mainText = item.mainText ?? ''
      const link = item.link ?? ''
      const score = typeof item.rerankScore === 'number' ? item.rerankScore : undefined
      const siteName = extractSiteName(link)

      if (mainText.length > CONTENT_CAP) {
        mainText = mainText.slice(0, CONTENT_CAP) + '…'
      }

      return {
        title,
        url: link,
        snippet,
        content: mainText || undefined,
        score,
        siteName: siteName || undefined,
        position: i + 1
      }
    })

    return { results }
  } catch (e) {
    const code = (e as { code?: string })?.code ?? 'unknown'
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `IQS UnifiedSearch error [${code}]: ${msg}` }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { query?: unknown; count?: unknown; time_range?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const queryRaw = typeof args.query === 'string' ? args.query : ''
  if (!queryRaw) {
    return JSON.stringify({ error: 'query is required' })
  }

  // Normalize query: pad if too short, truncate if too long
  let query = queryRaw
  if (query.length < 2) {
    query = (query + '相关信息').slice(0, 100)
  } else if (query.length > 1024) {
    query = query.slice(0, 1024)
  }

  const countRaw = typeof args.count === 'number' ? args.count : 8
  const count = Math.min(Math.max(1, Math.floor(countRaw)), 10)

  const timeRangeRaw = typeof args.time_range === 'string' ? args.time_range : 'NoLimit'
  const validTimeRanges = ['OneDay', 'OneWeek', 'OneMonth', 'OneYear', 'NoLimit']
  const timeRange = validTimeRanges.includes(timeRangeRaw) ? timeRangeRaw : 'NoLimit'

  // Check cache
  const cacheKey = `${query}:${count}:${timeRange}`
  const cached = getCached(cacheKey)
  if (cached) {
    return JSON.stringify({
      results: cached,
      total: cached.length,
      source: 'aliyun_iqs',
      cached: true
    })
  }

  const result = await iqsSearch(query, count, timeRange, ctx.abortSignal)

  if ('error' in result) {
    return JSON.stringify({ error: result.error })
  }

  setCached(cacheKey, result.results)

  return JSON.stringify({
    results: result.results,
    total: result.results.length,
    source: 'aliyun_iqs'
  })
}

export const webSearchTool: ToolDef = {
  name: 'web_search',
  openai: TOOL_DEF,
  execute
}

/* ════════════════════════════════════════════════════════════════════
 * OLD web_search tool — Bing CN scrape (v1)
 * Kept for reference. No longer active — the new IQS implementation
 * above replaces this entirely.
 * ════════════════════════════════════════════════════════════════════

// web_search tool — searches the web and returns results.
// v1: only Bing CN provider (scrape cn.bing.com, no API key, works in China).
// HTML parsing via cheerio; URL de-tracking via parse_qs `u` param.
//
// Enhancement: auto-fetches readable content from the top 3 results (in
// parallel), so the LLM gets real page content in one search call —
// reducing the need for separate web_fetch calls. Inspired by Brave LLM
// Context mode which returns richer snippets per result.
//
// Caching: in-memory 15-min TTL cache to prevent redundant queries.

import * as cheerio from 'cheerio'
import type { ToolDef, ToolExecContext } from '../tool-def'

const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const BING_CN_URL = 'https://cn.bing.com'

const FETCH_UA = 'Mozilla/5.0 (compatible; Lucid/1.0)'

// Max chars of page content to extract per result
const CONTENT_CAP = 2000
// Number of top results to auto-fetch content for
const FETCH_TOP_N = 3
// Cache TTL: 15 minutes
const CACHE_TTL = 15 * 60 * 1000

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web for information. Returns top results with titles, ' +
      'snippets, URLs, and auto-extracted page content for the top results. ' +
      'Works in mainland China. The extracted content usually provides ' +
      'enough detail to answer questions without needing web_fetch.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Max results to return', default: 8 }
      },
      required: ['query']
    }
  }
}

interface SearchResult {
  title: string
  url: string
  snippet: string
  content?: string
  position: number
}

// ── In-memory cache ──
interface CacheEntry {
  results: SearchResult[]
  timestamp: number
}
const searchCache = new Map<string, CacheEntry>()

function getCached(key: string): SearchResult[] | null {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return entry.results
}

function setCached(key: string, results: SearchResult[]): void {
  searchCache.set(key, { results, timestamp: Date.now() })
}

// ── Fetch and extract readable text from a URL ──
async function fetchPageContent(url: string, abortSignal: AbortSignal): Promise<string | null> {
  // Only fetch http/https URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA },
      signal: AbortSignal.any([controller.signal, abortSignal]),
      redirect: 'follow'
    })

    if (!resp.ok || resp.status >= 400) return null

    const contentType = resp.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) return null

    const buf = await resp.arrayBuffer()
    // Cap at 256KB for parsing performance
    const bytes = buf.byteLength > 256 * 1024 ? buf.slice(0, 256 * 1024) : buf
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes)

    const $ = cheerio.load(html)
    // Remove noise elements
    $('script, style, noscript, iframe, nav, footer, header, aside').remove()

    // Try common content selectors, fall back to body
    const selectors = [
      'article',
      'main',
      '.article-content',
      '.content',
      '#content',
      '.post-content',
      'body'
    ]
    let text = ''
    for (const sel of selectors) {
      const el = $(sel).first()
      if (el.length && el.text().trim().length > 100) {
        text = el.text().trim()
        break
      }
    }
    if (!text) text = $('body').text().trim()

    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim()

    if (text.length > CONTENT_CAP) {
      text = text.slice(0, CONTENT_CAP) + '…'
    }

    return text || null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// Bing CN scrape — no API key, works in China.
async function bingCnSearch(
  query: string,
  limit: number,
  abortSignal: AbortSignal
): Promise<{ results: SearchResult[] } | { error: string }> {
  const url = `${BING_CN_URL}/search?q=${encodeURIComponent(query)}&count=${limit}`
  const headers = {
    'User-Agent': BING_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml'
  }

  let resp: Response
  try {
    resp = await fetch(url, { headers, signal: abortSignal, redirect: 'follow' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `Could not reach Bing CN: ${msg}` }
  }

  if (!resp.ok) {
    return { error: `Bing CN HTTP ${resp.status}` }
  }

  const html = await resp.text()
  const $ = cheerio.load(html)

  const results: SearchResult[] = []
  $('li.b_algo').each((i, el): boolean | void => {
    if (i >= limit) return false

    const $el = $(el)
    const $link = $el.find('h2 a').first()
    const title = $link.text().trim()
    let urlRaw = $link.attr('href') ?? ''

    // Bing wraps some URLs with tracking (/search?q=...&u=real-url); extract real URL
    if (urlRaw.startsWith('/search?q=')) {
      try {
        const parsed = new URL(BING_CN_URL + urlRaw)
        const uVal = parsed.searchParams.get('u')
        if (uVal) urlRaw = uVal
      } catch {
        // keep raw
      }
    }

    // Snippet: prefer .b_caption p, fall back to any p
    let snippet = $el.find('.b_caption p').first().text().trim()
    if (!snippet) {
      snippet = $el.find('p').first().text().trim()
    }

    if (title || urlRaw) {
      results.push({ title, url: urlRaw, snippet, position: i + 1 })
    }
  })

  // ── Auto-fetch content for top N results (in parallel) ──
  const topN = results.slice(0, FETCH_TOP_N)
  const contents = await Promise.all(topN.map((r) => fetchPageContent(r.url, abortSignal)))
  for (let i = 0; i < topN.length; i++) {
    if (contents[i]) {
      results[i].content = contents[i]!
    }
  }

  return { results }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { query?: unknown; limit?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const query = typeof args.query === 'string' ? args.query : ''
  const limitRaw = typeof args.limit === 'number' ? args.limit : 8
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), 20)

  if (!query) {
    return JSON.stringify({ error: 'query is required' })
  }

  // Check cache
  const cacheKey = `${query}:${limit}`
  const cached = getCached(cacheKey)
  if (cached) {
    return JSON.stringify({
      results: cached,
      total: cached.length,
      source: 'bing_cn',
      cached: true
    })
  }

  const result = await bingCnSearch(query, limit, ctx.abortSignal)

  if ('error' in result) {
    return JSON.stringify({ error: result.error })
  }

  setCached(cacheKey, result.results)

  return JSON.stringify({
    results: result.results,
    total: result.results.length,
    source: 'bing_cn'
  })
}

export const webSearchTool: ToolDef = {
  name: 'web_search',
  openai: TOOL_DEF,
  execute
}

 * ════════════════════════════════════════════════════════════════════
 * END OF OLD CODE
 * ════════════════════════════════════════════════════════════════════ */
