/**
 * 宿主挂载冒烟：加载 lib/index.js（与 dsh plugin add 装进去的产物一致），
 * 在真实 cordis Context + 真实 @deepseek-ai/dsh-tools 环境里把插件跑起来，
 * 验证 Config 校验、工具注册与 execute 调用链路。
 *
 * dsh 0.1.5-rc.2 起 session.append 按「无损 JSON」严格校验载荷：任何一个
 * 对象属性值是 undefined 都整条拒绝。这里在 ctx 上 provide 一个同样严格的
 * 伪 session 服务，验证插件的事件载荷（含缺省的 note / narration）能过得了
 * 这道关。
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

// ---- 伪 session 服务：模仿 dsh 0.1.5-rc.2 的无损 JSON 严格校验 ----
// 真实现（@deepseek-ai/dsh-util-values 的 snapshotJsonValue）会在 append 现场
// 抛错；这里复刻与插件相关的失败类别：undefined 属性值、函数、非有限数、稀疏数组。
function assertLosslessJson(value, at = 'data') {
  if (value === null) return
  if (value === undefined) throw new Error(`${at} 是 undefined：rc.2 的 session.append 会整条拒绝`)
  if (typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
    throw new Error(`${at} 是 ${typeof value}，不可序列化`)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${at} 非法数字`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${at} 不是普通数组`)
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error(`${at}[${i}] 是空洞`)
      assertLosslessJson(value[i], `${at}[${i}]`)
    }
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${at} 不是普通对象（class 实例会被 rc.2 拒绝）`)
  }
  for (const [k, v] of Object.entries(value)) assertLosslessJson(v, `${at}.${k}`)
}

const sessionLog = []
const fakeSession = {
  append(type, data) {
    assertLosslessJson(data, `event ${type}.data`)
    sessionLog.push({ type, data })
    return { type, seq: sessionLog.length - 1, time: Date.now(), data }
  },
}

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
ctx.provide('session', fakeSession)
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

// ---- 走一遍 create → plan → draft → patch → undo → get 的 execute 链路 ----
// 事件全部落进严格校验的伪 session：载荷里若混进 undefined 属性值（rc.2 拒绝
// 的形态），append 当场抛错、冒烟失败。
const exec = { signal: new AbortController().signal }
const byName = Object.fromEntries(registered.map(d => [d.name, d]))

const created = await byName['anim_create_spec'].execute(
  { specId: 'smoke', title: '挂载冒烟' },
  exec,
)
assert.equal(created.specId, 'smoke')

// 大纲条目故意不带 narration：老代码会留下 narration: undefined 属性值，
// 在 rc.2 的严格 append 下整条炸掉——这条断言就是防回归的
const planned = await byName['anim_plan'].execute(
  {
    specId: 'smoke',
    outline: [{ id: 's1', name: '引入', intent: '建立直觉', durationMs: 2000 }],
  },
  exec,
)
assert.equal(planned.sceneCount, 1)

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

// note 故意省略：同上，patched 事件载荷不允许出现 note: undefined
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
console.log('  ✔ create → plan → draft → patch → undo → get 执行链路通过')

// 事件流的形状也要对：类型齐全、按序落盘
assert.deepEqual(sessionLog.map(e => e.type), [
  'anim/spec-created',
  'anim/outline-updated',
  'anim/spec-patched', // draft_scene
  'anim/spec-patched', // patch
  'anim/spec-patched', // undo
])
assert.ok(!('narration' in sessionLog[1].data.outline[0]), '缺省 narration 不应留下 undefined 属性')
assert.ok(!('note' in sessionLog[3].data), '省略的 note 不应留下 undefined 属性')
console.log(`  ✔ ${sessionLog.length} 条 anim/* 事件通过 rc.2 无损 JSON 校验并落盘`)

// anim_diagnose 会真正探测环境（浏览器/ffmpeg），只验证调用不抛
const diag = await byName['anim_diagnose'].execute({}, exec)
assert.equal(typeof diag.ok, 'boolean')
console.log(`  ✔ anim_diagnose 可调用（当前环境 ok=${diag.ok}）`)

// ---- 会话恢复：新挂载从同一份日志 fold，旧 spec（连同撤销历史）应原样可用 ----
const registered2 = []
const ctx2 = new Context()
ctx2.provide('tools', {
  register(definition) {
    registered2.push(definition)
    return () => {}
  },
})
ctx2.provide('session', {
  append(type, data) {
    assertLosslessJson(data, `event ${type}.data`)
    sessionLog.push({ type, data })
  },
  snapshotEvents: () => sessionLog,
})
await ctx2.plugin(plugin, {})

const byName2 = Object.fromEntries(registered2.map(d => [d.name, d]))
const got2 = await byName2['anim_get'].execute({ specId: 'smoke', path: '/scenes/0/layers/0/props/text' }, exec)
assert.equal(got2.value, '你好', '二次挂载应能读到重启前的 spec')
// fold 重建的撤销历史也要可用
const undone2 = await byName2['anim_undo'].execute({ specId: 'smoke' }, exec)
assert.equal(undone2.applied, 1)
assert.equal(sessionLog.at(-1).type, 'anim/spec-patched')
console.log('  ✔ 会话恢复：二次挂载从事件流 fold 出 spec，撤销历史可用')

// ---- 真机路径：宿主 ctx 没有 session 服务，落盘点是 exec.agent.session ----
const legacySpec = {
  version: 1,
  meta: { id: 'legacy', title: '历史片', fps: 30, size: { width: 1280, height: 720 } },
  theme: {
    colors: { background: '#101418', text: '#F2F5F7', muted: '#8B97A3', primary: '#4C9AFF', accent: '#FFB020' },
    font: { family: 'Noto Sans CJK SC', size: 48 },
  },
  assets: {},
  scenes: [],
}
const agentSession = {
  id: 'session-agent-test',
  _log: [{ type: 'anim/spec-created', data: { specId: 'legacy', spec: legacySpec } }],
  snapshotEvents() {
    return this._log
  },
  append(type, data) {
    assertLosslessJson(data, `event ${type}.data`)
    this._log.push({ type, data })
    return { type, seq: this._log.length, time: Date.now(), data }
  },
}
const execAgent = { signal: new AbortController().signal, agent: { session: agentSession } }

const registered3 = []
const ctx3 = new Context() // 注意：不提供 session 服务——逼出 agent.session 正道
ctx3.provide('tools', {
  register(definition) {
    registered3.push(definition)
    return () => {}
  },
})
await ctx3.plugin(plugin, {})
const byName3 = Object.fromEntries(registered3.map(d => [d.name, d]))

const created3 = await byName3['anim_create_spec'].execute({ specId: 'fresh', title: '新片' }, execAgent)
assert.equal(created3.specId, 'fresh')
assert.ok(
  agentSession._log.some(e => e.type === 'anim/spec-created' && e.data.specId === 'fresh'),
  '事件应落进 exec.agent.session（真机唯一落盘点）',
)
assert.ok(
  !sessionLog.some(e => e.data?.specId === 'fresh'),
  '无 agent 路径的日志不应混入新 spec 的事件',
)
console.log('  ✔ 真机落盘路径：exec.agent.session.append 收到 anim/* 事件')

// 第四次挂载 + 同一个 agent.session：懒恢复应让旧 spec 直接可读
const registered4 = []
const ctx4 = new Context()
ctx4.provide('tools', {
  register(definition) {
    registered4.push(definition)
    return () => {}
  },
})
await ctx4.plugin(plugin, {})
const byName4 = Object.fromEntries(registered4.map(d => [d.name, d]))
const got4 = await byName4['anim_get'].execute({ specId: 'legacy', path: '/meta/title' }, execAgent)
assert.equal(got4.value, '历史片', '懒恢复应从 exec.agent.session 的历史里还原旧 spec')
console.log('  ✔ 懒恢复：首次工具调用即从 agent 会话历史 fold 出旧 spec')

console.log('\n宿主挂载冒烟通过')
