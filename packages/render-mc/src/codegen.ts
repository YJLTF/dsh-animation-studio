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

import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import type { AnimationSpec, Asset, EaseSpec, JsonValue, KeyframeValue, Layer, LayerProps, LayerType, Scene } from '@dsh-anim/spec'
import { PROP_ALIASES, safeName, sceneDurationMs, specDurationMs, tweensOf } from '@dsh-anim/spec'

export interface GeneratedFile {
  /** 相对项目 src 目录的路径。 */
  path: string
  content: string
}

export interface GenerateResult {
  files: GeneratedFile[]
  /** 生成期降级（属性不被支持、图层类型未实现等），不阻断渲染。 */
  warnings: string[]
  /**
   * 音轨清单（§4.1）：audio 图层不进 MC 帧合成，由 adapter 在编码/拼接之后
   * 按这份清单 ffmpeg 二次混音。改音量不用清段缓存——音轨永远从现行 spec
   * 重新收集，段缓存只管画面。
   */
  audioTracks: AudioTrackCue[]
}

/* ------------------------------------------------------------ 属性白名单 */

/**
 * codegen 产物语义版本（§3.4）：进场景指纹。场景指纹哈希的是场景 JSON +
 * 渲染参数，而真正决定段内容的是 codegen 的输出——生成器行为一变（如
 * 「code 缺 fill 兜底主题色」这类不改输入只改输出的修正），旧段必须失效。
 * **改 codegen 输出语义时手动 +1**（新增图层类型 / 属性兜底 / 时序语义等）。
 * v2（0.4.0 M2）：slide 转场改中心相对坐标（旧写法把 view 贴到画布边缘）、
 * code 缺 fill 兜底主题色、project.meta 背景兜底主题底色、字幕条/退场新增。
 * v3：字幕字号改按画布高度比例（不再跟 theme.font.size），超宽自动折行、
 * 底条随行数增高——同输入下字幕段输出变了，旧段必须失效。
 * v4（0.5.0）：text maxWidth/textWrap、lineDash、fill 渐变、reveal 打字机、
 * video 图层、缓动 in/inOut 变体——生成语义整体扩面，旧段自然失效。
 */
export const CODEGEN_VERSION = 4

const COMMON_PROPS = ['x', 'y', 'opacity', 'scale', 'rotation'] as const

/**
 * 所有 Layout 系节点（Rect/Circle/Txt/Img/Line…）都有的尺寸/变换信号。
 * 单独列出来，是为了让「size/width/height 对所有图层可动画」成立——
 * MC 的 Layout 基类就有这三个 signal，不写进各类型的静态表也能动。
 */
const LAYOUT_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'size', 'width', 'height'] as const

/**
 * 各图层类型可接受的静态属性（值 = MC 组件上的属性名）。
 *
 * 三张表（STATIC_PROPS / COMPONENT / ANIMATABLE_BY_TYPE）的键集合由
 * `LayerType` 编译期钉死（Record<LayerType, …>），新增类型漏改会直接
 * 类型报错；导出是给冒烟的「枚举一致性断言」用的（0.3.x 优化清单 O14）。
 */
