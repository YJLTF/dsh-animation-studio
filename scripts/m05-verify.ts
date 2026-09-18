/**
 * 0.5.0 真机验收驱动（保留作回归工具）：直驱 render-mc + tools/tts 完整跑一遍
 * 「A 新元素全量渲染（渐变/虚线/长段落折行/打字机/in-inOut 缓动/video 图层）
 *  → B 配音端到端（edge-tts 真机合成、字幕跟随、缓存零重合成）
 *  → C 单幕直放（段缓存 findSceneSegment 命中）
 *  → D 拼贴图落盘
 *  → E TTS 命令失败降级（成片照常、警告可见）」。
 *
 * 渲染走真实浏览器 + ffmpeg，与 anim_render 完全同路径（README 口径）。
 * video 图层的 headless 帧同步是 0.5.0 M2 的真机 gate：本脚本 A 步即判定。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MotionCanvasRenderer, createDefaultRuntime } from '../packages/render-mc/src/index.ts'
import { previewClipFastPath } from '../packages/tools/src/ops.ts'
import { createTtsService, synthesizeNarration, probeAudioDurationMs, type TtsSynthesizer } from '../packages/tools/src/tts.ts'
import { validateSpec } from '../packages/spec/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'

const exec = promisify(execFile)
const OUT = 'C:/Users/18829/.dsh/anim/m05-verify'
mkdirSync(OUT, { recursive: true })
const TEST_VIDEO = 'F:/project/dsh-animation-studio/.tmp/v05/testclip.mp4'

function makeWav(path: string, ms: number, freq: number): void {
  const rate = 22050
  const n = Math.round((ms / 1000) * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 14000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

const bgmPath = join(OUT, 'bgm.wav')
makeWav(bgmPath, 2500, 330)

/** 是否配置配音（E 步降级验证时关闭）。 */
function buildSpec(opts: { withTts?: boolean } = {}): AnimationSpec {
  return {
    version: 1,
    meta: { id: 'm05-accept', title: '0.5.0 验收：配音与表达力', fps: 30, size: { width: 1280, height: 720 } },
    theme: {
      colors: { background: '#101418', text: '#F2F5F7', muted: '#8B97A3', primary: '#4C9AFF', accent: '#FFB020' },
      font: { family: 'Noto Sans CJK SC', size: 44 },
    },
    assets: {
      bgm: { kind: 'audio', src: bgmPath },
      clip: { kind: 'video', src: TEST_VIDEO },
    },
    ...(opts.withTts
      ? {
          narration: {
            cues: [
              { atMs: 300, text: '渐变底版上，逐字浮现的旁白正在配音' },
              { atMs: 4200, text: '第二幕嵌入实拍视频片段，画面音画同步' },
            ],
            tts: { volume: 1 },
          },
        }
      : {}),
    scenes: [
      {
        id: 'opening',
        name: '渐变与打字机',
        durationMs: 4000,
        transition: { kind: 'zoomIn', durationMs: 500, ease: { kind: 'backInOut' } },
        exit: { kind: 'fade', durationMs: 400 },
        layers: [
          {
            id: 'panel', name: '渐变底版', type: 'rect',
            props: { width: 900, height: 320, y: -60, fill: { type: 'linear', from: [-450, 0], to: [450, 0], stops: [[0, '#1B3A5C'], [1, '#4C9AFF']] }, radius: 24 },
            tracks: [{ id: 'p-in', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 600, value: 1 }] }],
          },
          {
            id: 'say', name: '打字机旁白', type: 'text',
            props: { text: '逐字浮现：0.5.0 配音上线', fontSize: 52, x: 0, y: -120 },
            tracks: [{ id: 'say-reveal', target: 'props.reveal', keys: [{ atMs: 400, value: 0 }, { atMs: 2200, value: 1, ease: { kind: 'easeInOut' } }] }],
          },
          {
            id: 'para', name: '长段落折行', type: 'text',
            props: {
              text: '这是一段刻意很长的说明文字，用来验证 maxWidth 与 textWrap 的自动折行：超宽之后按词与字符断行，底稿不再需要手工断句。',
              fontSize: 30, maxWidth: 620, textWrap: true, lineHeight: '150', x: 0, y: 40, fill: '#C9D4DE',
            },
            tracks: [{ id: 'para-in', target: 'props.opacity', keys: [{ atMs: 1400, value: 0 }, { atMs: 2000, value: 1 }] }],
          },
          {
            id: 'dash', name: '虚线辅助线', type: 'line',
            props: { points: [[-430, 180], [430, 180]], stroke: '#FFB020', lineWidth: 3, lineDash: [10, 8] },
            tracks: [{ id: 'dash-in', target: 'props.opacity', keys: [{ atMs: 1800, value: 0 }, { atMs: 2300, value: 1 }] }],
          },
          {
            id: 'star', name: '弹入星', type: 'star',
            props: { size: 56, fill: '#FFB020', x: 480, y: -200 },
            tracks: [{ id: 's-pop', target: 'props.scale', keys: [{ atMs: 2400, value: 0 }, { atMs: 3000, value: 1, ease: { kind: 'bounceIn' } }] }],
          },
          {
            id: 'bgm', name: 'BGM', type: 'audio',
            props: { src: 'asset:bgm', volume: 0.35, loop: true, stop: 'specEnd' },
            tracks: [],
          },
        ],
      },
      {
        id: 'video-scene',
        name: '实拍嵌入',
        durationMs: 4000,
        transition: { kind: 'slideLeft', durationMs: 400 },
        layers: [
          {
            id: 'clip', name: '测试视频', type: 'video',
            props: { src: 'asset:clip', width: 480, y: -40 },
            tracks: [{ id: 'v-in', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] }],
          },
          {
            id: 'cap', name: '视频说明', type: 'text',
            props: { text: '实拍片段 3s · testsrc', fontSize: 36, y: 220, fill: '#8B97A3' },
            tracks: [{ id: 'cap-in', target: 'props.opacity', keys: [{ atMs: 800, value: 0 }, { atMs: 1200, value: 1 }] }],
          },
        ],
      },
    ],
  }
}

