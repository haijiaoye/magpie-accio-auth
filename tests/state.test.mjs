import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { resetUtdidCache, stateDir, utdidOf, utdidPath } from '../src/state.mjs'

const CHILD = join(import.meta.dirname, 'utdid-child.mjs')

let dir

const spawnUtdid = () =>
  execFileSync(process.execPath, [CHILD], {
    encoding: 'utf8',
    env: { ...process.env, MAGPIE_ACCIO_STATE_DIR: dir, MAGPIE_ACCIO_UTDID: '' },
  }).trim()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magpie-accio-state-'))
  process.env.MAGPIE_ACCIO_STATE_DIR = dir
  delete process.env.MAGPIE_ACCIO_UTDID
  resetUtdidCache()
})

afterEach(() => {
  resetUtdidCache()
  delete process.env.MAGPIE_ACCIO_STATE_DIR
  delete process.env.MAGPIE_ACCIO_UTDID
  rmSync(dir, { recursive: true, force: true })
})

test('utdid 落盘一次后长期复用（模拟 magpie 重启）', () => {
  const first = utdidOf()
  assert.match(first, /^accio-[A-Za-z0-9_-]+$/)
  assert.equal(readFileSync(utdidPath(), 'utf8').trim(), first)

  // 新进程 = 进程内缓存清空：必须读回同一个指纹，而不是重新生成
  resetUtdidCache()
  assert.equal(utdidOf(), first)
})

test('MAGPIE_ACCIO_UTDID 指定指纹时照它走，且不写状态文件', () => {
  process.env.MAGPIE_ACCIO_UTDID = 'accio-fixed-fingerprint-1'
  assert.equal(utdidOf(), 'accio-fixed-fingerprint-1')
  assert.throws(() => readFileSync(utdidPath(), 'utf8'))
})

test('状态文件被写坏时自动重建，之后继续复用', () => {
  const first = utdidOf()
  writeFileSync(utdidPath(), '   \n', 'utf8')
  resetUtdidCache()
  const second = utdidOf()
  assert.notEqual(second, first)
  assert.match(second, /^accio-/)
  resetUtdidCache()
  assert.equal(utdidOf(), second)
})

test('状态目录可整体搬走（MAGPIE_ACCIO_STATE_DIR）', () => {
  const moved = mkdtempSync(join(tmpdir(), 'magpie-accio-other-'))
  try {
    process.env.MAGPIE_ACCIO_STATE_DIR = moved
    resetUtdidCache()
    const first = utdidOf()
    assert.equal(stateDir(), moved)
    assert.equal(readFileSync(join(moved, 'utdid'), 'utf8').trim(), first)
  } finally {
    rmSync(moved, { recursive: true, force: true })
  }
})

test('并发进程收敛到同一个 utdid（hard link 原子发布）', () => {
  const results = Array.from({ length: 4 }, spawnUtdid)
  assert.equal(new Set(results).size, 1, `每个进程应拿到同一个指纹：${results.join(' | ')}`)
  assert.match(results[0], /^accio-/)
  assert.equal(readFileSync(utdidPath(), 'utf8').trim(), results[0])
})