export const STATIC_PROPS: Record<LayerType, Record<string, string>> = {
  // textAlign 是 MC Layout 基类的原生 signal（Txt 继承），直通即可生效；
  // maxWidth + textWrap 支持正文长段落自动折行（0.5.0 §4.1，与字幕折行同一
  // 语义坑：\n 要 textWrap:'pre' 才生效、lineHeight 数字是 px）
  text: { text: 'text', fontSize: 'fontSize', fontFamily: 'fontFamily', fontWeight: 'fontWeight', fill: 'fill', lineHeight: 'lineHeight', textAlign: 'textAlign', maxWidth: 'maxWidth', textWrap: 'textWrap' },
  // lineDash 是 Shape 基类 signal（number[]，虚线样式）——line/arrow/rect 通用
  rect: { width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth', radius: 'radius', lineDash: 'lineDash' },
  // Circle 原生支持 width/height（width≠height 即椭圆），radius/r 是圆的半径，
  // 由 normalizeLayerProps 换算成 size；见 0.3.0 规划 §1.4（圆形画不出来的修复）。
  circle: { size: 'size', width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  image: { src: 'src', width: 'width', height: 'height' },
  // 成员经 children 引用，由 genSceneFile 组合成 Node 容器；静态属性只有变换。
  group: {},
  // Line 的 start/end（0~1 画线进度）与 endArrow/arrowSize 都是 Curve 内建 signal
  line: { points: 'points', lineWidth: 'lineWidth', stroke: 'stroke', start: 'start', end: 'end', startArrow: 'startArrow', endArrow: 'endArrow', arrowSize: 'arrowSize', lineDash: 'lineDash' },
  arrow: { points: 'points', lineWidth: 'lineWidth', stroke: 'stroke', start: 'start', end: 'end', startArrow: 'startArrow', endArrow: 'endArrow', arrowSize: 'arrowSize', lineDash: 'lineDash' },
  // MC 没有独立的 Ellipse 节点：椭圆 = Circle + width/height（官方用法）
  ellipse: { size: 'size', width: 'width', height: 'height', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  // MC Polygon 是正多边形（sides 边数 + radius 角圆角）；star 用 Path + codegen 内置星形 path
  polygon: { sides: 'sides', size: 'size', radius: 'radius', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  star: { data: 'data', fill: 'fill', stroke: 'stroke', lineWidth: 'lineWidth' },
  // MC SVG 组件只接受内嵌 svg 字符串（不是文件路径）；文件资产走 image 图层
  svg: { svg: 'svg', width: 'width', height: 'height' },
  // Code 组件：code 是 CodeSignal（字符串可补间，{{片段}} 可着色）；
  // language 不进静态表，由 emitNode 转成 highlighter 引用（见 code-highlight 模块）
  code: { code: 'code', fontSize: 'fontSize', fontFamily: 'fontFamily', fill: 'fill' },
  // Latex 组件（SVGNode）：tex 是 SVG 源，fill/fontSize 由 MC 的 Shape 信号提供
  math: { tex: 'tex', fontSize: 'fontSize', fill: 'fill' },
  // video 图层（0.5.0 §4.4）：MC Video extends Rect；play 固定注入（见 emitNode），
  // volume 无对应 signal（MC 按节点调音量不可行），写了会被「不支持」告警降级
  video: { src: 'src', width: 'width', height: 'height', loop: 'loop', time: 'time', playbackRate: 'playbackRate' },
  // audio 不进 MC 画面生成（genSceneFile 在 emitNode 之前跳过），此表只为
  // Record<LayerType, …> 的完整性存在
  audio: {},
}

/**
 * 各类型可动画的目标集合：LAYOUT 信号 + 该类型静态属性表里的键。
 *
 * 不能再用全局大集合——rect 有 fill、image 没有，全局集合会把「对 Img 补间
 * fill」这种运行时才会崩的代码放出去。按类型派生，不支持的动画目标走警告降级。
 */
export const ANIMATABLE_BY_TYPE: Record<LayerType, Set<string>> = Object.fromEntries(
  (Object.keys(STATIC_PROPS) as LayerType[]).map(type => [
    type,
    new Set<string>([...LAYOUT_PROPS, ...Object.keys(STATIC_PROPS[type])]),
  ]),
) as Record<LayerType, Set<string>>

/** 类型 → MC 组件名。Record<LayerType, …> 让「新增类型忘映射」编译期就炸。 */
export const COMPONENT: Record<LayerType, string> = {
  text: 'Txt',
  rect: 'Rect',
  circle: 'Circle',
  image: 'Img',
  group: 'Node', // 容器：成员用 .add() 挂进来，变换属性作用于整组
  line: 'Line',
  arrow: 'Line', // Line + endArrow（Curve 内建箭头，arrowSize 默认 24）
  ellipse: 'Circle',
  polygon: 'Polygon',
  star: 'Path', // codegen 内置星形 path（MC 3.17 没有 Star 组件）
  svg: 'SVG',
  code: 'Code',
  math: 'Latex',
  video: 'Video', // 实拍片段嵌入（0.5.0 §4.4）；headless 帧同步经真机 gate 验证
  audio: 'Node', // audio 永不 emitNode（不进画面），此处仅满足 Record 完整性
}

/**
 * code 图层的 language → code-highlight.ts 里导出的高亮器名。
 * @lezer/javascript 只导出单一 parser，TS/JSX 用 dialect 配置派生；
 * 未知语言返回 undefined（纯文本渲染，不染色）。
 */
const LANGUAGE_HIGHLIGHTER: Record<string, string> = {
  typescript: 'tsHighlighter',
  ts: 'tsHighlighter',
  tsx: 'tsxHighlighter',
  javascript: 'jsHighlighter',
  js: 'jsHighlighter',
  jsx: 'jsxHighlighter',
  python: 'pythonHighlighter',
  py: 'pythonHighlighter',
  json: 'jsonHighlighter',
  html: 'htmlHighlighter',
  css: 'cssHighlighter',
}

/**
 * code-highlight.ts 的完整源码：每个语言一个 LezerHighlighter 单例。
 * 只在 spec 里出现带 language 的 code 图层时才生成（见 generateProject）。
 */
const CODE_HIGHLIGHT_FILE = `/**
 * code 图层的语法高亮器。由 @dsh-anim/render-mc 生成，请勿手工编辑。
 *
 * @lezer/javascript 只导出单一 parser，TypeScript/JSX 通过 dialect 派生；
 * 其余语言各用独立解析器。LezerHighlighter 与 Code 组件同为实验性 API，
 * 但就是 3.17 的官方路径，渲染不受影响。
 */

import {LezerHighlighter} from '@motion-canvas/2d/lib/code';
import {parser as jsParser} from '@lezer/javascript';
import {parser as pythonParser} from '@lezer/python';
import {parser as jsonParser} from '@lezer/json';
import {parser as htmlParser} from '@lezer/html';
import {parser as cssParser} from '@lezer/css';

export const jsHighlighter = new LezerHighlighter(jsParser);
export const tsHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'ts'}));
export const jsxHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'jsx'}));
export const tsxHighlighter = new LezerHighlighter(jsParser.configure({dialect: 'ts + jsx'}));
export const pythonHighlighter = new LezerHighlighter(pythonParser);
export const jsonHighlighter = new LezerHighlighter(jsonParser);
export const htmlHighlighter = new LezerHighlighter(htmlParser);
export const cssHighlighter = new LezerHighlighter(cssParser);
`

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
 * 五角星（任意角数）的 SVG path 字符串，外接圆半径 = size/2，中心在原点。
 * MC 3.17 没有 Star 组件，用 Path 组件 + 生成 path 表达，模型不需要写 path。
 */
function starPath(size: number, sides: number): string {
  const n = Math.max(3, Math.round(sides))
  const R = size / 2
  const r = (R * Math.sin(Math.PI / (2 * n))) / Math.sin(Math.PI / n)
  const pts: string[] = []
  for (let i = 0; i < 2 * n; i++) {
    const rad = i % 2 === 0 ? R : r
    const a = -Math.PI / 2 + (i * Math.PI) / n
    pts.push(`${num(Math.cos(a) * rad)},${num(Math.sin(a) * rad)}`)
  }
  return `M ${pts.join(' L ')} Z`
}

/**
 * 字幕底条宽度用的粗估：CJK 字符按全宽（1em）、其余按 0.6em。
 * 只求底条别把文字挤出去，不追求像素级精确。
 */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6
  return Math.round(w)
}

/**
 * 字幕折行：整行估宽超出 maxTextWidth 时把 cue 折成多行（行间以 \n 连接，
 * MC 的 Txt 原生按换行符分行走 lineHeight）。断行规则：CJK 逐字可断、
 * 拉丁词按空白断；无空白的超长 token（长 URL 之类）按字符硬切兜底。
 * 与 estimateTextWidth 用同一套估宽——底条尺寸按折行后的最宽行计算，
 * 估宽误差只影响底条留白，不影响「不出画」这个硬约束。
 */
export function wrapSubtitleText(text: string, fontSize: number, maxTextWidth: number): string[] {
  if (estimateTextWidth(text, fontSize) <= maxTextWidth) return [text]
  const tokens: string[] = []
  let word = ''
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (word !== '') {
        tokens.push(word)
        word = ''
      }
      tokens.push(' ')
    } else if (ch.charCodeAt(0) > 0xff) {
      if (word !== '') {
        tokens.push(word)
        word = ''
      }
      tokens.push(ch)
    } else {
      word += ch
    }
  }
  if (word !== '') tokens.push(word)
  const fits = (s: string) => estimateTextWidth(s, fontSize) <= maxTextWidth
  const lines: string[] = []
  let cur = ''
  for (const tk of tokens) {
    if (tk === ' ') {
      if (cur !== '') cur += ' '
      continue
    }
    if (cur !== '' && fits(cur + tk)) {
      cur += tk
      continue
    }
    if (cur !== '') {
      lines.push(cur.replace(/\s+$/, ''))
      cur = ''
    }
    if (fits(tk)) {
      cur = tk
      continue
    }
    for (const c of tk) {
      if (cur !== '' && !fits(cur + c)) {
        lines.push(cur)
        cur = ''
      }
      cur += c
    }
  }
  if (cur !== '') lines.push(cur.replace(/\s+$/, ''))
  return lines.length > 0 ? lines : [text]
}

/**
 * 按类型把 props 归一化成最终要写进 JSX 的属性表，并产出警告。
 * 处理四类「模型常写错、静默画不出来」的形态：
 * - 属性别名（color→fill、strokeWidth→lineWidth，权威表 PROP_ALIASES）→
 *   归一在最先：它必须发生在颜色/尺寸兜底判断之前，否则「无色兜底」会把
 *   别名遮成主题色。规范名已给出时别名保留，留给下方白名单走「不支持」
 *   告警（规范名优先）；本类型不支持规范名时同样保留原名，让告警说人话；
 * - circle 的 radius/r → size×2（MC Circle 没有 radius 信号）；
 * - circle 缺尺寸 → 默认 size=100（MC 默认 0×0 不可见）；
 * - 封闭形状（rect/circle/ellipse/polygon/star）既无 fill 也无 stroke → 主题文字色兜底；
 * - line/arrow 缺 stroke → 主题文字色兜底；arrow 默认开 endArrow；
 * - star 的 sides/size → 生成 Path data；polygon 缺省 sides=6、size 兜底；
 * - image.src 的 `asset:<id>` 引用 → 解析成渲染项目内可加载的 URL。
 */
function normalizeLayerProps(
  type: LayerType,
  props: LayerProps,
  defaultTextFill: string,
  warnings: string[],
  assets: Record<string, Asset>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    out[k] = v as JsonValue
  }
  // 属性别名归一（表在 @dsh-anim/spec）：必须先于一切兜底判断
  const staticAllowed = STATIC_PROPS[type]
  for (const [alias, canonical] of Object.entries(PROP_ALIASES)) {
    if (out[alias] !== undefined && out[canonical] === undefined && staticAllowed[canonical] !== undefined) {
      out[canonical] = out[alias]
      delete out[alias]
    }
  }
  // 渐变 fill 的形态守门（0.5.0 §4.2）：描述对象非法（type 拼错 / stops 不足
  // 或条目坏）时告警摘除——渲染端宁可用无 fill 兜底，也不静默生成坏渐变
  if (out.fill !== undefined && typeof out.fill === 'object' && !Array.isArray(out.fill)) {
    const g = out.fill as { type?: JsonValue; stops?: JsonValue; from?: JsonValue; to?: JsonValue; angle?: JsonValue }
    const stops = Array.isArray(g.stops) ? g.stops.filter(s => Array.isArray(s) && s.length === 2 && typeof s[0] === 'number' && typeof s[1] === 'string') : []
    const okType = g.type === 'linear' || g.type === 'radial' || g.type === 'conic'
    if (!okType || stops.length < 2) {
      warnings.push(`图层（${type}）的 fill 渐变描述无效（type 应为 linear/radial/conic，stops 需要 >= 2 个 [offset, color]），已忽略渐变`)
      delete out.fill
    } else {
      const cleaned: Record<string, JsonValue> = { type: g.type as JsonValue, stops: stops as JsonValue }
      if (g.from !== undefined) cleaned.from = g.from
      if (g.to !== undefined) cleaned.to = g.to
      if (g.angle !== undefined) cleaned.angle = g.angle
      out.fill = cleaned
    }
  }
  if (type === 'group') {
    // children 是组合引用，由 genSceneFile 消费，不是节点属性
    delete out.children
    return out
  }
  if (type === 'code') {
    // language 不写进 JSX（Code 组件没有该 prop），由 emitNode 转成 highlighter 引用
    delete out.language
  }
  if ((type === 'rect' || type === 'circle' || type === 'ellipse' || type === 'polygon' || type === 'star') && out.fill === undefined && out.stroke === undefined) {
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
  if (type === 'polygon') {
    out.sides = out.sides ?? 6
    if (out.size === undefined && out.width === undefined && out.height === undefined) {
      out.size = 100
      warnings.push('polygon 图层未指定尺寸（size/width/height），已按 size=100 兜底')
    }
  }
  if (type === 'star') {
    const sides = Number(out.sides ?? 5)
    let size = Number(out.size ?? out.width ?? 0)
    delete out.sides
    delete out.size
    delete out.width
    delete out.height
    if (!Number.isFinite(size) || size <= 0) {
      size = 100
      warnings.push('star 图层尺寸异常（size 应 > 0），已按 size=100 生成星形')
    }
    out.data = starPath(size, sides)
  }
  if ((type === 'image' || type === 'video') && typeof out.src === 'string' && out.src.startsWith('asset:')) {
    const assetId = out.src.slice('asset:'.length)
    const asset = assets[assetId]
    if (!asset) {
      warnings.push(`${type} 图层引用了未登记的资产 ${assetId}（用 anim_asset_import 登记后再引用）`)
    } else if (/^https?:\/\//.test(asset.src)) {
      out.src = asset.src // http URL 资产原样透传，浏览器直接加载
    } else {
      const ext = extname(asset.src)
      out.src = `/assets/${safeName(assetId)}${ext}`
      if (type === 'image') {
        warnings.push(`image 图层引用资产 ${assetId}，已解析为 /assets/${safeName(assetId)}${ext}`)
      }
    }
  }
  return out
}

function num(v: number): string {
  return String(Number(v.toFixed(6)))
}

/**
 * 渐变描述 → MC Gradient 的几何参数片段（0.5.0 §4.2）。
 * linear 用 from/to（本地坐标，中心原点契约）或 angle；radial 用
 * fromRadius/toRadius。缺省项直接省略，交给 MC 的默认值。
 */
function gradientShapeArgs(g: {
  from?: unknown
  to?: unknown
  angle?: unknown
  fromRadius?: unknown
  toRadius?: unknown
}): string {
  const pair = (v: unknown): string | undefined => {
    if (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) {
      return `[${num(v[0] as number)}, ${num(v[1] as number)}]`
    }
    return undefined
  }
  const parts: string[] = []
  const from = pair(g.from)
  if (from) parts.push(`from: ${from}`)
  const to = pair(g.to)
  if (to) parts.push(`to: ${to}`)
  if (typeof g.angle === 'number' && Number.isFinite(g.angle)) parts.push(`angle: ${num(g.angle)}`)
  if (typeof g.fromRadius === 'number' && Number.isFinite(g.fromRadius)) parts.push(`fromRadius: ${num(g.fromRadius)}`)
  if (typeof g.toRadius === 'number' && Number.isFinite(g.toRadius)) parts.push(`toRadius: ${num(g.toRadius)}`)
  return parts.length > 0 ? `${parts.join(', ')}, ` : ''
}

/** 渐变 stops → MC GradientStop 数组字面量（形态已由 normalizeLayerProps 保证）。 */
function gradientStopsArg(stops: unknown): string {
  const items: string[] = []
  if (Array.isArray(stops)) {
    for (const st of stops) {
      if (Array.isArray(st) && st.length === 2 && typeof st[0] === 'number' && typeof st[1] === 'string') {
        items.push(`{ offset: ${num(st[0])}, color: ${JSON.stringify(st[1])} }`)
      } else if (Array.isArray(st) && st.length === 2 && typeof st[0] === 'number' && typeof st[1] === 'string') {
        continue
      }
    }
  }
  return `[${items.join(', ')}]`
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
    case 'bounce':
      imports.core.add('easeOutBounce')
      return 'easeOutBounce'
    case 'elastic':
      imports.core.add('easeOutElastic')
      return 'easeOutElastic'
    case 'back':
      imports.core.add('easeOutBack')
      return 'easeOutBack'
    case 'bounceIn':
      imports.core.add('easeInBounce')
      return 'easeInBounce'
    case 'bounceInOut':
      imports.core.add('easeInOutBounce')
      return 'easeInOutBounce'
    case 'elasticIn':
      imports.core.add('easeInElastic')
      return 'easeInElastic'
    case 'elasticInOut':
      imports.core.add('easeInOutElastic')
      return 'easeInOutElastic'
    case 'backIn':
      imports.core.add('easeInBack')
      return 'easeInBack'
    case 'backInOut':
      imports.core.add('easeInOutBack')
      return 'easeInOutBack'
  }
}

