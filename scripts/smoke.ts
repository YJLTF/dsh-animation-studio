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
import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

// 直接引用工作区源码（tsx 直跑 TS），根 package.json 因此不依赖 workspace: 协议，
// 离线打包器在暂存目录里的 npm install 不会被它绊住
import {
  ANIMATABLE_BY_TYPE,
  COMPONENT,
  dedupeWarnings,
  encodeFrames,
  collectAudioTracks,
  expandNarration,
  generateFontsCss,
  generateProject,
  generateProjectMeta,
  MotionCanvasRenderer,
  muxAudioTracks,
  pickScenes,
  sceneFrameBoundaries,
  sceneFingerprint,
  STATIC_PROPS,
  stableStringify,
} from '../packages/render-mc/src/index.ts'
import {
  applyPatch,
  LAYER_TYPES,
  PROP_ALIASES,
  sceneDurationMs,
  specDurationMs,
  truncateSpecAtMs,
  tweensOf,
  validateSpec,
} from '../packages/spec/src/index.ts'
import type { AnimationSpec, LayerType, Scene } from '../packages/spec/src/index.ts'
import { foldEvents, SpecStore } from '../packages/store/src/index.ts'
import { AnimRendererRegistry } from '../packages/tools/src/index.ts'
import type { AnimEvent } from '../packages/tools/src/events.ts'
import { coerceScene, opDraftScene, opPreview, opRender, opAssetImport, opPlan, reconcileOutline, scanSegmentCache } from '../packages/tools/src/ops.ts'
import type { AnimDeps, AnimJobHandle, AnimJobsService } from '../packages/tools/src/ops.ts'
import type { AnimRenderer } from '../packages/tools/src/render.ts'
import { createAnimKernel, MediaIndex, RenderTracker } from '../packages/tools/src/web.ts'
import type { KernelResponse } from '../packages/tools/src/web.ts'

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

check('validate: 报错文案可执行化——缺字段与写错值分开说，ease 报错带正确形态示例', () => {
  const mk = (layer: unknown) => {
    const spec = demoSpec()
    spec.scenes[0].layers = [layer as never]
    return validateSpec(spec)
  }
  // 缺 type：说清是「缺字段」并附可选列表（此前与写错值混为一句「未知图层类型」）
  const noType = mk({ id: 'a', name: 'A', props: { text: 'x' }, tracks: [] })
  assert.equal(noType.ok, false)
  if (!noType.ok) {
    assert.ok(
      noType.errors.some(e => e.path === '/scenes/0/layers/0/type' && e.message.includes('缺少 type 字段')),
      JSON.stringify(noType.errors),
    )
  }
  // 写错 type：报错回显收到的值
  const badType = mk({ id: 'a', name: 'A', type: 'textbox', props: {}, tracks: [] })
  assert.equal(badType.ok, false)
  if (!badType.ok) {
    assert.ok(badType.errors.some(e => e.message.includes('"textbox"')), JSON.stringify(badType.errors))
  }
  // 缺 props：给出字段形态示例
  const noProps = mk({ id: 'a', name: 'A', type: 'text', tracks: [] })
  assert.equal(noProps.ok, false)
  if (!noProps.ok) {
    assert.ok(noProps.errors.some(e => e.message.includes('缺少 props 字段')), JSON.stringify(noProps.errors))
  }
  // ease 写成字符串：报错直接给可照抄的示例
  const strEase = demoSpec()
  strEase.scenes[0].layers[0].tracks[0].keys[1].ease = 'easeOut' as never
  const r = validateSpec(strEase)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.errors.some(e => e.message.includes('{"kind":"easeInOut"}')), JSON.stringify(r.errors))
  }
  // 未知缓动名：报错回显名字 + 可选列表（bounce 已是合法品类，用真正不存在的名字）
  const unknownEase = demoSpec()
  unknownEase.scenes[0].layers[0].tracks[0].keys[1].ease = { kind: 'wobble' }
  const r2 = validateSpec(unknownEase)
  assert.equal(r2.ok, false)
  if (!r2.ok) {
    assert.ok(r2.errors.some(e => e.message.includes('未知缓动类型 "wobble"')), JSON.stringify(r2.errors))
  }
})

check('coerceScene: 真机首写三类机械错误自动纠正，repairs 回报，入参不被修改', () => {
  const input = {
    id: 'deep-dive',
    durationMs: 2000,
    layers: [
      {
        id: 'title',
        type: 'Text', // 大小写写飘
        props: { text: '你好', x: 0, y: 0 },
        tracks: [
          {
            id: 't1',
            target: 'props.opacity',
            keys: [{ atMs: 0, value: 0 }, { atMs: 600, value: 1, ease: 'easeOut' }], // ease 字符串
          },
        ],
      },
      { id: 'note', name: '备注', type: 'rect', props: { width: 100, height: 50 } }, // 漏 tracks
    ],
  }
  const { scene, repairs } = coerceScene(input)
  // 场景/图层 name 用 id 补上
  assert.equal(scene.name, 'deep-dive')
  assert.equal(scene.layers[0].name, 'title')
  // type 大小写纠正
  assert.equal(scene.layers[0].type, 'text')
  // ease 字符串包装成对象；无 ease 的关键帧不受影响
  assert.deepEqual(scene.layers[0].tracks[0].keys[1].ease, { kind: 'easeOut' })
  assert.equal(scene.layers[0].tracks[0].keys[0].ease, undefined)
  // 漏 tracks 补空数组
  assert.deepEqual(scene.layers[1].tracks, [])
  // 五类修复各报一条（场景 name + ease + type 大小写 + 图层 name + 图层 tracks），且说清改了什么
  assert.equal(repairs.length, 5, JSON.stringify(repairs))
  assert.ok(repairs.some(r => r.includes('ease')), JSON.stringify(repairs))
  assert.ok(repairs.some(r => r.includes('"Text"→"text"')), JSON.stringify(repairs))
  // 深拷贝：入参原样
  const rawL1 = input.layers[0] as { type: string; name?: string }
  const rawL2 = input.layers[1] as { tracks?: unknown[] }
  assert.equal(rawL1.type, 'Text')
  assert.equal(rawL1.name, undefined)
  assert.equal(Array.isArray(rawL2.tracks), false)
  // 纠正后的场景接在合法 spec 后能过校验
  const spec = demoSpec()
  spec.scenes.push(structuredClone(scene))
  const v = validateSpec(spec)
  assert.ok(v.ok, JSON.stringify(v.ok ? v.warnings : v.errors))
})

check('coerceScene: props.strokeWidth 归一化为 lineWidth；规范名已在则不动（不丢内容）', () => {
  const { scene, repairs } = coerceScene({
    id: 'x',
    name: 'x',
    durationMs: 1000,
    layers: [
      { id: 'a', name: 'A', type: 'line', props: { points: [[0, 0], [10, 0]], stroke: '#fff', strokeWidth: 6 }, tracks: [] },
      { id: 'b', name: 'B', type: 'rect', props: { width: 10, height: 10, strokeWidth: 2, lineWidth: 4 }, tracks: [] },
    ],
  })
  assert.equal(scene.layers[0].props.lineWidth, 6)
  assert.equal(scene.layers[0].props.strokeWidth, undefined)
  // 两者都在：规范名优先、冗余名不动（渲染端会对它告警），绝不静默丢值
  assert.equal(scene.layers[1].props.lineWidth, 4)
  assert.equal(scene.layers[1].props.strokeWidth, 2)
  assert.ok(repairs.some(r => r.includes('strokeWidth') && r.includes('a')), JSON.stringify(repairs))
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

/* ------------------------------------- 0.3.0：圆形修复 + 新元素类型 */

check('codegen: 圆形四形态回归——radius 换算、width/height 透传、缺省兜底、无色兜底', () => {
  const sceneFor = (props: Record<string, unknown>): { content: string; warnings: string[] } => {
    const spec = demoSpec()
    spec.scenes[0].layers = [{ id: 'ball', name: '球', type: 'circle', props, tracks: [] }]
    const r = generateProject(spec)
    return { content: r.files.find(f => f.path === 'scenes/s0-intro.tsx')!.content, warnings: r.warnings }
  }
  // radius → size×2（模型按「圆半径」写是高频形态，0.3.0 之前直接静默丢属性 → 0×0 不可见）
  const r1 = sceneFor({ radius: 40, fill: '#FFB020' })
  assert.match(r1.content, /size=\{80\}/)
  assert.ok(r1.warnings.some(w => w.includes('radius=40')), JSON.stringify(r1.warnings))
  // width/height 原生透传（MC Circle 官方用法，width≠height 即椭圆）
  const r2 = sceneFor({ width: 120, height: 60, fill: '#FFB020' })
  assert.match(r2.content, /width=\{120\} height=\{60\}/)
  // 缺尺寸 → size=100 兜底，杜绝 0×0
  const r3 = sceneFor({ fill: '#FFB020' })
  assert.match(r3.content, /size=\{100\}/)
  assert.ok(r3.warnings.some(w => w.includes('size=100')), JSON.stringify(r3.warnings))
  // 既无 fill 也无 stroke → 主题文字色兜底
  const r4 = sceneFor({ size: 60 })
  assert.match(r4.content, /fill=\{"#F2F5F7"\}/)
})

check('codegen: SVG 习惯名 strokeWidth 按 lineWidth 别名生效（静态+轨道），textAlign 直通', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [
    {
      id: 'ln', name: '线', type: 'line',
      props: { points: [[0, 0], [100, 0]], stroke: '#fff', strokeWidth: 6 },
      tracks: [
        { id: 'tk', target: 'props.strokeWidth', keys: [{ atMs: 0, value: 2 }, { atMs: 500, value: 6 }] },
      ],
    },
    { id: 't', name: '文本', type: 'text', props: { text: 'x', textAlign: 'center' }, tracks: [] },
  ] as never
  const r = generateProject(spec)
  const scene = r.files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  // 静态属性：strokeWidth=6 落到 lineWidth，不产生「不支持」告警
  assert.match(scene, /lineWidth=\{6\}/)
  assert.ok(!r.warnings.some(w => w.includes('strokeWidth')), JSON.stringify(r.warnings))
  // 轨道：props.strokeWidth 目标改写为 lineWidth 后放行（初值 + 补间都落在规范名上）
  assert.match(scene, /\.lineWidth\(2\)/)
  assert.doesNotMatch(scene, /strokeWidth/)
  // textAlign 直通（MC Layout 原生 signal），无告警
  assert.match(scene, /textAlign=\{"center"\}/)
  assert.ok(!r.warnings.some(w => w.includes('textAlign')), JSON.stringify(r.warnings))
})

check('codegen: lineWidth 显式给出时规范名优先，冗余 strokeWidth 走告警忽略', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [
    {
      id: 'ln', name: '线', type: 'line',
      props: { points: [[0, 0], [100, 0]], stroke: '#fff', strokeWidth: 4, lineWidth: 8 },
      tracks: [],
    },
  ] as never
  const r = generateProject(spec)
  const scene = r.files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  assert.match(scene, /lineWidth=\{8\}/)
  assert.ok(r.warnings.some(w => w.includes('strokeWidth')), JSON.stringify(r.warnings))
})

