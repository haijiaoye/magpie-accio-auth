// refresh_token 一次性轮换的跨进程保护。
//
// ## 为什么 magpie 自己的续期锁还不够
//
// magpie 按「账号槽」上锁（`accio`、`accio-global` 各一把）。但本插件的国际版
// 复用了国内版的登录，两个槽持有**同一个** refresh_token。两把锁互不相干，
// 两边同时到期时会拿同一个旧 token 各续一次：先到的一边成功，后到的一边拿到
// invalid_grant，账号被标成「需要重新登录」。
//
// 这里按 **refresh_token 指纹**上锁（跨进程、跨槽），并把「旧 token 指纹 →
// 新凭据」记一小段时间：后到的一边在锁内发现旧 token 已经被换过，直接复用
// 新凭据，不再向服务端发第二次续期。
//
// ⚠️ 记录写在插件自己的状态目录（`~/.cache/magpie-accio/`，`0600`），
//    绝不写 magpie 的配置目录。记录只按旧 token 的 SHA-256 指纹索引，
//    5 分钟后作废，正常读取时顺手清理。

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './state.mjs'

const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 120_000
export const ROTATION_TTL_MS = 5 * 60_000

export const tokenDigest = (token) => createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex').slice(0, 32)

const renewDir = () => join(stateDir(), 'renew')

function ensureDir() {
  mkdirSync(renewDir(), { recursive: true, mode: 0o700 })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function acquire(digest) {
  ensureDir()
  const lock = join(renewDir(), `${digest}.lock`)
  const me = JSON.stringify({ pid: process.pid, at: Date.now(), id: randomUUID() })
  for (let start = Date.now(), wait = 10; ; wait = Math.min(wait * 2, 500)) {
    try {
      writeFileSync(lock, me, { flag: 'wx', mode: 0o600 })
      return () => {
        try {
          if (readFileSync(lock, 'utf8') === me) unlinkSync(lock)
        } catch { /* 已被接管或清理 */ }
      }
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
    }
    let raw = null
    let holder = null
    let age = 0
    try {
      raw = readFileSync(lock, 'utf8')
      age = Date.now() - statSync(lock).mtimeMs
      holder = JSON.parse(raw)
    } catch { /* 正在写或刚被删 */ }
    const stale = Number.isInteger(holder?.pid)
      ? !alive(holder.pid) || Date.now() - holder.at > LOCK_STALE_MS
      : age > LOCK_STALE_MS
    if (raw !== null && (stale || Date.now() - start > LOCK_WAIT_MS)) {
      try {
        if (readFileSync(lock, 'utf8') === raw) unlinkSync(lock)
      } catch { /* 别人先清了 */ }
      continue
    }
    await sleep(wait)
  }
}

function recordPath(digest) {
  return join(renewDir(), `${digest}.json`)
}

export function readRotation(digest, now = Date.now()) {
  try {
    const record = JSON.parse(readFileSync(recordPath(digest), 'utf8'))
    if (!Number.isFinite(record?.at) || now - record.at > ROTATION_TTL_MS) return undefined
    return record.credential && typeof record.credential === 'object' ? record.credential : undefined
  } catch {
    return undefined
  }
}

function writeRotation(digest, credential) {
  ensureDir()
  const file = recordPath(digest)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ at: Date.now(), credential }), { mode: 0o600 })
  renameSync(tmp, file)
  const timer = setTimeout(() => {
    try {
      if (Date.now() - statSync(file).mtimeMs >= ROTATION_TTL_MS) unlinkSync(file)
    } catch { /* 已删除 */ }
  }, ROTATION_TTL_MS + 1_000)
  timer.unref?.()
}

export function sweepRotations(now = Date.now()) {
  let names
  try {
    names = readdirSync(renewDir())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
    const file = join(renewDir(), name)
    try {
      if (now - statSync(file).mtimeMs > ROTATION_TTL_MS) unlinkSync(file)
    } catch { /* 并发清理 */ }
  }
}

/**
 * 用 refresh_token 续期一次，保证同一个 refresh_token 在本机只会被消费一次。
 *
 * @param credential 当前凭据（至少含 refresh_token）
 * @param refresh    真正发请求的函数
 */
export async function renewOnce(credential, refresh) {
  const digest = tokenDigest(credential.refresh_token)
  const unlock = await acquire(digest)
  try {
    sweepRotations()
    const rotated = readRotation(digest)
    if (rotated !== undefined) return { ...credential, ...rotated }
    const next = await refresh(credential)
    writeRotation(digest, {
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      ...(next.sgcookie === undefined ? {} : { sgcookie: next.sgcookie }),
    })
    return next
  } finally {
    unlock()
  }
}
