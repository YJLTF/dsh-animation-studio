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

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import type { AnimationSpec, JsonValue, PatchOp, Scene, ThemeToken } from '@dsh-anim/spec'
import { LAYER_TYPES, PROP_ALIASES, readAt, safeName, sceneDurationMs, specDurationMs, validateSpec } from '@dsh-anim/spec'
import type { OutlineItem } from '@dsh-anim/store'
import { SpecStore, SpecStoreError } from '@dsh-anim/store'

import type { AnimEvent, AnimOutlineData } from './events.ts'
import type { AnimRenderer, AnimRendererRegistry } from './render.ts'

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
  // 「全片 Xs 共 N 幕」这类中性信息不再混进 pacing：totalMs/sceneCount 已在
  // 回执与面板摘要里，混在一起会稀释真警告的视觉权重（优化清单 O18）
  // 全片时长档位（0.4.0 规划 N5）：单幕体检管不住「幕幕合格加起来渲不动」
  if (totalMs > 180_000) {
    pacing.push(`全片 ${Math.round(totalMs / 1000)}s：默认渲染超时 30 分钟，这个体量渲染前先用 anim_render 的 scenes 抽查，并认真考虑压缩节奏或拆片`)
  } else if (totalMs > 60_000) {
    pacing.push(`全片 ${Math.round(totalMs / 1000)}s：长片渲染耗时以分钟计，确认这个体量是有意为之`)
  }

  // 大纲进状态（0.4.0 规划 N3）：后续 draft/render 才能对「大纲 ↔ 实际场景」
  // 做对账；事件照发，回放由 foldEvents 消费同一条事件恢复出同一份大纲
  deps.store.setOutline(args.specId, args.outline)
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
  // patch 后的软警告（时长超声明、疑似左上角坐标系）随回执带给模型
  const { warnings } = validateSpec(deps.store.get(args.specId))
  const durationMs = deps.store.durationMs(args.specId)

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
  /** 边界自动纠正清单：哪些机械错误被工具改掉了。模型应读到并下次自己写对。 */
  repairs: string[]
  /** 校验软警告（时长超声明、疑似左上角坐标系等）。模型必须读到并自行处理。 */
  warnings: string[]
  /**
   * 「大纲 ↔ 实际场景」对账提示（中性信息，非告警）：超出/偏离大纲的形态
   * 需要模型看一眼自行判断是新想法还是笔误。大纲不存在时缺省。
   */
  outlineNotes?: string[]
}

/* ----------------------------------------------------- 草稿边界自动纠错 */

export interface CoercedScene {
  scene: Scene
  /** 人话版修复清单，每条说清改了什么、为什么。 */
  repairs: string[]
}

const LAYER_TYPE_SET: ReadonlySet<string> = new Set(LAYER_TYPES)

/**
 * 场景草稿的机械错误自动纠正（真机首写 `anim_draft_scene` 高频失败四类）：
 * 1. `ease: "easeOut"` 写成字符串 → 包装成 `{ kind: 'easeOut' }`。未知缓动名
 *    也一并包装——这样校验器报的是「未知缓动类型 "bounce"，可选：…」而不是
 *    一句「应为对象」，模型一眼知道错在值不在形态；
 * 2. 图层 `type` 大小写写飘（"Text"/"Circle"）→ 按不区分大小写匹配 LAYER_TYPES 纠正；
 * 3. 漏纯展示字段 `name`（图层/场景）→ 用 id 补上；漏 `tracks`（静态图层本就合法）
 *    → 补空数组；
 * 4. 属性别名归一为规范名（权威表 `PROP_ALIASES`，0.4.0 N2 收敛）：props 键与
 *    轨道目标两侧都改写——`strokeWidth → lineWidth`、`color → fill`。规范名
 *    已显式给出时别名不动（规范名优先，不丢内容）。
 *
 * 只修「无歧义、不丢内容」的错；拿不准的一律不动，留给 validateSpec 报错
 * （文案自带可执行指引）。输入先深拷贝，绝不改调用方的参数对象。
 */
