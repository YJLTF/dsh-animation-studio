/**
 * 配音（TTS）能力面（0.5.0 规划 §5）。
 *
 * 架构与渲染 seam 同构：本模块只定义「给定文本 → 产出音频文件 + 实测时长」
 * 的最小接口（TtsSynthesizer），首发实现是**外部命令通道**——宿主配置里给一条
 * 命令模板（edge-tts / piper / 任何本地或云端 CLI），进程执行、产物落盘、
 * ffprobe 实测时长。不内置任何云 SDK / API key：离线分发友好，SDK 由使用者
 * 自行提供（想接云服务写一个实现 TtsSynthesizer 的 provider 插件即可）。
 *
 * 隐私口径：TTS 会把旁白文本送进配置的外部命令（可能出网）——README 与
 * anim_diagnose 报告都要写明；离线环境用 piper 类本地引擎。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { AnimationSpec } from '@dsh-anim/spec'
import { safeName, specDurationMs } from '@dsh-anim/spec'

const exec = promisify(execFile)

/** 一次合成的请求。 */
export interface TtsRequest {
  text: string
  /** 声音名。先经配置的 voices 映射表翻译，未命中则原样传给引擎。 */
  voice?: string
  /** 语速（原样替换进命令模板的 {rate} 占位符，语义由引擎解释）。 */
  rate?: string
  /** 产物落盘路径（调用方保证目录存在）。 */
  outFile: string
}

export interface TtsResult {
  filePath: string
  /** 实测音频时长（毫秒，ffprobe）。 */
  durationMs: number
}

/** TTS 合成器 seam：给文本，回音频与实测时长。抛错 = 该条合成失败。 */
export type TtsSynthesizer = (req: TtsRequest) => Promise<TtsResult>

/** TTS 配置（插件 Config.tts）。 */
export interface TtsConfig {
  /**
   * 命令模板（数组形式，逐项替换占位符后 execFile 执行——不经 shell，
   * 无引号转义问题）。占位符：{text} {outFile} {voice} {rate}。
   * edge-tts 示例：["edge-tts","--voice","{voice}","--rate","{rate}",
   * "--text","{text}","--write-media","{outFile}"]
   * piper 示例：["piper","--model","{voice}","--length_scale","{rate}",
   * "--output_file","{outFile}"]（文本走 stdin，模板里写 ["{stdin}"] 占位）
   */
  command: string[]
  /** 声音映射表：cue.voice / 默认声音 → 引擎的声音标识。 */
  voices?: Record<string, string>
  /** 默认声音（cue.voice 缺省时用；voices 映射的键）。 */
  voice?: string
  /** 默认语速占位值（edge-tts 形如 "+0%"；引擎语义各异）。 */
  rate?: string
  /** 旁白音量 0~1（默认 1；与 BGM 混音时建议 0.6~1，BGM 0.2~0.4）。 */
  volume?: number
  /** 单条合成超时（毫秒，默认 120000）。 */
  timeoutMs?: number
}

/** 挂进 AnimDeps 的 TTS 服务：合成器 + 规范化后的默认值。 */
export interface TtsService {
  synthesizer: TtsSynthesizer
  defaultVoice?: string
  rate: string
  volume: number
}

