// 插件自己的状态：装机级稳定的 utdid。
//
// ## 为什么要持久化
//
// `utdid` 是阿里网关的**装机级风控基线**（缺失会吃到 200 + 风控拦截页）。
// 早前版本只把它放在进程内存里，代价是 magpie 每重启一次就换一个指纹 ——
// 同一个账号/同一台机器上指纹频繁跳变，比长期稳定更可疑。这里改成落盘一次、
// 长期复用。
//
// ## 落盘位置
//
// ⚠️ 绝不往 magpie 的配置目录写任何东西（插件审核要求）。状态写到
//    系统缓存目录下自己的子目录：`$XDG_CACHE_HOME` 优先，否则 `~/.cache`，
//    再否则退回系统临时目录。可用 `MAGPIE_ACCIO_STATE_DIR` 整体覆盖，
//    用 `MAGPIE_ACCIO_UTDID` 直接指定指纹（后者优先级最高，且不落盘）。

import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 看起来像个合法 utdid：不含空白/控制字符，长度合理。 */
const UTDID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** 显式指定的指纹（env）—— 给了就完全照它走。 */
const envUtdid = () => {
  const raw = nonEmpty(process.env.MAGPIE_ACCIO_UTDID)
  return raw && UTDID_PATTERN.test(raw) ? raw : undefined
}

/** 状态目录（可被 `MAGPIE_ACCIO_STATE_DIR` 覆盖）。 */
export function stateDir() {
  const override = nonEmpty(process.env.MAGPIE_ACCIO_STATE_DIR)
  if (override) return override
  const xdg = nonEmpty(process.env.XDG_CACHE_HOME)
  const home = nonEmpty(homedir())
  const root = xdg ?? (home ? join(home, '.cache') : join(tmpdir(), 'magpie-accio-root'))
  return join(root, 'magpie-accio')
}

export const utdidPath = () => join(stateDir(), 'utdid')

function newUtdid() {
  return `accio-${randomBytes(6).toString('base64url')}${Date.now().toString(36)}`
}

function readUtdid(file) {
  try {
    const raw = readFileSync(file, 'utf8').trim()
    return UTDID_PATTERN.test(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * 落盘一份新指纹，并返回**文件里最终生效**的那个。
 *
 * ⚠️ 用 hard link 做原子发布：`link` 只在目标不存在时成功，于是并发的多个
 *    magpie 进程会收敛到同一个 id（而不是各自生成一个互相覆盖）。
 * ⚠️ 文件系统不支持 hard link 时退回 `rename` 覆盖写；写失败也只是退化回
 *    「每次进程一个新指纹」，不影响可用性。
 */
function publishUtdid(file, utdid) {
  const tmp = `${file}.${process.pid ?? 0}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, `${utdid}\n`, { mode: 0o600 })
  } catch {
    return utdid
  }
  try {
    linkSync(tmp, file)
    return utdid
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const winner = readUtdid(file)
      if (winner) return winner
    }
    try {
      renameSync(tmp, file)
      return utdid
    } catch {
      return utdid
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch { /* 已被 rename 走，或本来就没建起来 */ }
  }
}

let cached

/**
 * 本机长期稳定的 utdid。
 *
 * 顺序：env 指定 → 状态文件 → 生成并落盘。结果在进程内缓存，文件只读一次。
 */
export function utdidOf() {
  const fromEnv = envUtdid()
  if (fromEnv) return fromEnv
  if (cached && UTDID_PATTERN.test(cached)) return cached
  const file = utdidPath()
  const stored = readUtdid(file)
  if (stored) {
    cached = stored
    return cached
  }
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  } catch { /* 目录已存在或不可建：下面照常尝试 */ }
  cached = publishUtdid(file, newUtdid())
  return cached
}

/** 清掉进程内缓存（测试用；也方便宿主热重载后强制重读）。 */
export function resetUtdidCache() {
  cached = undefined
}