/* ------------------------------------------------------------ 场景生成 */

/** 一条字幕在本幕内的呈现时段（本地毫秒），由 planSubtitles 换算。 */
export interface SubtitleCue {
  text: string
  startMs: number
  endMs: number
}

/**
 * 字幕条样式与画布信息（§4.3），由 generateProject 从 spec 派生。
 * fontSize 与正文字号解耦：按画布高度的 4% 取整（14~56 夹取），
 * 超宽折行与底条几何都以它为准（wrapSubtitleText / 字幕渲染块）。
 */
export interface SubtitleStyle {
  mutedFill: string
  textColor: string
  fontSize: number
  canvasWidth: number
  canvasHeight: number
}

function genSceneFile(
  scene: Scene,
  index: number,
  background: string,
  defaultTextFill: string,
  assets: Record<string, Asset>,
  warnings: string[],
  usedHighlighters: Set<string>,
  subtitleStyle: SubtitleStyle,
): GeneratedFile {
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
    // Record<LayerType, string> 让「新增类型忘映射」编译期就失败，
    // 运行期不再需要「未实现」的防御分支
    const component = COMPONENT[layer.type]
    components.add(component)
    const name = varName(layer)

    const attrs = [`ref={${name}}`]
    const allowed: Record<string, string> = { ...STATIC_PROPS[layer.type] }
    for (const key of COMMON_PROPS) allowed[key] = key
    const normalized = normalizeLayerProps(layer.type, layer.props, defaultTextFill, warnings, assets)
    // reveal 打字机（0.5.0 §4.3）：text 图层带 props.reveal 轨道时，静态 text
    // 不直接上节点——改由 revealSignal 逐字裁剪（见下方与 emitTracks 的特判）
    const revealTrack = layer.type === 'text' ? layer.tracks.find(t => t.target === 'props.reveal') : undefined
    const revealSignal = revealTrack ? `${name}_reveal` : undefined
    if (revealSignal) {
      const first = [...revealTrack!.keys].sort((a, b) => a.atMs - b.atMs)[0]
      const startVal = typeof first?.value === 'number' && Number.isFinite(first.value) ? first.value : 0
      setup.push(`const ${revealSignal} = createSignal(${num(startVal)});`)
      coreImports.add('createSignal')
      const fullText = typeof layer.props.text === 'string' ? layer.props.text : ''
      const fullLit = JSON.stringify(fullText)
      attrs.push(`text={() => ${fullLit}.slice(0, Math.round(${revealSignal}() * ${fullText.length}))}`)
    }
    for (const [rawProp, value] of Object.entries(normalized)) {
      if (revealSignal && rawProp === 'text') continue // 文本已被 reveal signal 接管
      // 别名归一已在 normalizeLayerProps 完成（先于兜底判断）；走到这里的
      // 别名键都是「规范名已给出」或「本类型不支持规范名」的冗余形态，
      // 白名单查不到自然落到下方「不支持」告警——规范名优先，不静默覆盖
      const mapped = allowed[rawProp]
      if (!mapped) {
        warnings.push(`图层 ${layer.id} 的属性 ${rawProp} 不被 ${layer.type} 支持，已忽略`)
        continue
      }
      // 渐变 fill（0.5.0 §4.2）：描述对象 → new Gradient({...})，颜色/尺寸等
      // 其余形态照旧走字面量。无效形态在 normalizeLayerProps 阶段已告警摘除
      if (rawProp === 'fill' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const g = value as { type?: unknown; from?: unknown; to?: unknown; angle?: unknown; fromRadius?: unknown; toRadius?: unknown; stops?: unknown }
        attrs.push(`${mapped}={new Gradient({ type: ${JSON.stringify(g.type ?? 'linear')}, ${gradientShapeArgs(g)}stops: ${gradientStopsArg(g.stops)} })}`)
        components.add('Gradient')
        continue
      }
      attrs.push(`${mapped}={${litProp(value)}}`)
    }
    // text/math/code 没写 fill 时 MC 默认深色，在深底上就是「黑字黑底」看不见——
    // 兜底主题文字色（normalize 阶段 color 已归一为 fill 或被白名单拦下，这里只看 fill；
    // code 的默认色在自带的深色底上同样不可见，真机 M2 验收抓到后一并纳入）
    if ((layer.type === 'text' || layer.type === 'math' || layer.type === 'code') && normalized.fill === undefined) {
      attrs.push(`fill={${JSON.stringify(defaultTextFill)}}`)
    }
    // video 图层（0.5.0 §4.4）：headless 导出下不 play 则 time 永远停在起点
    //（整段画面都是首帧）——固定注入 play，起点与速率由 time/playbackRate 表达
    if (layer.type === 'video') {
      attrs.push('play={true}')
    }
    // code 图层写了 language：挂上对应高亮器（带语言的 code 图层才触发 code-highlight 模块生成）
    if (layer.type === 'code') {
      const lang = typeof layer.props.language === 'string' ? layer.props.language.toLowerCase() : undefined
      const highlighter = lang ? LANGUAGE_HIGHLIGHTER[lang] : undefined
      if (lang && !highlighter) {
        warnings.push(`code 图层 ${layer.id} 的语言 ${layer.props.language} 暂不支持高亮，按纯文本渲染`)
      } else if (highlighter) {
        usedHighlighters.add(highlighter)
        attrs.push(`highlighter={${highlighter}}`)
      }
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
      let prop = track.target.replace(/^props\./, '')
      // reveal 打字机特判（0.5.0 §4.3）：0~1 进度轨道 → 补间 reveal signal，
      // 文本由节点上的裁剪函数按 signal 值逐字显现（emitNode 侧接线）
      if (prop === 'reveal' && layer.type === 'text') {
        const sig = `${name}_reveal`
        for (const t of tweensOf(track)) {
          const ease = easeExpr(t.ease, imports)
          const easeArg = ease ? `, ${ease}` : ''
          const to = typeof t.to === 'number' && Number.isFinite(t.to) ? t.to : 1
          if (t.durationMs <= 0) {
            tasks.push(`delay(${sec(t.startMs)}, () => ${sig}(${num(to)})),`)
          } else {
            tasks.push(`delay(${sec(t.startMs)}, ${sig}(${num(to)}, ${sec(t.durationMs)}${easeArg})),`)
          }
        }
        continue
      }
      // 轨道目标走同一张别名表（@dsh-anim/spec）：存量 spec 里已落库的
      // props.strokeWidth 轨道由此一并复活（0.3.x O21 的延续，表驱动化）
      const alias = PROP_ALIASES[prop]
      if (alias !== undefined && !animatable.has(prop) && animatable.has(alias)) {
        prop = alias
      }
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

  // 主循环：group 的成员随所属组一起生成（保证父节点先于子节点存在）。
  // audio 图层不进画面（音轨走 adapter 的 ffmpeg mux），整体跳过
  for (const layer of scene.layers) {
    if (layer.type === 'audio') {
      if (layer.tracks.length > 0) {
        warnings.push(`audio 图层 ${layer.id} 的轨道不参与画面与时长，已忽略`)
      }
      continue
    }
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

  // 入场转场：view 级变换。**view.x/y 是位置分量**（MC 的画布中心在
  // size/2），slide 系列的起点/终点都必须相对画布中心表达——写成 0 会把
  // 整个 view（连同背景矩形）贴到画布左/上缘（0.2 起的潜伏缺陷，M2 真机
  // 验收抽帧时抓到：slide 入场后半屏露黑、内容整体偏移半幅）。
  const cx = subtitleStyle.canvasWidth / 2
  const cy = subtitleStyle.canvasHeight / 2
  if (scene.transition && scene.transition.kind !== 'none') {
    const ease = easeExpr(scene.transition.ease, imports)
    const easeArg = ease ? `, ${ease}` : ''
    const d = sec(scene.transition.durationMs)
    switch (scene.transition.kind) {
      case 'fade':
        initial.push('view.opacity(0);')
        tasks.push(`delay(0, view.opacity(1, ${d}${easeArg})),`)
        break
      case 'slideLeft':
        initial.push(`view.x(${num(cx + 200)});`, `view.y(${num(cy)});`)
        tasks.push(`delay(0, view.x(${num(cx)}, ${d}${easeArg})),`)
        break
      case 'slideRight':
        initial.push(`view.x(${num(cx - 200)});`, `view.y(${num(cy)});`)
        tasks.push(`delay(0, view.x(${num(cx)}, ${d}${easeArg})),`)
        break
      case 'slideUp':
        initial.push(`view.y(${num(cy + 200)});`, `view.x(${num(cx)});`)
        tasks.push(`delay(0, view.y(${num(cy)}, ${d}${easeArg})),`)
        break
      case 'slideDown':
        initial.push(`view.y(${num(cy - 200)});`, `view.x(${num(cx)});`)
        tasks.push(`delay(0, view.y(${num(cy)}, ${d}${easeArg})),`)
        break
      case 'zoomIn':
        initial.push('view.scale(0.6);', 'view.opacity(0);')
        tasks.push(`delay(0, view.scale(1, ${d}${easeArg})),`)
        tasks.push(`delay(0, view.opacity(1, ${d}${easeArg})),`)
        break
      default:
        warnings.push(`转场类型 ${String(scene.transition.kind)} 未实现，已忽略`)
    }
  }

  const duration = sceneDurationMs(scene)

  // 幕尾退场（§4.4）：占用本幕最后 exit.durationMs 做整体退出。退场任务把
  // 时间线顶到场景末尾，因此 lastEnd 必须纳入 exitEnd——否则尾部 waitFor
  // 补齐逻辑会在退场后再拖一段静止时间，退场永远放不完。slide 退场滑出
  // 半幅再带 240px 余量，保证画面完全离场。
  let exitCoveredDuration = false
  if (scene.exit && scene.exit.kind !== 'none' && scene.exit.durationMs > 0) {
    const ease = easeExpr(scene.exit.ease, imports)
    const easeArg = ease ? `, ${ease}` : ''
    const d = sec(scene.exit.durationMs)
    const exitStart = sec(Math.max(0, duration - scene.exit.durationMs))
    switch (scene.exit.kind) {
      case 'fade':
        tasks.push(`delay(${exitStart}, view.opacity(0, ${d}${easeArg})),`)
        exitCoveredDuration = true
        break
      case 'slideLeft':
        tasks.push(`delay(${exitStart}, view.x(${num(-(cx + 240))}, ${d}${easeArg})),`)
        exitCoveredDuration = true
        break
      case 'slideRight':
        tasks.push(`delay(${exitStart}, view.x(${num(cx + cx + 240)}, ${d}${easeArg})),`)
        exitCoveredDuration = true
        break
      case 'slideUp':
        tasks.push(`delay(${exitStart}, view.y(${num(-(cy + 240))}, ${d}${easeArg})),`)
        exitCoveredDuration = true
        break
      case 'slideDown':
        tasks.push(`delay(${exitStart}, view.y(${num(cy + cy + 240)}, ${d}${easeArg})),`)
        exitCoveredDuration = true
        break
      default:
        warnings.push(`退场类型 ${String(scene.exit.kind)} 暂不支持（可选：fade / slideLeft / slideRight / slideUp / slideDown），已忽略`)
    }
  }

  // 字幕条（§4.3）：底部居中，muted 半透明底条 + 主题文字色，按 cue 时段
  // 150ms 淡入淡出。字幕来自 scene.subtitles（expandNarration 的展开产物，
  // 场景内本地毫秒），只存在于生成的 TSX 里。
  // 超宽自动折行（wrapSubtitleText）：底条按最宽行计算、随行数增高，底边
  // 锚定在「画布底边上方 36px」——行数变多时向上生长，不越过画布下缘。
  let maxBandH = 0
  let bandUsed = false
  for (const [i, cue] of (scene.subtitles ?? []).entries()) {
    const bg = `nsub${i}bg`
    const tx = `nsub${i}tx`
    const fontSize = subtitleStyle.fontSize
    const lineHeight = Math.round(fontSize * 1.4)
    const padV = Math.round(fontSize * 0.55)
    const lines = wrapSubtitleText(cue.text, fontSize, Math.round(subtitleStyle.canvasWidth * 0.86) - 48)
    const textW = Math.max(...lines.map(l => estimateTextWidth(l, fontSize)))
    const w = Math.min(Math.round(subtitleStyle.canvasWidth * 0.9), textW + 48)
    const h = lines.length * lineHeight + padV * 2
    if (h > maxBandH) maxBandH = h
    bandUsed = true
    const y = Math.round(subtitleStyle.canvasHeight / 2 - h / 2 - 36)
    components.add('Rect')
    components.add('Txt')
    coreImports.add('createRef')
    setup.push(`const ${bg} = createRef<Rect>();`)
    setup.push(`view.add(<Rect ref={${bg}} x={0} y={${y}} width={${num(w)}} height={${h}} radius={${Math.round(h / 4)}} fill={${JSON.stringify(subtitleStyle.mutedFill)}} opacity={0} />);`)
    setup.push(`const ${tx} = createRef<Txt>();`)
    // MC 的 lineHeight 数字语义是 px，倍数要走字符串（'140' → 1.4 倍）；
    // textWrap='pre' 是 \n 分行的开关（默认 DOM 布局会折叠换行符）
    setup.push(`view.add(<Txt ref={${tx}} x={0} y={${y}} text={${JSON.stringify(lines.join('\n'))}} fontSize={${fontSize}} lineHeight={'140'} textWrap={'pre'} fill={${JSON.stringify(subtitleStyle.textColor)}} opacity={0} />);`)
    const fadeIn = 150
    const fadeOut = cue.endMs - cue.startMs < 2 * fadeIn ? Math.round((cue.endMs - cue.startMs) / 2) : fadeIn
    const fadeOutAt = Math.max(cue.startMs, cue.endMs - fadeOut)
    tasks.push(`delay(${sec(cue.startMs)}, ${bg}().opacity(0.6, ${sec(fadeOut)})),`)
    tasks.push(`delay(${sec(cue.startMs)}, ${tx}().opacity(1, ${sec(fadeOut)})),`)
    tasks.push(`delay(${sec(fadeOutAt)}, ${bg}().opacity(0, ${sec(fadeOut)})),`)
    tasks.push(`delay(${sec(fadeOutAt)}, ${tx}().opacity(0, ${sec(fadeOut)})),`)
  }

  // 字幕安全区提醒（软警告）：有字幕的幕，画布底部这一横条是字幕带，正文
  // 图层的锚点落进去会被字幕盖住。锚点级检查（props.y / props.y 轨道关键帧 /
  // line/arrow 的 points），不追图层包围盒——居中或全屏元素（y≈0）不会误报。
  if (bandUsed) {
    const bandTop = subtitleStyle.canvasHeight / 2 - 36 - maxBandH
    const offenders = new Set<string>()
    for (const layer of scene.layers) {
      if (layer.type === 'audio' || layer.type === 'group') continue
      const baseY = typeof layer.props.y === 'number' ? layer.props.y : 0
      const ys: number[] = []
      if (baseY !== 0) ys.push(baseY)
      for (const tr of layer.tracks) {
        if (tr.target !== 'props.y') continue
        for (const k of tr.keys) if (typeof k.value === 'number') ys.push(k.value)
      }
      const pts = layer.props.points
      if (Array.isArray(pts)) {
        for (const p of pts) {
          if (Array.isArray(p) && typeof p[1] === 'number') ys.push(baseY + p[1])
        }
      }
      if (ys.some(v => v > bandTop)) offenders.add(layer.id)
    }
    if (offenders.size > 0) {
      warnings.push(
        `本幕有字幕：画布底部约 ${Math.round(maxBandH + 36)}px 高的区域是字幕带，图层 ${[...offenders].join(' / ')} 的位置落在其中会被字幕遮挡，正文内容建议上移（y < ${Math.round(bandTop)}）`,
      )
    }
  }

  // 补齐到场景时长，让「留白」也进时间线
  const lastEnd = scene.layers.reduce((max, layer) => {
    if (layer.type === 'audio') return max
    for (const track of layer.tracks) {
      for (const t of tweensOf(track)) max = Math.max(max, t.startMs + t.durationMs)
    }
    return max
  }, Math.max(scene.transition?.durationMs ?? 0, ...(scene.subtitles ?? []).map(c => c.endMs), exitCoveredDuration ? duration : 0))
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
  if (usedHighlighters.size > 0) {
    L.push(`import {${[...usedHighlighters].sort().join(', ')}} from '../code-highlight';`)
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
      // 背景兜底主题底色：view 滑入/缩放入场时背景矩形会短暂离位，露出的是
      // project 背景——留 null（黑）会让 slide/zoom 入场的第一帧发黑
      background: spec.meta.background ?? spec.theme.colors.background ?? null,
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

/* ------------------------------------------------- 音轨清单 / 字幕 / 字体 */

/**
 * 一条待混音的音轨（§4.1）。时间与时长都是**渲染成片口径**的绝对值：
 * 场景起点按 sceneDurationMs 累计换算，`anim_render` 的 scenes 抽查渲染
 * 的是切片后的 spec，音轨清单也从切片后重新收集，两边天然一致。
 */
export interface AudioTrackCue {
  /** 引用的资产 id（回执 audioTracks 展示用；直连 URL 时为图层 id）。 */
  assetId: string
  /** ffmpeg 输入源：本地绝对路径或 http(s) URL。 */
  source: string
  /** 全片绝对起点（毫秒）。 */
  startMs: number
  /** 播放时长（毫秒），已按 stop 语义截断。 */
  durationMs: number
  /** 音量 0~1（越界已钳制）。 */
  volume: number
  /** 播到时长尽头仍没放完时循环。 */
  loop: boolean
}

/**
 * 从 spec 收集音轨清单（§4.1）。
 *
 * audio 图层不进 MC 帧合成（MC 的 Audio 节点不参与导出），成片的音频由
 * adapter 在编码/拼接之后按本清单 ffmpeg 二次混入。解析规则与 image 的
 * asset: 引用同构：`asset:<id>` 解析成资产文件的本地绝对路径（ffmpeg 不认
 * vite 的 /assets URL，但认文件路径），http(s) URL 原样透传（ffmpeg 可直接
 * 流式拉取）。文件缺失只警告不阻断——缺音轨的片子仍是无声成片，不该让
 * 整个渲染失败。
 */
export function collectAudioTracks(spec: AnimationSpec): { cues: AudioTrackCue[]; warnings: string[] } {
  const warnings: string[] = []
  const cues: AudioTrackCue[] = []
  const totalMs = specDurationMs(spec.scenes)
  let cursor = 0
  for (const scene of spec.scenes) {
    const sceneDur = sceneDurationMs(scene)
    for (const layer of scene.layers) {
      if (layer.type !== 'audio') continue
      const props = layer.props
      const src = typeof props.src === 'string' ? props.src : undefined
      let source: string | undefined
      let assetId = layer.id
      if (src === undefined || src.trim() === '') {
        warnings.push(`audio 图层 ${layer.id} 未提供 src（用 "asset:<assetId>" 引用已导入的音频资产），已忽略`)
      } else if (src.startsWith('asset:')) {
        assetId = src.slice('asset:'.length)
        const asset = spec.assets[assetId]
        if (!asset) {
          warnings.push(`audio 图层 ${layer.id} 引用了未登记的资产 ${assetId}（用 anim_asset_import 登记后再引用），已忽略`)
        } else if (/^https?:\/\//.test(asset.src)) {
          source = asset.src
        } else {
          const abs = resolve(asset.src)
          if (existsSync(abs)) source = abs
          else warnings.push(`audio 图层 ${layer.id} 的资产文件不存在：${abs}，已忽略`)
        }
      } else if (/^https?:\/\//.test(src)) {
        source = src
      } else {
        warnings.push(`audio 图层 ${layer.id} 的 src 应为 "asset:<assetId>" 或 http(s) URL，已忽略`)
      }
      if (source === undefined) continue

      const offsetMs = typeof props.atMs === 'number' && Number.isFinite(props.atMs) ? Math.max(0, props.atMs) : 0
      const startMs = cursor + offsetMs
      const stopAt = props.stop === 'specEnd' ? totalMs : cursor + sceneDur
      if (startMs >= stopAt) {
        warnings.push(`audio 图层 ${layer.id} 的起点（${startMs}ms）不早于停止点（${stopAt}ms），无声可放，已忽略`)
        continue
      }
      let volume = 1
      if (props.volume !== undefined) {
        if (typeof props.volume === 'number' && Number.isFinite(props.volume)) {
          volume = Math.min(1, Math.max(0, props.volume))
          if (volume !== props.volume) {
            warnings.push(`audio 图层 ${layer.id} 的 volume ${props.volume} 超出 0~1，已钳制为 ${volume}`)
          }
        } else {
          warnings.push(`audio 图层 ${layer.id} 的 volume 应为数字，已按 1 处理`)
        }
      }
      cues.push({
        assetId,
        source,
        startMs,
        durationMs: stopAt - startMs,
        volume,
        loop: props.loop === true,
      })
    }
    cursor += sceneDur
  }
  return { cues, warnings }
}

/** 一条字幕在本幕内的呈现时段（本地毫秒）。 */
export interface SubtitleCue {
  text: string
  startMs: number
  endMs: number
}

/**
 * 旁白字幕展开（§4.3）：把顶层 `narration.cues`（**全片绝对毫秒**）展开成
 * 各幕的 `scene.subtitles`（场景内本地毫秒），返回的 spec 不再带 narration。
 *
 * 为什么在渲染入口展开而不是在 codegen 里现场换算：展开之后字幕就是场景
 * JSON 的一部分——场景级增量渲染按场景指纹缓存，字幕改动天然触发该幕重渲；
 * scenes 抽查 / 幕级 solo 切片后字幕跟着场景走、本地时间不丢。真机验收发现
 * 的缺陷即来源于此：在切片后的 spec 上现场换算全局时间，第二幕的字幕整条
 * 丢失且不触发重渲。
 *
 * 规则：cue 缺省时长按中文语速估（≈4 字/秒，下限 1200ms）；配音渲染传
 * options.displayMs（与 cues 对齐的实测音频时长，0.5.0 §5）时显示时长取
 * 「估算与实测的较大者」——宁可字比声先消失，不让「声还在字没了」；跨幕 cue
 * 每幕各出一份（画面独立，只能如此）；与本幕交集不足 30ms 的尾巴不生成；
 * 超 80 字软警告（渲染端自动折行，不再截断——过长字幕画面偏挤，建议拆 cue）；
 * 起点越出全片时长给软警告。原 spec 不被修改。
 */
export function expandNarration(spec: AnimationSpec, options: { displayMs?: number[] } = {}): { spec: AnimationSpec; warnings: string[] } {
  const warnings: string[] = []
  const cues = spec.narration?.cues ?? []
  if (cues.length === 0) return { spec, warnings }
  const totalMs = specDurationMs(spec.scenes)
  const expanded = cues.map((cue, i) => {
    const spokenMs = options.displayMs?.[i] ?? 0
    const estimated = cue.durationMs ?? Math.max(1200, Math.round((cue.text.length / 4) * 1000))
    const durationMs = Math.max(estimated, spokenMs)
    if (cue.atMs >= totalMs) {
      warnings.push(`旁白 cue ${i}（${cue.atMs}ms）起于全片时长（${totalMs}ms）之外，不会出现`)
    }
    if (cue.text.length > 80) {
      warnings.push(`旁白 cue ${i} 超过 80 字，一条 cue 建议不超过 40 字（渲染时会自动折行，但整屏都是字幕观感偏挤）`)
    }
    return { atMs: cue.atMs, durationMs, text: cue.text }
  })
  const scenes: Scene[] = []
  let cursor = 0
  for (const scene of spec.scenes) {
    const sceneDur = sceneDurationMs(scene)
    const sceneStart = cursor
    cursor += sceneDur
    const subs: SubtitleCue[] = []
    for (const cue of expanded) {
      // cue（全片绝对毫秒）与本幕窗口 [sceneStart, sceneStart+sceneDur) 的
      // 交集，换算成场景内本地毫秒
      const start = Math.max(cue.atMs, sceneStart) - sceneStart
      const end = Math.min(cue.atMs + cue.durationMs, sceneStart + sceneDur) - sceneStart
      if (end - start <= 30) continue
      subs.push({ text: cue.text, startMs: start, endMs: end })
    }
    scenes.push(subs.length > 0 ? { ...scene, subtitles: subs } : scene)
  }
  return { spec: { ...spec, scenes, narration: undefined }, warnings }
}

/**
 * font 资产 → fonts.css（§4.2）：每个 font 资产一条 @font-face。
 * family 直接用 assetId 原文（opAssetImport 限制为 [A-Za-z0-9._-]，可安全
 * 进 CSS 引号串），模型在 text/code 图层写 fontFamily: "<assetId>" 即生效；
 * 文件 URL 用 safeName 净化串，与 copyAssetsToPublic 落盘的文件名严格一致。
 * http(s) 字体 URL 原样引用（注意远端字体需要 CORS 头，否则 canvas 拿不到）。
 * 没有 font 资产时不生成，项目保持最小。
 */
const FONT_FORMATS: Record<string, string> = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }

export function generateFontsCss(assets: Record<string, Asset>): GeneratedFile | undefined {
  const fonts = Object.entries(assets).filter(([, a]) => a.kind === 'font')
  if (fonts.length === 0) return undefined
  const rules = fonts.map(([id, asset]) => {
    const isRemote = /^https?:\/\//.test(asset.src)
    const ext = extname(isRemote ? asset.src.split(/[?#]/)[0]! : asset.src).slice(1).toLowerCase()
    const url = isRemote ? asset.src : `/assets/${safeName(id)}${ext ? `.${ext}` : ''}`
    const format = FONT_FORMATS[ext] ?? 'truetype'
    return `@font-face {\n  font-family: '${id}';\n  src: url('${url}') format('${format}');\n}`
  })
  return {
    path: 'fonts.css',
    content: `/* 自定义字体（font 资产 → @font-face）。由 @dsh-anim/render-mc 生成，请勿手工编辑。 */\n${rules.join('\n')}\n`,
  }
}

/* ------------------------------------------------------------------ 入口 */

/** 把一份 spec 编译成可直接交给 Motion Canvas 构建的项目文件。 */
export function generateProject(
  spec: AnimationSpec,
  options: { resolutionScale?: number; displayMs?: number[] } = {},
): GenerateResult {
  const warnings: string[] = []
  const background = spec.meta.background ?? spec.theme.colors.background ?? '#000000'
  const defaultTextFill = spec.theme.colors.text ?? '#FFFFFF'

  const files: GeneratedFile[] = [{ path: 'anim-easing.ts', content: EASING_FILE }]

  // 旁白 cues → 各幕 subtitles（§4.3）：字幕变成场景数据的一部分，
  // 场景级增量渲染的切片与指纹因此天然正确（见 expandNarration 注释）
  const expanded = expandNarration(spec, { displayMs: options.displayMs })
  warnings.push(...expanded.warnings)
  spec = expanded.spec

  // font 资产 → fonts.css（§4.2）：project.tsx 里 import 使 @font-face 生效
  const fontsCss = generateFontsCss(spec.assets)
  if (fontsCss) files.push(fontsCss)

  const subtitleStyle: SubtitleStyle = {
    mutedFill: spec.theme.colors.muted ?? '#8A8F98',
    textColor: defaultTextFill,
    // 字幕字号与画布高度成比例（约 4%，视频字幕的常见比例），不跟正文字号
    // （theme.font.size）走——正文 48px 的主题直接拿来当字幕就是顶天立地。
    fontSize: Math.min(56, Math.max(14, Math.round(spec.meta.size.height * 0.04))),
    canvasWidth: spec.meta.size.width,
    canvasHeight: spec.meta.size.height,
  }

  // code 图层用了 language 才生成高亮模块：没有任何 code 图层时，
  // 生成物不依赖 @lezer/* 语言包，项目保持最小。
  const usedHighlighters = new Set<string>()
  spec.scenes.forEach((scene, i) => {
    files.push(genSceneFile(scene, i, background, defaultTextFill, spec.assets, warnings, usedHighlighters, subtitleStyle))
  })
  if (usedHighlighters.size > 0) {
    files.push({ path: 'code-highlight.ts', content: CODE_HIGHLIGHT_FILE })
  }

  // 音轨清单（§4.1）：audio 不进帧合成，adapter 在编码/拼接后按清单混音
  const audio = collectAudioTracks(spec)
  warnings.push(...audio.warnings)

  const imports = spec.scenes.map((s, i) => `import s${i} from './scenes/s${i}-${sanitize(s.id)}?scene';`)
  const L: string[] = []
  L.push('/**')
  L.push(` * ${spec.meta.title}`)
  L.push(' *')
  L.push(' * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。')
  L.push(' * `?scene` 后缀是必需的：vite 插件会给场景补上 makeProject 需要的运行时字段。')
  L.push(' */')
  for (const line of imports) L.push(line)
  if (fontsCss) L.push("import './fonts.css';")
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

  return { files, warnings, audioTracks: audio.cues }
}
