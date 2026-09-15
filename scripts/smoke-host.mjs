/**
 * 宿主挂载冒烟：加载 lib/index.js（与 dsh plugin add 装进去的产物一致），
 * 在真实 cordis Context + 真实 @deepseek-ai/dsh-tools 环境里把插件跑起来，
 * 验证 Config 校验、工具注册与 execute 调用链路。
 *
 * 持久化模型（宿主 0.1.6-alpha.1 实证）：anim/* 事件绝不写宿主会话日志——
 * 读回路径对未知事件类型 fail-closed（`SessionEvent.ignorable` 才放行），
 * 而 `session.append` 不提供 ignorable 入口，写了整个会话拒读。事件落
 * 插件自有的 sidecar JSONL（`<outputDir>/sessions/<sessionId>.jsonl`）。
 * 这里验证：sidecar 落盘（含无损 JSON 严格校验）、宿主日志零污染、
 * sidecar 优先恢复、宿主日志回退恢复（旧日志 + 修复脚本场景）。
 *
 * 前提：先 pnpm build。用法：node scripts/smoke-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

// ---- 伪会话 fixture：模仿 dsh Session 的形状；append 是禁止写入的金丝雀 ----
// 一旦 sink 回退成写宿主会话日志（regression），append 抛错会让工具调用失败、
// 冒烟当场红——比静默毒化真机日志好得多。
function makeAgentSession(id, log = []) {
  return {
    id,
    _log: log,
    snapshotEvents() {
      return this._log
    },
    append() {
      throw new Error('金丝雀：anim/* 事件禁止写入宿主会话日志（会毒化读回）')
    },
  }
}

// 无损 JSON 校验（与 dsh 的 snapshotJsonValue 同一失败类别）：sidecar 行也走这套
function assertLosslessJson(value, at = 'data') {
  if (value === null) return
  if (value === undefined) throw new Error(`${at} 是 undefined：dsh 的无损 JSON 校验会整条拒绝`)
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
      assertLosslessJson(value[i], `${at}[i]`)
    }
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${at} 不是普通对象（class 实例会被 dsh 拒绝）`)
  }
  for (const [k, v] of Object.entries(value)) assertLosslessJson(v, `${at}.${k}`)
}

/** 读 sidecar 文件为事件数组，逐行做无损 JSON 校验。 */
function readSidecar(sessionsDir, sessionId) {
  const file = join(sessionsDir, `${sessionId}.jsonl`)
  assert.ok(existsSync(file), `sidecar 应存在：${file}`)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map((line, i) => {
      const ev = JSON.parse(line)
      assertLosslessJson(ev.data, `sidecar[${i}] ${ev.type}.data`)
      return ev
    })
}

// ---- 挂载：outputDir 指向临时目录（apply 由此派生 sessionsDir）----
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-anim-smoke-'))
const sessionsDir = resolve(tmpRoot, 'sessions')

const fakeToolsFor = sink => ({
  register(definition) {
    sink.push(definition)
    return () => {}
  },
})

const registered = []
const webRoutes = []
const ctx = new Context()
ctx.provide('tools', fakeToolsFor(registered))
// 伪 webServer：真机由 dsh web 组合提供；这里捕捉插件注册的 /dsh-anim 路由
ctx.provide('webServer', {
  register(route) {
    webRoutes.push(route)
    return () => {}
  },
})
// 注意：不提供 ctx.session——真机形态
try {
  await ctx.plugin(plugin, { outputDir: tmpRoot }) // Fiber & PromiseLike：await 即等待启动完成
} catch (err) {
  console.error('插件挂载失败：', err)
  process.exit(1)
}

