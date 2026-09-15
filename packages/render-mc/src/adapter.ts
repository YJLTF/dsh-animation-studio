/**
 * render-mc 作为 dsh 渲染接缝的 **Provider** 一半。
 *
 * 它把 AnimationSpec 编译成 Motion Canvas 项目源码，再驱动 headless 浏览器出帧、
 * 交给 ffmpeg 合成 MP4。三条踩过的坑固化成代码里的显式处理：
 *
 * 1. **WebGL**：SwiftShader 软渲染是出帧的钥匙。2026-09 实测 Edge 152 的新
 *    headless 配合 SwiftShader 能完整出片（旧版 headless 拿不到 GL，才有
 *    「必须有头 + Xvfb」的旧方案，现仅作调试后门保留）。所以本模块不自作
 *    主张地改浏览器参数，而是 `diagnose()` 把它查出来、让上层决定怎么办。
 * 2. **`?scene` 导入**：见 codegen.ts 头注释，场景只能以 `?scene` 形式进入 makeProject。
 * 3. **帧落盘子目录**：image-sequence exporter 把帧写进 `output/<project>/`，
 *    收集时必须递归，别只扫顶层。
 *
 * 依赖注入的边界：`AnimRenderer` 接口只认 spec 和信号，不认 vite / puppeteer。
 * 渲染实现通过 `MotionCanvasRuntime` 注入，这样插件跑在 dsh 里时可以用
 * `ctx.subprocess` 提供的进程能力，离线脚本里用直接 `spawn`。
 */

import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { AnimationSpec, Asset } from '@dsh-anim/spec'
import { safeName, sceneDurationMs, specDurationMs, truncateSpecAtMs } from '@dsh-anim/spec'

import type { AnimRenderer, PreviewRequest, PreviewResult, RenderDiagnostics, RenderRequest, RenderResult } from './contract.ts'
import { generateProject, resolveResolutionScale } from './codegen.ts'

const exec = promisify(execFile)

/** 生成物要落到磁盘上，这一步由调用方提供目录。 */
export interface MotionCanvasRuntime {
  /**
   * 把生成的项目文件写进工作目录，返回项目入口（vite 的 project 路径）。
   * 返回相对路径，便于日志可读。
   */
  materialize(files: Array<{ path: string; content: string }>, workDir: string): Promise<void>
  /**
   * 打开编辑器并驱动一次渲染，帧落到 workDir/output 下。
   * 实现里要处理 Xvfb / 浏览器参数 / 点击 Render / 等帧写满。
   */
  renderProject(options: {
    workDir: string
    fps: number
    expectedFrames: number
    signal: AbortSignal
    onProgress?: (done: number, total: number) => void
  }): Promise<{ frameDir: string; frameCount: number }>
  /** 环境自检：浏览器、WebGL、ffmpeg、中文字体。 */
  probe(): Promise<RenderDiagnostics>
}

export interface MotionCanvasRendererOptions {
  runtime: MotionCanvasRuntime
  /** 生成源码与帧的中间目录。 */
  workDir: string
  /** 默认输出路径（未在请求里指定时使用）。 */
  defaultOutputPath?: string
}

export class MotionCanvasRenderer implements AnimRenderer {
  readonly name = 'motion-canvas'

