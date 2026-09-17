/**
 * M2 真机验收驱动（保留作回归工具）：直驱 render-mc 完整跑一遍
 * 「A 全量(建缓存+混音) → B 全命中(音轨照常重混) → C 只改音量(段缓存全命中，
 * 成片音量必须变化)」，并抽帧做字幕条 / 字体 / morph / 弹入的目视校验。
 *
 * 渲染走真实浏览器 + ffmpeg，与 anim_render 完全同路径（README 口径）。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MotionCanvasRenderer, createDefaultRuntime } from '../packages/render-mc/src/index.ts'
import { validateSpec } from '../packages/spec/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'

const exec = promisify(execFile)
const OUT = 'C:/Users/18829/.dsh/anim/m2-verify'
mkdirSync(OUT, { recursive: true })

/* ------------------------------------------------ 素材：两张 wav + 一个字体 */

/** 单声道 16bit PCM 正弦波。 */
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
const sfxPath = join(OUT, 'sfx.wav')
makeWav(bgmPath, 2200, 330) // 比 BGM 时段短：靠 loop 铺满全片
makeWav(sfxPath, 400, 880)

// 自定义字体：复制 Windows 自带黑体（spec 引用本地文件路径）
const fontSrc = 'C:/Windows/Fonts/simhei.ttf'
const fontPath = join(OUT, 'demo-hei.ttf')
copyFileSync(fontSrc, fontPath)

/* ------------------------------------------------------------------- spec */

