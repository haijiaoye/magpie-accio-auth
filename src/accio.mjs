// Accio（阿里 Accio Work）渠道实现 —— 移植自 DSH
// `accio-product.ts` / `accio-oauth.ts` / `accio-auth.ts` / `accio.ts` /
// `accio-messages.ts` / `accio-adapter.ts`（全部 2026-10 真机实测结论）。
//
// ## 协议总览（与其它渠道最大的不同：Gemini 风格信封）
//
// ```
// POST {gateway}/api/adk/llm/generateContent?sg_k={md5(requestId)}
//   headers: Content-Type / Accept: text/event-stream / utdid / version / appKey:'OneChat'
//   body   : Gemini 风格（contents/parts，键 snake_case）+ token（★ 必须在 body，
//            放 Authorization 头恒流内 402）
//   响应   : SSE，帧 `{content:{parts},usage_metadata,finish_reason,turn_complete}`，
//            流内错误 `{"error_code":"402","error_message":"unauthorized"}`（HTTP 仍 200）
// ```
//
// ⚠️ 不需要 SecurityGuard 签名（实测不带 `pctb-x-*` 同样 200）。
//
// ## 上行的 model 是 `modelCode`（`1Drift-…`，非人类可读）
//
// 对外目录 id 用**展示名的 slug**（`qwen-3-8-flash`），上行**必须**换回 modelCode ——
// 发 slug 会请求打空，症状是「模型不回复」。查不到时**原样发入参**（让上游报错，
// 不本地编造空模型名）。
//
// ## magpie 侧的形状
//
// magpie 发 OpenAI 形状进来 → 先转 OpenAI 传输中间态（tool_calls/tool_call_id/name，
// 与 DSH 的 `toAccioWireMessages` 同位）→ 再转 Gemini 信封（`serializeAccioMessages`）。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fetchWithRetry } from './transport.mjs'

export const CHANNEL_ID = 'accio'
export const DISPLAY_NAME = 'Accio (阿里)'

/**
 * 国内版 / 国际版**共用同一个网关与账号体系**，只有两处不同（2026-11 实测）：
 *
 *  1. 登录站点：国内 `www.accio-ai.com`，国际 `www.accio.com`；
 *  2. 每个网关请求带 `x-package-region: GLOBAL`（国内不带，或 `CN`）。
 *
 * ⚠️ 区域不是「显示偏好」：`/api/llm/config/v2` 在 GLOBAL 下返回的是**另一套
 *    模型目录**（Claude / GPT / Gemini 共 27 个），国内 15 个；同名模型
 *    （Qwen 3.8 Max）两边的 `modelCode` **也不一样**。所以区域必须进凭据、
 *    续期原样保留，且模型 slug→modelCode 的映射要按区域分开存。
 */
export const SITE_CN = 'cn'
export const SITE_GLOBAL = 'global'

const GATEWAY = 'https://phoenix-gw.alibaba.com'
const LOGIN_BASE_CN = 'https://www.accio-ai.com'
const LOGIN_BASE_GLOBAL = 'https://www.accio.com'
const TOKEN_EXCHANGE_PATH = '/api/oauth/token'
const REFRESH_PATH = '/api/auth/refresh_token'
const LLM_PATH = '/api/adk/llm/generateContent'
const CATALOG_PATH = '/api/llm/config/v2'
const CALLBACK_PATH = '/auth/callback'
/**
 * 空间（Space）端点。
 *
 * ⚠️ Accio 的「商户空间」就是 **team**：桌面版 `/space/switch` 最终落到
 *    `POST /api/team/queryUserTeams` 取列表 + `x-team-id` 头切上下文。
 *    只带 `x-team-id` 不够 —— 额度接口还要 `?teamId=`（否则读到的仍是个人
 *    空间），实测（2026-11-12）：只带头时 `currentSubscription` 返回 406。
 */
const TEAMS_PATH = '/api/team/queryUserTeams'

const CLIENT_ID = 'accio-work'
const APP_KEY = 'OneChat'
const APP_VERSION = '0.34.4'

const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 600_000
/** 临期提前量（对齐本插件其它渠道的 10 分钟口径；DSH 是到点才续）。 */
const EXPIRY_LEAD_MS = 10 * 60 * 1000

// ── 小工具 ───────────────────────────────────────────────────────────────

const nonEmpty = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)

/**
 * 秒→毫秒归一化。⚠️ 上游 `expiresAt` 是**秒**；忘归一化会判「1970 年已过期」
 * ⇒ 每请求都续期 ⇒ 并发消费 refresh_token ⇒ `invalid_grant` ⇒ **账号被标死**。
 * `> 1e12` 视为已是毫秒（防御性）。
 */
export function accioExpiresAtMs(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
}

const expired = (c) => {
  const at = accioExpiresAtMs(c?.expires_at)
  if (at === undefined) return false
  return at - Date.now() < EXPIRY_LEAD_MS
}

/** camelCase → snake_case（递归）；`undefined` 键整个丢掉（null 与缺键不同义）。 */
export function accioToSnake(value) {
  if (Array.isArray(value)) return value.map(accioToSnake)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = accioToSnake(v)
    }
    return out
  }
  return value
}

const requestIdOf = () => `req-${Date.now()}-${randomUUID().slice(0, 8)}`
const sgKOf = (requestId) => createHash('md5').update(requestId, 'utf8').digest('hex')
/** message_id 必填（缺它上游 400）；掺随机量防上游按它去重。 */
const messageIdOf = (requestId) =>
  createHash('md5').update(`${requestId}:${randomBytes(16).toString('hex')}`, 'utf8').digest('hex')

/**
 * utdid：装机级稳定 id（阿里网关用它做风控基线；缺失会吃到 200+风控拦截页）。
 *
 * ⚠️ v0.5.0 起**只放在进程内存**（`process.esk.accioUtdid`），不再写
 *    `~/.config/magpie/accio-state.json` —— 插件不往 magpie 的配置目录写任何
 *    文件（PR #502 审核第 2 条）。代价：magpie 重启后 utdid 换新 —— 阿里网关
 *    只把它当风控基线，换新不拦（真机登录链路不依赖它的连续性）。
 */
