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

import type { AnimationSpec, EaseSpec, JsonValue, KeyframeValue, Layer, LayerProps, LayerType, Scene } from '@dsh-anim/spec'
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

/**
 * 所有 Layout 系节点（Rect/Circle/Txt/Img/Line…）都有的尺寸/变换信号。
 * 单独列出来，是为了让「size/width/height 对所有图层可动画」成立——
 * MC 的 Layout 基类就有这三个 signal，不写进各类型的静态表也能动。
 */
const LAYOUT_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'size', 'width', 'height'] as const

/** 各图层类型可接受的静态属性（值 = MC 组件上的属性名）。 */
const STATIC_PROPS: Record<LayerType, Record<string, string>> = {
  text: { text: 'text', fontSize: 'fontSize', fontFamily: 'fontFamily', fontWeight: 'fontWeight', fill: 'fill', lineHeight: 'lineHeight' },
  rect: { width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth', radius: 'radius' },
  // Circle 原生支持 width/height（width≠height 即椭圆），radius/r 是圆的半径，
  // 由 normalizeLayerProps 换算成 size；见 0.3.0 规划 §1.4（圆形画不出来的修复）。
  circle: { size: 'size', width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  image: { src: 'src', width: 'width', height: 'height' },
  // 成员经 children 引用，由 genSceneFile 组合成 Node 容器；静态属性只有变换。
  group: {},
  // Line 的 start/end（0~1 画线进度）与 endArrow/arrowSize 都是 Curve 内建 signal
  line: { points: 'points', lineWidth: 'lineWidth', stroke: 'stroke', start: 'start', end: 'end', startArrow: 'startArrow', endArrow: 'endArrow', arrowSize: 'arrowSize' },
  arrow: { points: 'points', lineWidth: 'lineWidth', stroke: 'stroke', start: 'start', end: 'end', startArrow: 'startArrow', endArrow: 'endArrow', arrowSize: 'arrowSize' },
  // MC 没有独立的 Ellipse 节点：椭圆 = Circle + width/height（官方用法）
  ellipse: { size: 'size', width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
}

/**
 * 各类型可动画的目标集合：LAYOUT 信号 + 该类型静态属性表里的键。
 *
 * 不能再用全局大集合——rect 有 fill、image 没有，全局集合会把「对 Img 补间
 * fill」这种运行时才会崩的代码放出去。按类型派生，不支持的动画目标走警告降级。
 */
const ANIMATABLE_BY_TYPE: Record<LayerType, Set<string>> = Object.fromEntries(
  (Object.keys(STATIC_PROPS) as LayerType[]).map(type => [
    type,
    new Set<string>([...LAYOUT_PROPS, ...Object.keys(STATIC_PROPS[type])]),
  ]),
) as Record<LayerType, Set<string>>

const COMPONENT: Record<LayerType, string | null> = {
  text: 'Txt',
  rect: 'Rect',
  circle: 'Circle',
  image: 'Img',
  group: 'Node', // 容器：成员用 .add() 挂进来，变换属性作用于整组
  line: 'Line',
  arrow: 'Line', // Line + endArrow（Curve 内建箭头，arrowSize 默认 24）
  ellipse: 'Circle',
}

/* -------------------------------------------------------------- 工具函数 */

function lit(value: KeyframeValue): string {
  if (typeof value === 'number' && Number.isFinite(value)) return num(value)
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/** 属性值字面量：数组（points）走 JSON，原样进 JSX。 */
function litProp(value: JsonValue): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (value === null) return 'null'
  return lit(value as KeyframeValue)
}

/**
 * 按类型把 props 归一化成最终要写进 JSX 的属性表，并产出警告。
 * 处理三类「模型常写错、静默画不出来」的形态：
 * - circle 的 radius/r → size×2（MC Circle 没有 radius 信号）；
 * - circle 缺尺寸 → 默认 size=100（MC 默认 0×0 不可见）；
 * - 封闭形状（rect/circle/ellipse）既无 fill 也无 stroke → 主题文字色兜底；
 * - line/arrow 缺 stroke → 主题文字色兜底；arrow 默认开 endArrow。
 */
function normalizeLayerProps(
  type: LayerType,
  props: LayerProps,
  defaultTextFill: string,
  warnings: string[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    out[k] = v as JsonValue
  }
  if (type === 'group') {
    // children 是组合引用，由 genSceneFile 消费，不是节点属性
    delete out.children
    return out
  }
  if ((type === 'rect' || type === 'circle' || type === 'ellipse') && out.fill === undefined && out.stroke === undefined) {
    out.fill = defaultTextFill
    warnings.push(`图层（${type}）既无 fill 也无 stroke，已按主题文字色填充兜底`)
  }
  if (type === 'circle') {
    const r = out.radius ?? out.r
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
      delete out.radius
      delete out.r
      if (out.size === undefined && out.width === undefined && out.height === undefined) {
        out.size = r * 2
        warnings.push(`circle 图层写了 radius=${r}，已换算为 size=${r * 2}`)
      } else {
        warnings.push(`circle 图层写了 radius=${r}，但已指定尺寸，radius 被忽略`)
      }
    }
    if (out.size === undefined && out.width === undefined && out.height === undefined) {
      out.size = 100
      warnings.push('circle 图层未指定尺寸（size/width/height/radius），已按 size=100 兜底')
    }
  }
  if (type === 'line' || type === 'arrow') {
    if (out.stroke === undefined) {
      out.stroke = defaultTextFill
      warnings.push(`${type} 图层未指定 stroke，已按主题文字色描边兜底`)
    }
    if (type === 'arrow' && out.endArrow === undefined && out.startArrow === undefined) {
      out.endArrow = true
    }
  }
  return out
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
 * durationMs 对齐（预览与成片会不一致）。所以两者都内联实现到生成的
 * anim-easing.ts 里，随项目一起编译。
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

  // Pass 1：分组关系。group 的 children 引用同一场景内的图层 id；
  // MVP 单层分组（组内不套组），冲突引用以警告降级而不是失败。
  const parentOf = new Map<string, string>() // 成员 id → 组 id
  const membersOf = new Map<string, string[]>() // 组 id → 成员 id 列表
  for (const layer of scene.layers) {
    if (layer.type !== 'group') continue
    const kids = Array.isArray(layer.props.children) ? layer.props.children : []
    for (const childId of kids) {
      if (childId === layer.id) {
        warnings.push(`group ${layer.id} 不能包含自己，已忽略`)
        continue
      }
      const child = scene.layers.find(l => l.id === childId)
      if (!child) {
        warnings.push(`group ${layer.id} 引用了不存在的图层 ${childId}，已忽略`)
        continue
      }
      if (child.type === 'group') {
        warnings.push(`group ${layer.id} 包含另一个 group（${childId}），MVP 不支持组内套组，已忽略`)
        continue
      }
      if (parentOf.has(childId)) {
        warnings.push(`图层 ${childId} 被多个 group 引用，只归入第一个（${parentOf.get(childId)}）`)
        continue
      }
      parentOf.set(childId, layer.id)
      membersOf.set(layer.id, [...(membersOf.get(layer.id) ?? []), childId])
    }
  }

  // 变量名 = 图层在数组里的位置 + 净化后的 id（与文件内唯一性解耦）
  const varName = (layer: Layer): string => `n${scene.layers.indexOf(layer)}_${sanitize(layer.id)}`

  /**
   * 生成单个图层的节点创建：createRef + 挂到 parentExpr（view 或组节点）。
   * 返回该图层的变量名，轨道生成要用它。
   */
  const emitNode = (layer: Layer, parentExpr: string): string => {
    const component = COMPONENT[layer.type]
    if (component === null) {
      warnings.push(`图层 ${layer.id}（${layer.name}）类型 ${layer.type} 暂未实现，已跳过`)
      return ''
    }
    components.add(component)
    const name = varName(layer)

    const attrs = [`ref={${name}}`]
    const allowed: Record<string, string> = { ...STATIC_PROPS[layer.type] }
    for (const key of COMMON_PROPS) allowed[key] = key
    const normalized = normalizeLayerProps(layer.type, layer.props, defaultTextFill, warnings)
    for (const [rawProp, value] of Object.entries(normalized)) {
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
      attrs.push(`${mapped}={${litProp(value)}}`)
    }
    // text 没写 fill 时 MC 默认深色，在深底上就是「黑字黑底」看不见——兜底主题文字色
    if (layer.type === 'text' && normalized.fill === undefined && normalized.color === undefined) {
      attrs.push(`fill={${JSON.stringify(defaultTextFill)}}`)
    }
    setup.push(`const ${name} = createRef<${component}>();`)
    setup.push(`${parentExpr}.add(<${component} ${attrs.join(' ')} />);`)
    coreImports.add('createRef')
    return name
  }

  /** 生成一个图层的轨道：初值 + 补间。 */
  const emitTracks = (layer: Layer): void => {
    const name = varName(layer)
    // 轨道：先落初值，再产出补间
    const initials = new Map<string, string>()
    const animatable = ANIMATABLE_BY_TYPE[layer.type]
    for (const track of layer.tracks) {
      const prop = track.target.replace(/^props\./, '')
      if (!animatable.has(prop)) {
        warnings.push(`图层 ${layer.id} 的轨道目标 ${track.target} 不可动画，已忽略`)
        continue
      }
      const keys = [...track.keys].sort((a, b) => a.atMs - b.atMs)
      if (keys.length === 0) continue
      initials.set(prop, `${name}().${prop}(${lit(keys[0].value)});`)

      for (const t of tweensOf(track)) {
        const ease = easeExpr(t.ease, imports)
        const easeArg = ease ? `, ${ease}` : ''
        if (t.durationMs <= 0) {
          // 离散跳变：delay 也接受普通 callback
          tasks.push(`delay(${sec(t.startMs)}, () => ${name}().${prop}(${lit(t.to)})),`)
        } else {
          tasks.push(`delay(${sec(t.startMs)}, ${name}().${prop}(${lit(t.to)}, ${sec(t.durationMs)}${easeArg})),`)
        }
      }
    }
    initial.push(...initials.values())
  }

  // 主循环：group 的成员随所属组一起生成（保证父节点先于子节点存在）
  for (const layer of scene.layers) {
    if (parentOf.has(layer.id)) continue // 成员由所属 group 内联生成
    if (layer.type === 'group') {
      const name = emitNode(layer, 'view')
      for (const memberId of membersOf.get(layer.id) ?? []) {
        const member = scene.layers.find(l => l.id === memberId)!
        emitNode(member, `${name}()`)
        emitTracks(member)
      }
      emitTracks(layer)
      continue
    }
    emitNode(layer, 'view')
    emitTracks(layer)
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
