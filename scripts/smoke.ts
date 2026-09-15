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

// 直接引用工作区源码（tsx 直跑 TS），根 package.json 因此不依赖 workspace: 协议，
// 离线打包器在暂存目录里的 npm install 不会被它绊住
import { generateProject, generateProjectMeta } from '../packages/render-mc/src/index.ts'
import { applyPatch, sceneDurationMs, specDurationMs, tweensOf, validateSpec } from '../packages/spec/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'
import { AnimRendererRegistry, SpecStore, foldEvents } from '../packages/tools/src/index.ts'

let passed = 0

function check(name: string, fn: () => void): void {
  fn()
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

console.log(`\n冒烟通过：${passed} 项`)
