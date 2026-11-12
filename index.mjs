// Accio（阿里 Accio Work）—— magpie / OpenCode 独立供应商插件。
//
// **一个插件，两条供应商**：
//   · `accio`        —— Accio 国内版（www.accio-ai.com）
//   · `accio-global` —— Accio 国际版（www.accio.com）
// 两者共用同一套网关与账号体系，只有登录站点与 `x-package-region` 头不同，
// 但**模型目录不同**（国际版有 Claude / GPT / Gemini，国内版有 GLM / DeepSeek /
// Kimi），所以拆成两条独立供应商：各自登录、各自开关、各自额度。
//
// ## 商户空间（team）
//
// Accio 的「商户空间」在接口层就是 **team**：`POST /api/team/queryUserTeams`
// 取列表，之后所有网关请求带 `x-team-id` 头，额度类端点还要 `?teamId=`。
// 空间选择是**账号级**属性，存进 magpie 的账号槽（`team_id` / `team_name`），
// 续期时原样保留 —— 否则每次续期都会静默退回个人空间。
//
// ## 为什么能读账号槽
//
// magpie 给插件的 `client.auth` 只有 set/remove，没有 get。切换空间需要
// **当前账号的 token**，所以这里以**只读**方式读取 magpie 自己的
// `plugin-auth.json`（只取本供应商的槽，且绝不写入该文件 —— 写入一律走
// `client.auth.set`，那是 magpie 的地盘）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  accioChannel,
  accioGlobalChannel,
  refreshCredential,
  isTerminalRefreshError,
  spaceLabelOf,
  SITE_CN,
  SITE_GLOBAL,
} from './src/accio.mjs'
import { debugLog } from './src/transport.mjs'

export const PROVIDER = 'accio'
export const PROVIDER_GLOBAL = 'accio-global'
const REFRESH_LEAD_MS = 10 * 60 * 1000
/** 旧的多渠道插件里的 Accio 槽 —— 一次性导入用。 */
const LEGACY_KEY = 'hub-accio'

// ── magpie 账号槽（只读）────────────────────────────────────────────────

const authPath = () => process.env.MAGPIE_AUTH_PATH
  ?? join(process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), '.config', 'magpie'), 'plugin-auth.json')

/** 本供应商的全部账号槽：`{key, auth}`（只读；不含别人的槽）。 */
function readSlots(provider = PROVIDER) {
  let all
  try {
    all = JSON.parse(readFileSync(authPath(), 'utf8'))
  } catch {
    return []
  }
  if (all === null || typeof all !== 'object') return []
  const out = []
  for (const [key, auth] of Object.entries(all)) {
    if (auth === null || typeof auth !== 'object') continue
    if (key !== provider && !key.startsWith(`${provider}#`)) continue
    out.push({ key, auth })
  }
  return out.sort((a, b) => (a.key === provider ? -1 : b.key === provider ? 1 : a.key < b.key ? -1 : 1))
}

/** 主槽（`accio` 优先，否则第一个）。 */
function primarySlot(provider = PROVIDER) {
  return readSlots(provider)[0]
}

/** 旧插件（hub-accio）的槽 —— 只在导入时读一次。 */
function legacySlot() {
  let all
  try {
    all = JSON.parse(readFileSync(authPath(), 'utf8'))
  } catch {
    return undefined
  }
  const auth = all?.[LEGACY_KEY]
  return auth !== null && typeof auth === 'object' ? auth : undefined
}

// ── 凭据形状 ────────────────────────────────────────────────────────────

/**
 * magpie 的 oauth auth → 渠道凭据。
 *
 * magpie 存 `{type:'oauth', access, refresh, expires}`；渠道用
 * `{access_token, refresh_token, expires_at}`。两套都要认：旧槽里可能
 * 是渠道形状（hub 写的就是这一套）。
 */
