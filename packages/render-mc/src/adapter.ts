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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { AnimationSpec, Asset, Scene } from '@dsh-anim/spec'
import { safeName, sceneDurationMs, specDurationMs, truncateSpecAtMs } from '@dsh-anim/spec'

import type { AnimRenderer, PreviewRequest, PreviewResult, RenderDiagnostics, RenderRequest, RenderResult } from './contract.ts'
import { CODEGEN_VERSION, collectAudioTracks, expandNarration, generateProject, resolveResolutionScale } from './codegen.ts'
import type { AudioTrackCue } from './codegen.ts'

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
  /**
   * 释放常驻实例（浏览器、vite dev server，§3.2）。渲染器宿主卸载时调用；
   * 无常驻实例的实现可省略。幂等，重复调用安全。
   */
  dispose?(): Promise<void>
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

  /** 释放常驻渲染实例（§3.2）。随插件卸载调用；幂等。 */
  async dispose(): Promise<void> {
    await this.#runtime.dispose?.()
  }

  async preview(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
    // 预览 = 只渲染抽样帧。Motion Canvas 没有「只渲某几帧」的入口，所以
    // 做法是：把时间线截短到最晚的抽帧点（其后的场景不渲），低分辨率出帧后
    // 按帧下标挑帧——截断点之前的时间线逐毫秒等价，下标取帧不受影响。
    const resolutionScale = resolveResolutionScale(request.scale)
    const at = request.atMs?.length ? request.atMs : autoSamplePoints(request.spec)
    const cutMs = Math.max(...at)
    const totalMs = specDurationMs(request.spec.scenes)
    // 截短在展开之前：截短收紧幕时长，展开按收紧后的窗口裁字幕
    const truncated = cutMs > 0 && cutMs < totalMs ? truncateSpecAtMs(request.spec, cutMs) : request.spec
    // 旁白 cues → 各幕 subtitles（§4.3）：字幕随场景数据走，截短后的本地时段才正确
    const spec = expandNarration(truncated).spec
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
    return {
      frames,
      renderer: this.name,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    }
  }

  async render(request: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    const resolutionScale = resolveResolutionScale(request.scale)
    // scenes 抽查：切片后的 spec 同时决定渲染内容与时长/帧数的报告口径。
    // 此参数曾只进契约不进实现（模型传了 scenes 却渲出整片），见优化清单 O1。
    // 旁白字幕在切片之后展开（§4.3）：展开产物挂在各幕 scene.subtitles 上
    // （场景内本地毫秒），solo 切片与场景指纹因此天然携带字幕。
    const spec = expandNarration(pickScenes(request.spec, request.scenes)).spec
    const rawOutputPath = request.outputPath || this.#defaultOutputPath
    if (!rawOutputPath) throw new Error('未指定输出路径，且适配器没有默认路径')
    // 相对路径按宿主进程 cwd 解析（ffmpeg 落盘的同一基准），回执给出绝对路径
    const outputPath = resolve(rawOutputPath)

    const fps = request.spec.meta.fps
    const durationMs = specDurationMs(spec.scenes)
    const expected = Math.round((durationMs / 1000) * fps)
    const dimensions = {
      width: Math.round(request.spec.meta.size.width * resolutionScale),
      height: Math.round(request.spec.meta.size.height * resolutionScale),
    }

    // 场景级增量渲染（0.4.0 规划 §3.4）：逐幕指纹比对段缓存，未变幕直接
    // 复用，只渲缺失段再 concat。cache:false 强制全量；增量流程任何一步
    // 失败（切段/拼接/校验）都自动回退全量渲染——绝不静默交残片的红线
    // 在增量路径同样成立。音轨不进段缓存：mux 永远在拼接之后按现行 spec
    // 重新执行（改音量不用清缓存）。
    let fallbackNote: string | undefined
    if (request.cache !== false && spec.scenes.length > 0 && expected > 0) {
      try {
        const incremental = await this.#renderIncremental({ spec, outputPath, fps, expected, resolutionScale, signal, onProgress: request.onProgress })
        const audio = await this.#finishAudio(spec, outputPath, expected, fps)
        return {
          outputPath,
          frameCount: expected,
          durationMs,
          ...dimensions,
          renderer: this.name,
          expectedFrames: expected,
          incremental: {
            scenesTotal: spec.scenes.length,
            scenesReused: spec.scenes.length - incremental.rendered,
          },
          ...(audio.tracks.length > 0 ? { audioTracks: audio.tracks } : {}),
          ...(audio.warnings.length > 0 ? { warnings: dedupeWarnings(audio.warnings) } : {}),
        }
      } catch (err) {
        if (signal.aborted) throw err
        const message = err instanceof Error ? err.message : String(err)
        fallbackNote = `增量渲染失败，已自动回退全量渲染：${message}`
        console.warn(`[render-mc] ${fallbackNote}`)
      }
    }

    const result = await this.#renderFrames(spec, signal, resolutionScale, request.onProgress)
    await encodeFrames(result.frameDir, result.expected, fps, outputPath)
    const audio = await this.#finishAudio(spec, outputPath, expected, fps)
    const warnings = [fallbackNote, ...result.warnings, ...audio.warnings].filter((w): w is string => w !== undefined)
    return {
      outputPath,
      frameCount: result.frameCount,
      durationMs,
      ...dimensions,
      renderer: this.name,
      expectedFrames: result.expected,
      ...(fallbackNote === undefined ? {} : { incremental: { scenesTotal: spec.scenes.length, scenesReused: 0, fallback: true } }),
      ...(warnings.length > 0 ? { warnings: dedupeWarnings(warnings) } : {}),
      ...(audio.tracks.length > 0 ? { audioTracks: audio.tracks } : {}),
    }
  }

  /**
   * 音轨收尾（§4.1）：按现行 spec 收集音轨清单并 mux 进成片。混音失败只
   * 降级警告（成片保留无声视频版本），绝不让已完成的画面渲染整单报废。
   */
  async #finishAudio(
    spec: AnimationSpec,
    outputPath: string,
    expectedFrames: number,
    fps: number,
  ): Promise<{ tracks: string[]; warnings: string[] }> {
    const { cues, warnings } = collectAudioTracks(spec)
    if (cues.length === 0) return { tracks: [], warnings }
    try {
      await muxAudioTracks(outputPath, cues, expectedFrames / fps)
      return { tracks: cues.map(c => c.assetId), warnings }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[render-mc] 音轨合成失败，成片保留无声版本：${message}`)
      return { tracks: [], warnings: [...warnings, `音轨合成失败，成片为无声版本：${message}`] }
    }
  }

  /* ---------------------------------------------------------------- 内部 */

  async #renderFrames(
    spec: AnimationSpec,
    signal: AbortSignal,
    resolutionScale: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ frameDir: string; frameCount: number; expected: number; warnings: string[] }> {
    return this.#serialized(() => this.#renderFramesInternal(spec, signal, resolutionScale, onProgress))
  }

  async #renderFramesInternal(
    spec: AnimationSpec,
    signal: AbortSignal,
    resolutionScale: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ frameDir: string; frameCount: number; expected: number; warnings: string[] }> {
    if (signal.aborted) throw new Error('渲染已取消')

    const { files, warnings } = generateProject(spec, { resolutionScale })
    if (warnings.length > 0) {
      // 宿主日志保留全量（排查用）；模型与面板看到的回执版本经去重合并
      for (const w of warnings) console.warn(`[render-mc] ${w}`)
    }

    // workDir 按 specId 分子目录（0.4.0 规划 §3.3）：vite 依赖预打包缓存
    // （<specDir>/.vite）、段缓存（<specDir>/segments）与帧产物按项目隔离，
    // 同一 spec 的连续「patch → preview → render」不再重复付预打包成本。
    // resetDir 只清 <specDir>/output，缓存不受影响；spec 删除不回收
    // （与 outputDir 产物同生命周期，anim_diagnose 报告磁盘占用）。
    const workDir = this.#specWorkDir(spec)
    mkdirSync(workDir, { recursive: true })
    // 资产物化：本地资产文件复制进渲染项目的 public/assets/（vite 的 public
    // 目录 → 根 URL 可加载）。codegen 已把 image.src 的 asset:<id> 解析成
    // /assets/<id>.<ext>，这里保证文件真的在。
    copyAssetsToPublic(spec.assets, workDir)
    await this.#runtime.materialize(files, workDir)

    const totalMs = specDurationMs(spec.scenes)
    const expected = Math.round((totalMs / 1000) * spec.meta.fps)
    const result = await this.#runtime.renderProject({
      workDir,
      fps: spec.meta.fps,
      expectedFrames: expected,
      signal,
      onProgress,
    })
    return { ...result, expected, warnings: dedupeWarnings(warnings) }
  }

  /** 一个 spec 的独立工作目录：缓存与中间产物按项目隔离（§3.3）。 */
  #specWorkDir(spec: AnimationSpec): string {
    return join(this.#workDir, safeName(spec.meta.id))
  }

  /**
   * 场景级增量渲染（0.4.0 规划 §3.4）。
   *
   * 可行性根据：场景之间没有跨场景状态——转场是「本幕入场动画」、每幕是独立
   * generator，单幕画面只由本幕 JSON + 渲染参数（fps/分辨率/缩放）决定，
   * 所以逐幕指纹比对段缓存是安全的。资产内容变化不参与指纹（src 相同即命中，
   * 「换图不换名要先删资产」由文档写明）；音轨永远不进段缓存（M2 的 audio
   * mux 在 concat 之后按现行 spec 重新执行，改音量不用清缓存）。
   *
   * 分段方式是**逐幕独立渲染**（每缺失幕一次编辑器 solo 渲染），不是「切片
   * 一次渲染再按声明时长切段」。真机测量（M1 验收）给出了否决后者的硬证据：
   * MC 编辑器内每幕的实际占帧带 reset 帧/补全帧（tween 收尾的幕多一帧端点），
   * 与 `round(时长×fps)` 预测边界恒有 ±1 漂移——按预测边界切段会让段尾裹进
   * 下一幕的帧，下一幕改动后这帧以旧缓存泄入成片（实测：改色后上一幕段尾
   * 残留旧色一帧）。逐幕 solo 渲染则由构造保证段内容恰好是本幕画面（实测
   * solo 帧与整片中该幕逐帧 MAD≈0），不依赖 MC 内部边界规则，版本漂移安全。
   *
   * 段文件名带 `r2` 代次：第一版（切片切段）的缓存段可能含上述裹帧缺陷，
   * 代次隔离让旧段自然失配而不误命中。
   *
   * 整个流程在串行闸内执行（多个 solo 渲染之间不允许被其他渲染插进来），
   * 内部走 #renderFramesInternal 避免闸嵌套死锁。任何一步失败向上抛，
   * 由 render() 回退全量渲染。
   */
  async #renderIncremental(opts: {
    spec: AnimationSpec
    outputPath: string
    fps: number
    expected: number
    resolutionScale: number
    signal: AbortSignal
    onProgress?: (done: number, total: number) => void
  }): Promise<{ rendered: number }> {
    return this.#serialized(async () => {
      const { spec, fps, expected, resolutionScale, signal } = opts
      const segDir = join(this.#specWorkDir(spec), 'segments')
      mkdirSync(segDir, { recursive: true })
      const sceneFramesOf = (i: number): number =>
        Math.round((sceneDurationMs(spec.scenes[i]!) / 1000) * fps)

      // 指纹 = 场景 JSON 稳定序列化 + 渲染参数 + codegen 产物版本联合 hash：
      // 换 fps/分辨率/缩放不会命中旧段（防串档）；codegen 输出语义变更（
      // CODEGEN_VERSION +1）让全体旧段自然失效；段名带序号，幕的增删导致
      // 重编号时自然错位、不会错拿旧段。
      const hashes = spec.scenes.map(scene =>
        sceneFingerprint(scene, {
          fps,
          resolutionScale,
          width: spec.meta.size.width,
          height: spec.meta.size.height,
          codegenVersion: CODEGEN_VERSION,
        }),
      )
      const segPaths = hashes.map((h, i) => join(segDir, `seg-${String(i).padStart(2, '0')}-r2-${h}.mp4`))
      const missing = segPaths.reduce<number[]>((acc, p, i) => (existsSync(p) ? acc : [...acc, i]), [])

      if (missing.length > 0) {
        const codec = await pickVideoCodec()
        // 进度按整片口径上报：已缓存幕的帧计入 done，面板进度条不会从 0 跳起
        let base = 0
        for (const i of spec.scenes.keys()) {
          if (!missing.includes(i)) base += sceneFramesOf(i)
        }
        for (const i of missing) {
          if (signal.aborted) throw new Error('渲染已取消')
          const scene = spec.scenes[i]!
          const sceneFrames = sceneFramesOf(i)
          if (sceneFrames <= 0) continue // 0 帧幕不占段时间，跳过切段与拼接
          // 单幕 solo 渲染：场景文件只含本幕，expectedFrames 即本幕帧数
          const soloSpec: AnimationSpec = { ...spec, scenes: [scene] }
          const progress = opts.onProgress
            ? (done: number, total: number): void => opts.onProgress?.(base + done, expected)
            : undefined
          const result = await this.#renderFramesInternal(soloSpec, signal, resolutionScale, progress)
          if (result.frameCount < sceneFrames) {
            throw new Error(`场景 ${scene.id} solo 渲染只产出 ${result.frameCount}/${sceneFrames} 帧，不足以成段`)
          }
          // 原子写：先写临时名再改名——半截段绝不能留到下一轮被当成命中
          const building = `${segPaths[i]}.building.mp4`
          await encodeFrameRange(result.frameDir, 0, sceneFrames, fps, building, codec)
          renameSync(building, segPaths[i]!)
          base += sceneFrames
        }
      }

      // 拼接 + 时长校验。段间同 fps/同分辨率/同编码参数（同一台 ffmpeg 的同一
      // 套参数），concat demuxer -c copy 零重编码
      const parts = segPaths.filter((_, i) => sceneFramesOf(i) > 0)
      if (parts.length === 0) throw new Error('所有场景的帧数都为 0，无可拼接内容')
      await concatSegments(parts, opts.outputPath)
      await validateConcatDuration(opts.outputPath, expected, fps)
      return { rendered: missing.length }
    })
  }
}

/**
 * 同类警告合并计数（0.4.0 规划 N4 / O21 观察项）。
 *
 * 同一错形（同图层同属性）在多幕重复出现时，codegen 会逐幕产出 identical
 * 的警告串——真机一次 6 幕渲染刷出 100+ 行 strokeWidth 告警就是它。去重按
 * 完整消息文本计数：相同文本只保留一条并附「×N」，不同图层/属性的消息
 * 互不吞并。渲染回执与 finished 事件都吃这份合并结果（宿主 console 保留
 * 全量，排查不受影响）。
 */
export function dedupeWarnings(warnings: string[]): string[] {
  const counts = new Map<string, number>()
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts.entries()].map(([w, n]) => (n > 1 ? `${w}（同类警告 ×${n}，已合并）` : w))
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
  const codec = await pickVideoCodec()
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

/**
 * 编码器选择（进程级缓存）：编码参数是段缓存拼接正确性的一半——所有段必须
 * 同编码同参数，concat -c copy 才能零重编码。缓存成单次决策也保证同一次
 * 增量渲染里各段与成片参数必然一致。
 */
let codecChoice: Promise<string> | undefined
function pickVideoCodec(): Promise<string> {
  codecChoice ??= hasEncoder('libx264').then(ok => (ok ? 'libx264' : 'libopenh264'))
  return codecChoice
}

/**
 * 把帧区间 [startFrame, startFrame + frameCount) 切成一段 MP4（§3.4）。
 * 参数与 encodeFrames 严格一致（仅多 -start_number），保证段与整片、段与段
 * 之间可拼接。
 */
export async function encodeFrameRange(
  frameDir: string,
  startFrame: number,
  frameCount: number,
  fps: number,
  outputPath: string,
  codec?: string,
): Promise<void> {
  const pattern = join(frameDir, '%06d.png')
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  const c = codec ?? (await pickVideoCodec())
  const codecOpts = c === 'libopenh264' ? ['-b:v', '6M'] : ['-crf', '20']
  await exec('ffmpeg', [
    '-y', '-framerate', String(fps), '-start_number', String(startFrame), '-i', pattern,
    '-frames:v', String(frameCount),
    '-fps_mode', 'cfr', '-r', String(fps), '-pix_fmt', 'yuv420p',
    '-c:v', c, ...codecOpts,
    '-movflags', '+faststart',
    outputPath,
  ])
}

/**
 * 段拼接（§3.4）：concat demuxer + `-c copy` 零重编码。清单文件的转义按
 * ffmpeg 语法处理（单引号成对翻转），Windows 盘符路径统一正斜杠。
 */
export async function concatSegments(segments: string[], outputPath: string): Promise<void> {
  if (segments.length === 0) throw new Error('没有可拼接的段缓存')
  const listPath = join(dirname(resolve(outputPath)), 'concat-list.txt')
  const entries = segments.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`)
  writeFileSync(listPath, `${entries.join('\n')}\n`, 'utf8')
  try {
    await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath])
  } finally {
    rmSync(listPath, { force: true })
  }
}

