/**
 * 渲染接缝（seam）：Service Definition 一半。
 *
 * dsh 的范式是「能力做成三角色齐全的 seam」，不是一个硬编码函数：
 *   Service Definition（本文件）→ Service Provider（render-mc 适配器）→ Consumer（anim_* 工具）
 *
 * 这样 `anim_render` 永远不知道自己在用 Motion Canvas。换 Remotion / Manim 时，
 * 工具、事件、UI 一行都不用改——这正是当初把 IR 定成后端无关的理由。
 */

import type { AnimationSpec } from '@dsh-anim/spec'

/** 启动期的环境自检结果，用来在第一次渲染失败之前就把坑说清楚。 */
export interface RenderDiagnostics {
  renderer: string
  ok: boolean
  /** 可读的问题清单，直接端给用户（缺 ffmpeg、缺中文字体…）。 */
  issues: string[]
  details?: Record<string, string>
}

export interface PreviewFrame {
  atMs: number
  /** 落盘的帧图路径（工具只回路径，不往模型上下文里塞 base64）。 */
  path: string
  width: number
  height: number
}

export interface PreviewRequest {
  spec: AnimationSpec
  /** 抽帧时间点，绝对毫秒。为空则由适配器按场景边界自动挑选。 */
  atMs?: number[]
  /** 预览降分辨率：默认 2 表示长宽各一半，快 4 倍。 */
  scale?: number
}

export interface PreviewResult {
  frames: PreviewFrame[]
  /** 实际使用的后端名，回执里带上是排查利器。 */
  renderer: string
}

export interface RenderRequest {
  spec: AnimationSpec
  outputPath: string
  /** 只渲染指定场景（0 基），为空则整片。 */
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

/**
 * Provider 注册表。MVP 只有一个 Provider 也要走注册，
 * 因为「选后端」这件事迟早要发生，而临时 if-else 一旦写进去就没人记得拆。
 */
export class AnimRendererRegistry {
  #renderers = new Map<string, AnimRenderer>()
  #defaultName: string | undefined

  register(renderer: AnimRenderer, options: { isDefault?: boolean } = {}): () => void {
    this.#renderers.set(renderer.name, renderer)
    if (options.isDefault || this.#defaultName === undefined) this.#defaultName = renderer.name
    return () => {
      this.#renderers.delete(renderer.name)
      if (this.#defaultName === renderer.name) this.#defaultName = [...this.#renderers.keys()][0]
    }
  }

  get(name?: string): AnimRenderer {
    const key = name ?? this.#defaultName
    const found = key ? this.#renderers.get(key) : undefined
    if (!found) {
      throw new Error(
        key ? `未找到渲染后端「${key}」` : '尚未注册任何渲染后端',
      )
    }
    return found
  }
}
