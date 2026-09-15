/**
 * 端到端冒烟测试：不依赖浏览器 / ffmpeg / dsh 宿主，秒级跑完。
 *
 * 断言的都是「悄悄坏了最难受」的结构性事实：
 * - spec 层：校验、patch 可逆、时间线展开；
 * - codegen：`?scene` 导入、绝对毫秒折成 delay 偏移、变量名合法；
 * - host 层：store 回滚、撤销、事件流 fold 回放。
 *
 * 用法：pnpm smoke
 */
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'

// 直接引用工作区源码（tsx 直跑 TS），根 package.json 因此不依赖 workspace: 协议，
// 离线打包器在暂存目录里的 npm install 不会被它绊住
import { generateProject, generateProjectMeta } from '../packages/render-mc/src/index.ts'
import {
  applyPatch,
  sceneDurationMs,
  specDurationMs,
  truncateSpecAtMs,
  tweensOf,
  validateSpec,
} from '../packages/spec/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'
import { foldEvents, SpecStore } from '../packages/store/src/index.ts'
import { AnimRendererRegistry } from '../packages/tools/src/index.ts'
import type { AnimEvent } from '../packages/tools/src/events.ts'
import { opRender } from '../packages/tools/src/ops.ts'
import type { AnimDeps, AnimJobsService } from '../packages/tools/src/ops.ts'
import type { AnimRenderer } from '../packages/tools/src/render.ts'

let passed = 0

function check(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`  ✔ ${name}`)
}

async function checkA(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`  ✔ ${name}`)
}

/* --------------------------------------------------------- 一份演示 spec */