export function createTtsService(config: TtsConfig): TtsService {
  const voices = config.voices ?? {}
  const resolveVoice = (voice?: string): string | undefined => {
    const requested = voice ?? config.voice
    if (requested === undefined || requested === '') return undefined
    return voices[requested] ?? requested
  }
  const synthesizer: TtsSynthesizer = async req => {
    const argv = config.command.map(part =>
      part
        .replaceAll('{text}', req.text)
        .replaceAll('{outFile}', req.outFile)
        .replaceAll('{voice}', resolveVoice(req.voice) ?? '')
        .replaceAll('{rate}', req.rate ?? config.rate ?? '+0%')
        .replaceAll('{stdin}', req.text),
    )
    const useStdin = config.command.includes('{stdin}')
    await exec(argv[0]!, argv.slice(1), {
      ...(useStdin ? { input: req.text } : {}),
      timeout: config.timeoutMs ?? 120_000,
      windowsHide: true,
    })
    if (!existsSync(req.outFile)) {
      throw new Error(`TTS 命令执行完毕但未产出音频文件（检查命令模板的 {outFile} 占位符与参数）`)
    }
    return { filePath: req.outFile, durationMs: await probeAudioDurationMs(req.outFile) }
  }
  return {
    synthesizer,
    ...(config.voice !== undefined ? { defaultVoice: config.voice } : {}),
    rate: config.rate ?? '+0%',
    volume: clamp01(config.volume ?? 1),
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** ffprobe 实测音频时长（毫秒）。ffprobe 缺装或读不出时抛错（调用方降级）。 */
export async function probeAudioDurationMs(filePath: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
  ])
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } }
  const seconds = Number(parsed.format?.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe 读不出音频时长：${filePath}`)
  return Math.round(seconds * 1000)
}

/* ---------------------------------------------------------------- 旁白合成 */

/** 一条已合成的旁白音轨（mux 用）。 */
export interface SpeechTrack {
  source: string
  /** 全片绝对起点（毫秒）= cue.atMs。 */
  startMs: number
  /** 音频实际时长（毫秒，ffprobe 实测）。 */
  durationMs: number
  volume: number
}

/** 渲染回执的音画对账条目（0.5.0 §5.3：报告而非改时间线）。 */
export interface SpeechNote {
  /** cue 在 narration.cues 里的下标。 */
  index: number
  text: string
  atMs: number
  /** 音频实际时长。 */
  audioMs: number
  /** 语音尾超出下一 cue 起点 / 全片时长的毫秒数（0 = 无溢出）。 */
  overflowMs: number
}

export interface SpeechBuildResult {
  tracks: SpeechTrack[]
  /** 与 narration.cues 对齐的字幕显示时长（毫秒）：max(估算, 实测音频)。 */
  displayMs: number[]
  notes: SpeechNote[]
  warnings: string[]
}

/**
 * 合成整份旁白（0.5.0 规划 §5.3）：
 * - 逐 cue 合成，缓存键 = sha256(text|voice|rate)，产物落 cacheDir——同文重渲
 *   零重合成（段缓存同款纪律）；
 * - 起点 = cue 的全片绝对 atMs（与 BGM/audio 图层同一 mux 管线对齐）；
 * - 单条失败：该条降级纯字幕 + 警告，不阻塞其余 cue，绝不让渲染整单报废；
 * - 溢出：语音尾超过下一 cue 起点 / 全片时长给毫秒级对账（notes + warnings），
 *   时间线的调整由模型用 anim_patch 决策——自动伸缩场景时长明确不做。
 */
export async function synthesizeNarration(
  spec: AnimationSpec,
  tts: TtsService,
  cacheDir: string,
): Promise<SpeechBuildResult> {
  const cues = spec.narration?.cues ?? []
  const ttsConf = spec.narration?.tts
  const tracks: SpeechTrack[] = []
  const displayMs: number[] = []
  const notes: SpeechNote[] = []
  const warnings: string[] = []
  mkdirSync(cacheDir, { recursive: true })
  const rate = typeof ttsConf?.rate === 'string' ? ttsConf.rate : tts.rate
  const volume = clamp01(typeof ttsConf?.volume === 'number' ? ttsConf.volume : tts.volume)
  const totalMs = specDurationMs(spec.scenes)

  const starts = cues.map(c => (typeof c.atMs === 'number' && Number.isFinite(c.atMs) ? Math.max(0, c.atMs) : -1))
  for (const [i, cue] of cues.entries()) {
    const text = typeof cue.text === 'string' ? cue.text.trim() : ''
    displayMs.push(0)
    if (starts[i]! < 0) {
      warnings.push(`旁白 cue #${i} 的 atMs 非法（应为全片绝对毫秒），该条未合成`)
      continue
    }
    if (text === '') {
      warnings.push(`旁白 cue #${i} 的 text 为空，已跳过`)
      continue
    }
    const voice = typeof cue.voice === 'string' && cue.voice !== '' ? cue.voice : tts.defaultVoice
    const hash = createHash('sha256').update(JSON.stringify({ text, voice: voice ?? null, rate })).digest('hex').slice(0, 16)
    const outFile = join(cacheDir, `${safeName(String(spec.meta.id))}-${hash}.mp3`)
    let audioMs: number
    try {
      // 缓存命中（同 text/voice/rate 已合成过）直接实测时长，不重调命令
      audioMs = existsSync(outFile)
        ? await probeAudioDurationMs(outFile)
        : await tts.synthesizer({ text, ...(voice !== undefined ? { voice } : {}), rate, outFile }).then(r => r.durationMs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`旁白 cue #${i}（「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」）合成失败，已降级为纯字幕：${message}`)
      continue
    }
    tracks.push({ source: outFile, startMs: starts[i]!, durationMs: audioMs, volume })
    // 字幕显示跟随语音：宁可字比声先消失一瞬，也不让「声还在字没了」
    const estimated = typeof cue.durationMs === 'number' && cue.durationMs > 0 ? cue.durationMs : estimateCueMs(text)
    displayMs[i] = Math.max(estimated, audioMs)
    const nextStart = starts[i + 1] ?? totalMs
    const overflowMs = Math.max(0, starts[i]! + audioMs - nextStart)
    notes.push({ index: i, text, atMs: starts[i]!, audioMs, overflowMs })
    if (overflowMs > 300) {
      warnings.push(
        `旁白 cue #${i} 的语音（${audioMs}ms）超出${i + 1 < cues.length ? `下一 cue 起点（${nextStart}ms）` : '全片时长'}约 ${overflowMs}ms——用 anim_patch 挪 atMs 或拆短文案`,
      )
    }
  }
  return { tracks, displayMs, notes, warnings }
}

/** 与渲染端字幕估算同口径的粗估：中文 ≈4 字/秒，下限 1200ms。 */
function estimateCueMs(text: string): number {
  return Math.max(1200, Math.round((text.length / 4) * 1000))
}
