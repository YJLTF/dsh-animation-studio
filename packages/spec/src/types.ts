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

/* ---------------------------------------------------------------- 关键帧 */

export type KeyframeValue = number | string | boolean

export interface Keyframe {
  /** 场景内绝对时间（毫秒）。 */
  atMs: number
  /** 该时刻的目标值。数字可插值；字符串/布尔为离散跳变。 */
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

export type LayerType = 'text' | 'rect' | 'circle' | 'image' | 'group'

/**
 * 图层静态属性。列出的是**已知**字段（有类型提示），
 * 其余字段通过索引签名放开放置，便于后端适配器扩展。
 */
export interface LayerProps {
  // 变换
  x?: number
  y?: number
  scale?: number
  rotation?: number
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
  // 分组
  children?: LayerId[]
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

export interface Transition {
  kind: 'none' | 'fade' | 'slideLeft' | 'slideUp'
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
  /** 相对项目根目录的路径，或 http(s) URL。 */
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
  /** MVP 预留：旁白轨道（实现涉及 TTS 与音画对齐，本轮不落地）。 */
  narration?: {
    cues: Array<{ atMs: number; text: string; voice?: string }>
  }
  /** MVP 预留：字幕轨道。 */
  subtitles?: Array<{ sceneId: SceneId; atMs: number; text: string }>
}