function demoSpec(): AnimationSpec {
  return {
    version: 1,
    meta: { id: 'smoke', title: '冒烟样片', fps: 30, size: { width: 1280, height: 720 } },
    theme: {
      colors: { background: '#101418', text: '#F2F5F7', muted: '#8B97A3', primary: '#4C9AFF', accent: '#FFB020' },
      font: { family: 'Noto Sans CJK SC', size: 48 },
    },
    assets: {},
    scenes: [
      {
        id: 'intro',
        name: '引入',
        durationMs: 2000,
        layers: [
          {
            id: 'title',
            name: '标题',
            type: 'text',
            props: { text: '梯度下降', fontSize: 64 },
            tracks: [
              {
                id: 'fade',
                target: 'props.opacity',
                keys: [
                  { atMs: 0, value: 0 },
                  { atMs: 500, value: 1, ease: { kind: 'easeOut' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/* ------------------------------------------------------------------ spec */

check('validate: 合法 spec 通过，缺 props. 前缀的 target 被拒', () => {
  assert.equal(validateSpec(demoSpec()).ok, true)
  const bad = demoSpec()
  bad.scenes[0].layers[0].tracks[0].target = 'opacity'
  assert.equal(validateSpec(bad).ok, false)
})

check('validate: 左上角原点坐标触发警告，出现负坐标则视为知情不告警', () => {
  const topLeft = demoSpec()
  topLeft.scenes[0].layers[0].props.x = 640 // 1280 宽的画布：中心原点下这是右缘
  topLeft.scenes[0].layers[0].props.y = 360
  const r = validateSpec(topLeft)
  assert.ok(r.ok, '坐标警告不应阻断校验')
  if (r.ok) assert.ok(r.warnings.some(w => w.includes('左上角')), JSON.stringify(r.warnings))

  const entrance = demoSpec()
  entrance.scenes[0].layers[0].props.x = 640
  entrance.scenes[0].layers[0].props.y = -200 // 有负值 = 作者知道画布中心之外还有空间
  const r2 = validateSpec(entrance)
  assert.ok(r2.ok)
  if (r2.ok) assert.deepEqual(r2.warnings, [])
})

check('patch: replace 生效且 inverse 完整还原、入参不被修改', () => {
  const original = demoSpec()
  const r = applyPatch(original, [{ op: 'replace', path: '/meta/title', value: '新标题' }])
  assert.equal(r.value.meta.title, '新标题')
  assert.equal(original.meta.title, '冒烟样片')
  assert.deepEqual(applyPatch(r.value, r.inverse).value, original)
})

check('timeline: 关键帧展开为补间段，时长取声明值与动画结束的较大者', () => {
  const track = demoSpec().scenes[0].layers[0].tracks[0]
  assert.deepEqual(tweensOf(track).map(t => [t.startMs, t.durationMs]), [[0, 500]])
  assert.equal(sceneDurationMs(demoSpec().scenes[0]), 2000)
  assert.equal(specDurationMs(demoSpec().scenes), 2000)
})

/* --------------------------------------------------------------- codegen */

check('codegen: 每场景一个文件、?scene 导入、delay 钉回绝对时间轴', () => {
  const { files } = generateProject(demoSpec())
  const scene = files.find(f => f.path === 'scenes/s0-intro.tsx')!
  const project = files.find(f => f.path === 'project.tsx')!
  assert.match(project.content, /from '\.\/scenes\/s0-intro\?scene'/)
  // 没有 ?scene 后缀，渲染器会在 reloadScenes 崩掉——这条断言就是防这个
  assert.match(project.content, /makeProject/)
  assert.match(scene.content, /delay\(0, n0_title\(\)\.opacity\(1, 0\.5, easeOutCubic\)\)/)
  // 初值必须落到轨道起点，否则动画第一帧会跳
  assert.match(scene.content, /n0_title\(\)\.opacity\(0\)/)
  // 按需 import：没用到的缓动不出现
  assert.doesNotMatch(scene.content, /springTiming|cubicBezier|easeInOutCubic/)
})

check('codegen: 图层 id 的连字符换成合法标识符；project.meta 带分辨率与帧率', () => {
  const spec = demoSpec()
  spec.scenes[0].layers[0].id = 'ball-label'
  const { files } = generateProject(spec)
  const scene = files.find(f => f.path === 'scenes/s0-intro.tsx')!
  assert.match(scene.content, /const n0_ball_label = createRef/)
  const meta = JSON.parse(generateProjectMeta(spec))
  assert.equal(meta.rendering.fps, 30)
  assert.deepEqual(meta.shared.size, { x: 1280, y: 720 })
})

/* ------------------------------------------------------------------ host */

check('store: 非法补丁整批回滚；patch 的 inverse 可撤销', () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  assert.throws(
    () => store.patch('gd', [{ op: 'replace', path: '/meta/fps', value: -1 }]),
    /非法/,
  )
  assert.equal(store.get('gd').meta.fps, 30)

  const r = store.patch('gd', [{ op: 'replace', path: '/scenes/0/layers/0/tracks/0/keys/1/atMs', value: 1200 }])
  assert.equal(store.get('gd').scenes[0].layers[0].tracks[0].keys[1].atMs, 1200)
  store.undo('gd')
  assert.equal(store.get('gd').scenes[0].layers[0].tracks[0].keys[1].atMs, 500)
  void r
})

check('foldEvents: 从事件流还原 store，坏事件跳过不崩', () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  store.patch('gd', [{ op: 'replace', path: '/meta/title', value: '改过的标题' }])
  // 伪造一条坏事件（指向不存在的路径）混进回放流
  const replay = foldEvents([
    { type: 'anim/spec-created', data: { specId: 'gd', spec: store.get('gd') } },
    {
      type: 'anim/spec-patched',
      data: {
        specId: 'gd',
        ops: [{ op: 'replace', path: '/scenes/9/name', value: 'x' }],
        inverse: [],
        durationMs: 0,
      },
    },
  ])
  assert.equal(replay.get('gd').meta.title, '改过的标题')
})

check('registry: 注册默认后端、按名获取、注销后回落', () => {
  const registry = new AnimRendererRegistry()
  const fake = { name: 'fake', diagnose: async () => ({ renderer: 'fake', ok: true, issues: [] }) } as never
  const dispose = registry.register(fake, { isDefault: true })
  assert.equal(registry.get().name, 'fake')
  assert.equal(registry.get('fake').name, 'fake')
  dispose()
  assert.throws(() => registry.get(), /尚未注册/)
})

/* --------------------------------------------------- 0.2.0：截短 / 恢复 / 后台渲染 */

function twoSceneSpec(): AnimationSpec {
  const spec = demoSpec()
  spec.scenes.push({
    id: 'second',
    name: '第二幕',
    durationMs: 2000,
    layers: [
      {
        id: 'ball',
        name: '球',
        type: 'circle',
        props: { radius: 40, fill: '#FFB020' },
        tracks: [
          { id: 'move', target: 'props.x', keys: [{ atMs: 0, value: 0 }, { atMs: 1500, value: 200 }] },
          // 整条轨道都在常见截断点之后——截短后应整条消失
          { id: 'late', target: 'props.opacity', keys: [{ atMs: 1800, value: 0.5 }] },
        ],
      },
    ],
  })
  return spec
}

check('truncate: 幕后截断零拷贝；幕中截断收紧时长、过滤越界关键帧、原 spec 不动', () => {
  const spec = twoSceneSpec()
  assert.equal(specDurationMs(spec.scenes), 4000)

  // 截断点在片尾之外：原样返回（引用相等）
  assert.equal(truncateSpecAtMs(spec, 99999), spec)
  assert.throws(() => truncateSpecAtMs(spec, 0), /cutMs/)

  const cut = truncateSpecAtMs(spec, 3000) // 落在第二幕中部
  assert.equal(cut.scenes.length, 2)
  assert.equal(specDurationMs(cut.scenes), 3000)
  const second = cut.scenes[1]
  assert.equal(second.durationMs, 1000)
  const move = second.layers[0].tracks.find(t => t.id === 'move')!
  assert.deepEqual(move.keys.map(k => k.atMs), [0], '越界的 1500ms 关键帧应被过滤')
  assert.equal(second.layers[0].tracks.some(t => t.id === 'late'), false, '整条越界的轨道应被丢弃')
  assert.ok(validateSpec(cut, { allowEmptyScenes: true }).ok, '截短后的 spec 仍要通过校验')
  // 原 spec 不被修改
  assert.equal(spec.scenes[1].durationMs, 2000)
  assert.equal(spec.scenes[1].layers[0].tracks.length, 2)
})

check('foldEvents: 渲染类事件不影响 spec 状态，带失败状态的载荷也不崩', () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  const replay = foldEvents([
    { type: 'anim/spec-created', data: { specId: 'gd', spec: store.get('gd') } },
    { type: 'anim/render-start', data: { specId: 'gd', jobId: 'anim-render-1', outputPath: 'out.mp4' } },
    { type: 'anim/render-progress', data: { specId: 'gd', jobId: 'anim-render-1', done: 5, total: 10, percent: 50 } },
    { type: 'anim/render-finished', data: { specId: 'gd', jobId: 'anim-render-1', outputPath: 'out.mp4', frameCount: 240 } },
    { type: 'anim/render-finished', data: { specId: 'gd', jobId: 'x', outputPath: 'o.mp4', status: 'failed', error: 'boom' } },
  ])
  assert.equal(replay.list().length, 1)
  assert.equal(replay.get('gd').meta.title, '冒烟样片')
})

check('store: adopt 整体并入（含撤销历史）——会话恢复的语义', () => {
  const source = new SpecStore()
  source.create('gd', demoSpec())
  source.patch('gd', [{ op: 'replace', path: '/meta/title', value: '第二版' }])
  const target = new SpecStore()
  target.adopt(source)
  assert.equal(target.get('gd').meta.title, '第二版')
  target.undo('gd')
  assert.equal(target.get('gd').meta.title, '冒烟样片', '恢复后的撤销历史应该可用')
})

/** 渲染测试共用脚手架：假后端 + 事件收集器。 */
function renderFixture(renderImpl: AnimRenderer['render']) {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  const emitted: AnimEvent[] = []
  const emit = (event: AnimEvent): void => {
    emitted.push(event)
  }
  const registry = new AnimRendererRegistry()
  registry.register(
    {
      name: 'fake',
      diagnose: async () => ({ renderer: 'fake', ok: true, issues: [] }),
      preview: async () => {
        throw new Error('preview 未在本测试中使用')
      },
      render: renderImpl,
    },
    { isDefault: true },
  )
  const deps: AnimDeps = { store, renderers: registry, outputDir: '.tmp' }
  return { deps, emitted, emit }
}

const RENDER_RESULT = {
  outputPath: '.tmp/gd.mp4',
  frameCount: 240,
  durationMs: 2000,
  width: 1280,
  height: 720,
  renderer: 'fake',
}

await checkA('opRender: 有 jobs 走后台——回执立即返回 jobId，事件按 start → progress → finished 落盘', async () => {
  const { deps, emitted, emit } = renderFixture(async request => {
    request.onProgress?.(5, 10)
    request.onProgress?.(10, 10)
    return RENDER_RESULT
  })
  let started = 0
  const jobs: AnimJobsService = {
    start(spec) {
      started++
      spec.run()
      return 'anim-render-7'
    },
  }
  const ticket = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit, jobs, {})
  assert.equal(started, 1)
  assert.equal(ticket.kind, 'background')
  assert.equal(ticket.jobId, 'anim-render-7')

  // 前三条事件的顺序钉死：start 先立起进度条，缓冲的进度随后补发
  assert.deepEqual(
    emitted.slice(0, 3).map(e => e.type),
    ['anim/render-start', 'anim/render-progress', 'anim/render-progress'],
  )
  assert.equal((emitted[0].data as { jobId: string }).jobId, 'anim-render-7')
  // 5%/一档节流：10 帧里报 5 和 10 → 恰好 50% 与 100% 两条
  const percents = emitted.filter(e => e.type === 'anim/render-progress').map(e => (e.data as { percent: number }).percent)
  assert.deepEqual(percents, [50, 100])

  await Promise.resolve()
  await Promise.resolve()
  const finished = emitted.find(e => e.type === 'anim/render-finished')
  assert.ok(finished, 'done 结算后应有 render-finished')
  assert.equal((finished.data as { frameCount?: number }).frameCount, 240)
  assert.ok(!('status' in finished.data), '成功完成不应带 status')
})

await checkA('opRender: job_kill 触发 cancel → killed 事件', async () => {
  let handle: { done: Promise<unknown> } | undefined
  const { deps, emitted, emit } = renderFixture(
    (_request, signal): Promise<{ outputPath: string; frameCount: number; durationMs: number; width: number; height: number; renderer: string }> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('渲染已取消')))
      }),
  )
  const jobs: AnimJobsService = {
    start(spec) {
      const h = spec.run()
      handle = { done: h.done }
      h.cancel('用户要求终止')
      return 'anim-render-9'
    },
  }
  const ticket = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit, jobs)
  assert.equal(ticket.kind, 'background')
  await handle!.done
  const finished = emitted.find(e => e.type === 'anim/render-finished')
  assert.ok(finished)
  const data = finished.data as { status?: string; frameCount?: number }
  assert.equal(data.status, 'killed')
  assert.equal(data.frameCount, undefined, 'killed 时帧数字段无意义，应缺省')
})

await checkA('opRender: 无 jobs 或 start 抛错都退回同步路径，行为与 0.1.x 一致', async () => {
  // (1) 宿主没有 jobs 服务
  {
    const { deps, emitted, emit } = renderFixture(async () => RENDER_RESULT)
    const result = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit)
    assert.equal(result.kind, 'sync', '同步路径直接返回渲染结果')
    assert.deepEqual(
      emitted.map(e => e.type),
      ['anim/render-start', 'anim/render-finished'],
    )
    assert.equal((emitted[0].data as { jobId: string }).jobId, 'sync')
  }
  // (2) jobs.start 抛错（如 owner 没有附加 job controller）
  {
    const { deps, emitted, emit } = renderFixture(async () => RENDER_RESULT)
    const jobs: AnimJobsService = {
      start() {
        throw new Error('owner has no attached job controller')
      },
    }
    const result = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit, jobs, {})
    assert.equal(result.kind, 'sync')
    assert.deepEqual(emitted.map(e => e.type), ['anim/render-start', 'anim/render-finished'])
  }
  // (3) 同步渲染失败也要发 failed 事件再抛
  {
    const { deps, emitted, emit } = renderFixture(async () => {
      throw new Error('ffmpeg 缺失')
    })
    await assert.rejects(
      opRender(deps, { specId: 'gd' }, new AbortController().signal, emit),
      /ffmpeg 缺失/,
    )
    const finished = emitted.find(e => e.type === 'anim/render-finished')
    assert.ok(finished)
    assert.equal((finished.data as { status?: string }).status, 'failed')
    assert.match((finished.data as { error?: string }).error ?? '', /ffmpeg/)
  }
})

