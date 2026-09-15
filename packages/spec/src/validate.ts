/**
 * 零依赖结构化校验。
 *
 * 为什么自己写而不是引 zod：spec 包要同时进 Node 与浏览器 bundle，
 * 且校验报错需要精确到「哪个场景的哪个图层的哪个关键帧」——这份定制逻辑
 * 比通用 schema 库更短也更可控。
 */

import type {
  AnimationSpec, Asset, EaseSpec, JsonValue, Keyframe, Layer, LayerType,
  Scene, Track,
} from './types.ts'

export interface SpecError {
  /** JSON Pointer 风格的路径，如 `/scenes/0/layers/2/tracks/1/keys/0/atMs`。 */
  path: string
  message: string
}

export type ValidateResult =
  | { ok: true; spec: AnimationSpec; warnings: string[] }
  | { ok: false; errors: SpecError[]; warnings: string[] }

const LAYER_TYPES: ReadonlySet<string> = new Set<LayerType>(['text', 'rect', 'circle', 'image', 'group'])
const EASE_KINDS: ReadonlySet<string> = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicBezier', 'spring'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isPrimitive(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
}

class Collector {
  readonly errors: SpecError[] = []
  readonly warnings: string[] = []

  fail(path: string, message: string): void {
    this.errors.push({ path, message })
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  str(path: string, obj: Record<string, unknown>, key: string): void {
    const v = obj[key]
    if (v === undefined || v === null) {
      this.fail(`${path}/${key}`, '缺少必填字段')
      return
    }
    if (typeof v !== 'string') this.fail(`${path}/${key}`, `应为字符串，实际为 ${typeof v}`)
    else if (v.trim() === '') this.fail(`${path}/${key}`, '不能为空字符串')
  }

  num(path: string, obj: Record<string, unknown>, key: string, opts: { min?: number } = {}): void {
    const v = obj[key]
    if (v === undefined || v === null) {
      this.fail(`${path}/${key}`, '缺少必填字段')
      return
    }
    if (!isFiniteNumber(v)) {
      this.fail(`${path}/${key}`, `应为有限数字，实际为 ${JSON.stringify(v)}`)
      return
    }
    if (opts.min !== undefined && v < opts.min) {
      this.fail(`${path}/${key}`, `应 >= ${opts.min}，实际为 ${v}`)
    }
  }
}

function validateEase(c: Collector, path: string, ease: unknown): void {
  if (ease === undefined) return
  if (!isRecord(ease) || typeof ease.kind !== 'string') {
    c.fail(path, 'ease 应为 { kind: ... } 对象')
    return
  }
  if (!EASE_KINDS.has(ease.kind)) {
    c.fail(`${path}/kind`, `未知缓动类型 "${ease.kind}"，可选：${[...EASE_KINDS].join(' / ')}`)
    return
  }
  if (ease.kind === 'cubicBezier') {
    const pts = ease.points
    if (!Array.isArray(pts) || pts.length !== 4 || !pts.every(isFiniteNumber)) {
      c.fail(`${path}/points`, 'cubicBezier 需要 4 个数字 [x1,y1,x2,y2]')
    }
  }
}

function validateKeyframe(c: Collector, path: string, k: unknown, index: number): void {
  const p = `${path}/${index}`
  if (!isRecord(k)) {
    c.fail(p, '关键帧应为对象')
    return
  }
  c.num(p, k, 'atMs', { min: 0 })
  if (!('value' in k)) c.fail(`${p}/value`, '缺少必填字段')
  else if (!isPrimitive(k.value)) c.fail(`${p}/value`, '关键帧值应为数字/字符串/布尔')
  validateEase(c, `${p}/ease`, k.ease)
}

function validateTrack(c: Collector, path: string, t: unknown, index: number): void {
  const p = `${path}/${index}`
  if (!isRecord(t)) {
    c.fail(p, '轨道应为对象')
    return
  }
  c.str(p, t, 'id')
  c.str(p, t, 'target')
  if (typeof t.target === 'string' && !t.target.startsWith('props.')) {
    c.fail(`${p}/target`, 'MVP 仅支持 props.<field> 形式的目标，如 props.opacity')
  }
  if (!Array.isArray(t.keys) || t.keys.length === 0) {
    c.fail(`${p}/keys`, '轨道至少需要 1 个关键帧')
    return
  }
  const seen = new Set<number>()
  t.keys.forEach((k, i) => {
    validateKeyframe(c, `${p}/keys`, k, i)
    if (isRecord(k) && isFiniteNumber(k.atMs)) {
      if (seen.has(k.atMs)) c.fail(`${p}/keys/${i}/atMs`, `同一轨道内时间重复：${k.atMs}ms`)
      seen.add(k.atMs)
    }
  })
}

function validateLayer(c: Collector, path: string, l: unknown, index: number): void {
  const p = `${path}/${index}`
  if (!isRecord(l)) {
    c.fail(p, '图层应为对象')
    return
  }
  c.str(p, l, 'id')
  c.str(p, l, 'name')
  if (typeof l.type !== 'string' || !LAYER_TYPES.has(l.type)) {
    c.fail(`${p}/type`, `未知图层类型，可选：${[...LAYER_TYPES].join(' / ')}`)
  }
  if (!isRecord(l.props)) c.fail(`${p}/props`, 'props 应为对象')
  if (!Array.isArray(l.tracks)) c.fail(`${p}/tracks`, 'tracks 应为数组')
  else l.tracks.forEach((t, i) => validateTrack(c, `${p}/tracks`, t, i))
}

function validateAsset(c: Collector, path: string, a: unknown): void {
  if (!isRecord(a)) {
    c.fail(path, '资产应为对象')
    return
  }
  if (!['image', 'audio', 'font', 'svg'].includes(a.kind as string)) {
    c.fail(`${path}/kind`, '资产类型应为 image / audio / font / svg')
  }
  c.str(path, a, 'src')
}

function validateScene(c: Collector, path: string, s: unknown, index: number): void {
  const p = `${path}/${index}`
  if (!isRecord(s)) {
    c.fail(p, '场景应为对象')
    return
  }
  c.str(p, s, 'id')
  c.str(p, s, 'name')
  c.num(p, s, 'durationMs', { min: 1 })
  if (!Array.isArray(s.layers)) {
    c.fail(`${p}/layers`, 'layers 应为数组')
  } else {
    const ids = new Set<string>()
    s.layers.forEach((l, i) => {
      validateLayer(c, `${p}/layers`, l, i)
      if (isRecord(l) && typeof l.id === 'string') {
        if (ids.has(l.id)) c.fail(`${p}/layers/${i}/id`, `场景内图层 id 重复：${l.id}`)
        ids.add(l.id)
      }
    })
  }
  if (s.transition !== undefined) {
    const tr = s.transition
    if (!isRecord(tr)) c.fail(`${p}/transition`, 'transition 应为对象')
    else {
      c.num(`${p}/transition`, tr, 'durationMs', { min: 0 })
      validateEase(c, `${p}/transition/ease`, tr.ease)
    }
  }
}

/**
 * 校验一份未知输入是否是合法的 AnimationSpec。
 *
 * 默认要求 scenes 非空——**空 spec 是合法中间态**（刚建好、还没写第一幕），
 * 所以调用方用 `allowEmptyScenes` 显式放行。做成选项而不是放宽默认值，
 * 是为了让「我要渲染一份空文档」这种事在调用点上看得见。
 */
export function validateSpec(input: unknown, options: { allowEmptyScenes?: boolean } = {}): ValidateResult {
  const c = new Collector()
  if (!isRecord(input)) {
    c.fail('', 'spec 应为对象')
    return { ok: false, errors: c.errors, warnings: c.warnings }
  }
  if (input.version !== 1) {
    c.fail('/version', `不支持的 IR 版本：${String(input.version)}（本实现支持 1）`)
  }

  // meta
  const meta = input.meta
  if (!isRecord(meta)) {
    c.fail('/meta', 'meta 应为对象')
  } else {
    c.str('/meta', meta, 'id')
    c.str('/meta', meta, 'title')
    c.num('/meta', meta, 'fps', { min: 1 })
    const size = meta.size
    if (!isRecord(size)) {
      c.fail('/meta/size', 'size 应为 { width, height }')
    } else {
      c.num('/meta/size', size, 'width', { min: 1 })
      c.num('/meta/size', size, 'height', { min: 1 })
    }
  }

  // theme
  const theme = input.theme
  if (!isRecord(theme)) {
    c.fail('/theme', 'theme 应为对象')
  } else {
    if (!isRecord(theme.colors)) c.fail('/theme/colors', 'colors 应为对象')
    if (!isRecord(theme.font)) c.fail('/theme/font', 'font 应为对象')
    else {
      c.str('/theme/font', theme.font, 'family')
      c.num('/theme/font', theme.font, 'size', { min: 1 })
    }
  }

  // assets
  if (!isRecord(input.assets)) c.fail('/assets', 'assets 应为对象')
  else for (const [k, v] of Object.entries(input.assets)) validateAsset(c, `/assets/${k}`, v)

  // scenes
  if (!Array.isArray(input.scenes) || (input.scenes.length === 0 && !options.allowEmptyScenes)) {
    c.fail('/scenes', options.allowEmptyScenes ? 'scenes 应为数组' : 'scenes 应为非空数组')
  } else if (Array.isArray(input.scenes)) {
    const ids = new Set<string>()
    input.scenes.forEach((s, i) => {
      validateScene(c, '/scenes', s, i)
      if (isRecord(s) && typeof s.id === 'string') {
        if (ids.has(s.id)) c.fail(`/scenes/${i}/id`, `场景 id 重复：${s.id}`)
        ids.add(s.id)
      }
    })
  }

  // 软性提示：声明时长与轨道实际结束时间不一致
  if (c.errors.length === 0 && Array.isArray(input.scenes)) {
    for (const [i, s] of input.scenes.entries()) {
      if (!isRecord(s) || !Array.isArray(s.layers)) continue
      let end = 0
      for (const l of s.layers) {
        if (!isRecord(l) || !Array.isArray(l.tracks)) continue
        for (const t of l.tracks) {
          if (!isRecord(t) || !Array.isArray(t.keys)) continue
          for (const k of t.keys) {
            if (isRecord(k) && isFiniteNumber(k.atMs)) end = Math.max(end, k.atMs)
          }
        }
      }
      if (isFiniteNumber(s.durationMs) && end > s.durationMs) {
        c.warn(`场景 ${i}（${String(s.name)}）的动画结束于 ${end}ms，超过声明时长 ${s.durationMs}ms，渲染时将按 ${end}ms 处理`)
      }
    }
  }

  // 坐标系启发式：IR 的原点在画布中心（x 右正、y 下正），而调用方的默认直觉
  // 是 web/CSS 的左上角原点。按左上角写出来的布局在中心原点下整体塌进右下
  // 象限——渲染不报错、只在看片时才发现，必须在生成阶段就提醒。
  //
  // 判据（按幕）：本幕所有 x/y 值都不为负——左上角思维意识不到画布左/上还有
  // 空间，永远写不出负坐标，出现任何一个负值就说明作者知道中心原点——且存在
  // 图层静止位置超出画布半径。中途的极端关键帧不参与判定，那多半是滑入入场的
  // 离屏起点；静止位置（静态 props 与每条轨道按 atMs 最大的关键帧）才是布局
  // 意图。确按中心原点的满幅布局理论上会误报，文案里写明可忽略。
  if (c.errors.length === 0 && Array.isArray(input.scenes)) {
    const size = isRecord(input.meta) && isRecord(input.meta.size) ? input.meta.size : undefined
    const halfW = size && isFiniteNumber(size.width) ? size.width / 2 : undefined
    const halfH = size && isFiniteNumber(size.height) ? size.height / 2 : undefined
    if (halfW !== undefined && halfH !== undefined) {
      for (const [i, s] of input.scenes.entries()) {
        if (!isRecord(s) || !Array.isArray(s.layers)) continue
        const offenders: string[] = []
        const values: number[] = []
        for (const l of s.layers) {
          if (!isRecord(l) || !isRecord(l.props)) continue
          const label = typeof l.id === 'string' && l.id !== '' ? l.id : typeof l.name === 'string' ? l.name : '图层'
          let restX = isFiniteNumber(l.props.x) ? l.props.x : undefined
          let restY = isFiniteNumber(l.props.y) ? l.props.y : undefined
          for (const v of [restX, restY]) if (v !== undefined) values.push(v)
          if (Array.isArray(l.tracks)) {
            for (const t of l.tracks) {
              if (!isRecord(t) || typeof t.target !== 'string' || !Array.isArray(t.keys)) continue
              const axis = t.target === 'props.x' ? 'x' : t.target === 'props.y' ? 'y' : null
              if (!axis) continue
              let bestAt = -Infinity
              for (const k of t.keys) {
                if (!isRecord(k)) continue
                if (isFiniteNumber(k.value)) values.push(k.value)
                if (isFiniteNumber(k.value) && isFiniteNumber(k.atMs) && k.atMs >= bestAt) {
                  bestAt = k.atMs
                  if (axis === 'x') restX = k.value
                  else restY = k.value
                }
              }
            }
          }
          if (restX !== undefined && restX >= halfW) offenders.push(`${label} 的 x=${restX}`)
          else if (restY !== undefined && restY >= halfH) offenders.push(`${label} 的 y=${restY}`)
        }
        if (offenders.length > 0 && (values.length === 0 || Math.min(...values) >= 0)) {
          c.warn(
            `场景 ${i}（${String(s.name)}）疑似按「左上角原点」书写坐标：${offenders.join('、')} 超出了画布半径。`
            + `IR 的原点在画布中心（x 右正、y 下正），${halfW * 2}×${halfH * 2} 的画布左上角是 (-${halfW}, -${halfH})，`
            + '请把 x/y 整体平移 (-画布宽/2, -画布高/2)；若确按中心原点布局可忽略本提示。',
          )
        }
      }
    }
  }

  if (c.errors.length > 0) return { ok: false, errors: c.errors, warnings: c.warnings }
  return { ok: true, spec: input as unknown as AnimationSpec, warnings: c.warnings }
}