function credentialOf(auth) {
  if (auth === null || typeof auth !== 'object') return undefined
  const access = typeof auth.access_token === 'string' && auth.access_token !== ''
    ? auth.access_token
    : typeof auth.access === 'string' ? auth.access : ''
  const refresh = typeof auth.refresh_token === 'string' && auth.refresh_token !== ''
    ? auth.refresh_token
    : typeof auth.refresh === 'string' ? auth.refresh : ''
  const expires = Number.isFinite(Number(auth.expires_at)) ? Number(auth.expires_at)
    : Number.isFinite(Number(auth.expires)) ? Number(auth.expires) : undefined
  if (access === '') return undefined
  return {
    access_token: access,
    ...(refresh === '' ? {} : { refresh_token: refresh }),
    ...(expires === undefined ? {} : { expires_at: expires }),
    ...(typeof auth.sgcookie === 'string' && auth.sgcookie !== '' ? { sgcookie: auth.sgcookie } : {}),
    ...(typeof auth.region === 'string' && auth.region !== '' ? { region: auth.region } : {}),
    ...(typeof auth.team_id === 'string' && auth.team_id !== '' ? { team_id: auth.team_id } : {}),
    ...(typeof auth.team_name === 'string' && auth.team_name !== '' ? { team_name: auth.team_name } : {}),
  }
}

/**
 * 渠道凭据 → 要交给 magpie 保存的 auth（oauth 形状 + 本插件附加字段）。
 *
 * `region` 由调用方按**供应商**传入并覆盖凭据里的值 —— 国际版复用国内版登录时，
 * 源凭据带的是 `cn`，照抄会让国际版槽永久记住错误的区域。
 */
function authOf(credential, channel, extra = {}, region) {
  return {
    type: 'oauth',
    channel,
    access: credential.access_token,
    ...(typeof credential.refresh_token === 'string' && credential.refresh_token !== ''
      ? { refresh: credential.refresh_token }
      : {}),
    ...(Number.isFinite(credential.expires_at) ? { expires: credential.expires_at } : {}),
    ...(typeof credential.sgcookie === 'string' && credential.sgcookie !== '' ? { sgcookie: credential.sgcookie } : {}),
    ...(typeof region === 'string' && region !== '' ? { region } : {}),
    ...(typeof credential.team_id === 'string' && credential.team_id !== '' ? { team_id: credential.team_id } : {}),
    ...(typeof credential.team_name === 'string' && credential.team_name !== '' ? { team_name: credential.team_name } : {}),
    ...extra,
  }
}

// ── 续期去重 ────────────────────────────────────────────────────────────
//
// ⚠️ Accio 的 refresh_token **用一次就轮换**：同一账号并发续期会「一个成功、
//    其余 invalid_grant」，失败方可能把好账号标死。同一凭据的并发请求共享
//    同一个在途续期。

const renewing = new Map()

function gatedRenew(credential) {
  const key = `${credential.access_token}:${credential.refresh_token ?? ''}`
  const inFlight = renewing.get(key)
  if (inFlight !== undefined) return inFlight
  const run = refreshCredential(credential).finally(() => renewing.delete(key))
  renewing.set(key, run)
  return run
}

// ── 模型目录 ────────────────────────────────────────────────────────────

async function catalogOf(channel, credential) {
  try {
    const models = await channel.catalog(credential)
    if (models !== null && typeof models === 'object' && Object.keys(models).length > 0) return models
  } catch (error) {
    debugLog(`catalog failed: ${error?.message ?? error}`)
  }
  return channel.fallbackModels
}

/** 请求体里的模型名可能是 `accio/kimi-k2-6` 或裸 `kimi-k2-6`。 */
const stripProvider = (model, provider = PROVIDER) => {
  const s = String(model ?? '').trim()
  const prefix = `${provider}/`
  return s.startsWith(prefix) ? s.slice(prefix.length) : s
}

// ── 空间切换 ────────────────────────────────────────────────────────────

const spaceOf = (auth) => (typeof auth?.team_id === 'string' && auth.team_id !== ''
  ? `商户空间 ${typeof auth.team_name === 'string' && auth.team_name !== '' ? auth.team_name : auth.team_id}`
  : '个人空间')

/**
 * 「切换空间」入口。
 *
 * 借 magpie 的 api 型登录方式做一个**无 Key 的一键入口**：
 *   - `keyless: true` → 不弹输入框；
 *   - `ask(inputs)` → 动态返回空间列表（上游数据，静态 prompts 表达不了）；
 *   - `authorize()` → 返回 oauth 形状的 success，magpie 按 `accountId` 去重，
 *     原地更新同一个账号槽，不会多出一个账号。
 */