export function coerceScene(input: unknown): CoercedScene {
  const repairs: string[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    // 场景本身不是对象：无从纠起，原样交校验器报「场景应为对象」
    return { scene: input as Scene, repairs }
  }
  const scene = structuredClone(input) as Record<string, unknown>

  // ease 字符串 → { kind } 包装。闭包共享计数，最后合并成一条修复说明
  let easeWrapped = 0
  const wrapEase = (holder: Record<string, unknown>, key: string): void => {
    if (typeof holder[key] === 'string') {
      holder[key] = { kind: holder[key] }
      easeWrapped++
    }
  }

  if ((scene.name === undefined || scene.name === null || scene.name === '') && typeof scene.id === 'string' && scene.id !== '') {
    scene.name = scene.id
    repairs.push(`场景缺 name，已用 id「${scene.id}」补上（name 只用于展示）`)
  }

  const typeFixed: string[] = []
  const nameFilled: string[] = []
  const tracksFilled: string[] = []
  const aliasesFixed: string[] = []
  if (Array.isArray(scene.layers)) {
    for (const l of scene.layers) {
      if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
      const layer = l as Record<string, unknown>
      const label = typeof layer.id === 'string' && layer.id !== '' ? layer.id : '(缺 id)'
      if (typeof layer.type === 'string' && !LAYER_TYPE_SET.has(layer.type)) {
        const lower = layer.type.toLowerCase()
        if (LAYER_TYPE_SET.has(lower)) {
          typeFixed.push(`"${layer.type}"→"${lower}"`)
          layer.type = lower
        }
      }
      if ((layer.name === undefined || layer.name === null || layer.name === '') && typeof layer.id === 'string' && layer.id !== '') {
        layer.name = layer.id
        nameFilled.push(label)
      }
      if (layer.tracks === undefined || layer.tracks === null) {
        layer.tracks = []
        tracksFilled.push(label)
      }
      // 属性别名归一（表驱动，含 color→fill / strokeWidth→lineWidth 等）：
      // 规范名写库时就落对，anim_get 读到的就是规范形态
      const lp = layer.props
      if (lp !== null && typeof lp === 'object' && !Array.isArray(lp)) {
        const p = lp as Record<string, unknown>
        for (const [alias, canonical] of Object.entries(PROP_ALIASES)) {
          if (p[alias] !== undefined && p[canonical] === undefined) {
            p[canonical] = p[alias]
            delete p[alias]
            aliasesFixed.push(`${label}: ${alias}→${canonical}`)
          }
        }
      }
      if (Array.isArray(layer.tracks)) {
        for (const t of layer.tracks) {
          if (t === null || typeof t !== 'object' || !Array.isArray((t as Record<string, unknown>).keys)) continue
          const tr = t as Record<string, unknown>
          // 轨道目标别名归一：props.strokeWidth → props.lineWidth（轨道目标
          // 永远不会被支持为别名形态，无歧义改写）
          if (typeof tr.target === 'string') {
            const m = /^props\.([^.]+)$/.exec(tr.target)
            const canonical = m ? PROP_ALIASES[m[1]!] : undefined
            if (m && canonical !== undefined) {
              tr.target = `props.${canonical}`
              aliasesFixed.push(`${label}: 轨道目标 ${m[1]}→${canonical}`)
            }
          }
          for (const k of tr.keys as unknown[]) {
            if (k !== null && typeof k === 'object' && !Array.isArray(k)) wrapEase(k as Record<string, unknown>, 'ease')
          }
        }
      }
    }
  }
  if (scene.transition !== undefined && scene.transition !== null && typeof scene.transition === 'object') {
    wrapEase(scene.transition as Record<string, unknown>, 'ease')
  }

  if (easeWrapped > 0) repairs.push(`${easeWrapped} 处 ease 由字符串包装成 { kind } 对象——下次请直接写 {"kind":"easeOut"} 形式`)
  if (typeFixed.length > 0) repairs.push(`图层 type 大小写已纠正：${typeFixed.join('、')}（类型名全小写）`)
  if (nameFilled.length > 0) repairs.push(`图层缺 name，已用各自 id 补上：${nameFilled.join('、')}`)
  if (tracksFilled.length > 0) repairs.push(`图层缺 tracks，已按静态图层补空数组：${tracksFilled.join('、')}`)
  if (aliasesFixed.length > 0) repairs.push(`属性别名已归一化为规范名：${aliasesFixed.join('、')}（下次直接写规范名）`)
  return { scene: scene as unknown as Scene, repairs }
}

