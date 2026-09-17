/**
 * AnimationSpec —— 与渲染后端无关的教学动画时间线中间表示（IR）。
 *
 * 设计要点：
 * 1. 时间一律用**场景内绝对毫秒**。LLM 生成绝对时间线的准确率远高于相对等待，
 *    人类在时间轴上拖关键帧也更自然；由渲染适配器负责转成后端的相对时序。
 * 2. 一切可动的属性都收进 `tracks`——淡入就是 opacity 上两个关键帧，
 *    没有「特殊动画类型」的特例，微调面板因此可以对任意属性统一处理。
 * 3. 本文件必须是纯类型 + 纯数据，不得引入任何 I/O 或渲染后端依赖，
 *    因为它同时被 host（Node）与 client（浏览器）共享。
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type SpecId = string
export type SceneId = string
export type LayerId = string
export type TrackId = string
export type AssetId = string

/* ------------------------------------------------------------------ 缓动 */

/** 缓动规范。渲染适配器负责映射到后端自己的 timing function。 */
export type EaseSpec =
  | { kind: 'linear' }
  | { kind: 'easeIn' }
  | { kind: 'easeOut' }
  | { kind: 'easeInOut' }
  | { kind: 'cubicBezier'; points: [number, number, number, number] }
  | { kind: 'spring'; stiffness?: number; damping?: number; mass?: number }
  /** 弹跳落定（easeOutBounce）：皮球落地式回弹，入场强调最常用。 */
  | { kind: 'bounce' }
  /** 弹性超调（easeOutElastic）：冲过头再弹回，适合「啪」地弹出。 */
  | { kind: 'elastic' }
  /** 回勾起手（easeOutBack）：先反向一点再冲到位，卡片/星标弹出常用。 */
  | { kind: 'back' }

/* ---------------------------------------------------------------- 关键帧 */

export type KeyframeValue = number | string | boolean

export interface Keyframe {
  /** 场景内绝对时间（毫秒）。 */
  atMs: number
  /** 该时刻的目标值。数字可插值；字符串/布尔默认为离散跳变——唯一的例外是
   * code 图层的 props.code：多个字符串关键帧会生成 MC 的逐词 diff morph
   * （代码演化动画），参见 anim_draft_scene 描述。 */
  value: KeyframeValue
  /** 从**上一个**关键帧补间到本关键帧所用的缓动；首帧无意义。 */
  ease?: EaseSpec
}

/* ------------------------------------------------------------------ 轨道 */

/**
 * 一条轨道 = 一个属性随时间的演进。
 * `target` 是属性路径，MVP 只支持 `props.<field>`（如 `props.opacity`）。
 */
export interface Track {
  id: TrackId
  target: string
  keys: Keyframe[]
}

/* ------------------------------------------------------------------ 图层 */

/**
 * 图层类型的唯一权威枚举：`LayerType` 联合从这里派生，validate 的放行集合、
 * codegen 的映射表、工具描述都以它为基准对齐（新增类型只改这一处 +
 * 各消费表，冒烟有枚举一致性断言盯着漂移）。
 */
export const LAYER_TYPES = [
  'text', 'rect', 'circle', 'ellipse', 'image',
  'line', 'arrow',
  'polygon', 'star',
  'svg',
  'code', 'math',
  'group',
  'audio',
] as const

export type LayerType = (typeof LAYER_TYPES)[number]

/**
 * 图层静态属性。列出的是**已知**字段（有类型提示），
 * 其余字段通过索引签名放开放置，便于后端适配器扩展。
 *
 * 坐标系契约：`x`/`y` 的**原点在画布中心**——x 向右为正、y 向下为正，
 * 单位 px，画布左上角是 `(-width/2, -height/2)`、右下角是 `(width/2, height/2)`。
 * 这与渲染后端（Motion Canvas）一致，但与 web/CSS 的左上角原点直觉相反；
 * validateSpec 会对疑似按左上角书写的坐标给出警告。
 */
