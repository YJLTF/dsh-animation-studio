/**
 * generate 与 render 两个脚本共用的「spec → src/ 生成物」同步逻辑。
 *
 * 生成物是多文件（每个场景一个 `?scene` 模块），所以做的是「同步目录」：
 * 先清掉上次生成的 scenes/，再写回，避免改名后的残留场景还挂在 project 上。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { generateProject } from '@dsh-anim/render-mc'
import { validateSpec } from '@dsh-anim/spec'

import { spec } from '../src/spec.ts'

export function syncProject(): void {
  const checked = validateSpec(spec)
  if (!checked.ok) {
    console.error('spec 校验失败：')
    for (const e of checked.errors) console.error(`  ${e.path || '(根)'} — ${e.message}`)
    process.exit(1)
  }
  for (const w of checked.warnings) console.warn(`[warn] ${w}`)

  const { files, warnings } = generateProject(checked.spec)
  for (const w of warnings) console.warn(`[warn] ${w}`)

  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  rmSync(join(srcDir, 'scenes'), { recursive: true, force: true })
  mkdirSync(srcDir, { recursive: true })

  for (const file of files) {
    const target = join(srcDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
}