/* ----------------------------------------------------------- 大纲对账 */

/**
 * 「大纲 ↔ 实际场景」对账（0.4.0 规划 N3）。
 *
 * 返回**中性提示**而不是 warnings：大纲与场景本就不要求逐字对应，这些形态
 * 需要模型看一眼自行判断是新想法（更新大纲）还是笔误（核对场景 id）。
 * `anim_draft_scene`（写幕时）与 `anim_render`（渲染前）都吃这份提示——
 * 渲染前的偏差意味着「整片重渲也得不到想要的片子」，此时说比渲完说便宜。
 */
export function reconcileOutline(outline: readonly OutlineItem[], scenes: readonly Scene[]): string[] {
  const notes: string[] = []
  if (outline.length === 0) return notes
  const outlineIds = new Set(outline.map(o => o.id))
  if (scenes.length > outline.length) {
    notes.push(`已写入 ${scenes.length} 幕，超出大纲的 ${outline.length} 幕——多出的幕是新想法（用 anim_plan 更新大纲）还是误写（核对场景）？`)
  }
  const stray = scenes.filter(s => !outlineIds.has(s.id)).map(s => s.id)
  if (stray.length > 0) {
    notes.push(`场景 ${stray.join('、')} 不在大纲中（大纲：${outline.map(o => o.id).join('、')}）`)
  }
  for (const s of scenes) {
    const suggested = outline.find(o => o.id === s.id)?.durationMs
    if (typeof suggested === 'number' && suggested > 0) {
      const dev = Math.abs(sceneDurationMs(s) - suggested) / suggested
      if (dev > 0.5) {
        notes.push(`场景「${s.id}」实际时长 ${sceneDurationMs(s)}ms，大纲建议 ${suggested}ms（偏差 ${Math.round(dev * 100)}%）`)
      }
    }
  }
  const actualMs = specDurationMs(scenes)
  const outlineMs = outline.reduce((sum, o) => sum + (typeof o.durationMs === 'number' && o.durationMs > 0 ? o.durationMs : 0), 0)
  // 全片偏差只在幕数写齐后才有意义：草稿写到一半偏差必然大（真机验证发现
  // 逐幕 draft 时这条提示每幕都响，属噪音）——「未写完」那条已经覆盖该语义
  if (outlineMs > 0 && actualMs > 0 && scenes.length >= outline.length) {
    const dev = Math.abs(actualMs - outlineMs) / outlineMs
    if (dev > 0.3) {
      notes.push(`全片实际 ${actualMs}ms，大纲合计 ${outlineMs}ms（偏差 ${Math.round(dev * 100)}%）——先对齐再渲染，避免整片重渲`)
    }
  }
  if (scenes.length > 0) {
    const missing = outline.filter(o => !scenes.some(s => s.id === o.id)).map(o => o.id)
    if (missing.length > 0) notes.push(`大纲还有 ${missing.length} 幕未写：${missing.join('、')}`)
  }
  return notes
}

export function opDraftScene(deps: AnimDeps, args: DraftSceneArgs, emit: Emit): DraftSceneResult {
  // 先过机械纠错再校验：ease 字符串、type 大小写、漏 name/tracks、strokeWidth
  // 旧名这类机械错误不值得烧一个来回，纠正清单随回执回报让模型下次自己写对
  const { scene, repairs } = coerceScene(args.scene)
  const checked = validateSpec({ ...deps.store.get(args.specId), scenes: [scene] })
  if (!checked.ok) {
    // 报错尾部带最小行动指引：模型不必翻工具描述就能对齐最常漏的形态
    throw new AnimOpError(
      `场景草稿非法：${checked.errors.map(e => `${e.path || '(根)'} — ${e.message}`).join('; ')}`
      + '。图层必填五字段 id / name / type / props / tracks，ease 必须是对象（如 {"kind":"easeOut"}）而不是字符串',
    )
  }
  let ops: PatchOp[]
  let inverse: PatchOp[]
  try {
    const r = deps.store.putScene(args.specId, scene, args.index)
    ops = r.ops
    inverse = r.inverse
  } catch (err) {
    throw new AnimOpError(err instanceof Error ? err.message : String(err))
  }
  const spec = deps.store.get(args.specId)
  const index = spec.scenes.findIndex(s => s.id === scene.id)
  const durationMs = specDurationMs(spec.scenes)
  emit({
    type: 'anim/spec-patched',
    data: { specId: args.specId, ops, inverse, note: `写入场景「${scene.name}」`, durationMs },
  })
  // 大纲存在才对账：大纲是模型的计划，写幕时偏差最便宜的时刻就在此刻
  const outline = deps.store.record(args.specId).outline
  const outlineNotes = outline !== undefined && outline.length > 0 ? reconcileOutline(outline, spec.scenes) : []
  return {
    specId: args.specId,
    sceneId: scene.id,
    index,
    sceneCount: spec.scenes.length,
    durationMs,
    inverse,
    repairs,
    warnings: checked.warnings,
    ...(outlineNotes.length > 0 ? { outlineNotes } : {}),
  }
}

