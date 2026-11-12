// 传输层小工具：网络重试与可选诊断日志。
//
// ⚠️ 本插件**不写** magpie 的配置目录：诊断日志只在
//    `MAGPIE_ACCIO_DEBUG=1` 时落到系统临时目录。

import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 全链路诊断日志（默认关闭）。 */
export function debugLog(line) {
  if (process.env.MAGPIE_ACCIO_DEBUG !== '1') return
  try {
    const dir = join(tmpdir(), 'magpie-accio')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 忽略 */ }
}

const sleep = (ms) => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/**
 * 这个错误是不是**传输层**的（值得重发）。
 *
 * ⚠️ 只认网络/证书/DNS 这类「包没到或被切断」的错误；HTTP 业务错误不在此列。
 * ⚠️ 追到 `cause` 链（Node 的 fetch 把真错误包在 `fetch failed` 外面）。
 */
export function isTransportError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if (typeof current !== 'object') break
    const name = typeof current.name === 'string' ? current.name : ''
    const message = typeof current.message === 'string' ? current.message.toLowerCase() : ''
    const code = typeof current.code === 'string' ? current.code : ''
    if (name.startsWith('UND_ERR_') || code.startsWith('UND_ERR_')) return true
    if (code.startsWith('SELF_SIGNED_CERT') || code.startsWith('CERT_')
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return true
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
      || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true
    if (message.includes('fetch failed')) return true
    if (message.includes('socket hang up') || message.includes('terminated')
      || message.includes('other side closed')) return true
    current = current.cause
  }
  return false
}

/** 传输级重试：默认 2 次、400ms 指数退避；abort 绝不重试。 */
export async function fetchWithRetry(fetchOnce, signal, retries = 2) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      lastError = error
      if (signal?.aborted === true) throw error
      if (!isTransportError(error)) throw error
      if (attempt === retries) break
      await sleep(400 * 2 ** attempt)
    }
  }
  throw lastError
}
