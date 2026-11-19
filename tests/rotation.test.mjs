import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { AccioGlobalPlugin, AccioPlugin } from '../index.mjs'
import { accioChannel, isGatewayDenial, refreshCredential } from '../src/accio.mjs'
import { renewOnce, tokenDigest } from '../src/renew-lock.mjs'

const realFetch = globalThis.fetch
let dir
let calls

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
})

const html = (status) => new Response('<html><!--rgv587_flag:sm--></html>', {
  status,
  headers: { 'content-type': 'TEXT/HTML ; charset=UTF-8' },
})

const refreshed = (index) => json({
  success: true,
  code: '200',
  data: { accessToken: `access-${index}`, refreshToken: `refresh-${index}`, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
})

const authFile = (slots) => writeFileSync(join(dir, 'plugin-auth.json'), JSON.stringify(slots), 'utf8')

const slot = (provider, refresh = 'refresh-0', access = 'access-0') => ({
  type: 'oauth',
  channel: provider,
  access,
  refresh,
  expires: Date.now() - 1_000,
  accountId: 'Accio (阿里)',
  team_id: '10478012',
  team_name: 'Business',
})

const pluginWith = async (factory, saved = []) => factory({
  client: {
    auth: { set: async (opts) => { saved.push(opts); return { data: true } } },
    tui: { showToast: async () => ({ data: true }) },
    app: { log: async () => ({ data: true }) },
  },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magpie-accio-rotation-'))
  process.env.MAGPIE_AUTH_PATH = join(dir, 'plugin-auth.json')
  process.env.MAGPIE_ACCIO_STATE_DIR = join(dir, 'state')
  process.env.MAGPIE_ACCIO_UTDID = 'accio-test-device-1'
  calls = []
  authFile({})
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.MAGPIE_AUTH_PATH
  delete process.env.MAGPIE_ACCIO_STATE_DIR
  delete process.env.MAGPIE_ACCIO_UTDID
  rmSync(dir, { recursive: true, force: true })
})

test('风控判定兼容大小写、空格和 charset', () => {
  assert.equal(isGatewayDenial(403, 'TEXT/HTML ; charset=UTF-8'), true)
  assert.equal(isGatewayDenial(401, 'application/xhtml+xml'), true)
  assert.equal(isGatewayDenial(403, 'application/json'), false)
  assert.equal(isGatewayDenial(200, 'text/html'), false)
})

test('403 + HTML 拦截页直接停下，不续期也不重试', async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return html(403)
  }
  let renewed = 0
  const response = await accioChannel.chat({ access_token: 'access-0', refresh_token: 'refresh-0' }, {
    body: { model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
    renew: async () => { renewed += 1; return { access_token: 'access-1' } },
  })
  const body = await response.json()
  assert.equal(response.status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
  assert.equal(renewed, 0)
  assert.equal(calls.length, 1)
})

test('续期接口返回 HTML 拦截页时，按风控处理而不是解析 JSON', async () => {
  globalThis.fetch = async () => html(403)
  await assert.rejects(
    refreshCredential({ access_token: 'access-0', refresh_token: 'refresh-0' }),
    (error) => error.code === 'PERMISSION_DENIED',
  )
})

test('续期响应缺 refreshToken 时保留旧值，避免把可用凭据丢掉', async () => {
  globalThis.fetch = async () => json({
    success: true,
    code: '200',
    data: { accessToken: 'access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  })
  const next = await refreshCredential({ access_token: 'access-0', refresh_token: 'refresh-0', team_id: '10478012' })
  assert.equal(next.access_token, 'access-1')
  assert.equal(next.refresh_token, 'refresh-0')
  assert.equal(next.team_id, '10478012')
})

test('同一个 refresh_token 并发续期只请求一次', async () => {
  let index = 0
  globalThis.fetch = async () => {
    index += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return refreshed(index)
  }
  authFile({ accio: slot('accio') })
  const plugin = await pluginWith(AccioPlugin)
  const results = await Promise.all(Array.from({ length: 5 }, () => plugin.auth.refresh(slot('accio'))))
  assert.equal(index, 1)
  assert.deepEqual(new Set(results.map((item) => item.refresh)), new Set(['refresh-1']))
})

test('另一个进程刚续过时，复用它的新凭据而不是再次消费旧 token', async () => {
  globalThis.fetch = async () => refreshed(1)
  const child = join(dir, 'renew-child.mjs')
  writeFileSync(child, [
    `import { renewOnce } from ${JSON.stringify(new URL('../src/renew-lock.mjs', import.meta.url).href)}`,
    'const next = await renewOnce({ access_token: "access-0", refresh_token: "refresh-0" }, async () => ({',
    '  access_token: "access-child", refresh_token: "refresh-child", expires_at: Date.now() + 3600000 }))',
    'process.stdout.write(next.refresh_token)',
  ].join('\n'))
  const output = execFileSync(process.execPath, [child], { encoding: 'utf8', env: process.env })
  assert.equal(output, 'refresh-child')

  let requests = 0
  const next = await renewOnce({ access_token: 'access-0', refresh_token: 'refresh-0' }, async () => {
    requests += 1
    return { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: Date.now() + 3600000 }
  })
  assert.equal(requests, 0)
  assert.equal(next.refresh_token, 'refresh-child')
  const record = readFileSync(join(dir, 'state', 'renew', `${tokenDigest('refresh-0')}.json`), 'utf8')
  assert.ok(!record.includes('refresh-0'))
})

test('国内版续期后，把新 token 同步给持有同一旧 token 的国际版', async () => {
  globalThis.fetch = async () => refreshed(1)
  authFile({ accio: slot('accio'), 'accio-global': slot('accio-global') })
  const saved = []
  const plugin = await pluginWith(AccioPlugin, saved)
  const next = await plugin.auth.refresh(slot('accio'))
  assert.equal(next.refresh, 'refresh-1')
  const synced = saved.find((item) => item.path.id === 'accio-global')
  assert.equal(synced.body.refresh, 'refresh-1')
  assert.equal(synced.body.access, 'access-1')
  assert.equal(synced.body.team_id, '10478012')
})

test('不会覆盖另一个槽里的不同账号', async () => {
  globalThis.fetch = async () => refreshed(1)
  authFile({ accio: slot('accio'), 'accio-global': slot('accio-global', 'other-refresh', 'other-access') })
  const saved = []
  const plugin = await pluginWith(AccioPlugin, saved)
  await plugin.auth.refresh(slot('accio'))
  assert.equal(saved.some((item) => item.path.id === 'accio-global'), false)
})

test('自己的旧 token 已被消费时，接管兄弟槽里同账号的新凭据', async () => {
  globalThis.fetch = async () => json({ success: false, code: '401', message: 'invalid_grant' }, 401)
  authFile({
    accio: { ...slot('accio', 'refresh-1', 'access-1'), expires: Date.now() + 3_600_000 },
    'accio-global': slot('accio-global'),
  })
  const plugin = await pluginWith(AccioGlobalPlugin)
  const next = await plugin.auth.refresh(slot('accio-global'))
  assert.equal(next.refresh, 'refresh-1')
  assert.equal(next.access, 'access-1')
  assert.equal(next.region, 'global')
})
