/**
 * 字幕切幕守则真机验收（保留作回归工具）：渲一条字幕跨幕的两幕小片，
 * 抽切幕前后的帧目检——
 *  - 幕 1 尾：字幕淡出应提前收在幕尾前 120ms（cut-120ms 之后不应再有字幕残影）；
 *  - 幕 2 头：跨幕延续段首帧即全显（不吃淡入，无二次闪烁）。
 * 渲染走真实浏览器 + ffmpeg，与 anim_render 完全同路径。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MotionCanvasRenderer, createDefaultRuntime } from '../packages/render-mc/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'

const exec = promisify(execFile)
const OUT = 'C:/Users/18829/.dsh/anim/subtitle-cut-verify'
mkdirSync(OUT, { recursive: true })

const spec: AnimationSpec = {
  version: 1,
  meta: { id: 'subtitle-cut-verify', title: '字幕切幕守则验收', fps: 30, size: { width: 1280, height: 720 } },
  theme: {
    colors: { background: '#101418', text: '#F2F5F7', muted: '#8B97A3', primary: '#4C9AFF', accent: '#FFB020' },
    font: { family: 'Noto Sans CJK SC', size: 48 },
  },
  assets: {},
  scenes: [
    {
      id: 's1', name: '第一幕', durationMs: 2000,
      layers: [{ id: 't1', name: '标题', type: 'text', props: { text: '第一幕', fontSize: 64 }, tracks: [] }],
    },
    {
      id: 's2', name: '第二幕', durationMs: 2000,
      layers: [{ id: 't2', name: '标题', type: 'text', props: { text: '第二幕', fontSize: 64 }, tracks: [] }],
    },
  ],
  // cue 1500→3000 跨切幕（2000）：幕 1 段淡出应收在 1880 前；幕 2 段首帧全显
  narration: { cues: [{ atMs: 1500, text: '这条字幕故意跨过切幕点', durationMs: 1500 }] },
}

const out = join(OUT, 'out.mp4')
const renderer = new MotionCanvasRenderer({
  runtime: createDefaultRuntime(),
  workDir: join(OUT, 'work'),
})
const r = await renderer.render({ spec, outputPath: out, cache: false }, new AbortController().signal)
console.log(`渲染完成：${out}（${r.frameCount} 帧，${r.durationMs}ms）`)

// 切幕在 2000ms；30fps 帧间隔 33.3ms。抽幕 1 尾与幕 2 头的帧。
const at = [1800, 1850, 1900, 1950, 2033, 2066]
for (const ms of at) {
  const png = join(OUT, `f${String(ms).padStart(5, '0')}.png`)
  await exec('ffmpeg', ['-y', '-ss', String(ms / 1000), '-i', out, '-frames:v', '1', png])
  console.log(`帧 ${ms}ms → ${png}`)
}
rmSync(join(OUT, 'work'), { recursive: true, force: true })
console.log('请目检：f01900/f01950 应无字幕残影；f02033/f02066 字幕应完整显示。')