const names = registered.map(d => d.name).sort()
assert.deepEqual(names, [
  'anim_asset_import',
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

// ---- create → plan → draft → patch → undo → get：事件全部落 sidecar ----
// 载荷里若混进 undefined 属性值（dsh 无损 JSON 校验拒绝的形态），逐行校验
// 当场失败；若 sink 回退写宿主会话日志，金丝雀 append 当场炸。
const agentSession = makeAgentSession('sess-main')
const exec = { signal: new AbortController().signal, agent: { session: agentSession } }
const byName = Object.fromEntries(registered.map(d => [d.name, d]))

const created = await byName['anim_create_spec'].execute(
  { specId: 'smoke', title: '挂载冒烟' },
  exec,
)
assert.equal(created.specId, 'smoke')

// 大纲条目故意不带 narration：老代码会留下 narration: undefined 属性值——
// 这条断言就是防回归的
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

// sidecar 的形状：类型齐全、按序落盘、宿主日志零污染
const sidecar = readSidecar(sessionsDir, 'sess-main')
assert.deepEqual(sidecar.map(e => e.type), [
  'anim/spec-created',
  'anim/outline-updated',
  'anim/spec-patched', // draft_scene
  'anim/spec-patched', // patch
  'anim/spec-patched', // undo
])
assert.ok(!('narration' in sidecar[1].data.outline[0]), '缺省 narration 不应留下 undefined 属性')
assert.ok(!('note' in sidecar[3].data), '省略的 note 不应留下 undefined 属性')
assert.equal(agentSession._log.length, 0, '宿主会话日志必须零 anim 事件（零污染）')
console.log(`  ✔ ${sidecar.length} 条 anim/* 事件落 sidecar 并通过无损 JSON 校验，宿主日志零污染`)

// anim_diagnose 会真正探测环境（浏览器/ffmpeg），只验证调用不抛 + host 报告形状
const diag = await byName['anim_diagnose'].execute({}, exec)
assert.equal(typeof diag.ok, 'boolean')
assert.equal(diag.host.sessionsDirConfigured, true, 'diagnose 应报告 sessionsDir 已配置')
assert.equal(diag.host.agentSessionIdKnown, true, 'diagnose 应报告会话 id 已知')
console.log(`  ✔ anim_diagnose 可调用（当前环境 ok=${diag.ok}），host 报告形状正确`)

// ---- 恢复（主路径）：新挂载 + 同一 sessionsDir，从 sidecar fold，旧 spec 原样可用 ----
const registered2 = []
const ctx2 = new Context()
ctx2.provide('tools', fakeToolsFor(registered2))
await ctx2.plugin(plugin, { outputDir: tmpRoot })
const byName2 = Object.fromEntries(registered2.map(d => [d.name, d]))
// 只带 id 不带 snapshotEvents：逼出 sidecar 恢复路径
const exec2 = { signal: new AbortController().signal, agent: { session: makeAgentSession('sess-main') } }
const got2 = await byName2['anim_get'].execute({ specId: 'smoke', path: '/scenes/0/layers/0/props/text' }, exec2)
assert.equal(got2.value, '你好', '二次挂载应能从 sidecar 读到重启前的 spec')
// fold 重建的撤销历史也要可用；undo 事件继续落同一份 sidecar
const undone2 = await byName2['anim_undo'].execute({ specId: 'smoke' }, exec2)
assert.equal(undone2.applied, 1)
assert.equal(readSidecar(sessionsDir, 'sess-main').at(-1).type, 'anim/spec-patched')
console.log('  ✔ 会话恢复（sidecar）：二次挂载 fold 出 spec，撤销历史可用')

// ---- 恢复（回退路径）：宿主日志里的旧 anim/* 事件（修复脚本处理过的旧日志）----
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
const legacySession = makeAgentSession('sess-legacy', [
  { type: 'anim/spec-created', data: { specId: 'legacy', spec: legacySpec } },
])
const registered3 = []
const ctx3 = new Context()
ctx3.provide('tools', fakeToolsFor(registered3))
await ctx3.plugin(plugin, { outputDir: tmpRoot })
const byName3 = Object.fromEntries(registered3.map(d => [d.name, d]))
const got3 = await byName3['anim_get'].execute(
  { specId: 'legacy', path: '/meta/title' },
  { signal: new AbortController().signal, agent: { session: legacySession } },
)
assert.equal(got3.value, '历史片', 'sidecar 缺失时应回退到宿主日志里的 anim/* 事件')
console.log('  ✔ 会话恢复（宿主日志回退）：sidecar 缺失时从 snapshotEvents fold 出旧 spec')

// ---- Web 面：/dsh-anim 路由已注册，JSON 端点经适配层可达 ----
const animRoute = webRoutes.find(r => r.kind === 'prefix' && r.path === '/dsh-anim')
assert.ok(animRoute, '插件应向 webServer 注册 /dsh-anim 前缀路由')

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.ended = true
      this.writableEnded = true
      this.body = body
    },
    on() {},
  }
}

const stateRes = makeRes()
await animRoute.handler({ method: 'GET', url: '/dsh-anim/api/state', headers: {} }, stateRes)
assert.equal(stateRes.status, 200)
const state = JSON.parse(stateRes.body.toString('utf8'))
assert.equal(state.specs[0]?.specId, 'smoke', '状态 API 应列出当前 spec（含恢复回来的）')
assert.ok(Array.isArray(state.renders), '状态 API 应带渲染任务簿（空也要在）')
console.log('  ✔ /dsh-anim/api/state 经 webServer 路由可达，spec 与渲染簿在列')

// ---- client bundle：lazy-CJS 包装契约 + keyed 工具视图注册 ----
const vm = await import('node:vm')
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
const sandbox = { window: { __ModuleLoader__: { load(reg) { registration = reg } } } }
vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
assert.ok(registration, 'bundle 执行必须向 window.__ModuleLoader__ 登记工厂')
assert.equal(registration.id, 'dsh-animation-studio', 'entry id 必须等于包名')

// 物化：factory(require) 只需要 react 系 stub（卡片渲染发生在浏览器）
const jsxStub = { Fragment: 'Fragment', jsx: () => null, jsxs: () => null }
const clientExports = registration.factory(spec =>
  spec === 'react/jsx-runtime' ? jsxStub : spec === 'react' ? {} : undefined,
)
assert.equal(typeof clientExports.apply, 'function', '工厂应产出插件对象（apply）')
assert.deepEqual([...clientExports.inject], ['slots'])

const registeredViews = []
const fakeClientCtx = {
  slots: {
    inject(slot, register) {
      assert.equal(slot, 'tool.call.toolview')
      register()
    },
    register(options, component) {
      assert.equal(typeof component, 'function')
      registeredViews.push(options.key)
      return () => {}
    },
  },
}
clientExports.apply(fakeClientCtx)
assert.deepEqual(registeredViews.sort(), [
  'anim_asset_import',
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
console.log(`  ✔ client bundle 包装契约成立，${registeredViews.length} 个 anim_* 卡片已注册进 tool.call.toolview`)

console.log('\n宿主挂载冒烟通过')
