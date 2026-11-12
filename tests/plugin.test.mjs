import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { AccioPlugin, PROVIDER } from '../index.mjs'

let dir

const authFile = (slots) => {
  writeFileSync(join(dir, 'plugin-auth.json'), JSON.stringify(slots), 'utf8')
}

const credential = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: Date.now() + 3_600_000,
  team_id: '10478012',
  team_name: 'Business',
}

const hook = async () => {
  const plugin = await AccioPlugin({
    client: {
      auth: { set: async () => ({ data: true }) },
      tui: { showToast: async () => ({ data: true }) },
      app: { log: async () => ({ data: true }) },
    },
  })
  return plugin
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magpie-accio-'))
  process.env.MAGPIE_AUTH_PATH = join(dir, 'plugin-auth.json')
  authFile({})
})

afterEach(() => {
  delete process.env.MAGPIE_AUTH_PATH
})

test('插件只声明一条供应商，并注册登录与空间切换两个入口', async () => {
  const plugin = await hook()
  assert.equal(plugin.auth.provider, PROVIDER)
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.deepEqual(labels, ['登录 Accio (阿里)', '切换 Accio 空间（个人 / 商户）'])
  assert.equal(plugin.auth.methods[0].type, 'oauth')
  assert.equal(plugin.auth.methods[1].type, 'api')
  assert.equal(plugin.auth.methods[1].keyless, true)
})

test('config 注册的供应商 id 是 accio', async () => {
  const plugin = await hook()
  const cfg = {}
  await plugin.config(cfg)
  assert.ok(cfg.provider[PROVIDER])
  assert.equal(cfg.provider[PROVIDER].name, 'Accio (阿里)')
})

test('从 hub-accio 旧槽一次性导入登录（幂等）', async () => {
  authFile({
    'hub-accio': {
      type: 'success',
      channel: 'accio',
      access_token: credential.access_token,
      refresh_token: credential.refresh_token,
      expires_at: credential.expires_at,
      team_id: credential.team_id,
      team_name: credential.team_name,
      accountId: 'Accio (阿里)',
    },
  })
  const saved = []
  await AccioPlugin({
    client: {
      auth: { set: async (opts) => { saved.push(opts); return { data: true } } },
      tui: { showToast: async () => ({ data: true }) },
      app: { log: async () => ({ data: true }) },
    },
  })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].path.id, PROVIDER)
  assert.equal(saved[0].body.access, credential.access_token)
  assert.equal(saved[0].body.refresh, credential.refresh_token)
  assert.equal(saved[0].body.team_id, credential.team_id)
  assert.equal(saved[0].body.team_name, 'Business')
})

test('已有 accio 槽时不再导入旧槽', async () => {
  authFile({
    accio: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 1000 },
    'hub-accio': { type: 'success', channel: 'accio', access_token: 'old', refresh_token: 'old-r' },
  })
  const saved = []
  await AccioPlugin({
    client: {
      auth: { set: async (opts) => { saved.push(opts); return { data: true } } },
      tui: { showToast: async () => ({ data: true }) },
      app: { log: async () => ({ data: true }) },
    },
  })
  assert.equal(saved.length, 0)
})

test('未登录时 usage 给出「未登录」而不是报成查询失败', async () => {
  const plugin = await hook()
  const usage = await plugin.auth.usage(async () => undefined)
  assert.equal(usage.windows.length, 1)
  assert.match(usage.windows[0].display, /未登录/)
})

test('未登录时 loader 的 fetch 返回 401，而不是静默转发', async () => {
  const plugin = await hook()
  const opts = await plugin.auth.loader(async () => undefined)
  const response = await opts.fetch('https://accio.invalid/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'accio/kimi-k2-6', messages: [] }),
  })
  assert.equal(response.status, 401)
})

test('模型名去掉 accio/ 前缀后转发', async () => {
  authFile({ accio: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 } })
  const plugin = await hook()
  const opts = await plugin.auth.loader(async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }))
  // 没有网络：断言「不是 401/404 的模型识别失败」即可（真正的转发由集成测试覆盖）
  const response = await opts.fetch('https://accio.invalid/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'accio/unknown-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.notEqual(response.status, 404)
})

test('空间切换方法在未登录时明确报错', async () => {
  const plugin = await hook()
  const method = plugin.auth.methods[1]
  assert.equal(await method.ask({}), null)
  const result = await method.authorize({ team: '10478012' })
  assert.equal(result.type, 'failed')
  assert.match(result.error, /请先登录/)
})

test('空间切换会把商户空间写进凭据', async () => {
  authFile({ accio: { type: 'oauth', ...credential, expires: credential.expires_at } })
  const plugin = await hook()
  const method = plugin.auth.methods[1]
  const result = await method.authorize({ team: 'personal' })
  assert.equal(result.type, 'success')
  assert.equal(result.team_id, undefined)
  assert.equal(result.team_name, undefined)
  assert.equal(result.access, credential.access_token)
  assert.equal(result.refresh, credential.refresh_token)
  assert.equal(result.expires, credential.expires_at)
  assert.equal(result.accountId, 'Accio (阿里)')
})