/* ------------------------------------------------------------------ 渲染 */

export async function opPreview(
  deps: AnimDeps,
  args: { specId: string; atMs?: number[]; scale?: number; renderer?: string },
  signal: AbortSignal,
): Promise<{ specId: string; renderer: string; frames: Array<{ atMs: number; path: string }>; warnings?: string[] }> {
  const spec = deps.store.get(args.specId)
  const renderer = deps.renderers.get(args.renderer)
  const result = await renderer.preview({ spec, atMs: args.atMs, scale: args.scale ?? 2 }, signal)
  return {
    specId: args.specId,
    renderer: result.renderer,
    frames: result.frames.map(f => ({ atMs: f.atMs, path: f.path })),
    ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  }
}

/**
 * dsh `ctx.jobs` 的最小结构接口。
 *
 * 宿主侧类型不在本包的类型面上（与 EventSink 同一个处境），运行时按结构探测
 * 后使用；字段语义以官方 jobs 子系统文档为准：
 * - `start()` 预检通过后**同步**调用一次 `run()`，返回品牌化 JobId（形如 anim-render-1）；
 * - `run()` 返回 `{ cancel, done, readOutput? }`，done 在资源释放后 resolve、不应 reject；
 * - 模型侧的 job_output / job_kill 由 dsh-tool-jobs 提供，本插件不必自己造。
 */
export interface AnimJobHandle {
  cancel(reason?: unknown): unknown
  done: Promise<{ status?: 'completed' | 'killed' | 'failed'; detail?: unknown; output?: unknown }>
}

export interface AnimJobsService {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run: () => AnimJobHandle
  }): unknown
}

export interface RenderArgs {
  specId: string
  outputPath?: string
  scenes?: number[]
  scale?: number
  renderer?: string
}

export interface RenderResultView {
  /** 区分回执：sync = 同步出片；background = 已转后台任务（见 RenderBackgroundTicket）。 */
  kind: 'sync'
  outputPath: string
  frameCount: number
  durationMs: number
  width: number
  height: number
  renderer: string
  /** 本片目标帧数（fps × 时长），成本预期管理（0.4.0 规划 N5）。 */
  expectedFrames?: number
  /** 生成期降级警告（同类已合并），模型需要逐条判断是否要改 spec（N4）。 */
  warnings?: string[]
  /** 大纲对账提示（中性信息），大纲不存在或完全对得上时缺省（N3）。 */
  outlineNotes?: string[]
}

/** 后台模式下工具的即时回执：真正的渲染结果经 job_output / 完成通知到达。 */
export interface RenderBackgroundTicket {
  kind: 'background'
  jobId: string
  specId: string
  outputPath: string
  next: string
  /** 渲染启动前的对账提示：此刻说比渲完说便宜。 */
  outlineNotes?: string[]
}

/** 进度事件按 5% 一档节流：事件直接落会话日志，每帧一发等于往回放流里灌水。 */
const PROGRESS_STEPS = 20