function loadUtdid() {
  const utdid = `accio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  return utdid
}

const utdidOf = () => {
  process.esk ??= {}
  process.esk.accioUtdid ??= loadUtdid()
  return process.esk.accioUtdid
}

// ── 登录：PKCE + 本地 loopback 回调（Accio 对 return_url 无白名单校验）────

const createPkce = () => {
  // ⚠️ verifier 是 **48 随机字节**的 base64url（官方客户端同款）。
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * 拼授权 URL。⚠️ **参数缺一不可**：少了 `code_challenge` 会被登录页判为
 * legacy 客户端而弹「请升级客户端」—— 这是社区移植最常踩的坑。
 */
export function buildAuthUrl({ region, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    client_id: CLIENT_ID,
    ttid: `ttid_${randomBytes(16).toString('hex')}`,
    language: region === SITE_GLOBAL ? 'en' : 'zh',
  })
  const base = region === SITE_GLOBAL ? LOGIN_BASE_GLOBAL : LOGIN_BASE_CN
  return `${base}/login?${params.toString()}`
}

/** 解析 `{success, code, message, data}` 信封；失败抛**带服务端原文**的错误。 */
function unwrapEnvelope(path, status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`accio: ${path} 返回非 JSON（HTTP ${status}）：${text.slice(0, 200)}`)
  }
  if (body?.success !== true) {
    throw new Error(`accio: ${path} 失败（${String(body?.code ?? status)} ${String(body?.message ?? '')}）`.trim())
  }
  if (body.data === null || typeof body.data !== 'object') {
    throw new Error(`accio: ${path} 响应缺 data 对象`)
  }
  return body.data
}

/** data → 凭据。⚠️ 三者缺一不可（官方客户端同款校验）；expiresAt 秒→毫秒在此一次性完成。 */
function toCredential(path, data, extra = {}) {
  const access = data.accessToken
  const refresh = data.refreshToken
  const expiresAt = accioExpiresAtMs(data.expiresAt)
  if (typeof access !== 'string' || access === '') throw new Error(`accio: ${path} 响应缺 accessToken`)
  if (typeof refresh !== 'string' || refresh === '') throw new Error(`accio: ${path} 响应缺 refreshToken`)
  if (expiresAt === undefined) throw new Error(`accio: ${path} 响应缺 expiresAt（或非正数）`)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    ...typeof data.sgcookie === 'string' && data.sgcookie !== '' ? { sgcookie: data.sgcookie } : {},
    ...extra,
  }
}

const exchangeCode = async ({ code, codeVerifier, redirectUri, region }) => {
  const res = await fetch(`${GATEWAY}${TOKEN_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, codeVerifier, clientId: CLIENT_ID, redirectUri }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  return toCredential(TOKEN_EXCHANGE_PATH, unwrapEnvelope(TOKEN_EXCHANGE_PATH, res.status, text), {
    region: region === SITE_GLOBAL ? SITE_GLOBAL : SITE_CN,
  })
}

/** 续期失败的**终态**标记（refresh_token 真的不能用了）。 */
const TERMINAL_MARKERS = ['invalid_grant', 'invalid refresh token', 'invalid refresh_token',
  'refresh token has been used', 'refresh_token has been used', 'refresh token expired',
  'refresh_token expired', 'expired refresh token', 'NOT_LOGIN', 'not_login']

export const isTerminalRefreshError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return TERMINAL_MARKERS.some((m) => lowered.includes(m.toLowerCase()))
}

/**
 * 续期。⚠️⚠️ **刷新会轮换 refresh_token**（参考实现明确记录）——
 * 并发续期会「1 成功、其余 invalid_grant」，失败方会把好账号标死。
 * 串行由聚合层的 gatedRenew 保证（与 DSH 的 SerialQueue 同位）。
 */
