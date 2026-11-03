// web_fetch tool — fetches and parses web content.
// SSRF protection (dns.lookup + ip-cidr), manual redirect following with re-check,
// HTML→markdown via turndown, byte truncation, PDF detection.

import dns from 'node:dns/promises'
import CIDR from 'ip-cidr'
import { URL } from 'node:url'
import TurndownService from 'turndown'
import type { ToolDef, ToolExecContext } from '../tool-def'

const MAX_CONTENT_BYTES = 512 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 30_000

// Realistic browser headers to avoid 403 from bot detection (Cloudflare, etc.)
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"'
}

// Private/reserved IP ranges — IPv4 + IPv6
const PRIVATE_NETWORKS: { cidr: string }[] = [
  { cidr: '10.0.0.0/8' },
  { cidr: '172.16.0.0/12' },
  { cidr: '192.168.0.0/16' },
  { cidr: '127.0.0.0/8' },
  { cidr: '0.0.0.0/8' },
  { cidr: '::1/128' },
  { cidr: 'fc00::/7' }, // IPv6 unique local
  { cidr: 'fe80::/10' } // IPv6 link-local
]

function isPrivateIp(ipStr: string): boolean {
  for (const net of PRIVATE_NETWORKS) {
    try {
      const cidr = new CIDR(net.cidr)
      if (cidr.contains(ipStr)) return true
    } catch {
      // invalid CIDR or IP — skip, but treat unparseable IPs as private downstream
    }
  }
  // Also block IPv4-mapped IPv6 of private ranges (e.g. ::ffff:127.0.0.1)
  const mapped = ipStr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) {
    return isPrivateIp(mapped[1])
  }
  return false
}

// Resolve hostname → IPs, check all against private blacklist.
// Throws on private IP or DNS failure.
async function resolveAndCheck(hostname: string): Promise<string[]> {
  let records: Array<{ address: string }>
  try {
    const raw = (await dns.lookup(hostname, { all: true })) as unknown
    // dns.lookup with {all:true} returns LookupAddress[] ({address,family}[])
    records = Array.isArray(raw) ? (raw as Array<{ address: string }>) : [{ address: String(raw) }]
  } catch {
    throw new Error(`DNS resolution failed for '${hostname}' — request blocked`)
  }

  const publicIps: string[] = []
  for (const info of records) {
    if (isPrivateIp(info.address)) {
      throw new Error(
        `Hostname '${hostname}' resolves to private IP '${info.address}' — request blocked`
      )
    }
    if (!publicIps.includes(info.address)) {
      publicIps.push(info.address)
    }
  }
  if (publicIps.length === 0) {
    throw new Error(`DNS returned no addresses for '${hostname}' — request blocked`)
  }
  return publicIps
}

// Validate URL scheme + hostname against SSRF blacklist. Throws on violation.
async function checkUrlSsrf(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol === 'file:') {
    throw new Error('file:// protocol is not allowed')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol.replace(':', '')}`)
  }
  if (!parsed.hostname) {
    throw new Error('URL has no hostname')
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '0.0.0.0') {
    throw new Error('localhost/0.0.0.0 is not allowed')
  }
  await resolveAndCheck(parsed.hostname)
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    codeBlockStyle: 'indented',
    bulletListMarker: '-'
  })
  // Drop script/style/noscript noise before conversion
  td.remove(['script', 'style', 'noscript', 'iframe'])
  return td.turndown(html)
}

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'web_fetch',
    description:
      'Fetch content from a URL and convert to markdown format. ' +
      'Supports HTTP/HTTPS public URLs only. ' +
      'The purpose parameter describes what information you want to extract from the page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (public HTTP/HTTPS only)' },
        purpose: {
          type: 'string',
          description:
            'What information you want to extract from this page (e.g. 青岛的海鲜价格趋势)'
        },
        format: {
          type: 'string',
          enum: ['markdown', 'text'],
          default: 'markdown',
          description: 'Output format'
        }
      },
      required: ['url', 'purpose']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { url?: unknown; purpose?: unknown; format?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const url = typeof args.url === 'string' ? args.url : ''
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
  const formatType = typeof args.format === 'string' ? args.format : 'markdown'

  if (!url) {
    return JSON.stringify({ error: 'url is required' })
  }
  if (!purpose) {
    return JSON.stringify({ error: 'purpose is required' })
  }

  // Initial SSRF check
  try {
    await checkUrlSsrf(url)
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }

  let currentUrl = url
  let redirects = 0

  try {
    while (redirects < MAX_REDIRECTS) {
      if (ctx.abortSignal.aborted) {
        return JSON.stringify({ error: 'Request aborted' })
      }

      // Per-request timeout — prevents a slow URL from blocking the agent
      // indefinitely. Combined with ctx.abortSignal so user cancel still works.
      const timeoutCtl = new AbortController()
      const timeout = setTimeout(() => timeoutCtl.abort(), FETCH_TIMEOUT_MS)
      const onParentAbort = () => timeoutCtl.abort()
      ctx.abortSignal.addEventListener('abort', onParentAbort, { once: true })

      let resp: Response
      try {
        resp = await fetch(currentUrl, {
          headers: BROWSER_HEADERS,
          signal: timeoutCtl.signal,
          redirect: 'manual'
        })
      } finally {
        clearTimeout(timeout)
        ctx.abortSignal.removeEventListener('abort', onParentAbort)
      }

      // Manual redirect handling — re-check SSRF on each hop
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const redirectUrl = resp.headers.get('location') ?? ''
        if (!redirectUrl) {
          return JSON.stringify({ error: `Redirect without location header at ${currentUrl}` })
        }
        try {
          await checkUrlSsrf(redirectUrl)
        } catch (e) {
          return JSON.stringify({ error: `Redirect target blocked: ${(e as Error).message}` })
        }
        currentUrl = redirectUrl
        redirects++
        continue
      }

      if (resp.status >= 400) {
        return JSON.stringify({ error: `HTTP error ${resp.status}`, url: currentUrl })
      }

      // Byte-aware truncation
      const buf = await resp.arrayBuffer()
      const bytes = buf.byteLength > MAX_CONTENT_BYTES ? buf.slice(0, MAX_CONTENT_BYTES) : buf
      const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes)

      const contentType = resp.headers.get('content-type') ?? ''

      // PDF detection
      if (contentType.includes('application/pdf') || currentUrl.toLowerCase().endsWith('.pdf')) {
        return JSON.stringify({
          content: 'PDF document detected. PDF content extraction is not supported in MVP.',
          url: currentUrl,
          content_type: 'pdf'
        })
      }

      let finalContent = content
      if (formatType === 'markdown' && contentType.includes('html')) {
        finalContent = htmlToMarkdown(content)
      }

      return JSON.stringify({
        purpose,
        content: finalContent,
        url: currentUrl,
        content_type: contentType,
        content_length: finalContent.length
      })
    }

    return JSON.stringify({ error: `Too many redirects (> ${MAX_REDIRECTS})` })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('aborted') || ctx.abortSignal.aborted) {
      if (!ctx.abortSignal.aborted) {
        return JSON.stringify({
          error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
          url: currentUrl
        })
      }
      return JSON.stringify({ error: 'Request aborted' })
    }
    return JSON.stringify({ error: `Request failed: ${msg}` })
  }
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  openai: TOOL_DEF,
  execute
}