/** ffmpeg 参数用的数字字面量：去尾零（1000 → "1000"、0.5 → "0.5"）。 */
function num(v: number): string {
  return String(Number(v.toFixed(6)))
}

/**
 * 音轨混入（§4.1）：把音轨清单混进已编码/已拼接的视频。
 *
 * 每条轨：`-stream_loop -1`（仅 loop）→ `adelay` 对齐全片绝对起点 →
 * `volume` → `atrim` 把（可能无限循环的）输入钳到 cue 时长 → 多轨 `amix`
 * 直接求和（normalize=0，多轨叠加不自动降音量）。视频流 `-c copy` 零重编码，
 * 音频编码 aac；输出时长用 `-t` 显式钳到视频时长——不依赖 -shortest（它在
 * -c:v copy 下按 mux 层截断，行为不稳）。
 *
 * 写临时文件再原子改名：mux 失败时视频文件保持原样（无声版本完整在盘），
 * 调用方只需降级警告，不必重渲。
 */
export async function muxAudioTracks(
  videoPath: string,
  cues: AudioTrackCue[],
  durationSec: number,
): Promise<void> {
  if (cues.length === 0) return
  const args: string[] = ['-y', '-i', videoPath]
  const chains: string[] = []
  const labels: string[] = []
  cues.forEach((cue, i) => {
    if (cue.loop) args.push('-stream_loop', '-1')
    args.push('-i', cue.source)
    const f: string[] = []
    if (cue.startMs > 0) f.push(`adelay=${num(cue.startMs)}:all=1`)
    if (cue.volume !== 1) f.push(`volume=${num(cue.volume)}`)
    f.push(`atrim=0:${num(cue.durationMs / 1000)}`, 'asetpts=PTS-STARTPTS')
    const label = `[a${i}]`
    chains.push(`[${i + 1}:a]${f.join(',')}${label}`)
    labels.push(label)
  })
  let finalLabel = labels[0]!
  if (labels.length > 1) {
    finalLabel = '[amixed]'
    chains.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0${finalLabel}`)
  }
  const tmp = `${videoPath}.muxing.mp4`
  try {
    await exec('ffmpeg', [
      ...args,
      '-filter_complex', chains.join(';'),
      '-map', '0:v', '-map', finalLabel,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-t', num(durationSec),
      '-movflags', '+faststart',
      tmp,
    ])
    renameSync(tmp, videoPath)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * 拼接产物时长校验（§3.4 红线的机器可查部分）：与目标帧数换算的时长偏差
 * 超过容忍值即抛错，render() 会回退全量渲染。ffprobe 不在 PATH（ffmpeg
 * 精简安装）时跳过校验——concat 退出码 + 输出存在仍是最基础的闸门。
 */
async function validateConcatDuration(outputPath: string, expectedFrames: number, fps: number): Promise<void> {
  let stdout: string
  try {
    const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath])
    stdout = String(r.stdout ?? '')
  } catch {
    return
  }
  const actual = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(actual)) return
  const expectedSec = expectedFrames / fps
  const tolerance = Math.max(0.5, 3 / fps)
  if (Math.abs(actual - expectedSec) > tolerance) {
    throw new Error(
      `拼接产物时长 ${actual.toFixed(2)}s 与预期 ${expectedSec.toFixed(2)}s 偏差超过容忍值（${tolerance.toFixed(2)}s），疑似段错位`,
    )
  }
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

/* ------------------------------------------------- 场景级增量渲染（§3.4） */

/**
 * JSON 的键排序稳定序列化：同一份场景数据无论属性书写顺序如何，指纹一致。
 * undefined 属性剔除（JSON.stringify 会静默丢它们，这里显式对齐语义）。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 场景指纹（§3.4）：场景内容 + 渲染参数（fps / 分辨率 / 缩放）的联合 sha256
 * 前 8 位。渲染参数入指纹防止「改参数后命中旧分辨率段」的串档；资产文件内容
 * 不入指纹（src 相同即命中，换图不换名要先删资产——文档口径）。
 * audio 图层不参与画面（不进 codegen、音轨由 mux 按现行 spec 重混），剔除出
 * 指纹——改音量/循环只重混音，绝不触发该幕重渲（§4.1「音轨不进段缓存」）。
 */
export function sceneFingerprint(
  scene: Scene,
  params: { fps: number; resolutionScale: number; width: number; height: number; codegenVersion: number },
): string {
  const visual: Scene = { ...scene, layers: scene.layers.filter(l => l.type !== 'audio') }
  return createHash('sha256').update(stableStringify({ scene: visual, ...params })).digest('hex').slice(0, 8)
}

/**
 * 逐幕帧边界：第 i 幕占帧 [starts[i], ends[i])。
 *
 * 边界按累计时长的 round 计算（不是逐幕独立 round），保证边界连续无缝、
 * 全片总帧数与 #renderFrames 的 expected 口径完全一致——这是增量段与全量
 * 帧列可互换的前提。场景时长用 sceneDurationMs（声明值与轨道结束时长取大，
 * 与渲染的实际时长同口径）。
 */
export function sceneFrameBoundaries(scenes: Scene[], fps: number): { starts: number[]; ends: number[]; total: number } {
  const starts: number[] = []
  const ends: number[] = []
  let cumMs = 0
  let prevEnd = 0
  for (const scene of scenes) {
    cumMs += sceneDurationMs(scene)
    const end = Math.round((cumMs / 1000) * fps)
    starts.push(prevEnd)
    ends.push(end)
    prevEnd = end
  }
  return { starts, ends, total: prevEnd }
}