export async function refreshCredential(current) {
  if (typeof current?.refresh_token !== 'string' || current.refresh_token === '') {
    throw new Error('凭据缺少 refresh_token，请重新登录')
  }
  const res = await fetch(`${GATEWAY}${REFRESH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: current.access_token, refreshToken: current.refresh_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  const next = toCredential(REFRESH_PATH, unwrapEnvelope(REFRESH_PATH, res.status, text), {
    region: current.region === SITE_GLOBAL ? SITE_GLOBAL : SITE_CN,
  })
  if (typeof current.sgcookie === 'string' && next.sgcookie === undefined) next.sgcookie = current.sgcookie
  // ⚠️ 空间选择是**凭据的一部分**（同一份 token 可读个人或商户空间），
  //    续期只换 token，空间必须原样带过去 —— 否则每次续期都静默退回个人空间。
  if (typeof current.team_id === 'string' && current.team_id !== '') {
    next.team_id = current.team_id
    if (typeof current.team_name === 'string') next.team_name = current.team_name
  }
  return next
}

// ── 空间（Space = 个人 / 商户 team）──────────────────────────────────────

/**
 * 团队（= 商户空间）列表。
 *
 * ⚠️ token 在 **body**（`{accessToken}`），与 `/api/llm/config/v2` 的 `token`
 *    不是同一个键名；放 query 或 header 都会拿到 `NOT_LOGIN`（实测 2026-11-12）。
 * ⚠️ 返回的 `teamId` 是**数字**，后续一律转字符串再进凭据（magpie 的 auth 是
 *    JSON，数字/字符串混用会让 `x-team-id` 拼出 `10478012.0` 这类值）。
 */
export async function listTeams(credential) {
  const res = await fetch(`${GATEWAY}${TEAMS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: credential.access_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text().catch(() => '')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`accio: 空间列表返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (body?.success !== true || !Array.isArray(body.data)) {
    const code = String(body?.code ?? res.status)
    const message = String(body?.message ?? '')
    if (code === '401' || /NOT_LOGIN/i.test(message)) {
      const error = new Error('未登录或登录已过期（NOT_LOGIN），请重新登录 Accio 账号')
      error.signedOut = true
      throw error
    }
    throw new Error(`accio: 空间列表查询失败（${code} ${message}）`.trim())
  }
  return body.data
    .filter((row) => row !== null && typeof row === 'object' && row.teamId !== undefined && row.teamId !== null)
    .map((row) => ({
      teamId: String(row.teamId),
      name: typeof row.teamName === 'string' && row.teamName !== '' ? row.teamName : `空间 ${row.teamId}`,
      role: typeof row.role === 'string' ? row.role : '',
      planId: row.planId === undefined || row.planId === null ? '' : String(row.planId),
    }))
}

/** 当前空间标签（额度/快照展示用）：`个人空间` 或 `商户空间 <名字>`。 */
export function spaceLabelOf(credential) {
  const teamId = typeof credential?.team_id === 'string' ? credential.team_id : ''
  if (teamId === '') return '个人空间'
  const name = typeof credential?.team_name === 'string' && credential.team_name !== ''
    ? credential.team_name
    : teamId
  return `商户空间 ${name}`
}

/**
 * 空间查询参数：只有商户空间才带 `teamId`。
 *
 * ⚠️ 额度类端点**只带 `x-team-id` 头会 406**（实测），必须同时带 `?teamId=`；
 *    两者一起带时服务端以参数为准，所以这里统一拼 query。
 */
const teamQueryOf = (credential) => {
  const teamId = typeof credential?.team_id === 'string' ? credential.team_id : ''
  return teamId === '' ? '' : `&teamId=${encodeURIComponent(teamId)}`
}

/** 区域（国内 / 国际）头：国际版每个网关请求都要带 `GLOBAL`。 */
const siteHeadersOf = (credential) => (
  credential?.region === SITE_GLOBAL ? { 'x-package-region': 'GLOBAL' } : {}
)

/** 商户空间才带的请求头（个人空间一个都不带）。 */
const teamHeadersOf = (credential) => (
  typeof credential?.team_id === 'string' && credential.team_id !== ''
    ? { 'x-team-id': credential.team_id }
    : {}
)

/** 起本地回调服务 + 授权 URL，**立刻**返回（beginLogin 契约）。 */
async function beginLogin({ site = SITE_CN, openBrowser } = {}) {
  const region = site === SITE_GLOBAL ? SITE_GLOBAL : SITE_CN
  const pkce = createPkce()
  const state = randomBytes(32).toString('hex')
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {}) // 防 unhandledRejection
  let settled = false
  let timer
  let serverClosed = false

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
    const page = (title, message) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      + `<title>${title}</title></head>`
      + `<body style="font-family:system-ui;padding:2rem"><p>${message}</p></body></html>`
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Accio 授权', '未知的回调路径'))
      return
    }
    const params = url.searchParams
    // ⚠️ state 必须原样匹配：否则任何能往 loopback 投查询串的本地进程都能
    // 把攻击者的授权码写进用户账号。
    if ((params.get('state') ?? '') !== state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Accio 授权失败', 'state 校验失败，请回到面板重新发起登录'))
      fail(new Error('accio: 登录回调 state 不匹配（可能是伪造的回调）'))
      return
    }
    const errorCode = params.get('error')
    if (errorCode !== null && errorCode !== '') {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Accio 授权失败', `授权被拒绝：${errorCode}`))
      fail(new Error(`accio: 授权被拒绝（${errorCode}）`))
      return
    }
    const code = params.get('code') ?? ''
    if (code === '') {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Accio 授权失败', '回调里没有授权码'))
      fail(new Error('accio: 登录回调缺少授权码'))
      return
    }
    // 先回提示页再后台兑换：用户不必盯着转圈的标签页等换 token。
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(page('Accio 授权', '授权已收到，可以关闭此页面并返回。'))
    exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri, region })
      .then(settleOk)
      .catch((error) => settleFail(error instanceof Error ? error : new Error(String(error))))
  })

  const closeServer = () => {
    if (serverClosed) return
    serverClosed = true
    server.close()
  }
  const settle = (ok, error) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    closeServer()
    ok ? settleOk(error) : settleFail(error)
  }
  const fail = (error) => settle(false, error)

  timer = setTimeout(() => fail(new Error('accio: 登录超时（未收到授权回调）')), LOGIN_TIMEOUT_MS)
  timer.unref?.()

  // ⚠️ 先挂 'error' 再 listen（EADDRINUSE 是异步 error 事件，不挂会崩进程）。
  const port = await new Promise((resolve, reject) => {
    let settledListen = false
    server.once('error', (error) => {
      if (settledListen) return
      settledListen = true
      reject(error)
    })
    // 只绑回环：绑全网卡会让同局域网机器也能投伪造的 ?code=。
    server.listen(0, '127.0.0.1', () => {
      settledListen = true
      server.on('error', () => {})
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    fail(new Error(`accio: 回调端口无法监听（${error.message}）`))
    throw error
  })

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const loginUrl = buildAuthUrl({ region, redirectUri, state, codeChallenge: pkce.challenge })
  if (openBrowser) openBrowser(loginUrl)
  return {
    url: loginUrl,
    result,
    instructions: `在打开的页面里完成 Accio（阿里）登录，完成后本窗口自动继续。也可以手动打开：${loginUrl}`,
  }
}

// ── 目录 ─────────────────────────────────────────────────────────────────

/** 展示名 → slug（对外 id）。归一后为空时回退 modelCode（空 id 会让整个目录不可用）。 */
const slugOf = (name) => {
  const s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s
}

/**
 * 远端目录条目归一（DSH `normalizeAccioModel` 同口径）：
 * `visible !== true` 剔除；`reasoningEfforts` 可能是 null（38 条里 31 条）——
 * 与空数组同样表达为「无档位」；`defaultReasoningEffort` 可单独存在（单档）。
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.visible !== true) return undefined
  const modelCode = typeof raw.modelCode === 'string' ? raw.modelCode : ''
  if (modelCode === '') return undefined
  const displayName = typeof raw.modelDisplayName === 'string' ? raw.modelDisplayName : ''
  const contextWindow = typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow)
    ? raw.contextWindow : 0
  const multiple = typeof raw.effectiveMultiple === 'number' && Number.isFinite(raw.effectiveMultiple)
    ? raw.effectiveMultiple : undefined
  const maxTokens = typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)
    ? raw.maxTokens : undefined
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.filter((e) => typeof e === 'string' && e.trim() !== '')
    : []
  const defaultEffort = typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.trim() !== ''
    ? raw.defaultReasoningEffort : undefined
  return {
    id: modelCode,
    name: displayName === '' ? modelCode : displayName,
    contextWindow,
    supportsImage: raw.multimodal === true,
    ...(multiple !== undefined ? { multiple } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  }
}

/** `POST /api/llm/config/v2`（token 在 body）→ `data[].modelList[]`，按倍率升序。 */
export function parseCatalog(body) {
  const data = body?.data
  if (!Array.isArray(data)) return []
  const models = []
  for (const group of data) {
    const list = group?.modelList
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const entry = normalizeModel(raw)
      if (entry !== undefined) models.push(entry)
    }
  }
  // ⚠️ 缺倍率排最后（`Infinity - Infinity = NaN` 会让 sort 退化为不稳定原序）。
  return models.sort((a, b) => {
    const l = a.multiple
    const r = b.multiple
    if (l === undefined && r === undefined) return 0
    if (l === undefined) return 1
    if (r === undefined) return -1
    return l - r
  })
}

async function catalog(credential) {
  let entries
  try {
    // 商户空间的目录与个人空间不同（倍率/可见集都可能不一样），
    // 带上 x-team-id + teamId 才拿到该空间的真实目录。
    const res = await fetch(`${GATEWAY}${CATALOG_PATH}${teamQueryOf(credential) === '' ? '' : `?teamId=${encodeURIComponent(credential.team_id)}`}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...siteHeadersOf(credential),
        ...teamHeadersOf(credential),
      },
      body: JSON.stringify({ token: credential.access_token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.ok) entries = parseCatalog(await res.json())
  } catch { /* 目录失败回落兜底表 */ }
  const isGlobal = credential?.region === SITE_GLOBAL
  const fallback = isGlobal ? FALLBACK_MODELS_GLOBAL : FALLBACK_MODELS
  const list = entries !== undefined && entries.length > 0 ? entries : fallback
  // slug（对外 id）与 modelCode 的映射表，chat 时换回。
  // ⚠️ 按区域分开存：同名模型（Qwen 3.8 Max）在两边是不同的 modelCode，
  //    共用一张表会让国内请求发到国际的 code（或反之）。
  const index = isGlobal ? globalModelIndex : cnModelIndex
  index.length = 0
  for (const entry of list) index.push({ slug: slugOf(entry.name) || entry.id, code: entry.id, entry })
  const models = {}
  for (const { slug, entry } of index) {
    models[slug] = {
      name: entry.multiple !== undefined ? `${entry.name} · x${entry.multiple}` : entry.name,
      limit: {
        context: entry.contextWindow > 0 ? entry.contextWindow : 128_000,
        output: entry.maxTokens ?? 8_192,
      },
      tool_call: true,
      capabilities: {
        temperature: true,
        // ⚠️ Accio 关不掉思考（实测四类字段全部无效），档位仅作展示（DSH 同口径）
        reasoning: true,
        attachment: entry.supportsImage === true,
        toolcall: true,
        // ⚠️ magpie 判定「模型说过能看图」读的是 capabilities.input.image
        //    （见 lingxi.mjs modelRow 注释）；只写顶层 modalities 会被当成 unsaid。
        input: { text: true, image: entry.supportsImage === true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      options: {},
      headers: {},
      variants: variantsOf(entry),
      status: 'active',
      release_date: '',
    }
  }
  return models
}

/** 档位仅展示：DSH 实测上游无任何受控字段（请求体不带 effort）。 */
function variantsOf(entry) {
  const out = {}
  if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    for (const effort of entry.efforts) out[effort] = { reasoning_effort: effort }
  } else if (entry.defaultEffort !== undefined) {
    out[entry.defaultEffort] = { reasoning_effort: entry.defaultEffort }
  }
  return out
}

/** slug → modelCode（上行必须用 modelCode；查不到原样发，让上游报错）。 */
const codeOf = (slug, credential) => {
  const index = credential?.region === SITE_GLOBAL ? globalModelIndex : cnModelIndex
  return index.find((m) => m.slug === slug)?.code ?? slug
}
/** 国内 / 国际各一张 slug→modelCode 表（同名模型两边 code 不同）。 */
const cnModelIndex = []
const globalModelIndex = []

/**
 * 兜底模型表（DSH 2026-10-12 实测 15 条，倍率升序；slug 由展示名归一）。
 * ⚠️ modelCode 非人类可读、无法手写维护 —— 兜底表只在远端目录失败时兜住。
 */
const FALLBACK_MODELS = [
  { id: '1Drift-N8kP2Q7wR5mX', name: 'Qwen 3.8 27B', contextWindow: 512_000, supportsImage: true, multiple: 0.013 },
  { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: '1Chronos-F53X9nQ3rT8w', name: 'GLM 5.3 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.045 },
  { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
  { id: '1Chronos-dX3cV9sA2mK7', name: 'GLM 5.1', contextWindow: 200_000, supportsImage: false, multiple: 0.12 },
  { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
  { id: '1Drift-A3bM5nK8pQ2w', name: 'Qwen 3.5 A3B', contextWindow: 256_000, supportsImage: false, multiple: 0.13 },
  { id: '1Synapse-G5aJ8wL1dV4s', name: 'Kimi K2.6', contextWindow: 256_000, supportsImage: true, multiple: 0.14 },
  { id: '1Chronos-L53W8nP2qR6m', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: '1Chronos-G5p2V9sA2mK7', name: 'GLM 5.2', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: '1Nova-bW7yT4kL9pN2', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsImage: false, multiple: 0.17 },
  { id: '1Drift-T3TB6WS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1_000_000, supportsImage: true, multiple: 0.44 },
  { id: '1Orbit-I9eY4tK8bW1f', name: 'Professional', contextWindow: 1_000_000, supportsImage: true, multiple: 1 },
  { id: '1Orbit-Q7hN3xR6cP2m', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
]

/**
 * 国际版兜底表（2026-11-12 实测 27 条，倍率升序）。
 *
 * ⚠️ 与国内表**不是超集关系**：国际版没有 GLM / DeepSeek / Kimi，国内版也没有
 *    Claude / GPT / Gemini。别把两张表合并成一张 —— 目录失败时会「多出」对方
 *    才有的模型，请求打过去必然失败。
 */
const FALLBACK_MODELS_GLOBAL = [
  { id: '1Drift-F8hS3mK7pL6I', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.003 },
  { id: '1Orbit-H55aN8xR6cP2m', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: '1Helix-G6Lu8nK4qR2m', name: 'GPT 6 Luna', contextWindow: 1_050_000, supportsImage: true, multiple: 0.04 },
  { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
  { id: '1Helix-3EjR3WN1dY6s', name: 'GPT 5.6 Luna', contextWindow: 1_050_000, supportsImage: true, multiple: 0.09 },
  { id: '1Nexus-R36W8qJ5vB6h', name: 'Gemini 3 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
  { id: '1Nexus-R7GF8qJ6vd8p', name: 'Gemini 3.7 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.25 },
  { id: '1Nexus-R8HF9qK7we1s', name: 'Gemini 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.25 },
  { id: '1Orbit-I93V4tK8bW1f', name: 'Claude Haiku 4.5', contextWindow: 200_000, supportsImage: true, multiple: 0.35 },
  { id: '1Nexus-R3wF8qJ5vc7o', name: 'Gemini 3.5 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.4 },
  { id: '1Helix-G46W8nP2qR6m', name: 'Grok 4.6', contextWindow: 500_000, supportsImage: true, multiple: 0.5 },
  { id: '1Drift-T3T9WWS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1_000_000, supportsImage: true, multiple: 0.56 },
  { id: '1Helix-G6So7pW3xN9q', name: 'GPT 6 Sol', contextWindow: 1_050_000, supportsImage: true, multiple: 0.7 },
  { id: '1Orbit-I93F4tK8bW1f', name: 'Claude Sonnet 5', contextWindow: 1_000_000, supportsImage: true, multiple: 0.7 },
  { id: '1Nexus-utXDaAethymI', name: 'Gemini 4 Argon', contextWindow: 1_048_576, supportsImage: true, multiple: 0.7 },
  { id: '1Helix-B33T3WN1dY6s', name: 'GPT 5.6 Terra', contextWindow: 1_050_000, supportsImage: true, multiple: 0.88 },
  { id: '1Orbit-I9eY7YK8bW1f', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, supportsImage: true, multiple: 1 },
  { id: '1Orbit-Q55pN8xR6cP2m', name: 'Claude Opus 5.5', contextWindow: 1_000_000, supportsImage: true, multiple: 1.33 },
  { id: '1Orbit-Q7hN2R6cP2m', name: 'Claude Opus 4.7', contextWindow: 1_000_000, supportsImage: true, multiple: 1.65 },
  { id: '1Orbit-Q2XN3xR6cP2m', name: 'Claude Opus 4.8', contextWindow: 1_000_000, supportsImage: true, multiple: 1.7 },
  { id: '1Helix-B3jR8wN1dY6s', name: 'GPT 5.5', contextWindow: 1_050_000, supportsImage: true, multiple: 1.8 },
  { id: '1Helix-B3jR3WN1dY6s', name: 'GPT 5.6 Sol', contextWindow: 1_050_000, supportsImage: true, multiple: 2.2 },
  { id: '1Orbit-Q5pN8xR6cP2m', name: 'Claude Opus 5', contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
  { id: '1Orbit-F52W8nP2qR7n', name: 'Claude Fable 5.2', contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
  { id: '1Helix-G6aS8tR2qN7m', name: 'GPT 6 Astra', contextWindow: 1_050_000, supportsImage: true, multiple: 3.5 },
  { id: '1Orbit-F51W8nP2qR6m', name: 'Claude Fable 5.1', contextWindow: 1_000_000, supportsImage: true, multiple: 3.5 },
  { id: '1Orbit-Q2XN3dX6cP2m', name: 'Claude Fable 5', contextWindow: 1_000_000, supportsImage: true, multiple: 3.5 },
]

// ── 请求体构造（buildAccioBody 同口径）──────────────────────────────────

/** 请求头。⚠️ 不带 SecurityGuard 的 pctb-x-*（实测不必需）；token 不放 Authorization。 */
function accioHeaders(credential) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    utdid: utdidOf(),
    version: APP_VERSION,
    appKey: APP_KEY,
    ...siteHeadersOf(credential),
  }
  if (typeof credential?.sgcookie === 'string' && credential.sgcookie !== '') {
    headers.sgcookie = credential.sgcookie
  }
  // 商户空间：桌面版所有网关请求都带 `x-team-id`（个人空间不带）。
  if (typeof credential?.team_id === 'string' && credential.team_id !== '') {
    headers['x-team-id'] = credential.team_id
  }
  return headers
}

function buildBody({ model, accessToken, contents, systemInstruction, tools, temperature, maxOutputTokens, requestId }) {
  const camel = {
    model,
    empid: '',
    tenant: '',
    iaiTag: '',
    requestId,
    userRequestId: requestId,
    contents,
    // ⚠️ 必须是**字符串**：对象形态实测恒回 HTTP 200 + 流内 400「Invalid request
    // format」（与 Gemini 在这一格上不同形，别照搬）。
    systemInstruction: systemInstruction === '' ? undefined : systemInstruction,
    // ⚠️ parametersJson 必须是字符串：accioToSnake 会下钻对象 —— schema 参数名
    // 是数据，递归改写会把 filePath 静默变成 file_path（无任何报错）。
    tools: tools !== undefined && tools.length > 0 ? tools : undefined,
    temperature,
    maxOutputTokens,
    stopSequences: [],
    properties: { utdid: utdidOf(), version: APP_VERSION, appKey: APP_KEY, normalizedResponse: 'true' },
    token: accessToken,
    messageId: messageIdOf(requestId),
    incremental: true,
  }
  const body = accioToSnake(camel)
  // ⚠️ properties 子树不参与 snake 转换：实测成功形状里 appKey 是驼峰、
  // normalized_response 是 snake（两种键形混用），走通用转换是未实测形状。
  body.properties = {
    utdid: utdidOf(),
    version: APP_VERSION,
    appKey: APP_KEY,
    normalized_response: 'true',
  }
  return body
}

// ── OpenAI → Gemini 信封 ────────────────────────────────────────────────

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('')
}

const dataUrlOf = (url) => {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ''))
  return match === null ? undefined : { mimeType: match[1], data: match[2] }
}

/**
 * OpenAI 消息 → `{contents, systemInstruction}`。
 *
 * ⚠️ 工具结果下发为 `{role:'user',parts:[{functionResponse}]}`（Gemini 风格），
 * **按 name 配对**（OpenAI 的 tool 消息不带 name ⇒ 需从 assistant 的 tool_calls
 * 建 id→name 映射回填，漏了映射工具结果就全字段丢失）。
 *
 * ⚠️⚠️ **跨消息配对纪律**（上游 61bfe25 修的真实缺陷，trae 4027 同约束的第二入口）：
 * `functionResponse` **必须紧密相邻** —— 中间插任何东西（含图片 user 消息）都会
 * 断开配对。故本函数把「工具结果内嵌的图片」先收集、**全部 functionResponse
 * 之后**才追加一条独立 user 消息（带说明文字 + inlineData）。
 * 同时 `responseJson` 只装文本 —— 把含图的数组整体 stringify 会把巨大 base64
 * 塞进 JSON 串（图片既没真正给模型，还撑爆请求体）。
 */
export function serializeMessages(messages) {
  const contents = []
  const system = []
  const toolNames = new Map()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string' && typeof call?.function?.name === 'string') {
          toolNames.set(call.id, call.function.name)
        }
      }
    }
  }
  /** 工具结果内嵌图片（data URL → inlineData），配对批完成后统一追加。 */
  const pendingImages = []
  const collectToolImages = (content) => {
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (part?.type === 'image_url') {
        const inline = dataUrlOf(part?.image_url?.url)
        if (inline !== undefined) pendingImages.push(inline)
      }
    }
  }
  const flushPendingImages = () => {
    if (pendingImages.length === 0) return
    contents.push({
      role: 'user',
      parts: [
        { text: 'Attached image(s) from tool result:' },
        ...pendingImages.map((inline) => ({ inlineData: inline })),
      ],
    })
    pendingImages.length = 0
  }
  for (const message of messages) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text !== '') system.push(text)
      continue
    }
    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      collectToolImages(message.content)
      // ⚠️ responseJson 只装文本：含图数组整体 stringify 会把巨大 base64 塞进 JSON
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('')
          : JSON.stringify(message.content ?? {})
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id,
            name: toolNames.get(id) ?? '',
            responseJson: text,
          },
        }],
      })
      continue
    }
    if (role === 'assistant') {
      // ⚠️ 跨 assistant 边界前必须先把上一批工具图片落盘（配对纪律）：
      // 进入下一条 model 消息之前，functionResponse 批必须已闭合。
      flushPendingImages()
      const parts = []
      const text = textOf(message.content)
      if (text !== '') parts.push({ text })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        parts.push({
          functionCall: {
            id: typeof call?.id === 'string' ? call.id : '',
            name: typeof call?.function?.name === 'string' ? call.function.name : '',
            argsJson: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}',
          },
        })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    // user（含图片：Gemini 风格 inline_data，实测四象限色块四色全对）
    const parts = []
    const blocks = Array.isArray(message.content) ? message.content : undefined
    if (blocks !== undefined) {
      for (const block of blocks) {
        if (typeof block?.text === 'string') {
          if (block.text !== '') parts.push({ text: block.text })
          continue
        }
        if (block?.type === 'image_url') {
          const inline = dataUrlOf(block?.image_url?.url)
          if (inline === undefined) {
            throw new Error('accio: 暂不支持远程图片链接（只支持 base64 data URL）')
          }
          parts.push({ inlineData: inline })
          continue
        }
      }
    }
    if (parts.length > 0) {
      contents.push({ role: 'user', parts })
      continue
    }
    const text = textOf(message.content)
    if (text !== '') contents.push({ role: 'user', parts: [{ text }] })
  }
  // ⚠️ 收尾：末尾一批工具结果的内嵌图片也要落盘（否则永远不发）
  flushPendingImages()
  return { contents, systemInstruction: system.join('\n\n') }
}

