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
}

export interface AnimRenderer {
  readonly name: string
  diagnose(): Promise<RenderDiagnostics>
  preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult>
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult>
}