await checkA('opRender: 进度 done 超过预估 total 时 percent 钳在 100（真机实测 92/90 → 102%）', async () => {
  const { deps, emitted, emit } = renderFixture(async request => {
    // 尾帧缓冲：实际帧数超出预估 total 是常态而非异常
    request.onProgress?.(92, 90)
    return RENDER_RESULT
  })
  await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit)
  const percents = emitted
    .filter(e => e.type === 'anim/render-progress')
    .map(e => (e.data as { percent: number }).percent)
  assert.deepEqual(percents, [100], '102% 会进会话日志，面板进度条不该画到界外')
})

await checkA('opRender: 相对 outputPath 解析成绝对路径——适配器收到绝对路径，回执/事件同步', async () => {
  const { deps, emitted, emit } = renderFixture(async request => {
    assert.ok(isAbsolute(request.outputPath), `适配器应收到绝对路径，收到 ${request.outputPath}`)
    return { ...RENDER_RESULT, outputPath: request.outputPath }
  })
  const result = await opRender(
    deps,
    { specId: 'gd', outputPath: 'test-animation.mp4' },
    new AbortController().signal,
    emit,
  )
  assert.ok(isAbsolute(result.outputPath), `回执应给绝对路径，收到 ${result.outputPath}`)
  const start = emitted.find(e => e.type === 'anim/render-start')
  assert.ok(isAbsolute((start!.data as { outputPath: string }).outputPath), 'render-start 事件的 outputPath 也是绝对路径')
})

console.log(`\n冒烟通过：${passed} 项`)