const toAccioTools = (tools) => {
  const out = []
  for (const tool of tools) {
    const fn = tool?.function
    if (fn === undefined || typeof fn.name !== 'string' || fn.name === '') continue
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parametersJson: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} }),
    })
  }
  return out.length > 0 ? out : undefined
}

// ── SSE：Accio 帧 → OpenAI chunks ───────────────────────────────────────

/**
 * 工具参数分片合并（DSH `mergeAccioToolArgs` 同口径）。
 * 实测形态：首帧无参数、后续帧重复**完整**参数；但增量式也会出现，两种都处理。
 */
export function mergeToolArgs(fragments) {
  const nonEmpty = fragments.filter((f) => f !== '')
  if (nonEmpty.length === 0) return ''
  let cumulative = true
  for (let i = 1; i < nonEmpty.length; i++) {
    if (!nonEmpty[i].startsWith(nonEmpty[i - 1])) { cumulative = false; break }
  }
  if (cumulative) return nonEmpty[nonEmpty.length - 1]
  let merged = ''
  for (const fragment of nonEmpty) {
    merged = fragment.startsWith(merged) ? fragment : merged + fragment
  }
  return merged
}

/** 流内错误帧判据：带 error_code/error_message 且 **error_code !== '200'**（200 是成功哨兵）。 */
export function isErrorFrame(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return false
  const code = frame.error_code ?? frame.errorCode
  const message = frame.error_message ?? frame.errorMessage
  if ((code === undefined || code === '') && (message === undefined || message === '')) return false
  return String(code ?? '') !== '200'
}