  #runtime: MotionCanvasRuntime
  #workDir: string
  #defaultOutputPath: string | undefined
  /** 渲染串行闸的队尾：workDir 与 vite 端口都是进程级独占资源。 */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: MotionCanvasRendererOptions) {
    this.#runtime = options.runtime
    this.#workDir = options.workDir
    this.#defaultOutputPath = options.defaultOutputPath
  }

  /**
   * 渲染串行闸。同一个渲染器的 workDir（project/scenes 文件、output 帧目录）
   * 与 vite 端口都只容得下一次渲染：并行第二渲会覆写文件、清掉正在产帧的
   * 目录或撞端口（0.3.x 优化清单 O2）。preview 与 render 都从这里过——
   * 排队期间 signal 取消的请求在轮到自己时立刻以「渲染已取消」退出。
   */
  #serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(step, step)
    this.#queue = run.catch(() => undefined)
    return run
  }

  async diagnose(): Promise<RenderDiagnostics> {
    return this.#runtime.probe()
  }

  async preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
    // 预览 = 只渲染抽样帧。Motion Canvas 没有「只渲某几帧」的入口，所以
    // 做法是：把时间线截短到最晚的抽帧点（其后的场景不渲），低分辨率出帧后
    // 按帧下标挑帧——截断点之前的时间线逐毫秒等价，下标取帧不受影响。
    const resolutionScale = resolveResolutionScale(request.scale)
    const at = request.atMs?.length ? request.atMs : autoSamplePoints(request.spec)
    const cutMs = Math.max(...at)
    const totalMs = specDurationMs(request.spec.scenes)
    const spec = cutMs > 0 && cutMs < totalMs ? truncateSpecAtMs(request.spec, cutMs) : request.spec
    const result = await this.#renderFrames(spec, signal, resolutionScale)
    const frames = at
      .map(atMs => {
        const index = Math.min(
          result.frameCount - 1,
          Math.max(0, Math.round((atMs / 1000) * request.spec.meta.fps)),
        )
        return {
          atMs,
          path: join(result.frameDir, `${String(index).padStart(6, '0')}.png`),
          width: Math.round(request.spec.meta.size.width * resolutionScale),
          height: Math.round(request.spec.meta.size.height * resolutionScale),
        }
      })
    return { frames, renderer: this.name }
  }

  async render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    const resolutionScale = resolveResolutionScale(request.scale)
    // scenes 抽查：切片后的 spec 同时决定渲染内容与时长/帧数的报告口径。
    // 此参数曾只进契约不进实现（模型传了 scenes 却渲出整片），见优化清单 O1。
    const spec = pickScenes(request.spec, request.scenes)
    const result = await this.#renderFrames(spec, signal, resolutionScale, request.onProgress)
    const rawOutputPath = request.outputPath || this.#defaultOutputPath
    if (!rawOutputPath) throw new Error('未指定输出路径，且适配器没有默认路径')
    // 相对路径按宿主进程 cwd 解析（ffmpeg 落盘的同一基准），回执给出绝对路径
    const outputPath = resolve(rawOutputPath)

    const durationMs = specDurationMs(spec.scenes)
    await encodeFrames(result.frameDir, result.expected, request.spec.meta.fps, outputPath)
    return {
      outputPath,
      frameCount: result.frameCount,
      durationMs,
      // 报告实际输出尺寸：resolutionScale ≠ 1 时帧是缩过的，别谎报原始分辨率
      width: Math.round(request.spec.meta.size.width * resolutionScale),
      height: Math.round(request.spec.meta.size.height * resolutionScale),
      renderer: this.name,
    }
  }

  /* ---------------------------------------------------------------- 内部 */

  async #renderFrames(
    spec: AnimationSpec,
    signal: AbortSignal,
    resolutionScale: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ frameDir: string; frameCount: number; expected: number }> {
    return this.#serialized(async () => {
      if (signal.aborted) throw new Error('渲染已取消')

      const { files, warnings } = generateProject(spec, { resolutionScale })
      if (warnings.length > 0) {
        // 生成期降级必须可见：静默丢属性比渲染失败更难查
        for (const w of warnings) console.warn(`[render-mc] ${w}`)
      }

      mkdirSync(this.#workDir, { recursive: true })
      // 资产物化：本地资产文件复制进渲染项目的 public/assets/（vite 的 public
      // 目录 → 根 URL 可加载）。codegen 已把 image.src 的 asset:<id> 解析成
      // /assets/<id>.<ext>，这里保证文件真的在。
      copyAssetsToPublic(spec.assets, this.#workDir)
      await this.#runtime.materialize(files, this.#workDir)

      const totalMs = specDurationMs(spec.scenes)
      const expected = Math.round((totalMs / 1000) * spec.meta.fps)
      const result = await this.#runtime.renderProject({
        workDir: this.#workDir,
        fps: spec.meta.fps,
        expectedFrames: expected,
        signal,
        onProgress,
      })
      return { ...result, expected }
    })
  }
}

