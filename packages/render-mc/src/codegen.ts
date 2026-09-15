/**
 * AnimationSpec → Motion Canvas 项目源码。
 *
 * 两个不那么显然、但踩过就忘不掉的点：
 *
 * 1. **时序转换**：IR 用绝对毫秒，Motion Canvas 用 `yield*` 串起来的相对时长。
 *    做法是每条轨道展开成补间段，再用 `all(delay(startSec, node.prop(to, durSec, ease)))`
 *    钉回绝对时间轴——`delay` 在 `all` 内是相对偏移，正好等于 IR 的绝对起点。
 *
 * 2. **场景必须走 `?scene` 导入**：`makeScene2D` 只给出 SceneDescription，而
 *    makeProject 需要的是 FullSceneDescription（多出 name/size/logger/timeEventsClass/
 *    sharedWebGLContext…），这些字段由 vite-plugin 在 `?scene` 导入时注入。
 *    直接把 makeScene2D 内联进 scenes 数组，渲染器会在 reloadScenes 里崩掉。
 */

import type { AnimationSpec, EaseSpec, KeyframeValue, Layer, LayerType, Scene } from '@dsh-anim/spec'
import { sceneDurationMs, tweensOf } from '@dsh-anim/spec'

export interface GeneratedFile {
  /** 相对项目 src 目录的路径。 */
  path: string
  content: string
}

export interface GenerateResult {
  files: GeneratedFile[]
  /** 生成期降级（属性不被支持、图层类型未实现等），不阻断渲染。 */
  warnings: string[]
}

/* ------------------------------------------------------------ 属性白名单 */

const COMMON_PROPS = ['x', 'y', 'opacity', 'scale', 'rotation'] as const

