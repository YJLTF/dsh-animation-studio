/**
 * M1 真机验收驱动（临时脚本，验收完可删）：直接驱动 render-mc 完整跑一遍
 * 「全量 → 全命中 → 改一幕增量 → cache:false」并做帧级校验。
 *
 * spec 从会话 sidecar fold 出来（与插件同源），渲染走真实浏览器 + ffmpeg。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { foldEvents, SpecStore } from '../packages/store/src/index.ts'
import { MotionCanvasRenderer, createDefaultRuntime } from '../packages/render-mc/src/index.ts'
import type { AnimationSpec } from '../packages/spec/src/index.ts'

const OUT = 'C:/Users/18829/.dsh/anim'
const SIDECAR = process.argv[2] ?? ''

// 1) 找最新的 sidecar，fold 出 m1-accept 的现行 spec
let sidecar = SIDECAR
if (!sidecar) {
  const { readdirSync } = await import('node:fs')
  const dir = join(OUT, 'sessions')
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    .map(f => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  sidecar = files[0]!
}
console.log('[m1] sidecar:', sidecar)
const events = readFileSync(sidecar, 'utf8').split('\n').filter(l => l.trim() !== '')
  .map(line => JSON.parse(line) as { type: string; data: unknown })
const store: SpecStore = foldEvents(events.filter(e => e.type.startsWith('anim/')))
if (!store.has('m1-accept')) throw new Error('sidecar 里没有 m1-accept')
const baseSpec: AnimationSpec = structuredClone(store.get('m1-accept'))
console.log('[m1] spec:', baseSpec.meta.id, baseSpec.scenes.length, '幕', baseSpec.scenes.map(s => `${s.id}:${sceneFill(s)}`).join(' '))

function sceneFill(s: { id: string; layers: Array<{ props: { fill?: unknown } }> }): string {
  const f = s.layers[0]?.props?.fill
  return typeof f === 'string' ? f : '(none)'
}

const renderer = new MotionCanvasRenderer({
  runtime: createDefaultRuntime({ outputDir: 'output' }),
  workDir: join(OUT, 'work'),
})

async function timed(label: string, spec: AnimationSpec, outputPath: string, cache?: boolean) {
  const t0 = Date.now()
  const r = await renderer.render({ spec, outputPath, ...(cache === undefined ? {} : { cache }) }, new AbortController().signal)
  console.log(`[m1] ${label}: ${Date.now() - t0}ms  incremental=${JSON.stringify(r.incremental ?? null)}  frames=${r.frameCount}`)
  return r
}

// 2) 全量（建 r2 段缓存）
await timed('A. full (build cache)', baseSpec, join(OUT, 'm1-v2-full.mp4'))
// 3) 内容未变：全命中
await timed('B. unchanged (all cached)', baseSpec, join(OUT, 'm1-v2-full.mp4'))
// 4) 改 demo 颜色后增量：只 solo 重渲第二幕
const patched: AnimationSpec = structuredClone(baseSpec)
const fill = patched.scenes[1]!.layers[0]!.props as { fill: string }
fill.fill = fill.fill === '#CC3333' ? '#223044' : '#CC3333'
console.log('[m1] patched demo fill ->', fill.fill)
await timed('C. incremental (1 scene changed)', patched, join(OUT, 'm1-v2-incr.mp4'))
// 5) cache:false 全量（同一内容，作为对照真值）
await timed('D. cache:false (ground truth)', patched, join(OUT, 'm1-v2-ref.mp4'))

console.log('[m1] renders done. 帧级校验用独立 ffmpeg 脚本进行。')