/** OpenAI finish_reason 映射（未知一律 stop，不编造成 error）。 */
const finishOf = (reason) => {
  if (reason === 'MAX_TOKENS' || reason === 'max_tokens') return 'length'
  return 'stop'
}

/**
 * 消费 Accio SSE → OpenAI chunk 流。
 *
 * 帧形状：`{content:{parts},usage_metadata,finish_reason,turn_complete}` +
 * 流内错误帧 + 顶层 function_call（无 content，工具意图首帧）。
 * ⚠️ 工具调用是**分片**到达（首帧只有 id/name，后续帧补 args_json）——
 * 按 id 缓冲、结束时用 mergeToolArgs 合并成一次调用（DSH 的合并层同位）。
 */
export async function* accioSseToOpenAi(body, { model, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const id = `chatcmpl-accio-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  let buffer = ''
  let sawAny = false
  let finishReason
  /** 原始 usage：取各键**最大值**（上游多帧重复播报且早期帧偏小）。 */
  const usage = {}
  /** 工具调用缓冲：id → {name, fragments[]}（按首见顺序）。 */
  const calls = new Map()

  const noteUsage = (raw) => {
    const u = typeof raw === 'object' && raw !== null ? raw : {}
    const pick = (...keys) => {
      for (const k of keys) {
        const v = u[k]
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v)
      }
      return undefined
    }
    const pairs = [
      ['prompt_tokens', pick('prompt_token_count', 'promptTokenCount')],
      ['completion_tokens', pick('candidates_token_count', 'candidatesTokenCount')],
      ['total_tokens', pick('total_token_count', 'totalTokenCount')],
      ['reasoning_tokens', pick('thoughts_token_count', 'thoughtsTokenCount')],
    ]
    for (const [key, value] of pairs) {
      if (value !== undefined && (usage[key] === undefined || value > usage[key])) usage[key] = value
    }
  }

  const handlePart = function* (part) {
    if (part === null || typeof part !== 'object') return
    if (typeof part.text === 'string' && part.text !== '') {
      sawAny = true
      // ⚠️ thought 标记的 part 是思考内容，映射 reasoning_content（不污染正文）
      yield chunk(part.thought === true ? { reasoning_content: part.text } : { content: part.text })
      return
    }
    const call = part.functionCall ?? part.function_call
    if (call !== null && typeof call === 'object') {
      // ⚠️ 无名调用也计入 sawAny：上游确实产出了内容（只是不可用），
      // 丢弃后若归零会触发「模型未返回任何内容块」、把 MAX_TOKENS 截断
      // 伪装成空响应（DSH 同款处理）。
      sawAny = true
      const callId = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${calls.size}`
      const name = typeof call.name === 'string' ? call.name : ''
      if (name === '') return // 无名调用整块丢弃（产出无名工具调用会让上游 400）
      const state = calls.get(callId) ?? { name, fragments: [], order: calls.size }
      if (typeof call.args_json === 'string' && call.args_json !== '') state.fragments.push(call.args_json)
      else if (typeof call.argsJson === 'string' && call.argsJson !== '') state.fragments.push(call.argsJson)
      calls.set(callId, state)
    }
  }

  const handleFrame = function* (frame) {
    if (isErrorFrame(frame)) {
      const code = String(frame.error_code ?? frame.errorCode ?? '')
      const message = String(frame.error_message ?? frame.errorMessage ?? '')
      const detail = [code === '' ? '' : `error_code=${code}`, message].filter((s) => s !== '').join(' ')
      // 402 = 额度/认证失败（token 放错头的典型形态）；其余按通用上游错误
      throw new Error(`accio: ${code === '402' ? '额度或认证失败' : '上游返回错误帧'}（${detail}）`)
    }
    noteUsage(frame.usage_metadata ?? frame.usageMetadata)
    if (typeof frame.finish_reason === 'string' && frame.finish_reason !== '') finishReason = frame.finish_reason
    if (typeof frame.finishReason === 'string' && frame.finishReason !== '') finishReason = frame.finishReason
    const content = frame.content
    if (content !== null && typeof content === 'object' && Array.isArray(content.parts)) {
      for (const part of content.parts) yield* handlePart(part)
    }
    // ⚠️ 顶层 function_call（无 content 信封）是**实测的真实形状** —— 丢弃它
    // = 模型的工具调用凭空消失（「思考一下就中断」的根因之一）。
    const topCall = frame.function_call ?? frame.functionCall
    if (topCall !== null && typeof topCall === 'object') yield* handlePart({ function_call: topCall })
  }

  const emitCalls = function* () {
    let index = 0
    for (const [callId, state] of calls) {
      const args = mergeToolArgs(state.fragments)
      yield chunk({
        tool_calls: [{
          index: index++,
          id: callId,
          type: 'function',
          function: { name: state.name, arguments: args },
        }],
      })
    }
  }

  const finalize = function* () {
    yield* emitCalls()
    const finish = finishOf(finishReason)
    yield chunk({}, finish)
    if (Object.keys(usage).length > 0) {
      const completion = usage.completion_tokens ?? 0
      const prompt = usage.prompt_tokens ?? 0
      const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: usage.total_tokens ?? prompt + completion,
      }
      if (usage.reasoning_tokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens }
      yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: out })}\n\n`
    }
    yield 'data: [DONE]\n\n'
  }

  const processLine = function* (rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let frame
    try { frame = JSON.parse(payload) } catch { return }
    yield* handleFrame(frame)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // ⚠️ 上游流以终帧收尾、**没有 [DONE]**；flush 解码器并把余量按整行走一遍
        buffer += decoder.decode()
        if (buffer !== '') {
          for (const line of buffer.split('\n')) yield* processLine(line)
        }
        break
      }
      const piece = decoder.decode(value, { stream: true })
      buffer += piece
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* processLine(line)
      if (signal?.aborted === true) break
    }
  } finally {
    await reader.cancel?.().catch(() => {})
    reader.releaseLock?.()
  }

  if (!sawAny) {
    throw new Error('accio: 模型未返回任何内容块')
  }
  yield* finalize()
}

// ── chat ────────────────────────────────────────────────────────────────

function sseResponse(generator) {
  const encoder = new TextEncoder()
  const iterator = generator[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** HTTP 错误体的可读 detail（逐字保留服务端原文）。 */
function errorDetail(body) {
  try {
    const data = JSON.parse(body)
    const parts = [
      data.error_code !== undefined ? `error_code=${String(data.error_code)}` : undefined,
      typeof data.error_message === 'string' ? data.error_message : undefined,
      data.code !== undefined ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((v) => v !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch { /* 非 JSON：原样 */ }
  return body
}

/**
 * 发一次对话。⚠️ token 在 **body**（放 Authorization 头恒流内 402 —— 本渠道
 * 最经典的坑）；401/403 先续期一次再重发（body.token 必须换成新值）。
 */
async function chat(credential, { body: openaiBody, signal, renew }) {
  const slug = String(openaiBody?.model ?? '')
  const wireModel = codeOf(slug, credential)
  const { contents, systemInstruction } = serializeMessages(Array.isArray(openaiBody?.messages) ? openaiBody.messages : [])
  const tools = toAccioTools(Array.isArray(openaiBody?.tools) ? openaiBody.tools : [])
  const requestedMax = Number(openaiBody?.max_tokens)
  const maxOutputTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0
    ? requestedMax
    : 8192
  const stop = Array.isArray(openaiBody?.stop)
    ? openaiBody.stop.filter((s) => typeof s === 'string' && s !== '')
    : (typeof openaiBody?.stop === 'string' && openaiBody.stop !== '' ? [openaiBody.stop] : [])

  const requestId = requestIdOf()
  const payload = buildBody({
    model: wireModel,
    accessToken: credential.access_token,
    contents,
    systemInstruction,
    tools,
    temperature: typeof openaiBody?.temperature === 'number' ? openaiBody.temperature : undefined,
    maxOutputTokens,
    requestId,
  })
  if (systemInstruction !== '') payload.system_instruction = systemInstruction
  else delete payload.system_instruction
  if (stop.length > 0) payload.stop_sequences = stop

  const send = (cred) => fetchWithRetry(
    () => fetch(`${GATEWAY}${LLM_PATH}?sg_k=${sgKOf(requestId)}`, {
      method: 'POST',
      headers: accioHeaders(cred),
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    signal,
  )

  let response = await send(credential)
  // HTTP 401/403：凭据可能被服务端提前撤销而本地 expires_at 未到 —— 续期一次重发。
  // ⚠️ token 在 body 里，重发前必须把新 token 写回（applyAccessToken 同位）。
  if ((response.status === 401 || response.status === 403) && typeof renew === 'function') {
    let renewed
    try {
      renewed = await renew(credential)
    } catch {
      renewed = undefined
    }
    if (renewed !== undefined && renewed.access_token !== credential.access_token) {
      payload.token = renewed.access_token
      response = await send(renewed)
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return Response.json(
      { error: { type: 'provider_error', message: `Accio 返回 HTTP ${response.status}：${errorDetail(text).slice(0, 300)}` } },
      { status: response.status >= 400 ? response.status : 502 },
    )
  }

  // ⚠️⚠️ 必须校验 content-type：**HTTP 200 也可能是一张风控拦截页**
  // （缺 utdid 时阿里网关回 200 + text/html，body 是 bixi-intl.alicdn.com/punish
  // 跳转脚本）。不校验会被 SSE 解析器吞掉，症状是「模型不回复」——
  // 真因是风控，排查方向完全错。判 content-type 比判 body 文本稳。
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    const peek = await response.text().catch(() => '')
    return Response.json(
      { error: { type: 'provider_error', message: `accio: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}` } },
      { status: 502 },
    )
  }

  if (payload.stream !== false && openaiBody?.stream !== false) {
    return sseResponse(accioSseToOpenAi(response.body, { model: slug, signal }))
  }
  // 非流式：聚合成一个 chat.completion（上游只有流式端点，这里做汇聚）
  const parts = []
  let finish = 'stop'
  let usage
  for await (const piece of accioSseToOpenAi(response.body, { model: slug, signal })) {
    if (!piece.startsWith('data: ') || piece === 'data: [DONE]\n\n') continue
    const chunk = JSON.parse(piece.slice(6))
    const delta = chunk.choices?.[0]?.delta
    if (typeof delta?.content === 'string') parts.push(delta.content)
    if (Array.isArray(delta?.tool_calls)) (parts.toolCalls ??= []).push(...delta.tool_calls)
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
    if (chunk.usage) usage = chunk.usage
  }
  const text = parts.filter((p) => typeof p === 'string').join('')
  const toolCalls = (parts.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    type: 'function',
    function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' },
  }))
  return Response.json({
    id: `chatcmpl-accio-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: slug,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    ...(usage !== undefined ? { usage } : {}),
  })
}