/** 各图层类型可接受的静态属性（值 = MC 组件上的属性名）。 */
const STATIC_PROPS: Record<LayerType, Record<string, string>> = {
  text: { text: 'text', fontSize: 'fontSize', fontFamily: 'fontFamily', fontWeight: 'fontWeight', fill: 'fill', lineHeight: 'lineHeight' },
  rect: { width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth', radius: 'radius' },
  circle: { size: 'size', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  image: { src: 'src', width: 'width', height: 'height' },
  group: {},
}

/** 可作为动画目标的属性（MC 上必须存在同名 signal）。 */
const ANIMATABLE = new Set<string>([
  ...COMMON_PROPS, 'fill', 'stroke', 'lineWidth', 'radius', 'width', 'height', 'size', 'fontSize', 'text',
])

const COMPONENT: Record<LayerType, string | null> = {
  text: 'Txt',
  rect: 'Rect',
  circle: 'Circle',
  image: 'Img',
  group: null, // MVP 未实现分组
}

/* -------------------------------------------------------------- 工具函数 */

function lit(value: KeyframeValue | string | number | boolean): string {
  if (typeof value === 'number' && Number.isFinite(value)) return num(value)
  return JSON.stringify(String(value))
}

function num(v: number): string {
  return String(Number(v.toFixed(6)))
}

/** 毫秒 → 秒（MC 的时间单位是秒）。 */
function sec(ms: number): string {
  return num(ms / 1000)
}

/**
 * 同时用于文件名和 TS 变量名，所以只保留 `[A-Za-z0-9_]`——
 * 连字符也得换掉：图层 id 里的 `-` 会让 `const n2_ball-label` 变成语法错误。
 */
function sanitize(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[0-9]/.test(s) ? `_${s}` : s.length > 0 ? s : 'scene'
}

/* ---------------------------------------------------------------- 缓动 */

/**
 * MC 没有导出 `cubicBezier`；原生 `spring` 的时长由物理决定、无法与 IR 的
 * durationMs 对齐（预览与成片会不一致）。所以两者都内联实现，公式与
 * spec 层的 applyEase 保持一致。
 */
const EASING_FILE = `/**
 * IR 缓动的内联实现。由 @dsh-anim/render-mc 生成，请勿手工编辑。
 *
 * - cubicBezier：MC 未导出同名函数，二分求解参数 s。
 * - springTiming：阻尼弹簧解析解，在 t=1 处收敛到 1；不用 MC 原生 spring，
 *   因为它的时长由物理参数决定，无法与 IR 的 durationMs 契约对齐。
 */

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bez = (s: number, p1: number, p2: number) =>
    3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
  return (t: number) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < t) lo = mid; else hi = mid;
    }
    return bez((lo + hi) / 2, y1, y2);
  };
}

export function springTiming(stiffness: number, damping: number, mass: number) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  return (t: number) => {
    const p = Math.min(1, Math.max(0.0001, t));
    return 1 - Math.exp(-zeta * w0 * p) * (Math.cos(wd * p) + ((zeta * w0) / wd) * Math.sin(wd * p));
  };
}
`

/**
 * 返回缓动表达式，并把需要 import 的名字记进对应的集合：
 * `core` 是 @motion-canvas/core 导出的缓动函数，`local` 是随项目生成的
 * anim-easing.ts 内联实现（cubicBezier / spring）。
 */
function easeExpr(
  ease: EaseSpec | undefined,
  imports: { core: Set<string>; local: Set<string> },
): string {
  if (!ease) return ''
  switch (ease.kind) {
    case 'linear':
      imports.core.add('linear')
      return 'linear'
    case 'easeIn':
      imports.core.add('easeInCubic')
      return 'easeInCubic'
    case 'easeOut':
      imports.core.add('easeOutCubic')
      return 'easeOutCubic'
    case 'easeInOut':
      imports.core.add('easeInOutCubic')
      return 'easeInOutCubic'
    case 'cubicBezier': {
      imports.local.add('cubicBezier')
      const [x1, y1, x2, y2] = ease.points
      return `cubicBezier(${num(x1)}, ${num(y1)}, ${num(x2)}, ${num(y2)})`
    }
    case 'spring': {
      imports.local.add('springTiming')
      return `springTiming(${num(ease.stiffness ?? 170)}, ${num(ease.damping ?? 26)}, ${num(ease.mass ?? 1)})`
    }
  }
}

/* ------------------------------------------------------------ 场景生成 */

function genSceneFile(scene: Scene, index: number, background: string, defaultTextFill: string, warnings: string[]): GeneratedFile {
  const components = new Set<string>()
  const coreImports = new Set<string>()
  const easingImports = new Set<string>()
  const imports = { core: coreImports, local: easingImports }
  const setup: string[] = []
  const initial: string[] = []
  const tasks: string[] = []

  for (const [i, layer] of scene.layers.entries()) {
    const component = COMPONENT[layer.type]
    if (component === null) {
      warnings.push(`图层 ${layer.id}（${layer.name}）类型 ${layer.type} 暂未实现，已跳过`)
      continue
    }
    components.add(component)
    const varName = `n${i}_${sanitize(layer.id)}`

    const attrs = [`ref={${varName}}`]
    const allowed: Record<string, string> = { ...STATIC_PROPS[layer.type] }
    for (const key of COMMON_PROPS) allowed[key] = key
    for (const [rawProp, value] of Object.entries(layer.props)) {
      if (value === undefined) continue
      let prop = rawProp
      // 模型几乎必然写过 color：语义就是填充色，按 fill 处理而不是丢弃
      if (prop === 'color' && !allowed.color && allowed.fill) {
        prop = 'fill'
      }
      const mapped = allowed[prop]
      if (!mapped) {
        warnings.push(`图层 ${layer.id} 的属性 ${rawProp} 不被 ${layer.type} 支持，已忽略`)
        continue
      }
      attrs.push(`${mapped}={${lit(value as KeyframeValue)}}`)
    }
    // text 没写 fill 时 MC 默认深色，在深底上就是「黑字黑底」看不见——兜底主题文字色
    if (layer.type === 'text' && layer.props.fill === undefined && layer.props.color === undefined) {
      attrs.push(`fill={${JSON.stringify(defaultTextFill)}}`)
    }
    setup.push(`const ${varName} = createRef<${component}>();`)
    setup.push(`view.add(<${component} ${attrs.join(' ')} />);`)
    coreImports.add('createRef')

    // 轨道：先落初值，再产出补间
    const initials = new Map<string, string>()
    for (const track of layer.tracks) {
      const prop = track.target.replace(/^props\./, '')
      if (!ANIMATABLE.has(prop)) {
        warnings.push(`图层 ${layer.id} 的轨道目标 ${track.target} 不可动画，已忽略`)
        continue
      }
      const keys = [...track.keys].sort((a, b) => a.atMs - b.atMs)
      if (keys.length === 0) continue
      initials.set(prop, `${varName}().${prop}(${lit(keys[0].value)});`)

      for (const t of tweensOf(track)) {
        const ease = easeExpr(t.ease, imports)
        const easeArg = ease ? `, ${ease}` : ''
        if (t.durationMs <= 0) {
          // 离散跳变：delay 也接受普通 callback
          tasks.push(`delay(${sec(t.startMs)}, () => ${varName}().${prop}(${lit(t.to)})),`)
        } else {
          tasks.push(`delay(${sec(t.startMs)}, ${varName}().${prop}(${lit(t.to)}, ${sec(t.durationMs)}${easeArg})),`)
        }
      }
    }
    initial.push(...initials.values())
  }

  // 进入转场
  if (scene.transition && scene.transition.kind !== 'none') {
    const ease = easeExpr(scene.transition.ease, imports)
    const easeArg = ease ? `, ${ease}` : ''
    const d = sec(scene.transition.durationMs)
    if (scene.transition.kind === 'fade') {
      initial.push('view.opacity(0);')
      tasks.push(`delay(0, view.opacity(1, ${d}${easeArg})),`)
    } else if (scene.transition.kind === 'slideLeft') {
      initial.push('view.x(200);')
      tasks.push(`delay(0, view.x(0, ${d}${easeArg})),`)
    } else if (scene.transition.kind === 'slideUp') {
      initial.push('view.y(200);')
      tasks.push(`delay(0, view.y(0, ${d}${easeArg})),`)
    }
  }

  const duration = sceneDurationMs(scene)
  // 补齐到场景时长，让「留白」也进时间线
  const lastEnd = scene.layers.reduce((max, layer) => {
    for (const track of layer.tracks) {
      for (const t of tweensOf(track)) max = Math.max(max, t.startMs + t.durationMs)
    }
    return max
  }, scene.transition?.durationMs ?? 0)
  // 没有任何 yield 的场景时长为 0，渲染时会直接被跳过——务必至少撑住声明时长
  const tail = duration - lastEnd
  const needsWaitFor = tasks.length === 0 || tail > 1
  if (needsWaitFor) coreImports.add('waitFor')
  if (tasks.length > 0) {
    coreImports.add('all')
    coreImports.add('delay')
  }

  const L: string[] = []
  L.push('/**')
  L.push(` * 场景 ${index + 1}：${scene.name}`)
  L.push(' * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。')
  L.push(' */')
  const scope = [...components].sort().join(', ')
  L.push(`import {${[...coreImports].sort().join(', ')}} from '@motion-canvas/core';`)
  L.push(`import {makeScene2D${scope ? `, ${scope}` : ''}} from '@motion-canvas/2d';`)
  if (easingImports.size > 0) {
    L.push(`import {${[...easingImports].sort().join(', ')}} from '../anim-easing';`)
  }
  L.push('')
  L.push('export default makeScene2D(function* (view) {')
  L.push(`  view.fill('${background}');`)
  L.push('')
  for (const s of setup) L.push(`  ${s}`)
  if (initial.length > 0) {
    L.push('')
    L.push('  // 动画初值：让每条轨道的起点在第一时间生效')
    for (const s of initial) L.push(`  ${s}`)
  }
  L.push('')
  if (tasks.length > 0) {
    L.push('  yield* all(')
    for (const t of tasks) L.push(`    ${t}`)
    L.push('  );')
  }
  if (tasks.length === 0) L.push(`  yield* waitFor(${sec(duration)});`)
  else if (tail > 1) L.push(`  yield* waitFor(${sec(tail)});`)
  L.push('});')
  L.push('')

  return { path: `scenes/s${index}-${sanitize(scene.id)}.tsx`, content: L.join('\n') }
}

/* ------------------------------------------------------------------ meta */

/**
 * 把工具层的 `scale`（降采样除数，2 = 长宽各一半）换算成 MC 的
 * resolutionScale（渲染倍率，0.5 = 一半）。两者互为倒数。
 *
 * 两个坑：
 * - MC 的 Scales 只接受 0.25 / 0.5 / 1 / 2，其他值会被 EnumMetaField
 *   **静默回落到 0.25**，所以这里必须显式对齐到合法档位；
 * - 模型经常把 scale 当「缩放系数」传（0.25 表示四分之一大小），与
 *   除数语义正好互为倒数——小于 1 的入参按系数解释，两种写法殊途同归。
 */
export function resolveResolutionScale(scale: number | undefined): number {
  const SCALES = [0.25, 0.5, 1, 2]
  if (!(typeof scale === 'number' && Number.isFinite(scale) && scale > 0)) return 1
  const divisor = scale < 1 ? 1 / scale : scale
  const target = 1 / divisor
  return SCALES.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), 1)
}

