/**
 * 渲染接缝的 Service Definition。
 *
 * 刻意在 `render-mc` 里复述一遍而不是从 host 包 import：adapter 是独立的 provider，
 * 不该反向依赖 host。两边靠结构类型对齐（TS 的 structural typing 让这里不需要
 * 共享一个基类，但**必须**保持字段一致——改了一边另一边要一起改）。
 *
 * 唯一的权威定义在 `packages/tools/src/render.ts`（host 包）。
 */

import type { AnimationSpec } from '@dsh-anim/spec'

export interface RenderDiagnostics {
  renderer: string
  ok: boolean
  issues: string[]
  details?: Record<string, string>
}

export interface PreviewFrame {
  atMs: number
  path: string
  width: number
  height: number
}

export interface PreviewRequest {
  spec: AnimationSpec
  atMs?: number[]
  scale?: number
}

export interface PreviewResult {
  frames: PreviewFrame[]
  renderer: string
  /**
   * 生成期降级警告（同类已合并计数）。此前只进宿主日志、模型看不见——
   * 「渲染不报错、看片才发现」的产出偏差由此堵住（0.4.0 规划 N4）。
   */
  warnings?: string[]
  /**
   * 单幕直放（0.5.0 规划 §3.2）：与 host 包 render.ts 的 PreviewResult
   * 成对改。MC 适配器的预览不产 clip（直放在 host 侧 findSceneSegment
   * 快路径完成），字段在此存在只为结构对齐。
   */
  clip?: PreviewClip
}

/** 单幕段视频直放的信息。段文件在 outputDir 内，媒体路由天然可服务。 */
export interface PreviewClip {
  path: string
  sceneId: string
  sceneIndex: number
  durationMs: number
}

/** 旁白配音载荷（0.5.0 规划 §5）。与 host 包 render.ts 成对改。 */
export interface SpeechPayload {
  tracks: Array<{ source: string; startMs: number; durationMs: number; volume: number }>
  displayMs?: number[]
}

export interface RenderRequest {
  spec: AnimationSpec
  outputPath: string
  scenes?: number[]
  scale?: number
  /**
   * 段缓存开关（0.4.0 规划 §3.4）。默认开启：逐幕指纹比对，未变幕直接复用
   * 上次渲染的段。显式传 false 强制全量渲染（排查缓存疑点时的保底开关）。
   */
  cache?: boolean
  /** 旁白配音（0.5.0 规划 §5）：mux 音轨 + 字幕显示时长跟随实测音频。
   * 允许传 Promise：后台渲染时合成发生在 job 内，不占模型回合。 */
  speech?: SpeechPayload | Promise<SpeechPayload>
  onProgress?: (done: number, total: number) => void
}

/** 增量渲染的结果说明（§3.4），全量渲染且未尝试增量时缺省。 */
export interface IncrementalInfo {
  /** 本次渲染涉及的幕数。 */
  scenesTotal: number
  /** 直接复用段缓存的幕数（0 = 全部现渲）。 */
  scenesReused: number
  /** 增量流程失败、自动回退全量渲染时为 true；原因见 warnings。 */
  fallback?: boolean
}

export interface RenderResult {
  outputPath: string
  frameCount: number
  durationMs: number
  width: number
  height: number
  renderer: string
  /** 本片目标帧数（fps × 时长），与进度事件的 total 同口径——成本预期管理。 */
  expectedFrames?: number
  /** 生成期降级警告（同类已合并计数），语义同 PreviewResult.warnings。 */
  warnings?: string[]
  /** 增量渲染命中情况（§3.4）；未走增量（cache:false / 空片）时缺省。 */
  incremental?: IncrementalInfo
  /**
   * 混入成片的音轨（§4.1）：audio 图层的 assetId 列表。空/缺省 = 无声成片。
   * 音轨在编码/拼接之后从现行 spec 重新混入，不参与段缓存。
   */
  audioTracks?: string[]
  /** 混入成片的旁白配音条数（0.5.0 规划 §5）。与 host 包成对改。 */
  speechTracks?: number
  /** 旁白音画对账清单（0.5.0 §5.3）。与 host 包成对改。 */
  speechNotes?: Array<{ index: number; text: string; atMs: number; audioMs: number; overflowMs: number }>
  /** 全片关键帧拼贴图（0.5.0 规划 §3.3）；生成失败缺省。与 host 包成对改。 */
  contactSheet?: string
}

export interface AnimRenderer {
  readonly name: string
  diagnose(): Promise<RenderDiagnostics>
  preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult>
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult>
  /**
   * 单幕段缓存查找（0.5.0 规划 §3.2，可选能力）。与 host 包 render.ts 成对改。
   */
  findSceneSegment?(spec: AnimationSpec, sceneIndex: number, scale?: number): { path: string; durationMs: number } | null
}