function buildSpaceMethod({ channel, provider, displayName, spaceLabel, authSet, toast }) {
  /** 区域以供应商为准（见 makePlugin 里 credentialFor 的同款说明）。 */
  const withSite = (credential) => (credential === undefined ? undefined : { ...credential, region: channel.site })
  return {
    type: 'api',
    keyless: true,
    label: spaceLabel,
    labels: {
      zh: spaceLabel,
      en: `Switch ${displayName} space (personal / business)`,
    },
    async ask(inputs) {
      if (inputs?.team !== undefined) return null
      const slot = primarySlot(provider)
      if (slot === undefined) return null
      const credential = withSite(credentialOf(slot.auth))
      if (credential === undefined) return null
      let teams
      try {
        teams = await channel.listTeams(credential)
      } catch (error) {
        return {
          type: 'select',
          key: 'team',
          message: `读取 ${displayName} 空间列表失败：${error instanceof Error ? error.message : String(error)}`,
          options: [{ label: '重试', value: '' }],
        }
      }
      const options = [{
        label: `个人空间（当前：${spaceOf(slot.auth)}）`,
        value: 'personal',
        hint: `使用 ${displayName} 个人账号的额度`,
      }]
      for (const team of teams) {
        options.push({
          label: `商户空间 · ${team.name}`,
          value: team.teamId,
          hint: [team.role, team.planId === '' ? '' : `plan ${team.planId}`].filter((s) => s !== '').join(' · '),
        })
      }
      return {
        type: 'select',
        key: 'team',
        message: teams.length === 0
          ? `这个 ${displayName} 账号没有加入任何商户空间`
          : '选择要使用的 Accio 空间（切换后额度与模型目录都按该空间）',
        options,
      }
    },
    async authorize(inputs) {
      const slot = primarySlot(provider)
      if (slot === undefined) {
        return { type: 'failed', error: `请先登录 ${displayName} 账号，再切换空间` }
      }
      const pick = String(inputs?.team ?? '').trim()
      if (pick === '') return { type: 'failed', error: '没有选择空间' }

      const stored = slot.auth
      let credential = withSite(credentialOf(stored))
      if (credential === undefined) {
        return { type: 'failed', error: `账号槽里没有 access token，请重新登录 ${displayName}` }
      }
      // 槽里的 token 可能已过期（切换时没有请求替它续期）：先续一次。
      if (channel.expired(credential) && typeof credential.refresh_token === 'string') {
        try {
          credential = await gatedRenew(credential)
        } catch (error) {
          return {
            type: 'failed',
            error: `续期失败：${error instanceof Error ? error.message : String(error)}。请重新登录 ${displayName}`,
          }
        }
      }

      let teamId = ''
      let teamName = ''
      if (pick !== 'personal') {
        let teams
        try {
          teams = await channel.listTeams(credential)
        } catch (error) {
          return { type: 'failed', error: `读取空间列表失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const hit = teams.find((team) => team.teamId === pick)
        if (hit === undefined) return { type: 'failed', error: `空间 ${pick} 不在当前账号下` }
        teamId = hit.teamId
        teamName = hit.name
      }

      const next = {
        ...authOf(credential, channel.id, {}, channel.site),
        ...(teamId === '' ? {} : { team_id: teamId, team_name: teamName }),
        // accountId 必须与原来一致：magpie 按它去重写回同一个槽。
        accountId: typeof stored.accountId === 'string' && stored.accountId !== ''
          ? stored.accountId
          : displayName,
      }
      if (teamId === '') {
        // 显式切回个人空间：字段必须真的删掉，不能留旧值。
        delete next.team_id
        delete next.team_name
      }
      toast(`${displayName}：已切换到${teamId === '' ? '个人空间' : `商户空间 ${teamName}`}`)
      // ⚠️ `type` 必须在最后：authOf() 带的是 `type: 'oauth'`（账号槽形状），
      //    而 magpie 的登录结果要 `type: 'success'` —— 顺序反了会把结果判成失败。
      return { ...next, type: 'success' }
    },
  }
}

// ── 插件 ────────────────────────────────────────────────────────────────

/**
 * 造一条供应商插件。
 *
 * ⚠️ 入口模块里**每个函数导出都是一条供应商**，所以下面只导出两个
 *    `makePlugin()` 的成品，别把工厂本身导出。
 */
function makePlugin({
  provider,
  displayName,
  channel,
  importLegacy,
  seedFrom,
  spaceLabel = `切换 ${displayName} 空间（个人 / 商户）`,
}) {
  const BASE_URL = `https://${provider}.invalid`
  const stripOwn = (model) => stripProvider(model, provider)

  return async (input = {}) => {
  const authSet = typeof input?.client?.auth?.set === 'function' ? input.client.auth.set : undefined
  const toast = (message, variant = 'info') => {
    try { void input?.client?.tui?.showToast?.({ body: { message, variant } }) } catch { /* 忽略 */ }
    try { void input?.client?.app?.log?.({ level: 'info', message }) } catch { /* 忽略 */ }
  }

    // 旧的多渠道插件（magpie-providers-hub）里的 Accio 登录：本供应商还没有账号
    // 时一次性搬过来，用户不必重新登录。只在**没有**本供应商槽时动，幂等。
    if (importLegacy) {
      try {
        if (readSlots(provider).length === 0) {
          const legacy = legacySlot()
          if (legacy !== undefined) {
            const credential = credentialOf(legacy)
            if (credential !== undefined) {
              await authSet?.({
                path: { id: provider },
                body: authOf(credential, channel.id, {
                  accountId: typeof legacy.accountId === 'string' && legacy.accountId !== ''
                    ? legacy.accountId
                    : displayName,
              }, channel.site),
              })
              toast(`${displayName}：已从 Providers Hub 导入登录`)
            }
          }
        }
      } catch (error) {
        debugLog(`legacy import failed: ${error?.message ?? error}`)
      }
    }

    // 国内版与国际版是**同一个 Accio 账号**（同一网关、同一套 token），只是
    // 请求头与模型目录不同。所以国际版还没有账号时直接复用国内版的登录态 ——
    // 让用户为同一个账号登录两次没有意义。
    if (seedFrom !== undefined) {
      try {
        if (readSlots(provider).length === 0) {
          const source = primarySlot(seedFrom)
          const credential = source === undefined ? undefined : credentialOf(source.auth)
          if (credential !== undefined) {
            await authSet?.({
              path: { id: provider },
              body: authOf(credential, channel.id, {
                accountId: typeof source.auth.accountId === 'string' && source.auth.accountId !== ''
                  ? source.auth.accountId
                  : displayName,
              }, channel.site),
            })
            toast(`${displayName}：已复用 ${seedFrom} 的登录`)
          }
        }
      } catch (error) {
        debugLog(`seed from ${seedFrom} failed: ${error?.message ?? error}`)
      }
    }

    /** 取当前账号的凭据（magpie 已按账号作用域传入）。 */
    const credentialFor = async (getAuth) => {
      let auth
      try {
        auth = await getAuth?.()
      } catch {
        auth = undefined
      }
      let credential = credentialOf(auth)
      if (credential === undefined) {
        const slot = primarySlot(provider)
        credential = slot === undefined ? undefined : credentialOf(slot.auth)
      }
      // ⚠️ 区域由**供应商**决定，不信账号槽里的值：国际版是从国内版复用的
      //    登录态，槽里可能还带着 `region: 'cn'` —— 照抄就会去拉国内目录。
      return credential === undefined ? undefined : { ...credential, region: channel.site }
    }

    const signedOut = (message) => Object.assign(new Error(message), { signIn: 'expired' })

    return {
      async config(cfg) {
        cfg.provider ??= {}
        cfg.provider[provider] ??= {
          name: displayName,
          npm: '@ai-sdk/openai-compatible',
          api: BASE_URL,
          models: {},
        }
      },

      auth: {
        provider,
        refreshLead: REFRESH_LEAD_MS,

        methods: [
          {
            type: 'oauth',
            label: `登录 ${displayName}`,
            async authorize() {
              // 不自己开浏览器：把 URL 交给 magpie（`opened` 不设 true），
              // 它会在用户的默认浏览器里打开，与其它插件一致。
              const started = await channel.beginLogin()
              return {
                url: started.url,
                method: 'auto',
                instructions: started.instructions,
                async callback() {
                  const credential = await started.result
                  const auth = authOf(credential, channel.id, {
                    accountId: displayName,
                  }, channel.site)
                  toast(`${displayName}：登录成功`)
                  // `type` 放最后：authOf() 带账号槽的 `type: 'oauth'`。
                  return { ...auth, type: 'success' }
                },
              }
            },
          },
          buildSpaceMethod({ channel, provider, displayName, spaceLabel, authSet, toast }),
        ],

      async refresh(auth) {
        const credential = credentialOf(auth)
        if (credential === undefined) return undefined
        try {
          const next = await gatedRenew(credential)
          return authOf(next, channel.id, {
            accountId: typeof auth?.accountId === 'string' && auth.accountId !== '' ? auth.accountId : displayName,
          }, channel.site)
        } catch (error) {
          if (isTerminalRefreshError(error)) throw signedOut(String(error?.message ?? error))
          throw error
        }
      },

      async loader(getAuth) {
        return {
          // ⚠️ baseURL 不能是空串：magpie 会据此判「无处可发」；真正上游在 fetch 里改写。
          baseURL: BASE_URL,
          apiKey: provider,
          async fetch(request, init) {
            let body
            try {
              body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
            } catch {
              body = undefined
            }
            const model = stripOwn(body?.model)
            if (model === '') {
              return Response.json(
                { error: { type: 'invalid_request_error', message: `无法识别的模型：${body?.model ?? '(空)'}` } },
                { status: 404 },
              )
            }
            const credential = await credentialFor(getAuth)
            if (credential === undefined) {
              return Response.json(
                { error: { type: 'authentication_error', message: `未登录 ${displayName}，请先在供应商页登录` } },
                { status: 401 },
              )
            }
            try {
              return await channel.chat(credential, {
                body: { ...body, model },
                signal: init?.signal,
                renew: (current) => gatedRenew(current),
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return Response.json(
                { error: { type: 'provider_error', message } },
                { status: 502 },
              )
            }
          },
        }
      },

      async usage(getAuth) {
        const credential = await credentialFor(getAuth)
        if (credential === undefined) {
          return {
            plan: displayName,
            windows: [{ name: displayName, used: 0, display: `未登录（${provider}）` }],
          }
        }
        try {
          const windows = await channel.usage(credential)
          return { plan: `${displayName} · ${spaceLabelOf(credential)}`, windows }
        } catch (error) {
          return {
            plan: displayName,
            windows: [{
              name: displayName,
              used: 0,
              display: `额度查询失败：${error instanceof Error ? error.message : String(error)}`,
            }],
          }
        }
      },
    },

      provider: {
        id: provider,
        /**
         * ⚠️ 第二参是 magpie 给的上下文（`{ auth }`）：凭据只在内存/账号槽，
         *    冷启动时用 `auth` 才能拉到当前空间的远端目录。
         */
        async models(prov, ctx = {}) {
          const auth = ctx?.auth
          const raw = credentialOf(auth) ?? credentialOf(primarySlot(provider)?.auth)
          // 区域按供应商归一（同 credentialFor：国际版可能复用了国内登录态）。
          const credential = raw === undefined ? undefined : { ...raw, region: channel.site }
          if (credential === undefined) {
            // ⚠️ 空对象也是「有值」：`prov.models ?? fallback` 会在宿主传 `{}` 时
            //    返回空目录，选择器整个空掉。必须按键数判。
            const known = prov?.models
            return known !== null && typeof known === 'object' && Object.keys(known).length > 0
              ? known
              : channel.fallbackModels
          }
          return catalogOf(channel, credential)
        },
      },
    }
  }
}

/** Accio 国内版（www.accio-ai.com）。 */
export const AccioPlugin = makePlugin({
  provider: PROVIDER,
  displayName: 'Accio (阿里)',
  channel: accioChannel,
  importLegacy: true,
  spaceLabel: '切换 Accio 空间（个人 / 商户）',
})

/** Accio 国际版（www.accio.com）—— Claude / GPT / Gemini 等模型。 */
export const AccioGlobalPlugin = makePlugin({
  provider: PROVIDER_GLOBAL,
  displayName: 'Accio 国际版',
  channel: accioGlobalChannel,
  importLegacy: false,
  seedFrom: PROVIDER,
})

export default AccioPlugin
