/**
 * 诊断脚本：走 @dsh-anim/render-mc 默认运行时的真实渲染链路
 * （junction → vite → 有头浏览器 → 点 Render → 等帧 → ffmpeg 合成）。
 * 冒烟测试不覆盖浏览器渲染，怀疑渲染层问题时用它单测。
 *
 * 用法：node --import tsx scripts/debug-render.ts
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createDefaultRuntime, encodeFrames, generateProject } from '../packages/render-mc/src/index.ts'
import { specDurationMs } from '../packages/spec/src/index.ts'
import { spec } from '../examples/hello-gradient/src/spec.ts'

const workDir = join(process.cwd(), '.dsh', 'anim', 'work-debug')
rmSync(workDir, { recursive: true, force: true })

const runtime = createDefaultRuntime({ outputDir: 'output' })
const probe = await runtime.probe()
console.log('probe:', JSON.stringify(probe))
if (!probe.ok) {
  for (const issue of probe.issues) console.error('  -', issue)
  process.exit(1)
}

const totalMs = specDurationMs(spec.scenes)
const expected = Math.round((totalMs / 1000) * spec.meta.fps)
console.log(`expected frames: ${expected}`)

await runtime.materialize(generateProject(spec).files, workDir)

const started = Date.now()
const result = await runtime.renderProject({
  workDir,
  fps: spec.meta.fps,
  expectedFrames: expected,
  signal: new AbortController().signal,
})
console.log(`frames: ${result.frameCount} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log('frameDir:', result.frameDir)

const out = join(process.cwd(), 'debug-output.mp4')
await encodeFrames(result.frameDir, Math.min(result.frameCount, expected), spec.meta.fps, out)
console.log('mp4 written:', out)
