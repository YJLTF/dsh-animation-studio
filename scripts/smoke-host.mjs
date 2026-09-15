/**
 * 宿主挂载冒烟：加载 lib/index.js（与 dsh plugin add 装进去的产物一致），
 * 在真实 cordis Context + 真实 @deepseek-ai/dsh-tools 环境里把插件跑起来，
 * 验证 Config 校验、工具注册与 execute 调用链路。
 *
 * 前提：先 pnpm build。用法：node scripts/smoke-host.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { Context } = await import('@deepseek-ai/cordis')
const { defineTool } = await import('@deepseek-ai/dsh-tools')
const Schema = (await import('@deepseek-ai/schemastery')).default

// lib 产物必须已构建，且确实内联了工作区源码（不是对 @dsh-anim/* 的外部引用）
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.ok(source.length > 10_000, 'lib/index.js 不存在或过小，先跑 pnpm build')
assert.ok(!source.includes('from "@dsh-anim/'), 'bundle 不应引用工作区包名（应已内联）')

const plugin = await import(new URL('../lib/index.js', import.meta.url))
assert.equal(plugin.name, 'dsh-anim-studio')
assert.deepEqual(plugin.inject, ['tools'])
assert.equal(typeof plugin.apply, 'function')

// Config 必须是 cordis 认可的 StandardSchemaV1（schemastery schema，可调用对象）
assert.ok(plugin.Config, '缺少 Config 导出')
const resolved = plugin.Config({}) // 空配置 → 默认值
assert.ok(resolved.outputDir, 'Config 应为 outputDir 填默认值')
assert.equal(typeof defineTool, 'function')
assert.equal(typeof Schema.object, 'function')

// ---- 伪 tools 服务：记录注册的定义，模仿 dsh 的 ToolRegistry 契约 ----
const registered = []
const fakeTools = {
  register(definition) {
    registered.push(definition)
    return () => {}
  },
}

const ctx = new Context()
ctx.provide('tools', fakeTools)
try {
  await ctx.plugin(plugin, {}) // Fiber & PromiseLike：await 即等待启动完成
} catch (err) {
  console.error('插件挂载失败：', err)
  process.exit(1)
}

const names = registered.map(d => d.name).sort()
assert.deepEqual(names, [
  'anim_create_spec',
  'anim_diagnose',
  'anim_draft_scene',
  'anim_get',
  'anim_patch',
  'anim_plan',
  'anim_preview',
  'anim_render',
  'anim_undo',
])
console.log(`  ✔ 插件挂载成功，${names.length} 个 anim_* 工具已注册`)

// ---- 走一遍 create_spec → draft_scene → patch → undo 的 execute 链路 ----
const exec = { signal: new AbortController().signal }
const byName = Object.fromEntries(registered.map(d => [d.name, d]))

const created = await byName['anim_create_spec'].execute(
  { specId: 'smoke', title: '挂载冒烟' },
  exec,
)
assert.equal(created.specId, 'smoke')

const scene = {
  id: 's1',
  name: '引入',
  durationMs: 2000,
  layers: [{
    id: 'title', name: '标题', type: 'text',
    props: { text: '你好' },
    tracks: [{
      id: 'fade', target: 'props.opacity',
      keys: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }],
    }],
  }],
}
const drafted = await byName['anim_draft_scene'].execute({ specId: 'smoke', scene }, exec)
assert.equal(drafted.sceneCount, 1)

const patched = await byName['anim_patch'].execute(
  { specId: 'smoke', ops: [{ op: 'replace', path: '/scenes/0/layers/0/props/text', value: '改动' }] },
  exec,
)
assert.equal(patched.applied, 1)
assert.ok(patched.inverse.length > 0, 'patch 应返回 inverse')

const undone = await byName['anim_undo'].execute({ specId: 'smoke' }, exec)
assert.equal(undone.applied, 1)

const got = await byName['anim_get'].execute({ specId: 'smoke', path: '/scenes/0/layers/0/props/text' }, exec)
assert.equal(got.value, '你好')
console.log('  ✔ create → draft → patch → undo → get 执行链路通过')

// anim_diagnose 会真正探测环境（浏览器/ffmpeg），只验证调用不抛
const diag = await byName['anim_diagnose'].execute({}, exec)
assert.equal(typeof diag.ok, 'boolean')
console.log(`  ✔ anim_diagnose 可调用（当前环境 ok=${diag.ok}）`)

console.log('\n宿主挂载冒烟通过')
