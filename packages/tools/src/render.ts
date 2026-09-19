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
  /**
   * 生成期降级警告（同类已合并计数）。此前只进宿主日志、模型看不见——
   * 与 render-mc 侧 contract.ts 的 PreviewResult 成对改（结构对齐是两包
   * 的显式契约）。
   */
  warnings?: string[]
  /**
   * 单幕直放（0.5.0 规划 §3.2）：抽帧点全部落在同一幕、且该幕的增量渲染
   * 段缓存命中时，预览直接回放段视频（原画质、带音频），frames 为空。
   * 与 render-mc 侧 contract.ts 的 PreviewResult 成对改。
   */
  clip?: PreviewClip
}

/** 单幕段视频直放的信息。段文件在 outputDir 内，媒体路由天然可服务。 */
export interface PreviewClip {
  /** 段 mp4 的绝对路径。 */
  path: string
  sceneId: string
  sceneIndex: number
  durationMs: number
}

/** 一条已合成旁白音轨（tools 侧 tts 模块产出，mux 管线消费）。 */
export interface SpeechTrackInfo {
  source: string
  startMs: number
  durationMs: number
  volume: number
}

/** 渲染回执的音画对账条目（0.5.0 §5.3）。 */
export interface SpeechNoteInfo {
  index: number
  text: string
  atMs: number
  audioMs: number
  overflowMs: number
}

/** 旁白配音载荷（0.5.0 规划 §5）：tools 层合成后交给后端 mux 与字幕展开。 */
export interface SpeechPayload {
  tracks: SpeechTrackInfo[]
  /** 与 spec.narration.cues 对齐的字幕显示时长（毫秒），缺省按估算。 */
  displayMs?: number[]
}

export interface RenderRequest {
  spec: AnimationSpec
  outputPath: string
  /** 只渲染指定场景（0 基），为空则整片。 */
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
  /** 本片目标帧数（fps × 时长），与进度事件的 total 同口径。 */
  expectedFrames?: number
  /** 生成期降级警告（同类已合并计数），语义同 PreviewResult.warnings。 */
  warnings?: string[]
  /** 增量渲染命中情况（§3.4）；未走增量（cache:false / 空片）时缺省。 */
  incremental?: IncrementalInfo
  /**
   * 混入成片的音轨（0.4.0 规划 §4.1）：audio 图层的 assetId 列表。
   * 空/缺省 = 无声成片。音轨在编码/拼接之后从现行 spec 重新混入，不进段缓存。
   */
  audioTracks?: string[]
  /** 混入成片的旁白配音条数（0.5.0 规划 §5），未配音/合成失败时缺省。 */
  speechTracks?: number
  /** 旁白音画对账清单（0.5.0 §5.3）：报告而非自动改时间线。 */
  speechNotes?: SpeechNoteInfo[]
  /**
   * 全片关键帧拼贴图（0.5.0 规划 §3.3）：按幕均匀抽帧的 contact sheet
   * （jpg，落 outputDir）。生成失败只降级警告，缺省 = 无拼贴图。
   */
  contactSheet?: string
}

export interface AnimRenderer {
  readonly name: string
  diagnose(): Promise<RenderDiagnostics>
  preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult>
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult>
  /**
   * 单幕段缓存查找（0.5.0 规划 §3.2，可选能力）：目标幕的增量渲染段存在
   * 且指纹命中时返回段路径与时长；否则返回 null。纯读操作——不渲染、
   * 不进串行闸。指纹口径与增量渲染完全一致（场景 JSON + 渲染参数 + codegen
   * 版本），后端没有段缓存概念时可缺省此方法，预览自动回退抽帧。
   */
  findSceneSegment?(spec: AnimationSpec, sceneIndex: number, scale?: number, displayMs?: number[]): { path: string; durationMs: number } | null
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
