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
}

export interface RenderRequest {
  spec: AnimationSpec
  outputPath: string
  scenes?: number[]
  scale?: number
  onProgress?: (done: number, total: number) => void
}

export interface RenderResult {
  outputPath: string
  frameCount: number
  durationMs: number
  width: number
  height: number
  renderer: string
}

export interface AnimRenderer {
  readonly name: string
  diagnose(): Promise<RenderDiagnostics>
  preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult>
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult>
}