// ── 额度分桶（移植 accio-credits.ts）────────────────────────────────────

const SUBSCRIPTION_PATH = '/api/entitlement/currentSubscription'
const QUOTA_PATH = '/api/entitlement/quota'

/**
 * 三类桶的**固定顺序**与展示名。
 * ⚠️ 顺序固定（daily → monthly → referral）而不是按响应键序 —— 键序由服务端
 * 决定，同一账号两次读数可能不同，面板会「跳行」。
 * ⚠️ 值为 0 的桶**保留**（用户要看到「还有 0」）；缺席的桶不产出
 * （不是产出一条 0 —— 那会把「没有这个桶」说成「桶是空的」）。
 */
const CREDIT_BUCKETS = [
  { key: 'daily', label: '每日积分' },
  { key: 'monthly', label: '每月积分' },
  { key: 'referral', label: '推荐积分' },
]

/** 余额端点信封请求。⚠️ token 在 **query**（`?accessToken=…`，缺它 400）。 */
async function entitlementGet(path, credential) {
  // 商户空间：额度接口必须带 `?teamId=`（只带 x-team-id 头会 406，实测）。
  const url = `${GATEWAY}${path}?accessToken=${encodeURIComponent(credential.access_token)}${teamQueryOf(credential)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...siteHeadersOf(credential),
      ...teamHeadersOf(credential),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`accio 余额查询响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 150)}`)
  }
  // ⚠️ 未登录的实测形态是 HTTP 200 + body {success:false, code:'401', message:'NOT_LOGIN'}，
  // 只看 HTTP 状态码会漏判；code 必须按标量归一（官方客户端 String(e.code)==='401'，
  // 说明它可能不是字符串）。
  const code = String(payload?.code ?? '')
  if (!response.ok || payload?.success === false) {
    if (code === '401' || /NOT_LOGIN/i.test(String(payload?.message ?? ''))) {
      const error = new Error('未登录或登录已过期（NOT_LOGIN），请重新登录 Accio 账号')
      error.signedOut = true
      throw error
    }
    throw new Error(`accio 余额查询失败（HTTP ${response.status} ${String(payload?.message ?? payload?.error ?? '')}）`.trim())
  }
  return payload?.data
}

/**
 * 额度分桶 → magpie usage windows。
 *
 * 桶行：`{ name: 'Accio · 每日积分', used: 百分比, resetsAt?, display: '剩余 N' }`。
 * `resetsAt` 只有 daily 桶有（quota 端点的 `refreshCountdownSeconds` 现算）——
 * ⚠️ 它是「额度何时**刷新**」，不是「积分何时**作废**」（Accio 未下发作废时间，
 * 未实测为同一时刻就不写 —— 写了就是编造）。
 */
async function usage(credential, displayName = DISPLAY_NAME) {
  const data = await entitlementGet(SUBSCRIPTION_PATH, credential)
  const entitlement = typeof data?.entitlement === 'object' && data.entitlement !== null
    ? data.entitlement
    : undefined
  // 空间名只加在**商户空间**的桶名上：个人空间的桶名保持原样（用户与既有
  // 习惯都按「Accio · 每日积分」读），商户空间则必须能分辨 —— 否则同一个人
  // 的个人槽与商户槽在卡片上是两套一模一样的桶名。
  const space = typeof credential?.team_id === 'string' && credential.team_id !== ''
    ? ` · ${spaceLabelOf(credential)}`
    : ''
  const windows = []
  if (entitlement === undefined) {
    // 服务端给了响应但既无桶也无总余额：明说，不退化成 0
    if (typeof data?.remaining !== 'number') {
      return [{ name: `${displayName}${space}`, used: 0, display: '响应未包含余额字段' }]
    }
    return [{ name: `${displayName}${space}`, used: 0, display: `剩余 ${data.remaining}` }]
  }
  // quota 端点失败可容忍（只影响 daily 的刷新时刻）
  let dailyResetIso
  try {
    const quota = await entitlementGet(QUOTA_PATH, credential)
    const seconds = Number(quota?.refreshCountdownSeconds)
    if (Number.isFinite(seconds) && seconds > 0) {
      dailyResetIso = new Date(Date.now() + seconds * 1000).toISOString()
    }
  } catch { /* 倒计时缺席就留空 */ }
  for (const bucket of CREDIT_BUCKETS) {
    const value = entitlement[bucket.key]
    if (typeof value !== 'object' || value === null) continue
    const remaining = Number(value.remaining)
    if (!Number.isFinite(remaining)) continue // 桶在但读不到 remaining = 数据不足，跳过
    const used = Number(value.used)
    const total = Number(value.total)
    const percent = Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round(((Number.isFinite(used) ? used : total - remaining) / total) * 100)))
      : (remaining <= 0 ? 100 : 0)
    windows.push({
      name: `Accio${space} · ${bucket.label}`,
      used: percent,
      ...(bucket.key === 'daily' && dailyResetIso !== undefined ? { resetsAt: dailyResetIso } : {}),
      // 剩 0 的桶收进折叠区（aside）：主环位留给有值的桶（与 astudio 同口径）
      ...(remaining <= 0 ? { aside: true } : {}),
      display: `剩余 ${remaining}`,
    })
  }
  return windows.length > 0 ? windows : [{ name: `${displayName}${space}`, used: 0, display: '已登录' }]
}

// ── 渠道对象 ────────────────────────────────────────────────────────────

const modelsOf = (table) => Object.fromEntries(table.map((m) => [slugOf(m.name) || m.id, {
  name: m.multiple !== undefined ? `${m.name} · x${m.multiple}` : m.name,
  limit: { context: m.contextWindow, output: 8_192 },
  tool_call: true,
}]))

/**
 * 造一条渠道。
 *
 * 国内版与国际版是**同一份协议**、两条独立供应商（各自登录、各自开关、
 * 各自额度），差别只在 `region` —— 它决定登录站点、`x-package-region` 头，
 * 以及目录/映射表。区域也随凭据走，所以续期、空间切换都不会串。
 */
function makeChannel({ id, displayName, site, fallbackTable }) {
  return {
    id,
    displayName,
    site,
    fallbackModels: modelsOf(fallbackTable),
    beginLogin: (openBrowser) => beginLogin({ site, openBrowser }),
    refresh: refreshCredential,
    expired,
    catalog,
    chat,
    /** 额度分桶（聚合层 usage 分发到这里）。 */
    usage: (credential) => usage(credential, displayName),
    /** 空间（个人/商户）列表与标签 —— 聚合层据此渲染切换入口。 */
    listTeams,
    spaceLabelOf,
  }
}

export const accioChannel = makeChannel({
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  site: SITE_CN,
  fallbackTable: FALLBACK_MODELS,
})

export const accioGlobalChannel = makeChannel({
  id: 'accio-global',
  displayName: 'Accio 国际版',
  site: SITE_GLOBAL,
  fallbackTable: FALLBACK_MODELS_GLOBAL,
})