check('validate: circle 缺尺寸 / line 缺 points 或 stroke 有软警告，不阻断', () => {
  const mk = (layer: unknown) => {
    const spec = demoSpec()
    spec.scenes[0].layers = [layer as never]
    return validateSpec(spec)
  }
  const circle = mk({ id: 'c', name: '圆', type: 'circle', props: { fill: '#fff' }, tracks: [] })
  assert.ok(circle.ok)
  if (circle.ok) assert.ok(circle.warnings.some(w => w.includes('circle')), JSON.stringify(circle.warnings))
  const line = mk({ id: 'l', name: '线', type: 'line', props: { stroke: '#fff' }, tracks: [] })
  assert.ok(line.ok)
  if (line.ok) assert.ok(line.warnings.some(w => w.includes('points')), JSON.stringify(line.warnings))
})

check('codegen: 新元素类型——group 组合、line/arrow 折线箭头、ellipse', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [
    { id: 'axis', name: '轴', type: 'line', props: { points: [[-240, 0], [240, 0]], stroke: '#4C9AFF', lineWidth: 4 }, tracks: [{ id: 'draw', target: 'props.end', keys: [{ atMs: 0, value: 0 }, { atMs: 600, value: 1 }] }] },
    { id: 'arr', name: '箭头', type: 'arrow', props: { points: [[0, -60], [0, -160]], stroke: '#FFB020', lineWidth: 4 }, tracks: [] },
    { id: 'ell', name: '椭圆', type: 'ellipse', props: { width: 200, height: 100, fill: '#4C9AFF' }, tracks: [] },
    { id: 'g', name: '组', type: 'group', props: { x: 100, children: ['axis', 'arr'] }, tracks: [{ id: 'fade', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] }] },
  ]
  const { files, warnings } = generateProject(spec)
  const s = files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  // group：Node 容器 + 成员挂到组节点而不是 view；组轨道作用于 Node
  assert.match(s, /import \{makeScene2D, Circle, Line, Node\} from '@motion-canvas\/2d'/)
  assert.match(s, /const n3_g = createRef<Node>\(\);/)
  assert.match(s, /view\.add\(<Node ref=\{n3_g\}/)
  assert.match(s, /n3_g\(\)\.add\(<Line ref=\{n0_axis\} /)
  assert.match(s, /n3_g\(\)\.opacity\(0\);/)
  // line：points 数组进 JSX；end 轨道驱动画线
  assert.match(s, /points=\{\[\[-240,0\],\[240,0\]\]\}/)
  assert.match(s, /n0_axis\(\)\.end\(1, 0\.6\)/)
  // arrow：自动 endArrow
  assert.match(s, /endArrow=\{true\}/)
  // ellipse：Circle + width/height
  assert.match(s, /const n2_ell = createRef<Circle>\(\);/)
  assert.match(s, /width=\{200\} height=\{100\}/)
  assert.deepEqual(warnings, [], JSON.stringify(warnings))
})