/**
 * 渲染事件按因果序落盘的保障。
 *
 * jobs.start 是**同步**调用 run() 的，品牌化 jobId 要等 start 返回才已知；
 * 极端情况下（同步完成的假后端、立即 abort）渲染可能在 id 产生前就结算。
 * 所以渲染事件都以 thunk 形式过这道闸：id 未定先缓冲，id 确定后统一补发，
 * 落盘顺序恒为 render-start → render-progress… → render-finished，且载荷里
 * 的 jobId 不会错。
 */
function createRenderEventGate(emit: Emit, jobIdBox: { value: string | null }) {
  const deferred: Array<() => AnimEvent> = []
  const pass = (make: () => AnimEvent): void => {
    if (jobIdBox.value) emit(make())
    else deferred.push(make)
  }
  const flush = (): void => {
    for (const make of deferred.splice(0)) emit(make())
  }
  return { pass, flush }
}

function createProgressReporter(
  specId: string,
  jobIdBox: { value: string | null },
  emit: (make: () => AnimEvent) => void,
) {
  let lastStep = -1
  return (done: number, total: number): void => {
    if (!(total > 0) || done < 0) return
    const step = Math.min(PROGRESS_STEPS, Math.floor((done / total) * PROGRESS_STEPS))
    if (step <= lastStep && done < total) return
    lastStep = step
    // jobId 在补发时才取值：缓冲期间 id 可能尚未产生
    // 尾帧缓冲会让 done 略超预估 total（真机实测 92/90），percent 钳在 100
    emit(() => ({
      type: 'anim/render-progress',
      data: {
        specId,
        jobId: jobIdBox.value ?? 'anim-render',
        done,
        total,
        percent: Math.min(100, Math.round((done / total) * 100)),
      },
    }))
  }
}

function emitRenderStart(emit: Emit, specId: string, jobId: string, outputPath: string, args: RenderArgs): void {
  emit({
    type: 'anim/render-start',
    data: {
      specId,
      jobId,
      outputPath,
      // 可选字段按无损 JSON 约束条件展开，不留 undefined 属性值
      ...(args.scenes ? { scenes: args.scenes } : {}),
      ...(args.scale === undefined ? {} : { scale: args.scale }),
    },
  })
}

/**
 * 渲染成 MP4。
 *
 * 宿主提供 ctx.jobs 时走后台任务：工具立即返回 jobId，进度以 render-progress
 * 事件可见，模型用 job_output 收集结果、job_kill 终止。任务一旦发布，取消只认
 * 任务自己的 cancel 信号——外层 exec.signal 的取消只是不再等待，不杀已发布的
 * 工作（官方 jobs 文档写明的约定）。宿主没有 jobs 服务或发布失败时退回同步
 * 渲染：调用方 await 到出片为止，进度事件照发。
 */
export async function opRender(
  deps: AnimDeps,
  args: RenderArgs,
  signal: AbortSignal,
  emit: Emit,
  jobs?: AnimJobsService,
  owner?: unknown,
): Promise<RenderResultView | RenderBackgroundTicket> {
  const spec = deps.store.get(args.specId)
  const renderer = deps.renderers.get(args.renderer)
  // 相对路径在这里解析成绝对路径：ffmpeg 把相对路径按宿主进程 cwd 落盘，
  // 回执必须给出文件的真实位置——真机教训：回显 "x.mp4" 让模型在会话目录
  // 找不到文件，全盘搜索无果后只能重渲一遍。
  const outputPath = resolve(args.outputPath ?? `${deps.outputDir}/${args.specId}.mp4`)
  if (signal.aborted) throw new AnimOpError('渲染已取消')
  // 渲染前对账（0.4.0 规划 N3）：大纲与实际场景对不上时，此刻说比渲完说便宜
  const outline = deps.store.record(args.specId).outline
  const outlineNotes = outline !== undefined && outline.length > 0 ? reconcileOutline(outline, spec.scenes) : []

  if (jobs) {
    // 先带 owner（结果可归属、job_output/job_kill 的访问控制按 owner 走）；
    // owner 没有附加 job controller 时退到无主任务；再不行退同步渲染。
    for (const ownerCandidate of [owner, undefined]) {
      try {
        return await startBackgroundRender(args, { spec, renderer, outputPath, outlineNotes }, emit, jobs, ownerCandidate)
      } catch {
        /* 发布失败，尝试下一档 */
      }
    }
  }
  return await renderSync(args, { spec, renderer, outputPath, outlineNotes }, signal, emit)
}

