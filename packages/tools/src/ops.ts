/**
 * 工具的业务逻辑（纯 TS，不 import 任何 dsh 类型）。
 *
 * 这么切的原因很实在：`defineTool` 的类型来自 dsh，而 dsh 的依赖链
 * （`@deepseek-ai/dsh-llm` 等）装不上，逻辑一旦写进工具里就再也没法单测。
 * 把逻辑留在这一层，`register.ts` 只负责包一层 schema，测试就能跑起来。
 *
 * 每个 op 都通过 `emit` 回调产出事件，而不是自己返回事件让调用方去发——
 * 「一次修改对应一条事件」这个约束在类型上就钉死了。
 */

import type { AnimationSpec, PatchOp, Scene, ThemeToken } from '@dsh-anim/spec'
import { readAt, specDurationMs, validateSpec } from '@dsh-anim/spec'

import type { AnimEvent, AnimOutlineData } from './events.ts'
import type { AnimRendererRegistry } from './render.ts'
import { SpecStore, SpecStoreError } from './store.ts'

export interface AnimDeps {
  store: SpecStore
  renderers: AnimRendererRegistry
  /** 渲染产物的默认落盘目录。 */
  outputDir: string
}

export type Emit = (event: AnimEvent) => void

/** 工具层统一错误：消息直接给模型看，所以要写成可执行的建议，不是堆栈。 */
export class AnimOpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnimOpError'
  }
}

/* ------------------------------------------------------------------ 主题 */

export const DEFAULT_THEME: ThemeToken = {
  colors: {
    background: '#101418',
    text: '#F2F5F7',
    muted: '#7C8A96',
    primary: '#4C9AFF',
    accent: '#FFB020',
  },
  font: { family: 'Noto Sans CJK SC, sans-serif', size: 48 },
}

/* ------------------------------------------------------------- 建 spec */

export interface CreateSpecArgs {
  specId: string
  title: string
  fps?: number
  width?: number
  height?: number
  background?: string
  fontFamily?: string
}

export type CreateSpecResult = {
  specId: string
  title: string
  fps: number
  size: { width: number; height: number }
  /** 下一步该做什么，写进回执里比让模型自己猜强。 */
  next: string
}

export function opCreateSpec(deps: AnimDeps, args: CreateSpecArgs, emit: Emit): CreateSpecResult {
  const spec: AnimationSpec = {
    version: 1,
    meta: {
      id: args.specId,
      title: args.title,
      fps: args.fps ?? 30,
      size: { width: args.width ?? 1280, height: args.height ?? 720 },
      background: args.background ?? DEFAULT_THEME.colors.background,
      locale: 'zh-CN',
    },
    theme: {
      ...DEFAULT_THEME,
      font: { ...DEFAULT_THEME.font, family: args.fontFamily ?? DEFAULT_THEME.font.family },
    },
    assets: {},
    scenes: [],
  }
  // 空 spec 是合法中间态：库层要显式放行，免得为了建空文档去伪造一个假场景
  const checked = validateSpec(spec, { allowEmptyScenes: true })
  if (!checked.ok) throw new AnimOpError(checked.errors.map(e => e.message).join('; '))
  const empty = checked.spec

  try {
    deps.store.create(args.specId, empty)
  } catch (err) {
    if (err instanceof SpecStoreError) throw new AnimOpError(err.message)
    throw err
  }
  emit({ type: 'anim/spec-created', data: { specId: args.specId, spec: empty } })

  return {
    specId: args.specId,
    title: args.title,
    fps: spec.meta.fps,
    size: spec.meta.size,
    next: `spec 已建立，0 个场景。下一步用 anim_plan 写分镜大纲，再用 anim_draft_scene 逐幕细化。`,
  }
}

/* ------------------------------------------------------------- 分镜大纲 */

export interface PlanArgs {
  specId: string
  outline: AnimOutlineData['outline']
}

export type PlanResult = {
  specId: string
  sceneCount: number
  totalMs: number
  /** 节奏体检：哪些幕太短讲不完、哪些幕太长会走神。 */
  pacing: string[]
}

/**
 * 大纲由模型写，工具负责落库与节奏体检。
 *
 * 为什么工具不自己「生成」大纲：生成内容本来就是模型的活，工具代劳只会把
 * 一次模型调用变成一次工具调用加一次模型调用。但**校验**值得放在工具里——
 * 教学动画的节奏是有客观约束的，模型自己算不准总时长。
 */
export function opPlan(deps: AnimDeps, args: PlanArgs, emit: Emit): PlanResult {
  if (!deps.store.has(args.specId)) throw new AnimOpError(`spec ${args.specId} 不存在，先调 anim_create_spec`)
  if (args.outline.length === 0) throw new AnimOpError('大纲不能为空')

  const pacing: string[] = []
  for (const item of args.outline) {
    if (item.durationMs < 1200) pacing.push(`「${item.name}」只有 ${item.durationMs}ms，讲不完一个概念，建议 ≥1500ms`)
    if (item.durationMs > 8000) pacing.push(`「${item.name}」${item.durationMs}ms 偏长，建议拆成两幕或压到 6s 内`)
    if (!item.intent) pacing.push(`「${item.name}」缺少教学意图，写清楚这幕要让学生明白什么`)
  }
  const totalMs = args.outline.reduce((s, x) => s + x.durationMs, 0)
  const seconds = (totalMs / 1000).toFixed(1)
  pacing.push(`全片 ${seconds}s，共 ${args.outline.length} 幕`)

  emit({ type: 'anim/outline-updated', data: { specId: args.specId, outline: args.outline } })
  return { specId: args.specId, sceneCount: args.outline.length, totalMs, pacing }
}

/* --------------------------------------------------------------- 读 spec */