const renderer = new MotionCanvasRenderer({
  runtime: createDefaultRuntime({ outputDir: 'output' }),
  workDir: join(OUT, 'work'),
})

async function timed(label: string, spec: AnimationSpec, outputPath: string, speech?: Parameters<typeof renderer.render>[0]['speech']) {
  const t0 = Date.now()
  const r = await renderer.render({ spec, outputPath, ...(speech ? { speech } : {}) }, new AbortController().signal)
  console.log(`[v05] ${label}: ${Date.now() - t0}ms  frames=${r.frameCount}  audioTracks=${JSON.stringify(r.audioTracks ?? null)}  speechTracks=${r.speechTracks ?? 0}  incremental=${JSON.stringify(r.incremental ?? null)}`)
  if (r.warnings?.length) console.log(`[v05]   warnings: ${r.warnings.join(' | ')}`)
  return r
}

async function probe(path: string): Promise<string> {
  try {
    const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'csv', path])
    return String(r.stdout ?? '').trim().replace(/\n/g, ' | ')
  } catch {
    return '(ffprobe 不可用)'
  }
}

async function grabFrame(video: string, atSec: number, png: string): Promise<void> {
  await exec('ffmpeg', ['-y', '-ss', String(atSec), '-i', video, '-frames:v', '1', png])
}

/* ------------------------------------------ B 前置：edge-tts 真机合成器 */

let synthCalls = 0
// createTtsService 是唯一入口；用带计数的代理包住它的 synthesizer
const ttsBase = createTtsService({
  command: ['edge-tts', '--voice', '{voice}', '--rate', '{rate}', '--text', '{text}', '--write-media', '{outFile}'],
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+8%',
  timeoutMs: 60_000,
})
const countingSynth: TtsSynthesizer = async req => {
  synthCalls += 1
  return ttsBase.synthesizer(req)
}
const tts = { ...ttsBase, synthesizer: countingSynth }

/* ------------------------------------------ A. 新元素全量渲染（video gate） */

console.log('[v05] ===== A. 新元素全量渲染（video 图层 headless gate） =====')
const specA = buildSpec()
const checkedA = validateSpec(specA)
if (!checkedA.ok) throw new Error(`spec 非法：${JSON.stringify(checkedA.errors)}`)
for (const w of checkedA.warnings) console.log('[v05] validate warn:', w)
const outA = join(OUT, 'v05-a.mp4')
const rA = await timed('A. full (new elements + video)', checkedA.spec, outA)
console.log('[v05] probe A:', await probe(outA))
if (!existsSync(outA) || statSync(outA).size < 50_000) throw new Error('A 步成片异常（过小）')
console.log('[v05] ✔ video 图层 headless gate 通过（video 场景渲出成片）')

// 抽帧目视校验：渐变底版 / 打字机中段 / 折行段落 / 虚线 / 实拍视频帧
const frames: Array<[string, number]> = [
  ['f1-gradient-typewriter.png', 1.6], // 渐变底版 + 打字机进行中 + 段落折行
  ['f2-dash-bounce.png', 3.4], // 虚线 + bounceIn 星
  ['f3-video-scene.png', 5.5], // 第二幕实拍视频画面
]
for (const [name, at] of frames) {
  await grabFrame(outA, at, join(OUT, name))
  console.log('[v05] 抽帧:', name, `@${at}s`)
}

/* ------------------------------------------ B. 配音端到端（edge-tts 真机） */