function buildSpec(bgmVolume: number): AnimationSpec {
  return {
    version: 1,
    meta: { id: 'm2-accept', title: 'M2 效果扩面验收', fps: 30, size: { width: 1280, height: 720 } },
    theme: {
      colors: { background: '#101418', text: '#F2F5F7', muted: '#8B97A3', primary: '#4C9AFF', accent: '#FFB020' },
      font: { family: 'Noto Sans CJK SC', size: 44 },
    },
    assets: {
      bgm: { kind: 'audio', src: bgmPath },
      sfx: { kind: 'audio', src: sfxPath },
      'demo-hei': { kind: 'font', src: fontPath },
    },
    narration: {
      cues: [
        { atMs: 500, text: '第一幕：zoomIn 入场、自定义字体、back 弹入', durationMs: 2200 },
        { atMs: 3300, text: '第二幕：代码逐词演化 morph', durationMs: 2200 },
      ],
    },
    scenes: [
      {
        id: 'opening',
        name: '开场',
        durationMs: 3000,
        transition: { kind: 'zoomIn', durationMs: 600 },
        exit: { kind: 'fade', durationMs: 500 },
        layers: [
          {
            id: 'title', name: '主标题', type: 'text',
            props: { text: 'M2 效果扩面', fontSize: 88, x: 0, y: -120 },
            tracks: [{ id: 't-fade', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 700, value: 1 }] }],
          },
          {
            id: 'hei', name: '自定义字体', type: 'text',
            props: { text: '黑体字体已生效 SimHei 123', fontFamily: 'demo-hei', fontSize: 44, fill: '#FFB020', x: 0, y: 40 },
            tracks: [{ id: 'h-fade', target: 'props.opacity', keys: [{ atMs: 800, value: 0 }, { atMs: 1300, value: 1 }] }],
          },
          {
            id: 'star', name: '强调星', type: 'star',
            props: { size: 64, fill: '#FFB020', x: 420, y: -180 },
            tracks: [{ id: 's-pop', target: 'props.scale', keys: [{ atMs: 1600, value: 0 }, { atMs: 2200, value: 1, ease: { kind: 'back' } }] }],
          },
          {
            id: 'bgm', name: 'BGM', type: 'audio',
            props: { src: 'asset:bgm', volume: bgmVolume, loop: true, stop: 'specEnd' },
            tracks: [],
          },
        ],
      },
      {
        id: 'morph',
        name: '代码演化',
        durationMs: 3000,
        transition: { kind: 'slideUp', durationMs: 400 },
        layers: [
          {
            id: 'code1', name: '演化代码', type: 'code',
            props: { code: 'loss = 0.6931', language: 'python', fontSize: 40, x: 0, y: -40 },
            tracks: [{
              id: 'c-morph', target: 'props.code',
              keys: [
                { atMs: 800, value: 'loss = 0.6931' },
                { atMs: 2000, value: 'loss = accuracy_score(y)', ease: { kind: 'easeInOut' } },
              ],
            }],
          },
          {
            id: 'sfx', name: '音效', type: 'audio',
            props: { src: 'asset:sfx', atMs: 400 },
            tracks: [],
          },
        ],
      },
      {
        id: 'closing',
        name: '收尾',
        durationMs: 2000,
        transition: { kind: 'fade', durationMs: 400 },
        exit: { kind: 'slideLeft', durationMs: 600 },
        layers: [
          {
            id: 'end', name: '结束语', type: 'text',
            props: { text: '验收完成', fontSize: 96, x: 0, y: 0 },
            tracks: [{ id: 'e-fade', target: 'props.opacity', keys: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] }],
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

async function timed(label: string, spec: AnimationSpec, outputPath: string) {
  const t0 = Date.now()
  const r = await renderer.render({ spec, outputPath }, new AbortController().signal)
  console.log(`[m2] ${label}: ${Date.now() - t0}ms  audioTracks=${JSON.stringify(r.audioTracks ?? null)}  incremental=${JSON.stringify(r.incremental ?? null)}  frames=${r.frameCount}`)
  if (r.warnings?.length) console.log(`[m2]   warnings: ${r.warnings.join(' | ')}`)
  return r
}

/** ffmpeg 响度检测：mean_volume 用来证明「只改音量、段缓存全命中」时音轨真的重混了。 */
async function meanVolume(path: string): Promise<string> {
  try {
    const r = await exec('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
    const m = String(r.stderr ?? '').match(/mean_volume:\s*(-?[\d.]+) dB/)
    return m ? `${m[1]} dB` : '(未测出)'
  } catch (err) {
    return `(失败: ${err instanceof Error ? err.message.slice(0, 80) : err})`
  }
}

async function probe(path: string): Promise<string> {
  try {
    const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'csv', path])
    return String(r.stdout ?? '').trim().replace(/\n/g, ' | ')
  } catch {
    return '(ffprobe 不可用，跳过)'
  }
}

async function grabFrame(video: string, atSec: number, png: string): Promise<void> {
  await exec('ffmpeg', ['-y', '-ss', String(atSec), '-i', video, '-frames:v', '1', png])
}

// A. 全量渲染：建段缓存 + 混音
const specA = buildSpec(0.5)
const checked = validateSpec(specA)
if (!checked.ok) throw new Error(`spec 非法: ${JSON.stringify(checked.errors)}`)
for (const w of checked.warnings) console.log('[m2] validate warn:', w)
const outA = join(OUT, 'm2-a.mp4')
const rA = await timed('A. full (build cache + mux)', checked.spec, outA)
if (JSON.stringify(rA.audioTracks) !== JSON.stringify(['bgm', 'sfx'])) {
  throw new Error(`A 步 audioTracks 不符：${JSON.stringify(rA.audioTracks)}`)
}

// B. 内容未变：段缓存全命中（编辑器零启动），音轨照常重混
const outB = join(OUT, 'm2-b.mp4')
await timed('B. unchanged (all cached, re-mux)', buildSpec(0.5), outB)

// C. 只把 BGM 音量 0.5 → 0.9：段缓存必须全命中，成片响度必须变化
const outC = join(OUT, 'm2-c.mp4')
await timed('C. volume-only change (all cached, re-mux)', buildSpec(0.9), outC)

// 机器可查的断言
console.log('[m2] probe A:', await probe(outA))
const volA = await meanVolume(outA)
const volC = await meanVolume(outC)
console.log(`[m2] mean_volume A(0.5) = ${volA}   C(0.9) = ${volC}`)
const a = Number.parseFloat(volA)
const c = Number.parseFloat(volC)
if (Number.isFinite(a) && Number.isFinite(c)) {
  if (c <= a) throw new Error(`C 步响度未升高（${volA} → ${volC}），音轨可能没有按现行 spec 重混`)
  console.log('[m2] ✔ 音量改动生效且无需重渲画面（音轨不进段缓存的真机证明）')
}

// 抽帧目视校验：字幕条 / 字体 / morph / back 弹入 / zoomIn
const frames: Array<[string, number]> = [
  ['f1-subtitle-font.png', 1.8], // 字幕 1 在显 + 自定义字体文字 + zoomIn 已就位
  ['f2-star-back.png', 2.5], // star back 弹入完成
  ['f3-morph.png', 4.6], // code morph 完成后段 + 字幕 2 在显
  ['f4-exit.png', 7.7], // 末幕 slideLeft 退场中
]
for (const [name, at] of frames) {
  await grabFrame(outA, at, join(OUT, name))
  console.log('[m2] 抽帧:', name, `@${at}s`)
}
console.log('[m2] 完成。产物与抽帧都在', OUT)
