/**
 * 无头渲染：把 spec 变成 output/output.mp4。
 *
 * 渲染链路（起 dev server → 浏览器点 Render → 等帧 → ffmpeg 合成）全部复用
 * @dsh-anim/render-mc 的默认运行时——插件里的 anim_render 走的是同一条代码路径。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultRuntime, encodeFrames, generateProject } from '@dsh-anim/render-mc'
import { specDurationMs } from '@dsh-anim/spec'

import { syncProject } from './common.ts'
import { spec } from '../src/spec.ts'

const projectDir = fileURLToPath(new URL('..', import.meta.url))
const MP4 = 'output/output.mp4'
// 渲染工作目录与 src/ 分离：运行时生成的 vite 配置假定 project.tsx 在 workDir
// 根（插件的 materialize 布局）。直接拿工程根当 workDir 会用生成的配置覆盖
// 仓库里的 vite.config.ts，还指向错误的 project 路径（编辑器 500、0 帧）。
const workDir = join(projectDir, 'output', 'work')

async function main(): Promise<void> {
  // src/ 照常同步：人要看生成物、vite serve 也用它；渲染走 workDir 自己的副本
  syncProject()

  const totalMs = specDurationMs(spec.scenes)
  const expected = Math.round((totalMs / 1000) * spec.meta.fps)
  console.log(`预计 ${expected} 帧（${(totalMs / 1000).toFixed(2)}s @ ${spec.meta.fps}fps，${spec.meta.size.width}x${spec.meta.size.height}）`)

  const runtime = createDefaultRuntime({ outputDir: 'output' })
  const diagnose = await runtime.probe()
  if (!diagnose.ok) {
    console.error('环境自检未通过：')
    for (const issue of diagnose.issues) console.error(`  - ${issue}`)
    process.exit(1)
  }

  rmSync(workDir, { recursive: true, force: true })
  await runtime.materialize(generateProject(spec).files, workDir)

  const { frameDir, frameCount } = await runtime.renderProject({
    workDir,
    expectedFrames: expected,
    signal: new AbortController().signal,
    onProgress: (done, total) => process.stdout.write(`\r  已落盘 ${done}/${total} 帧`),
  })
  console.log(`\n帧渲染完成：${frameCount} 帧 → ${frameDir}`)
  if (frameCount === 0) throw new Error('没有任何帧落盘，渲染未启动')

  await encodeFrames(frameDir, expected, spec.meta.fps, join(projectDir, MP4))
  console.log('完成：', MP4)
}

main().catch(err => {
  console.error('渲染失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