export interface LayerProps {
  // 变换
  /** 水平位置：原点在画布中心，向右为正；画布左缘是 -meta.size.width/2。 */
  x?: number
  /** 垂直位置：原点在画布中心，向下为正；画布上缘是 -meta.size.height/2。 */
  y?: number
  /** 等比缩放系数，1 = 原始大小。 */
  scale?: number
  /** 旋转角度（度），正值为顺时针。 */
  rotation?: number
  /** 不透明度，0（透明）~ 1（不透明）。 */
  opacity?: number
  // 尺寸
  width?: number
  height?: number
  size?: number
  radius?: number
  // 样式
  fill?: string
  stroke?: string
  lineWidth?: number
  // 文本
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  lineHeight?: number
  // 图片
  src?: string
  // 线条 / 箭头（line / arrow）
  /** 折线顶点，如 [[-200,0],[200,0]]。坐标以图层自身原点为准（中心原点契约）。 */
  points?: Array<[number, number]>
  /** 画线进度 0~1：只显示从起点到该比例的一段（配合轨道动画做「画线」效果）。 */
  start?: number
  end?: number
  startArrow?: boolean
  endArrow?: boolean
  /** 箭头大小（像素），默认 24。 */
  arrowSize?: number
  // 正多边形（polygon）与星形（star）
  /** polygon 的边数 / star 的角数（默认 6 / 5）。 */
  sides?: number
  // 内嵌 SVG（svg 图层）
  /** 内嵌 SVG 字符串（svg 图层用，如 '<svg viewBox="0 0 100 100">…</svg>'）。 */
  svg?: string
  // 代码（code 图层）
  /** 代码内容（code 图层）。字符串里用 `{{片段}}` 可给片段着色（Code 组件原生语法）。 */
  code?: string
  /**
   * 代码语言（code 图层，用于语法高亮）。
   * 支持：typescript/ts、tsx、javascript/js、jsx、python/py、json、html、css。
   * 缺省或未知语言不染色（纯文本，仍可正常渲染）。
   */
  language?: string
  // 数学公式（math 图层）
  /** LaTeX 公式源码（math 图层），如 'E = mc^2'、'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'。 */
  tex?: string
  // 分组
  /** group 图层的成员图层 id 列表（同一场景内）。变换属性作用于整组。 */
  children?: LayerId[]
  // 音频（audio 图层；不进画面，渲染尾步由 ffmpeg 混入成片）
  /** 音量 0~1，默认 1。 */
  volume?: number
  /** 播到停止点仍没放完时是否循环，默认 false。 */
  loop?: boolean
  /** 停止时机：sceneEnd（默认）= 本幕结束；specEnd = 一直响到片尾。
   * 第一幕 audio + loop + stop:'specEnd' 即全片 BGM 的标准写法。 */
  stop?: 'sceneEnd' | 'specEnd'
  /** 相对本幕开头的起始偏移（毫秒），默认 0（随幕起点开始）。 */
  atMs?: number
  [key: string]: JsonValue | undefined
}

export interface Layer {
  id: LayerId
  name: string
  type: LayerType
  props: LayerProps
  tracks: Track[]
}

/* ------------------------------------------------------------------ 场景 */

/**
 * 入场/退场动画。kind 语义都是「整幕 view 的变换」：
 * 入场从指定形态进入画面；exit（Scene.exit）在幕尾整体退出。
 */
export interface Transition {
  kind: 'none' | 'fade' | 'slideLeft' | 'slideUp' | 'slideRight' | 'slideDown' | 'zoomIn'
  durationMs: number
  ease?: EaseSpec
}

export interface Scene {
  id: SceneId
  /** 人类可读的场景名，也是教学分镜的标题（如「概念引入：什么是梯度」）。 */
  name: string
  /** 声明时长；实际时长取声明值与轨道结束时长的较大者。 */
  durationMs: number
  layers: Layer[]
  transition?: Transition
  /** 幕尾退场：占用本幕最后 exit.durationMs 做整体退出。缺省无退场。
   * 支持 fade / slideLeft / slideRight / slideUp / slideDown（zoomIn 仅入场）。 */
  exit?: Transition
  /**
   * 本幕的字幕条（场景内本地毫秒，§4.3）。**宿主展开产物**：作者侧用顶层
   * narration.cues（全片绝对毫秒），渲染入口展开成各幕的 subtitles——
   * 展开之后字幕就是场景数据的一部分，场景级增量渲染的切片与指纹天然
   * 正确（改字幕 → 场景 JSON 变 → 指纹变 → 重渲该幕）。
   */
  subtitles?: Array<{ text: string; startMs: number; endMs: number }>
  background?: string
}

/* -------------------------------------------------------------- 主题/资产 */

export interface ThemeToken {
  colors: {
    background: string
    text: string
    muted: string
    primary: string
    accent: string
    [key: string]: string
  }
  font: {
    family: string
    /** 基准字号，具体图层可覆盖。 */
    size: number
  }
}

export interface Asset {
  kind: 'image' | 'audio' | 'font' | 'svg'
  /**
   * 资产文件的绝对/相对路径，或 http(s) URL。
   * 图层 props 里用 `asset:<AssetId>` 引用（如 image.src = "asset:ball"），
   * 渲染端物化时把本地文件复制进项目并换成可加载的 URL。
   */
  src: string
  alt?: string
}

export interface Meta {
  id: SpecId
  title: string
  fps: number
  size: { width: number; height: number }
  background?: string
  locale?: string
}

/* ------------------------------------------------------------------ 顶层 */

export interface AnimationSpec {
  version: 1
  meta: Meta
  theme: ThemeToken
  assets: Record<AssetId, Asset>
  scenes: Scene[]
  /**
   * 旁白字幕（0.4.0 §4.3）：渲染时展开为各幕底部的字幕条（muted 半透明底条
   * + 主题文字色）。`atMs` 是**全片绝对毫秒**（与场景内时间轴区分）；
   * `durationMs` 缺省按中文语速估算（≈4 字/秒，下限 1200ms）。
   * 字幕字号按画布高度约 4% 自适应（与正文字号解耦），超宽自动折行、底条
   * 随行数增高；底部字幕带是保留区，正文图层的 y 应避开（渲染时会提示重叠）。
   * TTS 语音合成推迟到 0.5——届时 cues 从「显示」升级为「发声 + 显示」，
   * IR 不再改。
   */
  narration?: {
    cues: Array<{ atMs: number; text: string; durationMs?: number; voice?: string }>
  }
  /** MVP 预留：字幕轨道。 */
  subtitles?: Array<{ sceneId: SceneId; atMs: number; text: string }>
}