export interface GetArgs {
  specId: string
  /** JSON Pointer（`/scenes/1/layers/0`）；空或省略返回整份。 */
  path?: string
}

export function opGet(deps: AnimDeps, args: GetArgs): { specId: string; path: string; value: unknown; durationMs: number } {
  const spec = deps.store.get(args.specId)
  const path = args.path ?? ''
  let value: unknown = spec
  if (path !== '') {
    try {
      value = readAt(spec, path)
    } catch (err) {
      throw new AnimOpError(err instanceof Error ? err.message : String(err))
    }
  }
  return { specId: args.specId, path: path || '(整份)', value, durationMs: specDurationMs(spec.scenes) }
}

/* --------------------------------------------------------------- 写 spec */

export interface PatchArgs {
  specId: string
  ops: PatchOp[]
  note?: string
}

export type PatchResultView = {
  specId: string
  version: number
  applied: number
  durationMs: number
  /** 反向 ops，模型可以直接拿它再调一次 anim_patch 来撤销。 */
  inverse: PatchOp[]
  warnings: string[]
}

export function opPatch(deps: AnimDeps, args: PatchArgs, emit: Emit): PatchResultView {
  if (args.ops.length === 0) throw new AnimOpError('ops 为空，没有要改的东西')
  let applied: PatchOp[]
  let inverse: PatchOp[]
  let version: number
  try {
    const r = deps.store.patch(args.specId, args.ops, args.note)
    applied = [...args.ops]
    inverse = r.inverse
    version = deps.store.record(args.specId).version
  } catch (err) {
    throw new AnimOpError(err instanceof Error ? err.message : String(err))
  }
  const durationMs = deps.store.durationMs(args.specId)

  const warnings: string[] = []
  const checked = validateSpec(deps.store.get(args.specId))
  for (const w of checked.warnings) warnings.push(w)

  emit({ type: 'anim/spec-patched', data: { specId: args.specId, ops: applied, inverse, note: args.note, durationMs } })
  return { specId: args.specId, version, applied: applied.length, durationMs, inverse, warnings }
}

/* ------------------------------------------------------------- 场景草稿 */

export interface DraftSceneArgs {
  specId: string
  scene: Scene
  /** 省略则追加到末尾。 */
  index?: number
}

export type DraftSceneResult = {
  specId: string
  sceneId: string
  index: number
  sceneCount: number
  durationMs: number
  inverse: PatchOp[]
  /** 校验软警告（时长超声明、疑似左上角坐标系等）。模型必须读到并自行处理。 */
  warnings: string[]
}

export function opDraftScene(deps: AnimDeps, args: DraftSceneArgs, emit: Emit): DraftSceneResult {
  const checked = validateSpec({ ...deps.store.get(args.specId), scenes: [args.scene] })
  if (!checked.ok) {
    throw new AnimOpError(`场景草稿非法：${checked.errors.map(e => `${e.path || '(根)'} — ${e.message}`).join('; ')}`)
  }
  let ops: PatchOp[]
  let inverse: PatchOp[]
  try {
    const r = deps.store.putScene(args.specId, args.scene, args.index)
    ops = r.ops
    inverse = r.inverse
  } catch (err) {
    throw new AnimOpError(err instanceof Error ? err.message : String(err))
  }
  const spec = deps.store.get(args.specId)
  const index = spec.scenes.findIndex(s => s.id === args.scene.id)
  const durationMs = specDurationMs(spec.scenes)
  emit({
    type: 'anim/spec-patched',
    data: { specId: args.specId, ops, inverse, note: `写入场景「${args.scene.name}」`, durationMs },
  })
  return {
    specId: args.specId,
    sceneId: args.scene.id,
    index,
    sceneCount: spec.scenes.length,
    durationMs,
    inverse,
    warnings: checked.warnings,
  }
}

/* ------------------------------------------------------------------ 渲染 */

export async function opPreview(
  deps: AnimDeps,
  args: { specId: string; atMs?: number[]; scale?: number; renderer?: string },
  signal: AbortSignal,
): Promise<{ specId: string; renderer: string; frames: Array<{ atMs: number; path: string }> }> {
  const spec = deps.store.get(args.specId)
  const renderer = deps.renderers.get(args.renderer)
  const result = await renderer.preview({ spec, atMs: args.atMs, scale: args.scale ?? 2 }, signal)
  return {
    specId: args.specId,
    renderer: result.renderer,
    frames: result.frames.map(f => ({ atMs: f.atMs, path: f.path })),
  }
}

export async function opRender(
  deps: AnimDeps,
  args: { specId: string; outputPath?: string; scenes?: number[]; scale?: number; renderer?: string },
  signal: AbortSignal,
  emit: Emit,
): Promise<{ outputPath: string; frameCount: number; durationMs: number; width: number; height: number; renderer: string }> {
  const spec = deps.store.get(args.specId)
  const renderer = deps.renderers.get(args.renderer)
  const outputPath = args.outputPath ?? `${deps.outputDir}/${args.specId}.mp4`
  const result = await renderer.render({ spec, outputPath, scenes: args.scenes, scale: args.scale }, signal)
  emit({
    type: 'anim/render-finished',
    data: {
      specId: args.specId,
      jobId: 'sync',
      outputPath: result.outputPath,
      frameCount: result.frameCount,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
    },
  })
  return result
}

/* ------------------------------------------------------------------ 自检 */

export async function opDiagnose(
  deps: AnimDeps,
  args: { renderer?: string },
): Promise<{ renderer: string; ok: boolean; issues: string[] }> {
  const renderer = deps.renderers.get(args.renderer)
  const d = await renderer.diagnose()
  return { renderer: d.renderer ?? renderer.name, ok: d.ok, issues: d.issues }
}
