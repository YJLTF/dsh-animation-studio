/**
 * 零依赖结构化校验。
 *
 * 为什么自己写而不是引 zod：spec 包要同时进 Node 与浏览器 bundle，
 * 且校验报错需要精确到「哪个场景的哪个图层的哪个关键帧」——这份定制逻辑
 * 比通用 schema 库更短也更可控。
 */

import type {
  AnimationSpec, Asset, EaseSpec, JsonValue, Keyframe, Layer,
  Scene, Track,
} from './types.ts'
import { LAYER_TYPES } from './types.ts'

export interface SpecError {
  /** JSON Pointer 风格的路径，如 `/scenes/0/layers/2/tracks/1/keys/0/atMs`。 */
  path: string
  message: string
}

export type ValidateResult =
  | { ok: true; spec: AnimationSpec; warnings: string[] }
  | { ok: false; errors: SpecError[]; warnings: string[] }

// 权威枚举在 types.ts（LAYER_TYPES 常量），这里只派生放行集合，不再手抄一份
const LAYER_TYPE_SET: ReadonlySet<string> = new Set<string>(LAYER_TYPES)
const EASE_KINDS: ReadonlySet<string> = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicBezier', 'spring', 'bounce', 'elastic', 'back', 'bounceIn', 'bounceInOut', 'elasticIn', 'elasticInOut', 'backIn', 'backInOut'])
// 转场 kind：入场全集；退场（Scene.exit）不支持 zoomIn（那是进入画面的形态）
const TRANSITION_KINDS: ReadonlySet<string> = new Set(['none', 'fade', 'slideLeft', 'slideUp', 'slideRight', 'slideDown', 'zoomIn'])
const EXIT_KINDS: ReadonlySet<string> = new Set(['none', 'fade', 'slideLeft', 'slideUp', 'slideRight', 'slideDown'])

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
      // 报错带字段名：路径里有，但模型扫读报错时靠字段名定位更快
      this.fail(`${path}/${key}`, `缺少必填字段「${key}」`)
      return
    }
    if (typeof v !== 'string') this.fail(`${path}/${key}`, `应为字符串，实际为 ${typeof v}`)
    else if (v.trim() === '') this.fail(`${path}/${key}`, '不能为空字符串')
  }

  num(path: string, obj: Record<string, unknown>, key: string, opts: { min?: number } = {}): void {
    const v = obj[key]
    if (v === undefined || v === null) {
      this.fail(`${path}/${key}`, `缺少必填字段「${key}」`)
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
    // 真机高频错形：直接写 ease: "easeOut" 字符串。报错给出正确形态的示例，
    // 模型照抄即可修复，不用再猜「{ kind: ... }」里省略号是什么
    const got = JSON.stringify(ease) ?? '非对象'
    c.fail(path, `ease 应为 { kind: "..." } 对象（如 {"kind":"easeInOut"}），收到 ${got}${typeof ease === 'string' ? '，不能直接写字符串' : ''}`)
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
  if (!('value' in k)) c.fail(`${p}/value`, `缺少必填字段「value」（该时刻的目标值）`)
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
  // 「缺 type」和「type 值写错」是两种错法，分开说：缺字段要补字段，
  // 写错值要换值；都不给可选列表模型就得再跑一趟工具描述
  if (l.type === undefined || l.type === null) {
    c.fail(`${p}/type`, `缺少 type 字段（图层类型），可选：${[...LAYER_TYPE_SET].join(' / ')}`)
  } else if (typeof l.type !== 'string' || !LAYER_TYPE_SET.has(l.type)) {
    c.fail(`${p}/type`, `未知图层类型 ${JSON.stringify(l.type)}，可选：${[...LAYER_TYPE_SET].join(' / ')}`)
  }
  if (l.props === undefined || l.props === null) {
    c.fail(`${p}/props`, '缺少 props 字段（图层的静态属性对象，文本/坐标/样式都写在里面，如 { text: "标题", x: 0, y: 0 }）')
  } else if (!isRecord(l.props)) {
    c.fail(`${p}/props`, 'props 应为对象')
  }
  if (!Array.isArray(l.tracks)) c.fail(`${p}/tracks`, 'tracks 应为数组（无动画的静态图层给空数组 []）')
  else l.tracks.forEach((t, i) => validateTrack(c, `${p}/tracks`, t, i))

  // 类型相关的软性体检：不阻断校验，但把「注定画不出来」的形态说清楚。
  // 真机教训：circle 缺尺寸 = MC 默认 0×0 不可见；line/arrow 缺 points 或
  // 描边 = 不可见。渲染端还有一层兜底（见 codegen），这里的警告进工具回执。
  const props = isRecord(l.props) ? l.props : undefined
  if (l.type === 'audio' && props) {
    if (typeof props.src !== 'string' || (props.src as string).trim() === '') {
      c.warn(`图层 ${String(l.id)}（audio）未提供 src（用 "asset:<assetId>" 引用 anim_asset_import 导入的音频资产），将无声`)
    }
    if (props.volume !== undefined && (!isFiniteNumber(props.volume) || props.volume < 0 || props.volume > 1)) {
      c.fail(`${p}/props/volume`, `audio 的 volume 应为 0~1 的数字，实际为 ${JSON.stringify(props.volume)}`)
    }
    if (props.stop !== undefined && props.stop !== 'sceneEnd' && props.stop !== 'specEnd') {
      c.fail(`${p}/props/stop`, `audio 的 stop 应为 "sceneEnd" 或 "specEnd"，实际为 ${JSON.stringify(props.stop)}`)
    }
    if (props.loop !== undefined && typeof props.loop !== 'boolean') {
      c.fail(`${p}/props/loop`, 'audio 的 loop 应为布尔值')
    }
    if (props.atMs !== undefined && (!isFiniteNumber(props.atMs) || props.atMs < 0)) {
      c.fail(`${p}/props/atMs`, 'audio 的 atMs（相对本幕开头的偏移）应为 >= 0 的数字')
    }
    if (Array.isArray(l.tracks) && l.tracks.length > 0) {
      c.warn(`图层 ${String(l.id)}（audio）的轨道不参与画面与时长，已忽略——音量调节请改 props.volume`)
    }
  }
  if (l.type === 'circle' && props) {
    const hasSize = props.size !== undefined || props.width !== undefined || props.height !== undefined || props.radius !== undefined
    if (!hasSize) c.warn(`图层 ${String(l.id)}（circle）未指定尺寸（size/width/height/radius），渲染时按默认处理，可能过小或不可见`)
    if (props.fill === undefined && props.stroke === undefined) {
      c.warn(`图层 ${String(l.id)}（circle）既无 fill 也无 stroke，渲染端将按主题文字色兜底填充，否则不可见`)
    }
  }
  if ((l.type === 'line' || l.type === 'arrow') && props) {
    const pts = props.points
    if (!Array.isArray(pts) || pts.length < 2 || !pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      c.warn(`图层 ${String(l.id)}（${l.type}）的 points 需要至少两个 [x, y] 点，否则线条不可见`)
    }
    if (props.stroke === undefined) {
      c.warn(`图层 ${String(l.id)}（${l.type}）未指定 stroke，渲染端将按主题文字色兜底，否则线条不可见`)
    }
  }
  if ((l.type === 'polygon' || l.type === 'star') && props) {
    if (props.size === undefined && props.width === undefined && props.height === undefined) {
      c.warn(`图层 ${String(l.id)}（${l.type}）未指定尺寸（size/width/height），渲染时按默认处理，可能过小或不可见`)
    }
    if (props.sides !== undefined && (!Number.isFinite(props.sides) || Number(props.sides) < 3)) {
      c.fail(`${p}/props/sides`, `${l.type} 的 sides 应为 >= 3 的整数（角数/边数）`)
    }
  }
  if (l.type === 'svg' && props) {
    if (typeof props.svg !== 'string' || props.svg.trim() === '') {
      c.warn(`图层 ${String(l.id)}（svg）未提供 svg 内容（props.svg 内嵌 SVG 字符串），渲染为空`)
    }
  }
  // 渐变填充的形态体检（0.5.0 规划 §4.2）：fill 可以是字符串或渐变描述对象。
  // 描述对象的错误形态（缺 stops、type 拼错）在写库时说，比渲染时黑块/警告强。
  if (props && isRecord(props.fill)) {
    const g = props.fill
    const gtype = g.type
    if (gtype !== 'linear' && gtype !== 'radial' && gtype !== 'conic') {
      c.fail(`${p}/props/fill/type`, `渐变 type 应为 "linear" / "radial" / "conic"，实际为 ${JSON.stringify(gtype)}`)
    }
    if (!Array.isArray(g.stops) || g.stops.length < 2) {
      c.fail(`${p}/props/fill/stops`, '渐变 stops 需要 >= 2 个 [offset, color]（offset 为 0~1）')
    } else {
      g.stops.forEach((st, i) => {
        if (!Array.isArray(st) || st.length !== 2 || !isFiniteNumber(st[0]) || typeof st[1] !== 'string') {
          c.fail(`${p}/props/fill/stops/${i}`, 'stop 应为 [offset(0~1), "#rgb"] 元组，如 [0.5, "#4C9AFF"]')
        }
      })
    }
    if (gtype === 'linear' && g.to === undefined && g.angle === undefined && g.from === undefined) {
      c.warn(`图层 ${String(l.id)} 的 linear 渐变未提供 from/to 或 angle，渲染时按默认方向处理`)
    }
  }
  if (l.type === 'video' && props) {
    if (typeof props.src !== 'string' || (props.src as string).trim() === '') {
      c.warn(`图层 ${String(l.id)}（video）未提供 src（用 "asset:<assetId>" 引用 anim_asset_import 导入的视频资产），渲染为空`)
    }
    if (props.playbackRate !== undefined && (!isFiniteNumber(props.playbackRate) || props.playbackRate <= 0)) {
      c.fail(`${p}/props/playbackRate`, 'video 的 playbackRate 应为 > 0 的数字')
    }
    if (props.time !== undefined && (!isFiniteNumber(props.time) || props.time < 0)) {
      c.fail(`${p}/props/time`, 'video 的 time（源内起点，秒）应为 >= 0 的数字')
    }
  }
  if (l.type === 'code' && props) {
    if (typeof props.code !== 'string' || props.code.trim() === '') {
      c.warn(`图层 ${String(l.id)}（code）未提供代码内容（props.code），渲染为空`)
    }
    if (props.language !== undefined && typeof props.language !== 'string') {
      c.fail(`${p}/props/language`, 'code 图层的 language 应为字符串（如 typescript / python / json）')
    }
  }
  if (l.type === 'math' && props) {
    if (typeof props.tex !== 'string' || props.tex.trim() === '') {
      c.warn(`图层 ${String(l.id)}（math）未提供 LaTeX 公式（props.tex），渲染为空`)
    }
  }
  // group 的 children 字段形态在这里查；引用关系（存在/不自引用/不嵌套/
  // 不跨组争用）需要全幕图层 id，由 validateScene 统一查。
  if (l.type === 'group' && props && props.children !== undefined) {
    if (!Array.isArray(props.children) || !props.children.every(x => typeof x === 'string')) {
      c.fail(`${p}/props/children`, 'group 的 children 应为图层 id 字符串数组，如 ["axis", "ball"]')
    }
  }
}

function validateAsset(c: Collector, path: string, a: unknown): void {
  if (!isRecord(a)) {
    c.fail(path, '资产应为对象')
    return
  }
  if (!['image', 'audio', 'font', 'svg', 'video'].includes(a.kind as string)) {
    c.fail(`${path}/kind`, '资产类型应为 image / audio / font / svg / video')
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
  // 秒-毫秒量级混淆的软警告（0.5.0 规划 §3.4）：IR 全部时间都是毫秒，而
  // 「durationMs: 3」这种值几乎必然是把「3 秒」直接写了进来——30fps 下不足
  // 一帧，渲染端会静默按 0 帧处理，「这一幕凭空消失」。宁可在写库时多说一句。
  if (isFiniteNumber(s.durationMs) && s.durationMs < 34) {
    c.warn(
      `场景 ${JSON.stringify(String(s.id))} 的 durationMs=${s.durationMs} 短于一帧（30fps 下约 33ms），疑似把秒写成了毫秒（3 秒应写 3000）。若确要亚帧时长可忽略本提示`,
    )
  }
  if (!Array.isArray(s.layers)) {
    c.fail(`${p}/layers`, 'layers 应为数组')
  } else {
    const ids = new Set<string>()
    const groupIds = new Set<string>()
    const groups: Array<{ index: number; id: string; children: string[] }> = []
    s.layers.forEach((l, i) => {
      validateLayer(c, `${p}/layers`, l, i)
      if (!isRecord(l) || typeof l.id !== 'string') return
      if (ids.has(l.id)) c.fail(`${p}/layers/${i}/id`, `场景内图层 id 重复：${l.id}`)
      ids.add(l.id)
      if (l.type === 'group') {
        groupIds.add(l.id)
        const children = isRecord(l.props) ? l.props.children : undefined
        // children 形态非法时 validateLayer 已报错，这里只收合法的引用清单
        if (Array.isArray(children) && children.every(x => typeof x === 'string')) {
          groups.push({ index: i, id: l.id, children: children as string[] })
        }
      }
    })
    // group 的 children 引用体检（0.3.x 优化清单 O15）：引用必须存在、不能
    // 自引用、MVP 不嵌套 group、同一图层不被多个 group 争用。此前这些只有
    // codegen 的生成期警告，错写 children 要到渲染时才发现。
    const owners = new Map<string, string>()
    for (const g of groups) {
      for (const childId of g.children) {
        if (childId === g.id) {
          c.fail(`${p}/layers/${g.index}/props/children`, `group ${g.id} 不能引用自己`)
        } else if (!ids.has(childId)) {
          c.fail(`${p}/layers/${g.index}/props/children`, `group ${g.id} 引用了本幕不存在的图层 ${childId}（children 只能引用同一场景内的图层 id）`)
        } else if (groupIds.has(childId)) {
          c.fail(`${p}/layers/${g.index}/props/children`, `group ${g.id} 引用了另一个 group（${childId}），当前只支持单层分组`)
        } else {
          const owner = owners.get(childId)
          if (owner === undefined) owners.set(childId, g.id)
          else c.warn(`图层 ${childId} 被多个 group 引用（${owner}、${g.id}），渲染时只归入第一个`)
        }
      }
    }
  }
  // 转场 kind 此前不校验（写错静默无转场）；扩族后集合仍是闭合的，写错
  // 必须报出来——「渲染不报错、看片才发现没有转场」比显式失败更误导
  if (s.transition !== undefined) {
    const tr = s.transition
    if (!isRecord(tr)) c.fail(`${p}/transition`, 'transition 应为对象')
    else {
      if (tr.kind !== undefined && !TRANSITION_KINDS.has(tr.kind as string)) {
        c.fail(`${p}/transition/kind`, `未知转场类型 ${JSON.stringify(tr.kind)}，可选：${[...TRANSITION_KINDS].join(' / ')}`)
      }
      c.num(`${p}/transition`, tr, 'durationMs', { min: 0 })
      validateEase(c, `${p}/transition/ease`, tr.ease)
    }
  }
  if (s.exit !== undefined) {
    const ex = s.exit
    if (!isRecord(ex)) c.fail(`${p}/exit`, 'exit（幕尾退场）应为对象')
    else {
      if (ex.kind !== undefined && !EXIT_KINDS.has(ex.kind as string)) {
        c.fail(`${p}/exit/kind`, `未知退场类型 ${JSON.stringify(ex.kind)}，可选：${[...EXIT_KINDS].join(' / ')}（zoomIn 仅用于入场）`)
      }
      c.num(`${p}/exit`, ex, 'durationMs', { min: 0 })
      validateEase(c, `${p}/exit/ease`, ex.ease)
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

  // narration（旁白字幕条，§4.3）：atMs 是全片绝对毫秒。时长越界只给软警告
  //（在渲染端展开时判，这里管结构），结构错了才阻断
  if (input.narration !== undefined) {
    const nar = input.narration
    if (!isRecord(nar) || !Array.isArray(nar.cues)) {
      c.fail('/narration/cues', 'narration 应为 { cues: [...] }，cues 应为数组')
    } else {
      nar.cues.forEach((cue, i) => {
        if (!isRecord(cue)) {
          c.fail(`/narration/cues/${i}`, 'cue 应为对象 { atMs, text, durationMs? }')
          return
        }
        if (!isFiniteNumber(cue.atMs) || cue.atMs < 0) {
          c.fail(`/narration/cues/${i}/atMs`, `atMs 应为 >= 0 的数字（全片绝对毫秒），实际为 ${JSON.stringify(cue.atMs)}`)
        }
        if (typeof cue.text !== 'string' || cue.text.trim() === '') {
          c.fail(`/narration/cues/${i}/text`, 'text 应为非空字符串')
        }
        if (cue.durationMs !== undefined && (!isFiniteNumber(cue.durationMs) || cue.durationMs <= 0)) {
          c.fail(`/narration/cues/${i}/durationMs`, `durationMs 应为正数，实际为 ${JSON.stringify(cue.durationMs)}`)
        }
      })
    }
  }

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
