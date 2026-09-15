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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// 直接引用工作区源码（tsx 直跑 TS），根 package.json 因此不依赖 workspace: 协议，
// 离线打包器在暂存目录里的 npm install 不会被它绊住
import {
  ANIMATABLE_BY_TYPE,
  COMPONENT,
  generateProject,
  generateProjectMeta,
  MotionCanvasRenderer,
  pickScenes,
  STATIC_PROPS,
} from '../packages/render-mc/src/index.ts'
import {
  applyPatch,
  LAYER_TYPES,
  sceneDurationMs,
  specDurationMs,
  truncateSpecAtMs,
  tweensOf,
  validateSpec,
} from '../packages/spec/src/index.ts'
import type { AnimationSpec, LayerType } from '../packages/spec/src/index.ts'
import { foldEvents, SpecStore } from '../packages/store/src/index.ts'
import { AnimRendererRegistry } from '../packages/tools/src/index.ts'
import type { AnimEvent } from '../packages/tools/src/events.ts'
import { opRender, opAssetImport } from '../packages/tools/src/ops.ts'
import type { AnimDeps, AnimJobsService } from '../packages/tools/src/ops.ts'
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

/** 渲染测试共用脚手架：假后端 + 事件收集器。 */
function renderFixture(renderImpl: AnimRenderer['render']) {  const store = new SpecStore()
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

console.log(`\n冒烟通过：${passed} 项`)