async function startBackgroundRender(
  args: RenderArgs,
  resolved: { spec: AnimationSpec; renderer: AnimRenderer; outputPath: string; outlineNotes: string[] },
  emit: Emit,
  jobs: AnimJobsService,
  owner: unknown,
): Promise<RenderBackgroundTicket> {
  const { spec, renderer, outputPath, outlineNotes } = resolved
  const specId = args.specId
  const controller = new AbortController()
  const jobIdBox: { value: string | null } = { value: null }
  const gate = createRenderEventGate(emit, jobIdBox)
  const progress = createProgressReporter(specId, jobIdBox, gate.pass)

  const finishedId = (): string => jobIdBox.value ?? 'anim-render'
  const run = (): AnimJobHandle => ({
    cancel: (reason?: unknown) => {
      controller.abort(reason instanceof Error ? reason : new Error(reason ? String(reason) : '渲染任务被终止'))
    },
    done: renderer
      .render(
        { spec, outputPath, scenes: args.scenes, scale: args.scale, onProgress: progress },
        controller.signal,
      )
      .then(
        result => {
          gate.pass(() => ({
            type: 'anim/render-finished',
            data: {
              specId,
              jobId: finishedId(),
              outputPath: result.outputPath,
              frameCount: result.frameCount,
              durationMs: result.durationMs,
              width: result.width,
              height: result.height,
              ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            },
          }))
          return { status: 'completed' as const, output: result }
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (controller.signal.aborted) {
            gate.pass(() => ({
              type: 'anim/render-finished',
              data: { specId, jobId: finishedId(), outputPath, status: 'killed' },
            }))
            return { status: 'killed' as const, detail: message }
          }
          gate.pass(() => ({
            type: 'anim/render-finished',
            data: { specId, jobId: finishedId(), outputPath, status: 'failed', error: message },
          }))
          return { status: 'failed' as const, detail: message }
        },
      ),
  })

  // await 兼容同步/异步两种 start 签名；发布失败向上抛，由 opRender 退回同步
  const jobId = await jobs.start({
    kind: 'anim-render',
    label: `渲染「${spec.meta.title}」(${specId}) → ${outputPath}`,
    // 无主任务按「省略 owner」的形状传，让宿主按缺省处理
    ...(owner === undefined ? {} : { owner }),
    run,
  })
  const id = typeof jobId === 'string' ? jobId : String(jobId ?? 'anim-render')
  jobIdBox.value = id
  emitRenderStart(emit, specId, id, outputPath, args)
  gate.flush()
  return {
    kind: 'background',
    jobId: id,
    specId,
    outputPath,
    next: '渲染已在后台进行。用 job_output 收集进度与结果；需要终止时用 job_kill。',
    ...(outlineNotes.length > 0 ? { outlineNotes } : {}),
  }
}