/**
 * MC 的分辨率/帧率/导出格式不在 makeProject 里，而在项目旁的 project.meta。
 * IR 的 meta.fps 与 meta.size 必须落到这里，否则 spec 说 30fps、渲染出来 60fps，
 * 预览与成片对不上，微调就失去意义。
 */
export function generateProjectMeta(spec: AnimationSpec, resolutionScale = 1): string {
  const meta = {
    version: 0,
    shared: {
      background: spec.meta.background ?? null,
      range: [0, null] as [number, null],
      size: { x: spec.meta.size.width, y: spec.meta.size.height },
      audioOffset: 0,
    },
    preview: { fps: spec.meta.fps, resolutionScale },
    rendering: {
      fps: spec.meta.fps,
      resolutionScale,
      colorSpace: 'srgb',
      exporter: {
        name: '@motion-canvas/core/image-sequence',
        options: { fileType: 'image/png', quality: 100, groupByScene: false },
      },
    },
  }
  return JSON.stringify(meta, null, 2)
}

/* ------------------------------------------------------------------ 入口 */

/** 把一份 spec 编译成可直接交给 Motion Canvas 构建的项目文件。 */
export function generateProject(
  spec: AnimationSpec,
  options: { resolutionScale?: number } = {},
): GenerateResult {
  const warnings: string[] = []
  const background = spec.meta.background ?? spec.theme.colors.background ?? '#000000'
  const defaultTextFill = spec.theme.colors.text ?? '#FFFFFF'

  const files: GeneratedFile[] = [{ path: 'anim-easing.ts', content: EASING_FILE }]

  spec.scenes.forEach((scene, i) => {
    files.push(genSceneFile(scene, i, background, defaultTextFill, warnings))
  })

  const imports = spec.scenes.map((s, i) => `import s${i} from './scenes/s${i}-${sanitize(s.id)}?scene';`)
  const L: string[] = []
  L.push('/**')
  L.push(` * ${spec.meta.title}`)
  L.push(' *')
  L.push(' * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。')
  L.push(' * `?scene` 后缀是必需的：vite 插件会给场景补上 makeProject 需要的运行时字段。')
  L.push(' */')
  for (const line of imports) L.push(line)
  L.push(`import {makeProject} from '@motion-canvas/core';`)
  L.push('')
  L.push('export default makeProject({')
  L.push(`  // ${spec.meta.size.width}x${spec.meta.size.height} @ ${spec.meta.fps}fps`)
  L.push('  scenes: [')
  spec.scenes.forEach((_, i) => L.push(`    s${i},`))
  L.push('  ],')
  L.push('});')
  L.push('')
  files.push({ path: 'project.tsx', content: L.join('\n') })
  files.push({ path: 'project.meta', content: generateProjectMeta(spec, options.resolutionScale ?? 1) })

  return { files, warnings }
}