check('codegen: M1 新元素——polygon/star/svg 与 image 资产引用', () => {
  const spec = demoSpec()
  spec.assets = {
    icon: { kind: 'image', src: '/tmp/icon.png' },
    web: { kind: 'image', src: 'https://example.com/a.png' },
  }
  spec.scenes[0].layers = [
    { id: 'p', name: '多边形', type: 'polygon', props: { sides: 3, size: 120, fill: '#4C9AFF' }, tracks: [] },
    { id: 's', name: '星', type: 'star', props: { size: 100, fill: '#FFB020' }, tracks: [] },
    { id: 'sv', name: 'svg', type: 'svg', props: { svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>' }, tracks: [] },
    { id: 'im', name: '图', type: 'image', props: { src: 'asset:icon', width: 60 }, tracks: [] },
    { id: 'im2', name: '图2', type: 'image', props: { src: 'asset:web', width: 60 }, tracks: [] },
  ]
  const { files, warnings } = generateProject(spec)
  const s = files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  // polygon：Polygon 组件 + sides 透传
  assert.match(s, /import \{makeScene2D, Img, Path, Polygon, SVG\} from '@motion-canvas\/2d'/)
  assert.match(s, /const n0_p = createRef<Polygon>\(\);/)
  assert.match(s, /sides=\{3\} size=\{120\}/)
  // star：Path 组件 + 内置星形 path（首字母 M，闭合 Z）
  assert.match(s, /const n1_s = createRef<Path>\(\);/)
  assert.match(s, /data=\{"M [^"]+Z"\}/)
  // svg：内嵌字符串（JSX 里引号被 JSON 转义）
  assert.match(s, /const n2_sv = createRef<SVG>\(\);/)
  assert.match(s, /svg=\{"<svg viewBox=\\"/)
  // image 资产引用：本地文件 → 项目根 URL；http URL → 原样
  assert.match(s, /src=\{?\"\/assets\/icon\.png\"\}?/)
  assert.match(s, /src=\{?\"https:\/\/example\.com\/a\.png\"\}?/)
  assert.ok(warnings.some(w => w.includes('/assets/icon.png')), JSON.stringify(warnings))
})

check('codegen: image 引用未登记资产 → 警告且 src 保持原样', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [{ id: 'im', name: '图', type: 'image', props: { src: 'asset:ghost' }, tracks: [] }]
  const { warnings } = generateProject(spec)
  assert.ok(warnings.some(w => w.includes('未登记') && w.includes('ghost')), JSON.stringify(warnings))
})

check('codegen: M3 元素——code 高亮器与 math 公式', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [
    { id: 'c', name: '代码', type: 'code', props: { code: 'const x: number = 1;', language: 'typescript', fontSize: 28, fill: '#fff' }, tracks: [] },
    { id: 'c2', name: '代码2', type: 'code', props: { code: 'print("hi")', language: 'PyThOn' }, tracks: [] },
    { id: 'c3', name: '代码3', type: 'code', props: { code: 'plain text' }, tracks: [] },
    { id: 'm', name: '公式', type: 'math', props: { tex: 'E = mc^2' }, tracks: [] },
  ]
  const { files, warnings } = generateProject(spec)
  const s = files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  // Code/Latex 组件映射
  assert.match(s, /import \{makeScene2D, Code, Latex\} from '@motion-canvas\/2d'/)
  assert.match(s, /const n0_c = createRef<Code>\(\);/)
  assert.match(s, /const n3_m = createRef<Latex>\(\);/)
  // language → highlighter 引用（大小写不敏感），场景 import 相应高亮器
  assert.match(s, /highlighter=\{tsHighlighter\}/)
  assert.match(s, /highlighter=\{pythonHighlighter\}/)
  assert.match(s, /import \{pythonHighlighter, tsHighlighter\} from '\.\.\/code-highlight'/)
  assert.ok(files.some(f => f.path === 'code-highlight.ts'), '带语言的 code 图层应生成 code-highlight.ts')
  // 无 language 的 code 图层不染色、不告警
  assert.doesNotMatch(s, /n2_c3\(\)[\s\S]*highlighter/, '无 language 的 code 图层不应挂 highlighter')
  // math：tex 透传 + fill 兜底主题文字色
  assert.match(s, /tex=\{"E = mc\^2"\}/)
  assert.match(s, /fill=\{"#F2F5F7"\}/)
  assert.ok(!warnings.some(w => w.includes('不支持高亮')), JSON.stringify(warnings))
})

check('validate: code 缺 code 内容 / math 缺 tex 有软警告，language 非字符串是硬错误', () => {
  const mk = (layer: unknown) => {
    const spec = demoSpec()
    spec.scenes[0].layers = [layer as never]
    return validateSpec(spec)
  }
  const code = mk({ id: 'c', name: '代码', type: 'code', props: {}, tracks: [] })
  assert.ok(code.ok)
  if (code.ok) assert.ok(code.warnings.some(w => w.includes('props.code')), JSON.stringify(code.warnings))
  const math = mk({ id: 'm', name: '公式', type: 'math', props: { tex: '' }, tracks: [] })
  assert.ok(math.ok)
  if (math.ok) assert.ok(math.warnings.some(w => w.includes('props.tex')), JSON.stringify(math.warnings))
  assert.equal(mk({ id: 'c2', name: '代码2', type: 'code', props: { code: 'x', language: 42 }, tracks: [] }).ok, false)
})

check('枚举一致性: LAYER_TYPES 与 codegen 三张表零漂移（0.3.x O14 防线）', () => {
  const expected = [...LAYER_TYPES].sort()
  assert.equal(new Set(expected).size, expected.length, 'LAYER_TYPES 本身不应有重复项')
  assert.deepEqual(Object.keys(STATIC_PROPS).sort(), expected, 'STATIC_PROPS 键应与 LAYER_TYPES 一致')
  assert.deepEqual(Object.keys(COMPONENT).sort(), expected, 'COMPONENT 键应与 LAYER_TYPES 一致')
  assert.deepEqual(Object.keys(ANIMATABLE_BY_TYPE).sort(), expected, 'ANIMATABLE_BY_TYPE 键应与 LAYER_TYPES 一致')
})

check('枚举一致性: anim_draft_scene 工具描述与 LAYER_TYPES 对齐（模型必读的第四张面）', () => {
  const source = readFileSync(join(process.cwd(), 'packages/tools/src/register.ts'), 'utf8')
  const m = source.match(/type 可选：([a-z |]+)/)
  assert.ok(m, '工具描述应包含「type 可选：…」列表')
  const listed = m[1]!.split('|').map(s => s.trim()).filter(Boolean)
  assert.deepEqual(listed, [...LAYER_TYPES], '描述里的类型列表应与 LAYER_TYPES 完全一致（顺序也对齐）')
})

check('render-mc: vite 配置文件名用 .mts，从源头掐掉 CJS 弃用告警（真机日志回归）', () => {
  const source = readFileSync(join(process.cwd(), 'packages/render-mc/src/runtime.ts'), 'utf8')
  assert.match(source, /vite\.config\.mts/, 'workDir 的 vite 配置应写为 .mts（强制 ESM 加载）')
  assert.doesNotMatch(source, /vite\.config\.ts/, '不应再写 .ts 配置（无 type:module 的目录会走 CJS require）')
})

check('anim_draft_scene 描述里的完整最小示例本身合法：可解析、过校验、codegen 零警告', () => {
  // 示例是模型照抄的模板，改坏了等于发毒图稿——这条断言盯着它
  const source = readFileSync(join(process.cwd(), 'packages/tools/src/register.ts'), 'utf8')
  const m = source.match(/'(\{"id":"intro".*?)。'/)
  assert.ok(m, '描述应包含以 {"id":"intro" 开头的完整最小示例')
  const exampleScene = JSON.parse(m[1]!) as { id: string; layers: unknown[] }
  const spec = demoSpec()
  spec.scenes = [exampleScene as never]
  const v = validateSpec(spec)
  assert.ok(v.ok, JSON.stringify(v.ok ? v.warnings : v.errors))
  const g = generateProject(spec)
  assert.deepEqual(g.warnings, [], '示例照抄后不应产生任何 codegen 警告')
})

check('validate: group children——引用存在/不自引用/不嵌套 group 是硬错，重复归属是软警告', () => {
  const mk = (layers: unknown[]) => {
    const spec = demoSpec()
    spec.scenes[0].layers = layers as never
    return validateSpec(spec)
  }
  const circle = { id: 'a', name: 'A', type: 'circle', props: { size: 50, fill: '#fff' }, tracks: [] }
  // 合法引用：本幕存在的图层
  assert.equal(mk([circle, { id: 'g', name: '组', type: 'group', props: { children: ['a'] }, tracks: [] }]).ok, true)
  // 引用本幕不存在的图层 → 硬错（此前只能到渲染期以警告发现，O15）
  const ghost = mk([circle, { id: 'g', name: '组', type: 'group', props: { children: ['ghost'] }, tracks: [] }])
  assert.equal(ghost.ok, false)
  if (!ghost.ok) assert.ok(ghost.errors.some(e => e.message.includes('ghost')), JSON.stringify(ghost.errors))
  // 自引用 → 硬错
  assert.equal(mk([{ id: 'g', name: '组', type: 'group', props: { children: ['g'] }, tracks: [] }]).ok, false)
  // group 套 group（MVP 单层分组）→ 硬错
  assert.equal(
    mk([
      { id: 'g1', name: '组1', type: 'group', props: { children: [] }, tracks: [] },
      { id: 'g2', name: '组2', type: 'group', props: { children: ['g1'] }, tracks: [] },
    ]).ok,
    false,
  )
  // children 形态非法（字符串而不是数组）→ 硬错
  assert.equal(mk([{ id: 'g', name: '组', type: 'group', props: { children: 'a' }, tracks: [] }]).ok, false)
  // 同一图层被两个 group 引用 → 不阻断，但给警告
  const dupe = mk([
    circle,
    { id: 'g1', name: '组1', type: 'group', props: { children: ['a'] }, tracks: [] },
    { id: 'g2', name: '组2', type: 'group', props: { children: ['a'] }, tracks: [] },
  ])
  assert.equal(dupe.ok, true)
  if (dupe.ok) assert.ok(dupe.warnings.some(w => w.includes('多个 group')), JSON.stringify(dupe.warnings))
})

check('validate+codegen: 13 种图层类型三处一致（validate 放行、codegen 有映射且不崩）', () => {
  const types: Array<{ type: LayerType; props: Record<string, unknown> }> = [
    { type: 'text', props: { text: 'x' } },
    { type: 'rect', props: { width: 100, height: 50, fill: '#fff' } },
    { type: 'circle', props: { size: 80, fill: '#fff' } },
    { type: 'image', props: { src: 'x.png' } },
    { type: 'group', props: { children: [] } },
    { type: 'line', props: { points: [[0, 0], [10, 10]], stroke: '#fff' } },
    { type: 'arrow', props: { points: [[0, 0], [10, 10]], stroke: '#fff' } },
    { type: 'ellipse', props: { width: 100, height: 60, fill: '#fff' } },
    { type: 'polygon', props: { size: 80, fill: '#fff' } },
    { type: 'star', props: { size: 80, fill: '#fff' } },
    { type: 'svg', props: { svg: '<svg/>' } },
    { type: 'code', props: { code: 'x', language: 'python' } },
    { type: 'math', props: { tex: 'x^2' } },
  ]
  for (const t of types) {
    const spec = demoSpec()
    spec.scenes[0].layers = [{ id: 'l0', name: 'x', type: t.type, props: t.props, tracks: [] }]
    assert.equal(validateSpec(spec).ok, true, `${t.type} 应通过校验`)
    const { files } = generateProject(spec)
    assert.ok(files.some(f => f.path === 'scenes/s0-intro.tsx'), `${t.type} 应产出场景文件`)
  }
})

await checkA('opAssetImport: 本地文件复制进资产目录并 patch 进 spec，事件带 ops/inverse；坏输入被拒', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'anim-asset-'))
  const store = new SpecStore()
  store.create('gd', demoSpec())
  const emitted: AnimEvent[] = []
  const deps: AnimDeps = { store, renderers: new AnimRendererRegistry(), outputDir: tmp }
  const src = join(tmp, 'icon.png')
  writeFileSync(src, 'png-bytes')

  const r = opAssetImport(deps, { specId: 'gd', assetId: 'icon', kind: 'image', src }, e => emitted.push(e))
  assert.equal(r.assetId, 'icon')
  assert.ok(isAbsolute(r.src), `回执 src 应为绝对路径，收到 ${r.src}`)
  assert.ok(existsSync(r.src), '资产文件应被复制进插件资产目录')
  assert.equal(store.get('gd').assets.icon.kind, 'image')
  assert.equal(store.get('gd').assets.icon.src, r.src)
  assert.equal(emitted[0].type, 'anim/spec-patched')
  assert.ok(Array.isArray((emitted[0].data as { ops: unknown }).ops), '事件应带 ops 载荷')

  // 坏输入：文件不存在 / 扩展名与类型不匹配 / 重复 assetId / 非法 assetId
  assert.throws(() => opAssetImport(deps, { specId: 'gd', assetId: 'x', kind: 'image', src: join(tmp, 'nope.png') }, () => {}), /文件不存在/)
  const txt = join(tmp, 'notes.txt')
  writeFileSync(txt, 'hi')
  assert.throws(() => opAssetImport(deps, { specId: 'gd', assetId: 'x', kind: 'image', src: txt }, () => {}), /不支持扩展名/)
  assert.throws(() => opAssetImport(deps, { specId: 'gd', assetId: 'icon', kind: 'image', src }, () => {}), /已存在/)
  assert.throws(() => opAssetImport(deps, { specId: 'gd', assetId: 'bad id!', kind: 'image', src }, () => {}), /assetId/)
})

await checkA('opDraftScene: 真机首写错误形态自动纠正入库（repairs 进回执），修不了的错报错自带指引', async () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  const deps: AnimDeps = { store, renderers: new AnimRendererRegistry(), outputDir: mkdtempSync(join(tmpdir(), 'anim-draft-')) }
  const emitted: AnimEvent[] = []
  // 真机实测的失败形态：ease 写字符串 + 图层漏 name + type 大小写 + 场景漏 name
  const r = opDraftScene(deps, {
    specId: 'gd',
    scene: {
      id: 's1',
      durationMs: 1500,
      layers: [
        {
          id: 'ball',
          type: 'Circle',
          props: { size: 80, fill: '#FFB020' },
          tracks: [
            { id: 'b1', target: 'props.x', keys: [{ atMs: 0, value: -400 }, { atMs: 900, value: 0, ease: 'easeInOut' }] },
          ],
        },
      ],
    } as never,
  }, e => emitted.push(e))
  assert.equal(r.sceneId, 's1')
  assert.equal(r.index, 1)
  assert.ok(r.repairs.length >= 3, JSON.stringify(r.repairs))
  // 库里落的是纠正后的场景
  const saved = store.get('gd').scenes[1]
  assert.equal(saved?.name, 's1')
  assert.equal(saved?.layers[0]?.type, 'circle')
  assert.deepEqual(saved?.layers[0]?.tracks[0]?.keys[1]?.ease, { kind: 'easeInOut' })
  assert.equal(emitted[0].type, 'anim/spec-patched')
  // 修不了的错（漏 props 会丢内容，不代劳）依然硬报错，报错带最小行动指引
  assert.throws(
    () =>
      opDraftScene(
        deps,
        { specId: 'gd', scene: { id: 's2', name: 'x', durationMs: 1000, layers: [{ id: 'z', name: 'z', type: 'text', tracks: [] }] } as never },
        () => {},
      ),
    /图层必填五字段/,
  )
})

/* ---------------------------------------------- 0.3.0 M2：anim-studio preset */

check('preset: anim-studio 预设文件齐全且含 persona 方法论锚点', () => {
  const dir = join(process.cwd(), 'config/agent-presets/anim-studio')
  const meta = readFileSync(join(dir, 'preset.yml'), 'utf8')
  const agent = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
  assert.match(meta, /^name: .+/m, 'preset.yml 应有显示名')
  assert.match(meta, /^description: .+/m, 'preset.yml 应有描述')
  // agent.cordis.yml 是会话层插件行列表：persona 挂官方 dsh-persona
  assert.match(agent, /^- id: persona$/m)
  assert.match(agent, /name: '@deepseek-ai\/dsh-persona'/)
  // persona 文本覆盖完整工作流的关键锚点：自检→建文档→大纲→逐幕→预览→微调→出片
  for (const anchor of ['anim_diagnose', 'anim_create_spec', 'anim_plan', 'anim_draft_scene', 'anim_preview', 'anim_patch', 'anim_render']) {
    assert.ok(agent.includes(anchor), `persona 方法论应提到 ${anchor}`)
  }
  assert.ok(agent.includes('中心原点'), 'persona 应钉死中心原点坐标系契约')
  assert.ok(agent.includes('props.end'), 'persona 应提到画线轨道 props.end')
  // 0.4.0 §4.7 视频技巧包：方法论段落要盖住新能力的用法
  for (const anchor of ['stop:"specEnd"', '{"kind":"back"}', 'props.code', 'narration/cues', 'fontFamily', 'scene.exit']) {
    assert.ok(agent.includes(anchor), `persona 视频技巧应提到 ${anchor}`)
  }
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

check('store: undo 失败不丢历史记录——先应用后出栈（真机排查发现的隐患）', () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  store.patch('gd', [{ op: 'replace', path: '/meta/title', value: 'v2' }])
  // 模拟历史与当前态漂移（坏事件恢复的形态）：inverse 指向必炸的路径
  store.record('gd').history[0].inverse = [{ op: 'remove', path: '/scenes/9' }]
  assert.throws(() => store.undo('gd'))
  assert.equal(store.record('gd').history.length, 1, 'undo 失败不得丢历史记录')
  assert.equal(store.get('gd').meta.title, 'v2', 'undo 失败不得改动 spec')
  // 修复漂移后撤销照常可用
  store.record('gd').history[0].inverse = [{ op: 'replace', path: '/meta/title', value: '冒烟样片' }]
  store.undo('gd')
  assert.equal(store.get('gd').meta.title, '冒烟样片')
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

check('pickScenes: 按索引切片保序去重、原 spec 不动，越界索引可读报错（O1）', () => {
  const spec = twoSceneSpec()
  const picked = pickScenes(spec, [1, 0, 1])
  assert.deepEqual(picked.scenes.map(s => s.id), ['intro', 'second'], '保持原播放顺序且去重')
  assert.equal(spec.scenes.length, 2, '原 spec 不被修改')
  assert.throws(() => pickScenes(spec, [2]), /越界索引/)
  assert.throws(() => pickScenes(spec, [-1]), /越界索引/)
  assert.equal(pickScenes(spec), spec, '省略/空 scenes 原样返回（引用相等，零拷贝）')
})

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

await checkA('MotionCanvasRenderer.render: scenes 抽查真正切片——生成物只含所选幕（O1 接线）', async () => {
  const spec = twoSceneSpec()
  let materialized: Array<{ path: string; content: string }> = []
  const runtime = {
    // 在 ffmpeg 合成之前停下：这里只验证「切片后的 spec 进了 codegen」这条接线
    async materialize(files: Array<{ path: string; content: string }>) {
      materialized = files
      throw new Error('SENTINEL-STOP')
    },
    async renderProject(): Promise<never> {
      throw new Error('unreachable')
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const renderer = new MotionCanvasRenderer({
    runtime: runtime as never,
    workDir: mkdtempSync(join(tmpdir(), 'anim-scenes-')),
  })
  await assert.rejects(
    renderer.render({ spec, outputPath: join(tmpdir(), 'scenes-o.mp4'), scenes: [1] }, new AbortController().signal),
    /SENTINEL-STOP/,
  )
  assert.deepEqual(
    materialized.filter(f => f.path.startsWith('scenes/')).map(f => f.path),
    ['scenes/s0-second.tsx'],
    '只应生成所选幕的场景文件（切片后重编号为 s0）',
  )
  const project = materialized.find(f => f.path === 'project.tsx')!
  assert.doesNotMatch(project.content, /intro/, '未选中的第一幕不应出现在 project 里')
  // 越界索引在触达渲染器之前就被拒
  await assert.rejects(
    renderer.render({ spec, outputPath: join(tmpdir(), 'scenes-o.mp4'), scenes: [9] }, new AbortController().signal),
    /越界索引/,
  )
})

await checkA('MotionCanvasRenderer: preview/render 共用串行闸——并发调用不重叠（O2）', async () => {
  let running = 0
  let maxConcurrent = 0
  const runtime = {
    async materialize(): Promise<void> {},
    async renderProject(options: { expectedFrames: number }) {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise(r => setTimeout(r, 20))
      running -= 1
      return { frameDir: 'frame-dir', frameCount: options.expectedFrames }
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const renderer = new MotionCanvasRenderer({
    runtime: runtime as never,
    workDir: mkdtempSync(join(tmpdir(), 'anim-lock-')),
  })
  // preview 与 render 走同一个 #renderFrames 串行闸，preview 可在无 ffmpeg 环境并发验证
  const shortSpec = twoSceneSpec()
  shortSpec.scenes[0].durationMs = 1000
  const [a, b] = await Promise.all([
    renderer.preview({ spec: twoSceneSpec(), atMs: [100], scale: 4 }, new AbortController().signal),
    renderer.preview({ spec: shortSpec, atMs: [100], scale: 4 }, new AbortController().signal),
  ])
  assert.equal(maxConcurrent, 1, '两个并发渲染请求不得重叠执行')
  assert.equal(a.frames.length, 1)
  assert.equal(b.frames.length, 1)
})

/** 渲染测试共用脚手架：假后端 + 事件收集器。previewImpl 缺省时 preview 一律抛错。 */
function renderFixture(renderImpl: AnimRenderer['render'], previewImpl?: AnimRenderer['preview']) {  const store = new SpecStore()
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
      preview: previewImpl ?? (async () => {
        throw new Error('preview 未在本测试中使用')
      }),
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

/* ------------------------------------------------- §5.3 预览后台化（O19） */

const PREVIEW_FRAMES = [
  { atMs: 100, path: '.tmp/frames/p-100.png' },
  { atMs: 900, path: '.tmp/frames/p-900.png' },
]

await checkA('opPreview: 有 jobs 走后台——票据立即返回 jobId，帧清单经 preview-finished 事件落盘', async () => {
  const { deps, emitted, emit } = renderFixture(
    async () => {
      throw new Error('render 未在本测试中使用')
    },
    async () => ({ renderer: 'fake', frames: PREVIEW_FRAMES, warnings: ['降级示例'] }),
  )
  let started = 0
  const jobs: AnimJobsService = {
    start(spec) {
      started++
      assert.equal(spec.kind, 'anim-preview')
      spec.run()
      return 'anim-preview-3'
    },
  }
  const ticket = await opPreview(deps, { specId: 'gd', atMs: [100, 900] }, new AbortController().signal, emit, jobs, {})
  assert.equal(started, 1)
  assert.equal(ticket.kind, 'background')
  assert.equal(ticket.jobId, 'anim-preview-3')
  assert.deepEqual(
    emitted.map(e => e.type),
    ['anim/preview-start', 'anim/preview-finished'],
    '后台预览的事件顺序：start 立起卡片，finished 带帧清单',
  )
  assert.equal((emitted[0].data as { jobId: string }).jobId, 'anim-preview-3')
  const finished = emitted[1] as { data: { frames?: Array<{ atMs: number }>; warnings?: string[] } }
  assert.deepEqual(finished.data.frames?.map(f => f.atMs), [100, 900])
  assert.deepEqual(finished.data.warnings, ['降级示例'])
})

await checkA('opPreview: job_kill 触发 cancel → killed 事件；无 jobs 时同步回退且事件照发', async () => {
  // killed 路径：cancel 后后端拒绝
  const killed = renderFixture(
    async () => {
      throw new Error('unused')
    },
    (options, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
        void options
      }),
  )
  let handle: AnimJobHandle | undefined
  const jobsKill: AnimJobsService = {
    start(spec) {
      handle = spec.run()
      return 'anim-preview-9'
    },
  }
  const ticket = await opPreview(killed.deps, { specId: 'gd' }, new AbortController().signal, killed.emit, jobsKill, {})
  assert.equal(ticket.kind, 'background')
  handle!.cancel('用户终止')
  await new Promise(r => setTimeout(r, 10))
  const finished = killed.emitted.find(e => e.type === 'anim/preview-finished')
  assert.ok(finished, '取消后应有 preview-finished')
  assert.equal((finished.data as { status?: string }).status, 'killed')

  // 同步回退：无 jobs（老签名调用方式依旧可用），回执带帧，事件流同款
  const sync = renderFixture(
    async () => {
      throw new Error('unused')
    },
    async () => ({ renderer: 'fake', frames: PREVIEW_FRAMES }),
  )
  const result = await opPreview(sync.deps, { specId: 'gd', atMs: [100, 900] }, new AbortController().signal, sync.emit)
  assert.deepEqual(result.frames.map(f => f.atMs), [100, 900])
  assert.deepEqual(
    sync.emitted.map(e => e.type),
    ['anim/preview-start', 'anim/preview-finished'],
    '同步预览也发 start/finished 事件（回放与任务簿同一口径）',
  )
  assert.equal((sync.emitted[0].data as { jobId: string }).jobId, 'sync')
})

await checkA('RenderTracker: 预览任务与渲染同簿——kind=preview、完成带帧清单（§5.3）', async () => {
  const tracker = new RenderTracker()
  tracker.observe({ type: 'anim/preview-start', data: { specId: 'gd', jobId: 'anim-preview-5' } })
  tracker.observe({
    type: 'anim/preview-finished',
    data: { specId: 'gd', jobId: 'anim-preview-5', frames: PREVIEW_FRAMES, warnings: ['降级示例'] },
  })
  const snap = tracker.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].kind, 'preview')
  assert.equal(snap[0].status, 'completed')
  assert.equal(snap[0].percent, 100)
  assert.equal(snap[0].frames?.length, 2)
  assert.deepEqual(snap[0].warnings, ['降级示例'])
})

/* ------------------------------------------------- /dsh-anim 请求内核 */

/** 内核响应统一收流成 Buffer，断言才好写。 */
async function drain(response: KernelResponse): Promise<Buffer> {
  if (response.body) return Buffer.from(response.body)
  const chunks: Buffer[] = []
  for await (const chunk of response.stream!) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

await checkA('/dsh-anim 内核：渲染任务簿 + 状态 API + 媒体放行', async () => {
  // 目录布局：tmpRoot（outputDir 之外的世界）/ output（outputDir 本体）
  const tmpRoot = mkdtempSync(join(tmpdir(), 'anim-web-'))
  const outputDir = join(tmpRoot, 'output')
  mkdirSync(outputDir)
  const insideMp4 = join(outputDir, 'demo.mp4')
  writeFileSync(insideMp4, '0123456789')
  const insideText = join(outputDir, 'notes.txt')
  writeFileSync(insideText, '秘密')
  const outsideMp4 = join(tmpRoot, 'outside.mp4')
  writeFileSync(outsideMp4, 'abcdefghij')

  const store = new SpecStore()
  store.create('webdemo', demoSpec())
  const tracker = new RenderTracker()
  const kernel = createAnimKernel({ store, tracker, media: new MediaIndex(), outputDir })

  // 事件记账 → /api/state 讲得出任务状态
  tracker.observe({ type: 'anim/render-start', data: { specId: 'webdemo', jobId: 'anim-render-1', outputPath: insideMp4 } })
  tracker.observe({
    type: 'anim/render-progress',
    data: { specId: 'webdemo', jobId: 'anim-render-1', done: 50, total: 100, percent: 50 },
  })
  tracker.observe({
    type: 'anim/render-finished',
    data: { specId: 'webdemo', jobId: 'anim-render-1', outputPath: insideMp4, frameCount: 30, durationMs: 1000 },
  })
  const stateRes = await kernel({ method: 'GET', url: '/dsh-anim/api/state', headers: {} })
  assert.equal(stateRes.status, 200)
  const state = JSON.parse((await drain(stateRes)).toString('utf8')) as {
    specs: Array<{ specId: string; renders: Array<{ jobId: string; status: string; percent: number }> }>
    renders: Array<{ jobId: string }>
  }
  assert.equal(state.specs[0]?.specId, 'webdemo')
  assert.equal(state.specs[0]?.renders[0]?.status, 'completed')
  assert.equal(state.specs[0]?.renders[0]?.percent, 50)
  assert.equal(state.renders.length, 1)

  // /api/spec：整份 spec 可读；未知 id 404
  const specRes = await kernel({ method: 'GET', url: '/dsh-anim/api/spec?id=webdemo', headers: {} })
  assert.equal(specRes.status, 200)
  // store 键（webdemo）与 spec.meta.id（demoSpec 自带 smoke）本就独立
  assert.equal(((JSON.parse((await drain(specRes)).toString('utf8')) as { spec: AnimationSpec }).spec).meta.id, 'smoke')
  assert.equal((await kernel({ method: 'GET', url: '/dsh-anim/api/spec?id=nope', headers: {} })).status, 404)

  // media：outputDir 内的 MP4 可服务（200 全量 / 206 区间 / 304 协商）
  const media = (p: string, extra: Record<string, string> = {}): Promise<KernelResponse> =>
    kernel({ method: 'GET', url: `/dsh-anim/media?p=${encodeURIComponent(p)}`, headers: extra })
  const full = await media(insideMp4)
  assert.equal(full.status, 200)
  assert.equal(full.headers['content-type'], 'video/mp4')
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.equal((await drain(full)).toString(), '0123456789')
  const part = await media(insideMp4, { range: 'bytes=0-3' })
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 0-3/10')
  assert.equal((await drain(part)).toString(), '0123')
  const etag = full.headers.etag
  assert.equal((await media(insideMp4, { 'if-none-match': etag })).status, 304)
  assert.equal((await media(insideMp4, { range: 'bytes=99-' })).status, 416)

  // 放行边界：目录穿越、outputDir 外未登记、非媒体扩展名一律 404
  assert.equal((await media(join(tmpRoot, '..', 'outside-of-scope.mp4'))).status, 404)
  assert.equal((await media(outsideMp4)).status, 404, 'outputDir 外、回执未出现过的文件不可服务')
  assert.equal((await media(insideText)).status, 404, '非媒体扩展名不可服务')

  // 回执索引：工具出过这条路径才放行 outputDir 外的产物
  const indexedKernel = createAnimKernel({ store, tracker, media: new MediaIndex(), outputDir: outputDir })
  assert.equal(
    (await indexedKernel({ method: 'GET', url: `/dsh-anim/media?p=${encodeURIComponent(outsideMp4)}`, headers: {} })).status,
    404,
  )
  const mediaIndex = new MediaIndex()
  const indexedKernel2 = createAnimKernel({ store, tracker, media: mediaIndex, outputDir: outputDir })
  mediaIndex.add(outsideMp4)
  const indexed = await indexedKernel2({
    method: 'GET',
    url: `/dsh-anim/media?p=${encodeURIComponent(outsideMp4)}`,
    headers: {},
  })
  assert.equal(indexed.status, 200)
  assert.equal((await drain(indexed)).toString(), 'abcdefghij')

  // 杂项：POST 405、未知路径 404
  assert.equal((await kernel({ method: 'POST', url: '/dsh-anim/api/state', headers: {} })).status, 405)
  assert.equal((await kernel({ method: 'GET', url: '/dsh-anim/other', headers: {} })).status, 404)
})

/* ------------------------------------- 0.4.0 M0：别名收敛 / 大纲对账 / 警告与成本预期 */

check('别名一致性: PROP_ALIASES 键值合法——值是已知规范名，键不同时是任何类型的规范名', () => {
  const canonical = new Set<string>()
  for (const table of Object.values(STATIC_PROPS)) {
    for (const key of Object.keys(table)) canonical.add(key)
  }
  assert.ok(Object.keys(PROP_ALIASES).length > 0, '别名表不应为空（空表说明消费方接线断了也没人发现）')
  for (const [alias, name] of Object.entries(PROP_ALIASES)) {
    assert.ok(canonical.has(name), `别名 ${alias} 的规范名 ${name} 应存在于 STATIC_PROPS 各表中`)
    assert.notEqual(alias, name, `别名 ${alias} 不应映射到自身`)
    assert.equal(canonical.has(alias), false, `别名 ${alias} 不应同时是规范名（归一化会打架）`)
  }
})

check('codegen: color 按 fill 别名生效；规范名 fill 已给出时 color 冗余走告警', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [
    { id: 'r1', name: 'R1', type: 'rect', props: { width: 100, height: 50, color: '#FF0000' }, tracks: [] },
    { id: 'r2', name: 'R2', type: 'rect', props: { width: 100, height: 50, color: '#FF0000', fill: '#00FF00' }, tracks: [] },
  ] as never
  const r = generateProject(spec)
  const s = r.files.find(f => f.path === 'scenes/s0-intro.tsx')!.content
  // r1：唯一色值走别名，静默归一为 fill，不产生任何告警
  assert.match(s, /fill=\{"#FF0000"\}/)
  assert.doesNotMatch(s, /color=/)
  assert.ok(!r.warnings.some(w => w.includes('#FF0000') || w.includes('r1')), JSON.stringify(r.warnings))
  // r2：规范名优先，冗余 color 告警忽略（与 strokeWidth 同一语义，绝不静默覆盖）
  assert.match(s, /fill=\{"#00FF00"\}/)
  assert.ok(r.warnings.some(w => w.includes('color') && w.includes('r2')), JSON.stringify(r.warnings))
})

check('coerceScene: color→fill 与轨道目标 strokeWidth→lineWidth 表驱动归一；规范名已在则不动', () => {
  const { scene, repairs } = coerceScene({
    id: 'x',
    name: 'x',
    durationMs: 1000,
    layers: [
      { id: 'a', name: 'A', type: 'text', props: { text: 'hi', color: '#FFF' }, tracks: [] },
      {
        id: 'b', name: 'B', type: 'line', props: { points: [[0, 0], [1, 1]], stroke: '#fff' },
        tracks: [{ id: 't', target: 'props.strokeWidth', keys: [{ atMs: 0, value: 2 }, { atMs: 400, value: 6 }] }],
      },
      { id: 'c', name: 'C', type: 'rect', props: { width: 10, height: 10, fill: '#123', color: '#456' }, tracks: [] },
    ],
  })
  assert.equal(scene.layers[0].props.fill, '#FFF')
  assert.equal(scene.layers[0].props.color, undefined)
  assert.equal(scene.layers[1].tracks[0].target, 'props.lineWidth')
  // 规范名已在：别名原样保留（不丢内容，渲染端会对它告警）
  assert.equal(scene.layers[2].props.fill, '#123')
  assert.equal(scene.layers[2].props.color, '#456')
  assert.ok(repairs.some(r => r.includes('color→fill')), JSON.stringify(repairs))
  assert.ok(repairs.some(r => r.includes('strokeWidth→lineWidth') && r.includes('轨道')), JSON.stringify(repairs))
  // 归一后的图层过 codegen：a/b 的别名已落规范名零警告；c 的冗余 color 是
  // 刻意保留的（规范名优先、不丢内容），codegen 对它告警正是预期行为
  const spec = demoSpec()
  spec.scenes = [structuredClone(spec.scenes[0])]
  spec.scenes[0].layers = [scene.layers[0], scene.layers[1]]
  const g = generateProject(spec)
  assert.deepEqual(g.warnings, [], JSON.stringify(g.warnings))
})

check('store: outline 进状态——setOutline 写入、foldEvents 回放、adopt 随记录迁移（N3）', () => {
  const outline = [{ id: 's1', name: '第一幕', intent: '引入', durationMs: 2000 }]
  const store = new SpecStore()
  store.create('gd', demoSpec())
  store.setOutline('gd', outline)
  assert.deepEqual(store.record('gd').outline, outline)

  const replay = foldEvents([
    { type: 'anim/spec-created', data: { specId: 'gd', spec: demoSpec() } },
    { type: 'anim/outline-updated', data: { specId: 'gd', outline } },
  ])
  assert.deepEqual(replay.record('gd').outline, outline)
  // 乱序回放（outline 先于 spec-created）：跳过不崩
  const early = foldEvents([{ type: 'anim/outline-updated', data: { specId: 'ghost', outline } }])
  assert.equal(early.list().length, 0)

  const target = new SpecStore()
  target.adopt(store)
  assert.deepEqual(target.record('gd').outline, outline, '会话恢复应连大纲一起迁移')
})

check('reconcileOutline: 超纲/离纲/单幕偏差/全片偏差/未写完五类提示；完全对得上则为零', () => {
  const outline = [
    { id: 'a', name: 'A', intent: 'x', durationMs: 2000 },
    { id: 'b', name: 'B', intent: 'x', durationMs: 3000 },
  ]
  const scene = (id: string, durationMs: number): Scene => ({ id, name: id, durationMs, layers: [] })
  // 完全一致（两幕都写、时长相同）→ 零提示
  assert.deepEqual(reconcileOutline(outline, [scene('a', 2000), scene('b', 3000)]), [])
  // 超纲 + 离纲
  const over = reconcileOutline(outline, [scene('a', 2000), scene('b', 3000), scene('c', 1000)])
  assert.ok(over.some(n => n.includes('超出大纲')), JSON.stringify(over))
  assert.ok(over.some(n => n.includes('c 不在大纲中')), JSON.stringify(over))
  // 未写完是提示不是错误；且草稿期幕未写齐时不发全片偏差（真机打磨：逐幕
  // draft 时全片必然「偏差大」，这条只在写齐后讲才有意义）
  const partial = reconcileOutline(outline, [scene('a', 2000)])
  assert.ok(partial.some(n => n.includes('未写')), JSON.stringify(partial))
  assert.ok(!partial.some(n => n.includes('全片实际')), `草稿期不应提示全片偏差：${JSON.stringify(partial)}`)
  // 单幕时长偏差 >50%（4000 vs 2000 → 100%）
  const deviated = reconcileOutline(outline, [scene('a', 4000), scene('b', 3000)])
  assert.ok(deviated.some(n => n.includes('a') && n.includes('偏差 100%')), JSON.stringify(deviated))
  // 全片偏差 >30%（8000 vs 5000 → 60%）
  const total = reconcileOutline(outline, [scene('a', 2000), scene('b', 6000)])
  assert.ok(total.some(n => n.includes('全片实际')), JSON.stringify(total))
})

await checkA('opDraftScene: 大纲在 store 时回执带 outlineNotes 对账', async () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  // 大纲覆盖 demoSpec 自带的 intro 幕 + 即将写入的 s1：写完 s1 恰好对齐
  store.setOutline('gd', [
    { id: 'intro', name: '引入', intent: 'x', durationMs: 2000 },
    { id: 's1', name: 'S1', intent: '引入', durationMs: 2000 },
  ])
  const deps: AnimDeps = { store, renderers: new AnimRendererRegistry(), outputDir: '.tmp' }
  // 按大纲写：对账干净，字段缺省
  const ok = opDraftScene(deps, {
    specId: 'gd',
    scene: { id: 's1', name: 'S1', durationMs: 2000, layers: [{ id: 't', name: 'T', type: 'text', props: { text: 'x' }, tracks: [] }] },
  }, () => {})
  assert.equal(ok.outlineNotes, undefined, JSON.stringify(ok.outlineNotes))
  // 写离纲场景：超纲 + 点名提示
  const stray = opDraftScene(deps, {
    specId: 'gd',
    scene: { id: 'stray', name: '离纲', durationMs: 1000, layers: [{ id: 't2', name: 'T2', type: 'text', props: { text: 'x' }, tracks: [] }] },
  }, () => {})
  assert.ok(stray.outlineNotes?.some(n => n.includes('超出大纲')), JSON.stringify(stray.outlineNotes))
  assert.ok(stray.outlineNotes?.some(n => n.includes('stray 不在大纲中')), JSON.stringify(stray.outlineNotes))
})

check('dedupeWarnings: 同类警告合并计数（O21 真机百行刷屏的收敛），不同消息互不吞并', () => {
  const merged = dedupeWarnings([
    '图层 b 的属性 strokeWidth 不被 line 支持，已忽略',
    '图层 b 的属性 strokeWidth 不被 line 支持，已忽略',
    '另一条警告',
  ])
  assert.equal(merged.length, 2)
  assert.match(merged[0]!, /×2/)
  assert.doesNotMatch(merged[1]!, /×/)
})

await checkA('MotionCanvasRenderer.preview: 生成期警告随回执返回（此前只进宿主日志，模型看不见）', async () => {
  const runtime = {
    async materialize(): Promise<void> {},
    async renderProject(options: { expectedFrames: number }) {
      return { frameDir: join(tmpdir(), `anim-warn-frames-${Date.now()}`), frameCount: options.expectedFrames }
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const renderer = new MotionCanvasRenderer({ runtime: runtime as never, workDir: mkdtempSync(join(tmpdir(), 'anim-warn-')) })
  const spec = demoSpec()
  spec.scenes[0].layers = [
    { id: 'x', name: 'X', type: 'rect', props: { width: 10, height: 10, fill: '#fff', ghostProp: 1 }, tracks: [] },
  ] as never
  const r = await renderer.preview({ spec, atMs: [100], scale: 4 }, new AbortController().signal)
  assert.ok(r.warnings?.some(w => w.includes('ghostProp')), JSON.stringify(r.warnings))
})

await checkA('opRender: 同步回执与完成事件携带 warnings / expectedFrames（N4/N5）', async () => {
  const { deps, emitted, emit } = renderFixture(async () => ({
    ...RENDER_RESULT,
    expectedFrames: 60,
    warnings: ['图层 x 的属性 foo 不被 rect 支持，已忽略'],
  }))
  const result = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit)
  assert.equal(result.kind, 'sync')
  assert.equal((result as { expectedFrames?: number }).expectedFrames, 60)
  assert.deepEqual((result as { warnings?: string[] }).warnings, ['图层 x 的属性 foo 不被 rect 支持，已忽略'])
  const finished = emitted.find(e => e.type === 'anim/render-finished')!
  assert.deepEqual((finished.data as { warnings?: string[] }).warnings, ['图层 x 的属性 foo 不被 rect 支持，已忽略'])
})

await checkA('opRender: 大纲与场景偏差时票据带 outlineNotes——渲染前说比渲完说便宜', async () => {
  const { deps, emitted, emit } = renderFixture(async () => RENDER_RESULT)
  // demoSpec 的 intro 实际 2000ms，大纲写 9000ms → 单幕偏差 78% + 全片偏差 78%
  deps.store.setOutline('gd', [{ id: 'intro', name: '引入', intent: 'x', durationMs: 9000 }])
  const jobs: AnimJobsService = {
    start(spec) {
      spec.run()
      return 'anim-render-11'
    },
  }
  const ticket = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit, jobs, {})
  assert.equal(ticket.kind, 'background')
  assert.ok(
    (ticket as { outlineNotes?: string[] }).outlineNotes?.some(n => n.includes('偏差')),
    JSON.stringify((ticket as { outlineNotes?: string[] }).outlineNotes),
  )
})

await checkA('opPlan: 全片时长档位提示（N5）+ 大纲落 store（N3 的状态侧）', async () => {
  const store = new SpecStore()
  store.create('gd', demoSpec())
  const deps: AnimDeps = { store, renderers: new AnimRendererRegistry(), outputDir: '.tmp' }
  const item = (id: string, durationMs: number) => ({ id, name: id, intent: 'x', durationMs })
  // >60s：分钟级提示；>180s：超时预算 + scenes 抽查建议
  const long = opPlan(deps, { specId: 'gd', outline: [item('a', 70_000)] }, () => {})
  assert.ok(long.pacing.some(p => p.includes('分钟计')), JSON.stringify(long.pacing))
  const huge = opPlan(deps, { specId: 'gd', outline: [item('a', 200_000)] }, () => {})
  assert.ok(huge.pacing.some(p => p.includes('scenes 抽查')), JSON.stringify(huge.pacing))
  // 常规时长不追加全片档位
  const fine = opPlan(deps, { specId: 'gd', outline: [item('a', 8000)] }, () => {})
  assert.ok(!fine.pacing.some(p => p.includes('全片')), JSON.stringify(fine.pacing))
  // 大纲进状态：后续 draft/render 对账的数据源
  assert.deepEqual(store.record('gd').outline?.map(o => o.id), ['a'])
})

/* --------------------------------------------------- 0.4.0 M1：渲染产能 */

check('stableStringify: 键序无关、undefined 剔除；sceneFingerprint: 内容/渲染参数敏感、结果稳定（§3.4）', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }), '键书写顺序不影响序列化')
  assert.equal(stableStringify({ x: undefined, y: 1 }), stableStringify({ y: 1 }), 'undefined 属性不进指纹')
  assert.equal(stableStringify([1, 'a', null]), '[1,"a",null]')
  const params = { fps: 30, resolutionScale: 1, width: 1280, height: 720, codegenVersion: 1 }
  const fp = sceneFingerprint(demoSpec().scenes[0], params)
  assert.equal(sceneFingerprint(demoSpec().scenes[0], params), fp, '同内容同参数指纹一致（对象新建也一致）')
  assert.notEqual(sceneFingerprint(demoSpec().scenes[0], { ...params, fps: 60 }), fp, 'fps 入指纹防串档')
  assert.notEqual(sceneFingerprint(demoSpec().scenes[0], { ...params, resolutionScale: 0.5 }), fp, '分辨率缩放入指纹')
  assert.notEqual(sceneFingerprint(demoSpec().scenes[0], { ...params, codegenVersion: 2 }), fp, 'codegen 产物版本入指纹——生成器语义变更使旧段失效（M2 真机教训：fill 兜底修正后旧段被吃到）')
  const changed = demoSpec().scenes[0]
  changed.layers[0].props.text = '改过的字'
  assert.notEqual(sceneFingerprint(changed, params), fp, '图层内容变化换指纹')
  // §4.1：audio 图层不参与画面——改音量不换指纹（改音量不该触发重渲）
  const withAudio = demoSpec().scenes[0]
  withAudio.layers.push({ id: 'bgm', name: 'BGM', type: 'audio', props: { src: 'asset:bgm', volume: 0.5 }, tracks: [] } as never)
  const fpAudio = sceneFingerprint(withAudio, params)
  ;(withAudio.layers[1]!.props as { volume: number }).volume = 0.9
  assert.equal(sceneFingerprint(withAudio, params), fpAudio, 'audio props 变化不换指纹')
  // §4.3：字幕是场景数据——改字幕必须换指纹（否则段缓存吃到旧字幕）
  const withSub = { ...demoSpec().scenes[0], subtitles: [{ text: '字幕', startMs: 100, endMs: 900 }] }
  const fpSub = sceneFingerprint(withSub, params)
  assert.notEqual(sceneFingerprint({ ...withSub, subtitles: [{ text: '改过的字幕', startMs: 100, endMs: 900 }] }, params), fpSub, '字幕变化换指纹')
})

check('sceneFrameBoundaries: 边界连续无缝、总帧数与 expected 同口径、轨道溢出时长入界（§3.4）', () => {
  const scene = (durationMs: number): Scene => ({
    id: `s${durationMs}`,
    name: String(durationMs),
    durationMs,
    layers: [],
    tracks: [],
  })
  const scenes = [scene(1000), scene(1500), scene(500)]
  const { starts, ends, total } = sceneFrameBoundaries(scenes, 10)
  assert.deepEqual(starts, [0, 10, 25], '累计 round：边界连续无孔')
  assert.deepEqual(ends, [10, 25, 30])
  assert.equal(total, 30)
  assert.equal(total, Math.round((specDurationMs(scenes) / 1000) * 10), '与渲染 expected 公式完全同口径')

  // 轨道超出声明时长：sceneDurationMs 取大者，边界跟着实际渲染时长走
  const overrun = demoSpec()
  overrun.scenes[0].layers[0].tracks[0].keys.push({ atMs: 3000, value: 0 })
  const b2 = sceneFrameBoundaries([overrun.scenes[0], scene(1000)], 10)
  assert.equal(sceneDurationMs(overrun.scenes[0]), 3000)
  assert.deepEqual(b2.starts, [0, 30])
  assert.deepEqual(b2.ends, [30, 40])
})

await checkA('MotionCanvasRenderer: workDir 按 specId 分子目录——不同 spec 物化/渲染到各自目录（§3.3）', async () => {
  const seen: string[] = []
  const runtime = {
    async materialize(_files: unknown, workDir: string) {
      seen.push(workDir)
    },
    async renderProject(options: { workDir: string }): Promise<never> {
      seen.push(options.workDir)
      throw new Error('SENTINEL-STOP')
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const renderer = new MotionCanvasRenderer({ runtime: runtime as never, workDir: mkdtempSync(join(tmpdir(), 'anim-wd-')) })
  const spec = demoSpec()
  spec.meta.id = 'my spec' // 带空格：子目录必须经 safeName 净化
  await assert.rejects(
    renderer.render({ spec, outputPath: join(tmpdir(), 'wd-o.mp4') }, new AbortController().signal),
    /SENTINEL-STOP/,
  )
  assert.ok(seen.length >= 2, 'materialize 与 renderProject 都应收到同一 specDir')
  for (const dir of seen) {
    assert.equal(dir, seen[0], '同一 spec 的物化与渲染必须落在同一目录')
    assert.match(dir!, /my_spec$/, '子目录 = work/<safeName(meta.id)>')
  }
})

check('scanSegmentCache: 各 spec 段数与体积按体积降序；无缓存/空目录时为零（§3.4 配套）', () => {
  const root = mkdtempSync(join(tmpdir(), 'anim-cache-scan-'))
  const mk = (spec: string, files: Array<[string, number]>) => {
    const dir = join(root, 'work', spec, 'segments')
    mkdirSync(dir, { recursive: true })
    for (const [f, size] of files) writeFileSync(join(dir, f), Buffer.alloc(size))
  }
  mk('alpha', [['seg-00-aa.mp4', 300], ['seg-01-bb.mp4', 100]])
  mk('beta', [['seg-00-cc.mp4', 50]])
  mkdirSync(join(root, 'work', 'empty', 'segments'), { recursive: true })
  const scan = scanSegmentCache(root)
  assert.deepEqual(scan.specs.map(s => s.workDir), ['alpha', 'beta'], '按体积降序，空段目录不出现')
  assert.equal(scan.specs[0]!.segments, 2)
  assert.equal(scan.specs[0]!.bytes, 400)
  assert.equal(scan.totalBytes, 450)
  assert.deepEqual(scanSegmentCache(mkdtempSync(join(tmpdir(), 'anim-cache-none-'))), { specs: [], totalBytes: 0 })
})

await checkA('opRender: 增量命中情况进回执与完成事件（§3.4）', async () => {
  const { deps, emitted, emit } = renderFixture(async () => ({
    ...RENDER_RESULT,
    incremental: { scenesTotal: 3, scenesReused: 2 },
  }))
  const result = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit)
  assert.deepEqual((result as { incremental?: unknown }).incremental, { scenesTotal: 3, scenesReused: 2 })
  const finished = emitted.find(e => e.type === 'anim/render-finished')!
  assert.deepEqual((finished.data as { incremental?: unknown }).incremental, { scenesTotal: 3, scenesReused: 2 })
})

// 2×2 的帧：yuv420p 要求宽高为偶数，1×1 会被 libx264 拒收
const PNG_2X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGM4YWTEwMDAAKEAFSYCWd99v2IAAAAASUVORK5CYII=',
  'base64',
)

const execFileAsync = promisify(execFileCallback)

async function ffmpegAvailable(): Promise<boolean> {
  try {
    // execFile 直解析 PATH；exec 走 cmd.exe 壳，在 msys 环境下可能解析不到同一个 PATH
    await execFileAsync('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

function threeSceneSpec(): AnimationSpec {
  const spec = demoSpec()
  spec.meta.id = 'incr'
  spec.meta.fps = 10
  spec.scenes = [1, 2, 3].map(n => ({
    id: `s${n}`,
    name: `第${n}幕`,
    durationMs: 1000,
    layers: [
      {
        id: `l${n}`,
        name: `层${n}`,
        type: 'rect',
        props: { width: 100, height: 80, x: 0, y: 0, fill: '#3388CC' },
        tracks: [],
      },
    ],
  })) as Scene[]
  return spec
}

await checkA('MotionCanvasRenderer.render: 场景级增量——未变幕零渲染直取段缓存，改一幕只重渲一幕（§3.4）', async () => {
  if (!(await ffmpegAvailable())) {
    console.log('    （本机无 ffmpeg，跳过增量渲染端到端断言）')
    return
  }
  let renderCalls = 0
  const renderedScenes: number[] = []
  const runtime = {
    async materialize(): Promise<void> {},
    async renderProject(options: { workDir: string; expectedFrames: number }) {
      renderCalls++
      const frameDir = join(options.workDir, 'frames')
      mkdirSync(frameDir, { recursive: true })
      for (let i = 0; i < options.expectedFrames; i++) {
        writeFileSync(join(frameDir, `${String(i).padStart(6, '0')}.png`), PNG_2X2)
      }
      renderedScenes.push(options.expectedFrames)
      return { frameDir, frameCount: options.expectedFrames }
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const workDir = mkdtempSync(join(tmpdir(), 'anim-incr-'))
  const renderer = new MotionCanvasRenderer({ runtime: runtime as never, workDir })
  const out = join(workDir, 'out.mp4')
  const signal = new AbortController().signal

  // 1) 首渲：3 幕各自 solo 渲染（每幕一次编辑器调用），段缓存建立
  const spec = threeSceneSpec()
  const r1 = await renderer.render({ spec, outputPath: out }, signal)
  assert.deepEqual(r1.incremental, { scenesTotal: 3, scenesReused: 0 })
  assert.equal(renderCalls, 3, '每幕各一次 solo 渲染')
  assert.deepEqual(renderedScenes, [10, 10, 10], '每次 solo 渲染只含本幕帧数')
  assert.equal(r1.frameCount, 30)
  assert.ok(existsSync(out), '拼接产物落盘')

  // 2) 内容未变（新建的等价对象）：3 幕全命中，编辑器一次都不开
  const r2 = await renderer.render({ spec: threeSceneSpec(), outputPath: out }, signal)
  assert.deepEqual(r2.incremental, { scenesTotal: 3, scenesReused: 3 })
  assert.equal(renderCalls, 3, '缓存全命中时不应再进渲染器')

  // 3) 改第二幕的一个属性：只 solo 重渲这一幕，另两幕继续吃缓存
  const changed = threeSceneSpec()
  ;(changed.scenes[1]!.layers[0]!.props as { fill: string }).fill = '#CC3333'
  const r3 = await renderer.render({ spec: changed, outputPath: out }, signal)
  assert.deepEqual(r3.incremental, { scenesTotal: 3, scenesReused: 2 })
  assert.equal(renderCalls, 4)
  assert.deepEqual(renderedScenes.slice(3), [10], '第三次渲染只渲改动的第二幕')

  // 4) cache:false：强制全量，回执不带 incremental
  const r4 = await renderer.render({ spec: threeSceneSpec(), outputPath: out, cache: false }, signal)
  assert.equal(r4.incremental, undefined)
  assert.equal(renderCalls, 5)

  rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------ M2 效果扩面 */

check('validate: audio 图层——volume/stop/loop/atMs 越界报错，缺 src 只警告，audio 轨道提醒忽略', () => {
  const mk = (props: Record<string, unknown>, tracks: unknown[] = []) => {
    const spec = demoSpec()
    spec.scenes[0].layers = [{ id: 'bgm', name: 'BGM', type: 'audio', props, tracks } as never]
    return validateSpec(spec)
  }
  assert.equal(mk({ src: 'asset:bgm' }).ok, true)
  const noSrc = mk({})
  assert.equal(noSrc.ok, true, '缺 src 是软警告不是硬错误')
  if (noSrc.ok) assert.ok(noSrc.warnings.some(w => w.includes('audio') && w.includes('src')), JSON.stringify(noSrc.warnings))
  const badVolume = mk({ src: 'asset:bgm', volume: 1.5 })
  assert.equal(badVolume.ok, false)
  if (!badVolume.ok) assert.ok(badVolume.errors.some(e => e.path.endsWith('/props/volume')))
  const badStop = mk({ src: 'asset:bgm', stop: 'forever' })
  assert.equal(badStop.ok, false)
  if (!badStop.ok) assert.ok(badStop.errors.some(e => e.path.endsWith('/props/stop')))
  const withTracks = mk({ src: 'asset:bgm' }, [{ id: 't', target: 'props.volume', keys: [{ atMs: 0, value: 1 }] }])
  assert.equal(withTracks.ok, true)
  if (withTracks.ok) assert.ok(withTracks.warnings.some(w => w.includes('轨道不参与')), JSON.stringify(withTracks.warnings))
})

check('validate: 转场/退场 kind 闭合校验——写错值报错并给可选列表，zoomIn 不可作退场', () => {
  const withTransition = (transition: unknown, exit?: unknown) => {
    const spec = demoSpec()
    spec.scenes[0].transition = transition as never
    if (exit !== undefined) spec.scenes[0].exit = exit as never
    return validateSpec(spec)
  }
  assert.equal(withTransition({ kind: 'flyIn', durationMs: 400 }).ok, false)
  assert.equal(withTransition({ kind: 'zoomIn', durationMs: 400 }).ok, true)
  assert.equal(withTransition({ kind: 'fade', durationMs: 400 }, { kind: 'slideDown', durationMs: 500 }).ok, true)
  const badExit = withTransition({ kind: 'none', durationMs: 0 }, { kind: 'zoomIn', durationMs: 500 })
  assert.equal(badExit.ok, false, 'zoomIn 是进入画面的形态，不可作退场')
})

check('validate: narration cues 结构——atMs 非法/空 text/durationMs 非正报错', () => {
  const spec = demoSpec()
  spec.narration = { cues: [{ atMs: 500, text: '你好' }, { atMs: -1, text: '坏' }, { atMs: 600, text: '' }, { atMs: 700, text: '坏', durationMs: 0 }] }
  const r = validateSpec(spec)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.errors.some(e => e.path === '/narration/cues/1/atMs'))
    assert.ok(r.errors.some(e => e.path === '/narration/cues/2/text'))
    assert.ok(r.errors.some(e => e.path === '/narration/cues/3/durationMs'))
  }
})

check('collectAudioTracks: 音轨清单——specEnd/loop/atMs/volume 语义、缺失资产警告降级、场景起点累计换算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anim-audio-'))
  const wav = join(dir, 'bgm.wav')
  writeFileSync(wav, 'x') // 内容无所谓，只验 existsSync 路径
  const spec = demoSpec()
  spec.scenes = [
    { id: 'a', name: '一', durationMs: 2000, layers: [
      { id: 'bgm', name: 'BGM', type: 'audio', props: { src: 'asset:bgm', volume: 0.3, loop: true, stop: 'specEnd' }, tracks: [] },
      { id: 'ghost', name: '幽灵', type: 'audio', props: {}, tracks: [] },
    ] },
    { id: 'b', name: '二', durationMs: 3000, layers: [
      { id: 'sfx', name: '音效', type: 'audio', props: { src: 'asset:sfx', atMs: 500 }, tracks: [] },
      { id: 'loud', name: '过响', type: 'audio', props: { src: 'asset:bgm', volume: 1.5, atMs: 500 }, tracks: [] },
    ] },
  ] as never
  spec.assets = {
    bgm: { kind: 'audio', src: wav },
    sfx: { kind: 'audio', src: join(dir, 'missing.wav') },
  }
  const { cues, warnings } = collectAudioTracks(spec)
  // BGM：随第一幕起点响到片尾（2s + 3s = 5000ms）；ghost（未登记 src）与
  // sfx（资产文件缺失）被警告降级；volume 1.5 钳制为 1 的 loud 保留
  assert.equal(cues.length, 2, `cues: ${JSON.stringify(cues)}`)
  assert.deepEqual(cues[0], { assetId: 'bgm', source: wav, startMs: 0, durationMs: 5000, volume: 0.3, loop: true })
  // loud：第二幕起点 2000 + 偏移 500，响到片尾（5000），音量钳为 1
  assert.equal(cues[1]!.startMs, 2500)
  assert.equal(cues[1]!.durationMs, 2500)
  assert.equal(cues[1]!.volume, 1, 'volume 1.5 已钳制为 1')
  assert.ok(warnings.some(w => w.includes('ghost') && w.includes('src')), JSON.stringify(warnings))
  assert.ok(warnings.some(w => w.includes('不存在')), JSON.stringify(warnings))
  assert.ok(warnings.some(w => w.includes('1.5')), 'volume 越界钳制要给警告')
  rmSync(dir, { recursive: true, force: true })
})

check('collectAudioTracks: 音轨不撑长时间线——audio 轨道不参与 sceneDurationMs/specDurationMs', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [{
    id: 'bgm', name: 'BGM', type: 'audio',
    props: { src: 'asset:bgm' },
    tracks: [{ id: 't', target: 'props.volume', keys: [{ atMs: 0, value: 0 }, { atMs: 90_000, value: 1 }] }],
  } as never]
  assert.equal(specDurationMs(spec.scenes), 2000, '写错的 audio 轨道不得把 2s 的幕撑到 90s')
})

check('generateFontsCss + project.tsx: font 资产生成 @font-face 并注入 import；无 font 资产不生成', () => {
  const withFont = demoSpec()
  withFont.assets = {
    'my-font': { kind: 'font', src: 'C:/fonts/My-Font.TTF' },
    remote: { kind: 'font', src: 'https://example.com/f/r.woff2' },
    pic: { kind: 'image', src: 'C:/x.png' },
  }
  const css = generateFontsCss(withFont.assets)
  assert.ok(css, '有 font 资产必须生成 fonts.css')
  assert.equal(css!.path, 'fonts.css')
  assert.ok(css!.content.includes("font-family: 'my-font'"), css!.content)
  assert.ok(css!.content.includes("url('/assets/my-font.ttf') format('truetype')"), '文件 URL 用 safeName 净化串 + 扩展名小写')
  assert.ok(css!.content.includes("font-family: 'remote'"), css!.content)
  assert.ok(css!.content.includes("url('https://example.com/f/r.woff2') format('woff2')"), '远端字体 URL 原样引用并识别格式')
  const result = generateProject(withFont)
  const tsx = result.files.find(f => f.path === 'project.tsx')!.content
  assert.ok(tsx.includes("import './fonts.css';"), tsx)
  const without = generateProject(demoSpec())
  assert.ok(!without.files.some(f => f.path === 'fonts.css'))
  assert.ok(!without.files.find(f => f.path === 'project.tsx')!.content.includes('fonts.css'))
})

check('expandNarration: cue 展开为各幕 scene.subtitles（本地毫秒）——solo 切片后字幕不丢（§4.3 真机缺陷回归）', () => {
  const spec = demoSpec()
  spec.scenes = [
    { id: 'a', name: '一', durationMs: 2000, layers: [] },
    { id: 'b', name: '二', durationMs: 2000, layers: [] },
  ] as never
  spec.narration = {
    cues: [
      { atMs: 1000, text: '跨幕字幕' }, // 缺省时长 max(1200, 4字≈1000)=1200 → [1000, 2200)
      { atMs: 5000, text: '片外 cue' }, // 全片 4000ms，起在外面
      { atMs: 2500, text: '长'.repeat(45) },
    ],
  }
  const { spec: expanded, warnings } = expandNarration(spec)
  assert.equal(expanded.narration, undefined, '展开后顶层 narration 摘除')
  assert.deepEqual(expanded.scenes[0]!.subtitles, [{ text: '跨幕字幕', startMs: 1000, endMs: 2000 }])
  assert.equal(expanded.scenes[1]!.subtitles!.length, 2)
  assert.deepEqual(expanded.scenes[1]!.subtitles![0], { text: '跨幕字幕', startMs: 0, endMs: 200 })
  assert.equal(expanded.scenes[1]!.subtitles![1]!.text, `${'长'.repeat(39)}…`, '超长截断到 40 字含省略号')
  assert.equal(expanded.scenes[1]!.subtitles![1]!.startMs, 500, '全局 2500ms 在幕 b 的本地时间是 500ms')
  assert.ok(warnings.some(w => w.includes('5000')), JSON.stringify(warnings))
  assert.ok(warnings.some(w => w.includes('40 字')), JSON.stringify(warnings))
  // 入参不被修改
  assert.equal(spec.scenes[0].subtitles, undefined)
  assert.ok(spec.narration, '入参 narration 保留')
  // 关键回归：只渲第二幕（场景级增量的 solo 切片）时字幕跟着场景走、本地时间不变——
  // 此前在切片后的 spec 上按全局时间现场换算，第二幕字幕整条丢失
  const solo = { ...expanded, scenes: [expanded.scenes[1]!] }
  const tsx = generateProject(solo).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  assert.ok(tsx.includes('"跨幕字幕"'), `solo 切片后字幕应保留：\n${tsx}`)
  // 跨幕字幕的幕 b 段是 [0,200)：时段 <300ms 时渐变自动减半为 100ms
  assert.ok(tsx.includes('delay(0, nsub0tx().opacity(1, 0.1)'), tsx)
  // 与本幕交集不足 30ms 的尾巴不生成
  const edge = demoSpec()
  edge.scenes = spec.scenes
  edge.narration = { cues: [{ atMs: 1980, text: '擦边', durationMs: 40 }] }
  assert.equal(expandNarration(edge).spec.scenes[1]!.subtitles, undefined)
})

check('codegen: 字幕条/转场扩族/exit 退场落进 TSX——绝对时间 delay、不与尾部 waitFor 打架', () => {
  const spec = demoSpec()
  spec.scenes[0].transition = { kind: 'zoomIn', durationMs: 500 }
  spec.scenes[0].exit = { kind: 'fade', durationMs: 500 }
  spec.narration = { cues: [{ atMs: 200, text: '字幕', durationMs: 1000 }] }
  const result = generateProject(spec)
  const tsx = result.files.find(f => f.path.startsWith('scenes/s0-'))!.content
  // zoomIn 入场：scale 0.6 起步 + 淡入
  assert.ok(tsx.includes('view.scale(0.6);'), tsx)
  assert.ok(tsx.includes('view.opacity(0);'), tsx)
  assert.ok(tsx.includes('view.scale(1, 0.5'), tsx)
  // exit fade：占用本幕最后 500ms（delay 1.5s 起，长 0.5s）
  assert.ok(tsx.includes('delay(1.5, view.opacity(0, 0.5'), tsx)
  // 退场已顶满 2s 时长：不再有尾部 waitFor 把退场后再拖一段静止
  assert.ok(!tsx.includes('waitFor('), `exit 后不应有尾部 waitFor：\n${tsx}`)
  // 字幕条：合成图层在 TSX 里，按时段淡入淡出（cue [200,1200]，150ms 渐变）
  assert.ok(tsx.includes('createRef<Rect>()'), tsx)
  assert.ok(tsx.includes('createRef<Txt>()'), tsx)
  assert.ok(tsx.includes('"字幕"'), tsx)
  assert.ok(tsx.includes('delay(0.2, nsub0tx().opacity(1, 0.15)'), tsx)
  assert.ok(tsx.includes('delay(1.05, nsub0tx().opacity(0, 0.15)'), tsx)
  // slideRight/slideDown 入场：起点与终点都相对画布中心（640/360）——
  // 写成 0 会把整个 view（连同背景）贴到画布边缘（M2 真机抓到的潜伏缺陷）
  const slideSpec = demoSpec()
  slideSpec.scenes[0].transition = { kind: 'slideRight', durationMs: 400 }
  const slideTsx = generateProject(slideSpec).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  assert.ok(slideTsx.includes('view.x(440);'), `slideRight 应从中心左 200px 进入：\n${slideTsx}`)
  assert.ok(slideTsx.includes('view.y(360);'), slideTsx)
  assert.ok(slideTsx.includes('delay(0, view.x(640, 0.4)),'), slideTsx)
  const downSpec = demoSpec()
  downSpec.scenes[0].transition = { kind: 'slideDown', durationMs: 400 }
  const downTsx = generateProject(downSpec).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  assert.ok(downTsx.includes('view.y(160);'), downTsx)
  assert.ok(downTsx.includes('delay(0, view.y(360, 0.4)),'), downTsx)
  // slide 退场：滑出半幅再带 240px 余量
  const exitSpec = demoSpec()
  exitSpec.scenes[0].exit = { kind: 'slideLeft', durationMs: 500 }
  const exitTsx = generateProject(exitSpec).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  assert.ok(exitTsx.includes('delay(1.5, view.x(-880, 0.5)),'), exitTsx)
})

check('codegen: 缓动扩族 bounce/elastic/back 映射到 MC 的 easeOut*（映射 × MC 实际导出双保险）', () => {
  const mk = (kind: string) => {
    const spec = demoSpec()
    spec.scenes[0].layers[0].tracks[0].keys[1].ease = { kind } as never
    return generateProject(spec).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  }
  assert.ok(mk('bounce').includes(', easeOutBounce)'), mk('bounce'))
  assert.ok(mk('elastic').includes(', easeOutElastic)'), mk('elastic'))
  assert.ok(mk('back').includes(', easeOutBack)'), mk('back'))
  // 防 MC 升级漂移：映射目标必须是 MC 实际导出的函数（core 无法被 node 直接
  // import——内部有目录导入，只有 vite 能解析——所以读它的 .d.ts 静态断言）
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@motion-canvas/core')
  const pkgRoot = dirname(dirname(entry)) // <pkg>/lib/index.js → <pkg>
  const decl = readFileSync(join(pkgRoot, 'lib', 'tweening', 'timingFunctions.d.ts'), 'utf8')
  for (const fn of ['easeOutBounce', 'easeOutElastic', 'easeOutBack']) {
    assert.ok(decl.includes(`const ${fn}`), `MC 缓动导出漂移：找不到 ${fn}（${join(pkgRoot, 'lib', 'tweening')}）`)
  }
})

check('codegen: code morph 转正——props.code 多字符串关键帧生成带时长的补间（非离散跳变）', () => {
  const spec = demoSpec()
  spec.scenes[0].layers = [{
    id: 'snippet', name: '代码', type: 'code',
    props: { code: 'const a = 1;', language: 'typescript' },
    tracks: [{
      id: 'morph', target: 'props.code',
      keys: [
        { atMs: 0, value: 'const a = 1;' },
        { atMs: 1000, value: 'const a = 1 + 2;', ease: { kind: 'easeInOut' } },
      ],
    }],
  } as never]
  const tsx = generateProject(spec).files.find(f => f.path.startsWith('scenes/s0-'))!.content
  // 带时长的补间形态：code(新值, 1, easeInOutCubic)——diff morph 由 MC CodeSignal 完成
  assert.ok(tsx.includes('.code("const a = 1 + 2;", 1, easeInOutCubic)'), `应生成带时长的 code 补间：\n${tsx}`)
  // 初值照常落
  assert.ok(tsx.includes('.code("const a = 1;");'), tsx)
})

check('coerceScene: 新缓动字符串（back/bounce/elastic）包装后过校验', () => {
  const { scene, repairs } = coerceScene({
    id: 's', name: 'S', durationMs: 1000,
    layers: [{ id: 'l', name: 'L', type: 'rect', props: { width: 10, height: 10 }, tracks: [{ id: 't', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 300, value: 1, ease: 'back' }] }] }],
  })
  const r = validateSpec({ ...demoSpec(), scenes: [scene as never] })
  assert.equal(r.ok, true, JSON.stringify(r.ok ? r.warnings : r.errors))
  assert.ok(repairs.some(x => x.includes('ease')), JSON.stringify(repairs))
})

await checkA('opRender: audioTracks 进同步回执与完成事件（§4.1 契约）', async () => {
  const { deps, emitted, emit } = renderFixture(async () => ({ ...RENDER_RESULT, audioTracks: ['bgm'] }))
  const result = await opRender(deps, { specId: 'gd' }, new AbortController().signal, emit)
  assert.deepEqual((result as { audioTracks?: string[] }).audioTracks, ['bgm'])
  const finished = emitted.find(e => e.type === 'anim/render-finished')!
  assert.deepEqual((finished.data as { audioTracks?: string[] }).audioTracks, ['bgm'])
})

/** 生成单声道 16bit PCM WAV（正弦波），给 mux 冒烟当音源。 */
function makeWav(path: string, ms: number, freq = 440, rate = 8000): void {
  const n = Math.round((ms / 1000) * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

/** ffprobe 读流信息；ffprobe 缺装返回 null（调用方降级为只验退出码）。 */
async function probeStreams(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv', path])
    return String(stdout ?? '')
  } catch {
    return null
  }
}

await checkA('muxAudioTracks: 真机 ffmpeg——adelay 对齐 + loop 钳制 + amix 求和，视频流零重编码', async () => {
  if (!(await ffmpegAvailable())) {
    console.log('    （本机无 ffmpeg，跳过音轨混流端到端断言）')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'anim-mux-'))
  const frameDir = join(dir, 'frames')
  mkdirSync(frameDir, { recursive: true })
  for (let i = 0; i < 10; i++) writeFileSync(join(frameDir, `${String(i).padStart(6, '0')}.png`), PNG_2X2)
  const video = join(dir, 'video.mp4')
  await encodeFrames(frameDir, 10, 10, video) // 10fps × 10 帧 = 1s
  makeWav(join(dir, 'a.wav'), 300)
  makeWav(join(dir, 'b.wav'), 2000) // 比 cue 时长长：验 atrim 钳制
  await muxAudioTracks(video, [
    { assetId: 'a', source: join(dir, 'a.wav'), startMs: 0, durationMs: 1000, volume: 1, loop: false },
    { assetId: 'b', source: join(dir, 'b.wav'), startMs: 500, durationMs: 500, volume: 0.5, loop: true },
  ], 1)
  assert.ok(existsSync(video), '混音产物替换原视频')
  const streams = await probeStreams(video)
  if (streams !== null) {
    assert.ok(streams.includes('audio'), `应有音频流：${streams}`)
    assert.ok(streams.includes('video'), `视频流保留：${streams}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

await checkA('MotionCanvasRenderer.render: audio 图层端到端——增量路径拼接后自动混音，回执带 audioTracks', async () => {
  if (!(await ffmpegAvailable())) {
    console.log('    （本机无 ffmpeg，跳过音轨渲染端到端断言）')
    return
  }
  const runtime = {
    async materialize(): Promise<void> {},
    async renderProject(options: { workDir: string; expectedFrames: number }) {
      const frameDir = join(options.workDir, 'frames')
      mkdirSync(frameDir, { recursive: true })
      for (let i = 0; i < options.expectedFrames; i++) {
        writeFileSync(join(frameDir, `${String(i).padStart(6, '0')}.png`), PNG_2X2)
      }
      return { frameDir, frameCount: options.expectedFrames }
    },
    async probe() {
      return { renderer: 'motion-canvas', ok: true, issues: [] }
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'anim-audio-e2e-'))
  makeWav(join(dir, 'bgm.wav'), 2500)
  const spec = demoSpec()
  spec.meta.id = 'audio-e2e'
  spec.meta.fps = 10
  spec.assets = { bgm: { kind: 'audio', src: join(dir, 'bgm.wav') } }
  spec.scenes[0]!.layers.push({
    id: 'bgm', name: 'BGM', type: 'audio',
    props: { src: 'asset:bgm', volume: 0.4, loop: true, stop: 'specEnd' },
    tracks: [],
  } as never)
  const workDir = mkdtempSync(join(tmpdir(), 'anim-audio-work-'))
  const renderer = new MotionCanvasRenderer({ runtime: runtime as never, workDir })
  const out = join(dir, 'out.mp4')
  const r = await renderer.render({ spec, outputPath: out }, new AbortController().signal)
  assert.deepEqual(r.audioTracks, ['bgm'])
  const streams = await probeStreams(out)
  if (streams !== null) assert.ok(streams.includes('audio'), `成片应有音频流：${streams}`)
  rmSync(dir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

console.log(`\n冒烟通过：${passed} 项`)