async function renderSync(
  args: RenderArgs,
  resolved: { spec: AnimationSpec; renderer: AnimRenderer; outputPath: string; outlineNotes: string[] },
  signal: AbortSignal,
  emit: Emit,
): Promise<RenderResultView> {
  const { spec, renderer, outputPath, outlineNotes } = resolved
  const specId = args.specId
  const jobIdBox: { value: string | null } = { value: 'sync' }
  const gate = createRenderEventGate(emit, jobIdBox)
  const progress = createProgressReporter(specId, jobIdBox, gate.pass)
  emitRenderStart(emit, specId, 'sync', outputPath, args)
  try {
    const result = await renderer.render(
      { spec, outputPath, scenes: args.scenes, scale: args.scale, onProgress: progress },
      signal,
    )
    emit({
      type: 'anim/render-finished',
      data: {
        specId,
        jobId: 'sync',
        outputPath: result.outputPath,
        frameCount: result.frameCount,
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
    })
    return {
      ...result,
      kind: 'sync' as const,
      ...(outlineNotes.length > 0 ? { outlineNotes } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit({
      type: 'anim/render-finished',
      data: { specId, jobId: 'sync', outputPath, status: 'failed', error: message },
    })
    throw err
  }
}

/* ------------------------------------------------------------------ 资产导入 */

export const ASSET_KINDS = ['image', 'svg', 'audio', 'font'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

/** 资产类型 → 可接受的扩展名（不含点）。 */
const ASSET_EXT: Record<AssetKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  svg: ['svg'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'aac'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
}

export interface AssetImportArgs {
  specId: string
  assetId: string
  kind: AssetKind
  /** 本地文件路径或 http(s) URL。 */
  src: string
  alt?: string
}

export type AssetImportResult = {
  specId: string
  assetId: string
  kind: AssetKind
  /** 解析后的 src：本地文件复制到 <outputDir>/assets/ 的绝对路径；URL 原样。 */
  src: string
  next: string
}

/**
 * 登记一份资产进 spec.assets。
 *
 * 本地文件会被复制进插件的资产目录（<outputDir>/assets/），渲染时再复制进
 * 渲染项目（见 render-mc 的 copyAssetsToPublic）；http(s) URL 原样登记，
 * 渲染时浏览器直接加载。登记即写 spec（patch + 事件），撤销 / 回放天然可用。
 */
export function opAssetImport(deps: AnimDeps, args: AssetImportArgs, emit: Emit): AssetImportResult {
  if (!deps.store.has(args.specId)) throw new AnimOpError(`spec ${args.specId} 不存在，先调 anim_create_spec`)
  if (!ASSET_KINDS.includes(args.kind)) throw new AnimOpError(`资产类型应为 ${ASSET_KINDS.join(' / ')}，收到 ${String(args.kind)}`)
  if (!/^[A-Za-z0-9._-]+$/.test(args.assetId)) throw new AnimOpError('assetId 只能含字母/数字/._-（会被用作文件名与 URL）')
  if (deps.store.get(args.specId).assets[args.assetId]) {
    throw new AnimOpError(`资产 ${args.assetId} 已存在，覆盖请用 anim_patch 改 /assets/${args.assetId}`)
  }
  const ext = extname(args.src).slice(1).toLowerCase()
  if (!ASSET_EXT[args.kind].includes(ext)) {
    throw new AnimOpError(`资产类型 ${args.kind} 不支持扩展名 .${ext || '(无)'}，可选：${ASSET_EXT[args.kind].join(' / ')}`)
  }

  let resolvedSrc: string
  if (/^https?:\/\//.test(args.src)) {
    resolvedSrc = args.src
  } else {
    const abs = resolve(args.src)
    let stats
    try {
      stats = statSync(abs)
    } catch {
      throw new AnimOpError(`文件不存在：${abs}`)
    }
    if (!stats.isFile()) throw new AnimOpError(`不是文件（应为图片/音频等文件本身）：${abs}`)
    const dir = join(deps.outputDir, 'assets')
    mkdirSync(dir, { recursive: true })
    resolvedSrc = join(dir, `${safeName(args.assetId)}.${ext}`)
    copyFileSync(abs, resolvedSrc)
  }

  const value = { kind: args.kind, src: resolvedSrc, ...(args.alt === undefined ? {} : { alt: args.alt }) }
  const ops: PatchOp[] = [{ op: 'add', path: `/assets/${args.assetId}`, value: value as unknown as JsonValue }]
  const { inverse } = deps.store.patch(args.specId, ops, `导入资产 ${args.assetId}`)
  emit({
    type: 'anim/spec-patched',
    data: {
      specId: args.specId,
      ops,
      inverse,
      note: `导入资产 ${args.assetId}`,
      durationMs: deps.store.durationMs(args.specId),
    },
  })
  return {
    specId: args.specId,
    assetId: args.assetId,
    kind: args.kind,
    src: resolvedSrc,
    next: `资产 ${args.assetId} 已登记（${args.kind}）。在图层 props 里用 src="asset:${args.assetId}" 引用它。`,
  }
}

/* ------------------------------------------------------------------ 自检 */

export async function opDiagnose(
  deps: AnimDeps,
  args: { renderer?: string },
): Promise<{ renderer: string; ok: boolean; issues: string[] }> {
  const renderer = deps.renderers.get(args.renderer)
  const d = await renderer.diagnose()
  return { renderer: d.renderer, ok: d.ok, issues: d.issues }
}