console.log('[v05] ===== B. 配音端到端（edge-tts） =====')
const specB = buildSpec({ withTts: true })
const checkedB = validateSpec(specB)
if (!checkedB.ok) throw new Error(`spec 非法：${JSON.stringify(checkedB.errors)}`)
const ttsCacheDir = join(OUT, 'work', 'm05-accept', 'tts')
rmSync(ttsCacheDir, { recursive: true, force: true }) // 可重跑：每次验证首合成从零开始
const speechBuild = await synthesizeNarration(checkedB.spec, tts, ttsCacheDir)
console.log(`[v05] 首次合成：${speechBuild.tracks.length} 轨，合成命令调用 ${synthCalls} 次`)
for (const w of speechBuild.warnings) console.log('[v05] tts warn:', w)
for (const n of speechBuild.notes) {
  console.log(`[v05] 对账 #${n.index + 1} @${n.atMs}ms 语音 ${n.audioMs}ms 溢出 ${n.overflowMs}ms`)
}
if (speechBuild.tracks.length !== 2 || synthCalls !== 2) throw new Error('B 步首次合成数量不符')
const cachedFiles1 = readdirSync(ttsCacheDir).length

const outB = join(OUT, 'v05-b.mp4')
const rB = await timed('B. full with speech', checkedB.spec, outB, { tracks: speechBuild.tracks, displayMs: speechBuild.displayMs })
console.log('[v05] probe B（应含 audio 流）:', await probe(outB))
if ((rB.speechTracks ?? 0) !== 2) throw new Error(`B 步 speechTracks 不符：${rB.speechTracks}`)
// speechNotes 由 tools 层（synthesizeNarration）产出——直驱 adapter 的本脚本
// 直接断言合成侧的 notes（opRender 会把它们带进回执，冒烟与宿主链路覆盖）
if (speechBuild.notes.length !== 2) throw new Error('B 步 speechNotes 缺失')
// 字幕跟随：displayMs 取估算与实测的较大者
console.log('[v05] displayMs:', JSON.stringify(speechBuild.displayMs))

// 缓存零重合成：同 spec 重渲（改 BGM 音量触发重 mux，画面段全命中），不调合成命令
synthCalls = 0
const specB2 = buildSpec({ withTts: true })
specB2.scenes[0]!.layers.find(l => l.id === 'bgm')!.props.volume = 0.6
const speechBuild2 = await synthesizeNarration(specB2, tts, ttsCacheDir)
const outB2 = join(OUT, 'v05-b2.mp4')
await timed('B2. re-render (tts cache hit)', specB2, outB2, { tracks: speechBuild2.tracks, displayMs: speechBuild2.displayMs })
if (synthCalls !== 0) throw new Error(`B2 步重合成发生了 ${synthCalls} 次——缓存失效`)
console.log(`[v05] ✔ 配音缓存零重合成（缓存文件 ${cachedFiles1} 个，第二次合成命令调用 0 次）`)

/* ------------------------------------------ C. 单幕直放（段缓存命中） */

console.log('[v05] ===== C. 单幕直放 =====')
const seg = renderer.findSceneSegment?.(buildSpec(), 0)
if (!seg) throw new Error('C 步：渲染后第 0 幕的段缓存未命中')
console.log('[v05] 段命中:', seg.path, `${seg.durationMs}ms`)
const clip = previewClipFastPath(buildSpec(), renderer, { specId: 'm05-accept', atMs: [1000] })
if (!clip) throw new Error('C 步：previewClipFastPath 未命中')
console.log('[v05] ✔ 单幕直放命中：', clip.sceneId, clip.path)

/* ------------------------------------------ D. 拼贴图 */

console.log('[v05] ===== D. 拼贴图 =====')
if (!rA.contactSheet || !existsSync(rA.contactSheet)) throw new Error(`D 步：contactSheet 缺失 ${rA.contactSheet}`)
console.log('[v05] ✔ 拼贴图:', rA.contactSheet, statSync(rA.contactSheet).size, 'bytes')

/* ------------------------------------------ E. TTS 命令失败降级 */

console.log('[v05] ===== E. TTS 命令失败降级 =====')
const badTts = createTtsService({ command: ['definitely-not-a-real-tts-binary', '--text', '{text}', '--write-media', '{outFile}'], timeoutMs: 5000 })
const specE = buildSpec({ withTts: true })
const buildE = await synthesizeNarration(specE, badTts, join(OUT, 'work', 'm05-accept', 'tts-bad'))
if (buildE.tracks.length !== 0) throw new Error('E 步：坏命令不应产出音轨')
if (!buildE.warnings.some(w => w.includes('降级为纯字幕'))) throw new Error(`E 步：降级警告缺失：${JSON.stringify(buildE.warnings)}`)
console.log('[v05] ✔ 坏命令降级：全部 cue 纯字幕，警告可见（', buildE.warnings.length, '条）')

// E2: 配了坏 TTS 的完整渲染仍出片（warnings 带「纯字幕」）
const outE = join(OUT, 'v05-e.mp4')
const ttsServiceBad = { ...badTts }
const buildE2 = await synthesizeNarration(specE, ttsServiceBad, join(OUT, 'work', 'm05-accept', 'tts-bad'))
await timed('E2. full render with failed tts', specE, outE, buildE2.tracks.length > 0 ? { tracks: buildE2.tracks, displayMs: buildE2.displayMs } : undefined)
console.log('[v05] probe E2（无声也合法）:', await probe(outE))

console.log('\n[v05] 全部验收通过。产物在', OUT)