/**
 * 把帧序列合成 MP4。
 *
 * - 有 libx264 用 CRF 质量；没有则退到 libopenh264（部分发行版的 ffmpeg）；
 * - `-frames:v` 严格按 spec 时长截断，避免 exporter 多输出的黑色缓冲帧混进成片。
 */
export async function encodeFrames(
  frameDir: string,
  expected: number,
  fps: number,
  outputPath: string,
): Promise<void> {
  const pattern = join(frameDir, '%06d.png')
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  const codec = await hasEncoder('libx264') ? 'libx264' : 'libopenh264'
  const codecOpts = codec === 'libopenh264' ? ['-b:v', '6M'] : ['-crf', '20']
  await exec('ffmpeg', [
    '-y', '-framerate', String(fps), '-i', pattern,
    '-frames:v', String(expected),
    '-fps_mode', 'cfr', '-r', String(fps), '-pix_fmt', 'yuv420p',
    '-c:v', codec, ...codecOpts,
    '-movflags', '+faststart',
    outputPath,
  ])
}

async function hasEncoder(name: string): Promise<boolean> {
  try {
    const { stdout } = await exec('ffmpeg', ['-hide_banner', '-encoders'])
    return String(stdout ?? '').includes(name)
  } catch {
    return false
  }
}

/** 递归一层收集帧文件。不要只扫顶层——exporter 会建子目录。 */
export function collectFrames(dir: string): string[] {
  const out: string[] = []
  for (const top of readdirSync(dir)) {
    const full = join(dir, top)
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full)) {
        if (f.endsWith('.png') || f.endsWith('.jpg')) out.push(join(full, f))
      }
    } else if (top.endsWith('.png') || top.endsWith('.jpg')) {
      out.push(full)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

/** 清空输出目录：旧帧混进新片是最难发现的一类错误。 */
export function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/**
 * 把 spec.assets 里的**本地文件**复制进渲染项目的 `public/assets/`。
 * http(s) URL 资产不复制（浏览器直接加载）。资产缺失不抛错——
 * codegen 已给出引用警告，渲染继续（缺图比整片渲染失败容易诊断）。
 * 文件名用 safeName 净化，与 codegen 生成的 `/assets/<id><ext>` URL 严格一致。
 */
export function copyAssetsToPublic(assets: Record<string, Asset>, workDir: string): string[] {
  const copied: string[] = []
  const publicDir = join(workDir, 'public', 'assets')
  mkdirSync(publicDir, { recursive: true })
  for (const [id, asset] of Object.entries(assets)) {
    if (/^https?:\/\//.test(asset.src)) continue
    const ext = extname(asset.src)
    const target = join(publicDir, `${safeName(id)}${ext}`)
    try {
      copyFileSync(resolve(asset.src), target)
      copied.push(target)
    } catch {
      /* 资产文件缺失不拖垮渲染 */
    }
  }
  return copied
}

/** 没有指定抽帧点时的默认采样：每幕的起点 + 每幕的中点（内容最丰富的时刻）。 */
export function autoSamplePoints(spec: AnimationSpec): number[] {
  const points: number[] = []
  let cursor = 0
  for (const scene of spec.scenes) {
    const d = sceneDurationMs(scene)
    points.push(cursor, cursor + Math.round(d / 2))
    cursor += d
  }
  return points
}

/**
 * 按 0 基索引挑场景（保持原播放顺序、去重），`anim_render` 的 scenes 抽查。
 * 越界索引直接报可读错误——静默渲整片比失败更误导（优化清单 O1）。
 */
export function pickScenes(spec: AnimationSpec, scenes?: number[]): AnimationSpec {
  if (!scenes || scenes.length === 0) return spec
  const total = spec.scenes.length
  const indices = [...new Set(scenes)]
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= total) {
      throw new Error(`scenes 含越界索引 ${i}（本片共 ${total} 幕，有效范围 0 ~ ${total - 1}）`)
    }
  }
  return { ...spec, scenes: indices.sort((a, b) => a - b).map(i => spec.scenes[i]!) }
}
