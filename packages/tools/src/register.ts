/**
 * 把 ops 包成 dsh 的 `defineTool` 定义。
 *
 * 这一层只做三件事：声明 schema、把模型给的 JSON 收敛成类型、决定卡片长什么样。
 * 业务逻辑一律在 ops.ts——那边不 import dsh，能被单测。
 *
 * 两条写在 dsh 文档里、但很容易踩的规矩：
 * 1. `output.schema` 的对象必须显式写 `additionalProperties`，不然推导出的返回值
 *    类型是 `never`，你会卡在「为什么我 return 什么都类型错误」。
 * 2. `presentCall` / `presentResult` 必须是纯函数：它们会在直播流和日志回放两种
 *    场合被调用，不能依赖任何运行时状态。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Context, Disposable } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { PatchOp } from '@dsh-anim/spec'
import { safeName } from '@dsh-anim/spec'

import type { AnimEvent } from './events.ts'
import { probe } from './ctx-probe.ts'
import type { AnimDeps, AnimJobsService, AssetKind, Emit } from './ops.ts'
import {
  ASSET_KINDS,
  opAssetImport,
  opCreateSpec,
  opDiagnose,
  opDraftScene,
  opGet,
  opPatch,
  opPlan,
  opPreview,
  opRender,
} from './ops.ts'

/* ------------------------------------------------------------------ 事件槽 */

/**
 * 会话事件写入口。
 *
 * **落盘主路径是插件自有的 sidecar JSONL**（`<sessionsDir>/<sessionId>.jsonl`，
 * 按会话一文件、行即事件）。绝不写宿主会话日志（`session.append`）：dsh 的
 * 读回路径对未知事件类型 fail-closed——除非记录带 `SessionEvent.ignorable: true`
 * 信封，整个会话拒读（「likely written by a newer harness」）；而宿主
 * 0.1.6-alpha.2 的 append API 仍不提供 ignorable 入口，写入 anim/* 事件等于
 * 毒化该会话日志（真机事故：session-0ea61fc8）。等宿主开放
 * ignorable 写入后再评估切回。
 *
 * **会话归因靠 append 的 agent 参数**，不是共享槽位：后台渲染的事件在 job 里
 * 异步产生，若 sink 用「当前 agent」单槽位记录，另一会话的工具调用会覆盖它，
 * 前一个会话的渲染进度从此落错 sidecar（0.3.x 优化清单 O3）。每次工具调用的
 * emit 闭包都绑定当次 agent（见 registerAnimTools 的 emitFor），事件永远落对文件。
 *
 * 拿不到会话 id（冒烟环境）或 sidecar 写失败时按退路降级：
 * 1. cordis 事件总线——仅进程内可见；
 * 2. 日志——最后的可见性兜底。
 *
 * 载荷在边界上做深清理（跳过 undefined 属性值——无损 JSON 校验的拒绝形态），
 * 对所有退路统一生效。其余代码只认这个接口，不认具体实现。
 */
export interface EventSink {
  /** `agent` 是当次工具调用 exec 里的 agent（用于定位会话 sidecar）。 */
  append(event: AnimEvent, agent: unknown): void
}

/**
 * 深清理事件载荷：返回一个不含 undefined 属性值的等价 JSON 值。
 * 只重建普通对象与数组；遇到 undefined 属性即跳过（正是 dsh rc.2 的
 * 无损 JSON 校验所拒绝的形态），其余原样保留。
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = stripUndefined(v)
    }
    return out as unknown as T
  }
  return value
}

/**
 * 探测宿主的 ctx.jobs 服务（结构探测：宿主侧类型不在本包的类型面上）。
 * 没有该服务时渲染类工具自动走同步路径，行为与 0.1.x 一致。
 */
function probeJobs(ctx: Context, jobsBox?: { value?: unknown }): AnimJobsService | undefined {
  // 捕获盒优先：cordis 按 inject 许可属性访问，主插件上下文直接读 ctx.jobs
  // 会因未声明而抛错（吞错后恒 undefined）——真机 jobsOnCtx=false 的根因。
  const candidates = [jobsBox?.value, probe(ctx, 'jobs')]
  for (const jobs of candidates) {
    const j = jobs as { start?: unknown } | undefined
    if (j && typeof j.start === 'function') return j as AnimJobsService
  }
  return undefined
}

/**
 * 事件落盘选项：`sessionsDir` 是插件自有的事件 sidecar 目录
 * （`<outputDir>/sessions/<sessionId>.jsonl`）。
 */
export interface EventSinkOptions {
  sessionsDir?: string
}

export function resolveEventSink(ctx: Context, options: EventSinkOptions = {}): EventSink {
  return {
    append(event, agent) {
      const data = stripUndefined(event.data)
      // 1. 插件自有 sidecar（真机持久化正道）。绝不写宿主会话日志：
      //    dsh 读回路径对未知事件类型 fail-closed（`SessionEvent.ignorable`
      //    才放行），而 `session.append` API 不提供 ignorable 入口——写了
      //    anim/* 事件整个会话就拒读（真机事故：session-0ea61fc8）。
      //    会话 id 来自 append 参数（emit 闭包绑定的当次 agent），不读共享
      //    状态——并发会话的事件才能各落各的文件。
      const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
      if (options.sessionsDir && typeof sessionId === 'string') {
        try {
          // recursive mkdir 对已存在目录是廉价的幂等操作，不值得为它维护
          // 「目录已建」标记位（标记位在写失败后反而会挡住重建）
          mkdirSync(options.sessionsDir, { recursive: true })
          const line = `${JSON.stringify({ type: event.type, time: Date.now(), data })}\n`
          appendFileSync(join(options.sessionsDir, `${safeName(sessionId)}.jsonl`), line, 'utf8')
          return
        } catch {
          /* sidecar 写失败退到总线/日志，工具调用不能被持久化拖垮 */
        }
      }
      // 2/3. 事件总线 → 日志（无 sessionsDir 或拿不到会话 id 时的降级）
      const emit = probe(ctx, 'emit') as ((name: string, payload?: unknown) => void) | undefined
      if (typeof emit === 'function') {
        emit.call(ctx, event.type, data)
        return
      }
      const logger = probe(ctx, 'logger') as { info?(message: string): void } | undefined
      logger?.info?.(`[anim] ${event.type} ${JSON.stringify(data).slice(0, 200)}`)
    },
  }
}

/* ------------------------------------------------------------------ 工具函数 */

/** 文本块的最大长度：整份 spec 塞进上下文既烧 token 又挤掉别的信息。 */
const MAX_TEXT = 4000

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n…（已截断，共 ${text.length} 字符，用更精确的路径再读一次）`
}

const text = (content: string) => [{ type: 'text', text: truncate(content) }] as never

/** 容忍二次编码的 JSON 解析：不是字符串原样返回，解析失败返回 undefined。 */
function jsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

/**
 * 把模型给的 ops 收敛成 PatchOp[]。
 * 不做盲转——bad op 早失败，比让 applyPatch 在第 7 条炸掉更容易让模型纠正。
 */
function coerceOps(input: unknown): PatchOp[] {
  if (!Array.isArray(input)) throw new Error('ops 必须是数组')
  const supported = new Set(['add', 'remove', 'replace', 'move'])
  return input.map((raw, i) => {
    const op = coerceJsonParam(raw, `ops[${i}]`) as Record<string, unknown>
    if (typeof op.op !== 'string' || !supported.has(op.op)) {
      throw new Error(`ops[${i}].op 必须是 add/remove/replace/move 之一，收到 ${String(op.op)}`)
    }
    if (op.op === 'move') {
      if (typeof op.from !== 'string') throw new Error(`ops[${i}].from 必须是字符串路径`)
      if (typeof op.path !== 'string') throw new Error(`ops[${i}].path 必须是字符串路径`)
    } else {
      if (typeof op.path !== 'string') throw new Error(`ops[${i}].path 必须是字符串路径`)
      if (op.op !== 'remove' && !('value' in op)) {
        throw new Error(`ops[${i}] 是 ${op.op}，必须带 value`)
      }
    }
    return op as unknown as PatchOp
  })
}

/**
 * 容忍模型把 json 型参数二次编码成字符串（实测会发生：合法场景对象被序列化
 * 成字符串传来，校验器只报「应为对象」，模型很难自救）。字符串就尝试验证后
 * 解析；其他类型原样返回。
 */
function coerceJsonParam(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} 应是对象（或可解析的 JSON 字符串），解析失败：${value.slice(0, 80)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label} 应是对象，收到 ${typeof parsed}`)
  }
  return parsed
}

/**
 * 宿主服务可见性报告：anim_diagnose 用它把「事件落盘 / 后台渲染在真机上
 * 到底走哪条路」变成可观测事实，而不是让我们对着回执猜。
 */
function hostServiceReport(
  ctx: Context,
  exec: { agent?: unknown },
  sessionsDir: string | undefined,
  jobsBox?: { value?: unknown },
): Record<string, unknown> {
  const read = (obj: unknown, key: string): unknown => {
    try {
      return (obj as Record<string, unknown>)?.[key]
    } catch {
      return undefined
    }
  }
  // jobs 走捕获盒优先（0.5.0 §2.1）：主插件上下文未经 inject 许可读不到它，
  // 捕获子插件拿到后在 box 里；两处都探，谁有用谁
  const jobs = [jobsBox?.value, read(ctx, 'jobs')].find(
    (j): j is { start?: unknown } => typeof (j as { start?: unknown } | undefined)?.start === 'function',
  )
  const session = read(ctx, 'session')
  const sessions = read(ctx, 'sessions')
  const agentSession = read(read(exec, 'agent'), 'session') as { id?: unknown }
  return {
    // 落盘链路：sidecar 需要「目录已配置 + 当次会话 id 可读」两个条件
    sessionsDirConfigured: typeof sessionsDir === 'string',
    agentSessionIdKnown: typeof agentSession?.id === 'string',
    sessionOnCtx: typeof (session as { append?: unknown } | undefined)?.append === 'function',
    sessionsRegistryOnCtx: typeof (sessions as { get?: unknown } | undefined)?.get === 'function',
    // 后台渲染链路：jobsOnCtx 为 false 时渲染一律走同步回退
    jobsOnCtx: jobs !== undefined,
  }
}

/* ------------------------------------------------------------------ 注册 */

export interface RegisterOptions {
  deps: AnimDeps
  sink: EventSink
  /**
   * 事件 sidecar 目录（`<outputDir>/sessions`）。配置后 anim/* 事件按会话
   * 落 JSONL sidecar，绝不写宿主会话日志（见 resolveEventSink 内注释）。
   */
  sessionsDir?: string
  /**
   * 每次工具调用前按当次 agent 做会话懒恢复（见 makeSessionHydrator）。
   * 省略则不做恢复（冒烟等无宿主环境）。
   */
  hydrate?: (agent: unknown) => void
  /** 渲染任务簿：渲染事件流过的同时记账，/dsh-anim/api/state 读它讲进度。 */
  tracker?: { observe(event: AnimEvent): void }
  /** 产物媒体索引：工具回执里出现过的文件路径才可被 /dsh-anim/media 服务。 */
  media?: { add(path: string): void }
  /**
   * jobs 服务捕获盒（0.5.0 §2.1）：宿主有 jobs 时由捕获子插件异步填入。
   * 按引用读——捕获时机可能晚于注册，但一定早于第一次真正的渲染调用。
   */
  jobsBox?: { value?: unknown }
}

/**
 * 回执媒体采集：结果对象里的 outputPath / frames[].path 全部进媒体索引。
 * 放在工具包装层而不是 ops 层——新增一个返回产物的 op 时不用记得登记。
 */
function indexMediaFromResult(media: { add(path: string): void } | undefined, result: unknown): void {
  if (!media || typeof result !== 'object' || result === null) return
  const record = result as Record<string, unknown>
  if (typeof record.outputPath === 'string') media.add(record.outputPath)
  if (Array.isArray(record.frames)) {
    for (const frame of record.frames) {
      const path = (frame as { path?: unknown } | null)?.path
      if (typeof path === 'string') media.add(path)
    }
  }
}

/**
 * 注册全部 `anim_*` 工具，返回一次性注销函数（`ctx.effect` 会自动调用）。
 */
export function registerAnimTools(ctx: Context, options: RegisterOptions): Disposable {
  const { deps, sink, sessionsDir, hydrate } = options
  /**
   * 每次工具调用构造自己的 emit：闭包绑定当次 agent，后台渲染在 job 里
   * 异步发事件时归因也不会被其他会话的工具调用覆盖（优化清单 O3）。
   */
  const emitFor = (exec: { agent?: unknown } | undefined): Emit => {
    const agent = exec?.agent
    return event => {
      sink.append(event, agent)
      options.tracker?.observe(event)
    }
  }
  const disposers: Array<() => void> = []
  /**
   * §5.2 面板最简交互：工具回执统一带上会话 id。卡片按钮把结构化指令发回
   * 「出这张卡片的会话」（session/prompt，见 client 面 promptAgent）；
   * 老宿主形态没有 agent.session 时原样返回，回执不带该字段。
   */
  const stampSession = (result: unknown, exec: { agent?: unknown } | undefined): unknown => {
    const session = (exec?.agent as { session?: { id?: unknown } } | undefined)?.session
    if (typeof session?.id !== 'string' || session.id === '') return result
    if (
      result !== null && typeof result === 'object' && !Array.isArray(result)
      && (result as { sessionId?: unknown }).sessionId === undefined
    ) {
      return { ...(result as Record<string, unknown>), sessionId: session.id }
    }
    return result
  }
  const register = (definition: Parameters<typeof ctx.tools.register>[0]) => {
    // 单一收口：每个工具执行前做会话懒恢复（事件归因由 emitFor 按调用绑定）
    const originalExecute = definition.execute as ((args: never, exec: never) => unknown) | undefined
    if (originalExecute) {
      const wrapped = async (args: never, exec: { agent?: unknown }): Promise<unknown> => {
        hydrate?.(exec?.agent)
        const result = await originalExecute(args, exec as never)
        indexMediaFromResult(options.media, result)
        return stampSession(result, exec)
      }
      ;(definition as { execute: unknown }).execute = wrapped
    }
    disposers.push(ctx.tools.register(definition))
  }

  /* --- anim_diagnose：开工前先自检，别等到渲染失败才说缺 ffmpeg --- */
  register(
    defineTool({
      name: 'anim_diagnose',
      description:
        '检查动画渲染环境（渲染后端、ffmpeg、中文字体）是否就绪。在开始制作动画前先调一次；环境不通过时返回可操作的修复建议。',
      parameters: {
        renderer: { type: 'string', description: '渲染后端名，省略用默认后端' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // 面板卡片读 meta：结构化、不受模型回执截断影响（presentCall 卡片）
        presentationMeta: (_args, value) => value as never,
      },
      presentCall: () => ({ card: 'generic', title: '检查渲染环境', kind: 'read' }),
      async execute(args, exec) {
        const result = await opDiagnose(deps, args)
        return { ...result, host: hostServiceReport(ctx, exec, sessionsDir, options.jobsBox) } as never
      },
    }),
  )

  /* --- anim_create_spec --- */
  register(
    defineTool({
      name: 'anim_create_spec',
      description:
        '新建一份动画 spec（时间线文档）。给定标题与画布参数，返回 specId；之后所有操作都用这个 id。一份 spec = 一支片子。'
        + '坐标系为「中心原点」：后续写图层的 props.x/y 时，原点在画布中心（x 右正、y 下正），不要按 web 的左上角原点。'
        + '旁白字幕：用 anim_patch 往 /narration/cues 写 [{ atMs, text, durationMs? }]（atMs 是全片绝对毫秒，durationMs 缺省按 4 字/秒估算），渲染时自动出底部字幕条（字号随画布自适应、超宽自动折行，一条建议 ≤40 字）；写了字幕的片子，画布底部字幕带是保留区，正文图层的 y 要避开。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec 标识，建议用短横线命名，如 gradient-descent' },
        title: { type: 'string', required: true, description: '片名' },
        fps: { type: 'number', description: '帧率，默认 30' },
        width: { type: 'number', description: '画布宽，默认 1280' },
        height: { type: 'number', description: '画布高，默认 720' },
        background: { type: 'string', description: '背景色，如 #101418' },
        fontFamily: { type: 'string', description: '字体族，中文建议 Noto Sans CJK SC' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        presentationMeta: (_args, value) => value as never,
      },
      presentCall: args => ({ card: 'generic', title: `新建动画：${args.title}`, kind: 'other' }),
      execute: (args, exec) => Promise.resolve(opCreateSpec(deps, args, emitFor(exec)) as never),
    }),
  )

  /* --- anim_plan：大纲由模型写，工具负责落库 + 节奏体检 --- */
  register(
    defineTool({
      name: 'anim_plan',
      description:
        '为一份 spec 记录分镜大纲并做节奏体检。大纲内容（每幕的教学意图、旁白草稿、时长）由你写，工具负责校验与落库；返回的 pacing 会指出太短/太长/缺意图的幕。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        outline: {
          type: 'array',
          required: true,
          description: '分镜大纲，按播放顺序',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', description: '场景 id，英文短横线' },
              name: { type: 'string', description: '场景标题' },
              intent: { type: 'string', description: '这一幕要让学生明白什么' },
              narration: { type: 'string', description: '旁白草稿' },
              durationMs: { type: 'number', description: '建议时长（毫秒）' },
            },
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // 大纲本体在参数里（回执只有体检结果），面板卡片要的是两者合体
        presentationMeta: (args, value) => ({ ...(value as object), outline: args.outline }) as never,
      },
      presentCall: args => ({ card: 'generic', title: `规划分镜：${args.specId}`, kind: 'edit' }),
      execute: (args, exec) => {
        const outline = (args.outline as unknown[]).map((item, i) => {
          const o = coerceJsonParam(item, `outline[${i}]`) as Record<string, unknown>
          return {
            id: String(o.id ?? ''),
            name: String(o.name ?? ''),
            intent: String(o.intent ?? ''),
            // 缺省就别留 undefined 属性值：rc.2 的 session.append 会按无损
            // JSON 校验整条拒绝（EventSink 里还有一层兜底深清理）
            ...(o.narration === undefined ? {} : { narration: String(o.narration) }),
            durationMs: Number(o.durationMs ?? 0),
          }
        })
        return Promise.resolve(opPlan(deps, { specId: args.specId, outline }, emitFor(exec)) as never)
      },
    }),
  )

  /* --- anim_draft_scene：逐幕细化，避免一次吐出整份 JSON --- */
  register(
    defineTool({
      name: 'anim_draft_scene',
      description:
        '把一个场景（图层 + 轨道 + 关键帧）写入 spec。一次只写一幕，可反复调用；写完后用 anim_get 复核、用 anim_preview 看效果。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        scene: {
          type: 'json',
          required: true,
          description:
            '场景对象：{ id, name, durationMs, layers: [{ id, name, type, props: {...}, tracks: [{ id, target: "props.x", keys: [{ atMs, value, ease }] }] }], transition?: { kind, durationMs } }。'
            + '完整最小示例（形状拿不准就整体照抄再改内容）：'
            + '{"id":"intro","name":"开场","durationMs":2000,"layers":[{"id":"title","name":"标题","type":"text","props":{"text":"你好","x":0,"y":0},"tracks":[{"id":"title-fade","target":"props.opacity","keys":[{"atMs":0,"value":0},{"atMs":600,"value":1,"ease":{"kind":"easeOut"}}]}]}]}。'
            + '三条高频错误，写之前先自查：① ease 一律写对象 {"kind":"easeInOut"}，不能直接写 "easeInOut" 字符串；'
            + '② 每个图层必填五字段 id/name/type/props/tracks，一个都不能少（漏 name/tracks 工具会自动补并在回执 repairs 里回报，漏 props/type 则直接报错）；'
            + '③ type 名全小写。'
            + 'type 可选：text | rect | circle | ellipse | image | line | arrow | polygon | star | svg | code | math | group | audio | video。'
            + 'circle/ellipse 用 size（或 width/height，width≠height 即椭圆），radius 会被换算为 size。'
            + 'line/arrow 用 points: [[x,y],...] 定折线，stroke 描边色、lineWidth 描边宽度（SVG 习惯名 strokeWidth 会被自动换算成 lineWidth）、lineDash 虚线样式（如 [8,6]，rect 也支持）；'
            + 'arrow 自动带末端箭头，画线进度用 start/end（0~1）轨道。'
            + 'polygon 用 sides（边数）+ size（正多边形）；star 用 size + sides（角数，默认 5），形状自动生成。'
            + 'text 支持 textAlign（left/center/right）；长段落写 maxWidth + textWrap:true（超宽自动折行；textWrap 值为字符串 "pre" 时只认显式换行）；'
            + '逐字打字机：text 图层的 props.reveal 轨道写 0→1 关键帧，文本按进度逐字浮现（旁白配音的标配）。'
            + 'fill 可以是纯色字符串或渐变对象 {type:"linear", from:[x,y], to:[x,y], stops:[[0,"#色"],[1,"#色"]]}（radial 用 fromRadius/toRadius；坐标是图层本地坐标，中心原点）。'
            + 'svg 用 svg 内嵌 SVG 字符串。image/video 的 src 可写 asset:<assetId> 引用 anim_asset_import 登记的素材（video 资产 kind 为 video，mp4/webm/mov）。'
            + 'code 用 code（代码内容）+ language（typescript/ts/tsx/javascript/js/jsx/python/py/json/html/css，自动语法高亮；`{{片段}}` 可给片段着色，字符串里的 `{{` 需写 `\\{{` 转义）+ fontSize/fill。'
            + '代码演化动画：code 图层的 props.code 轨道写多个字符串关键帧（atMs 递增），帧间自动生成逐词 diff morph——分步讲解代码的首选写法（其他图层的字符串关键帧仍是离散跳变）。'
            + 'math 用 tex 写 LaTeX 公式（如 "x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}"）。'
            + 'group 用 children: [成员图层id...] 组合，变换属性作用于整组，成员自己的动画不受影响。'
            + 'audio 用 src:"asset:<assetId>" 引用音频资产，props 可带 volume（0~1）、loop、atMs（相对本幕开头的偏移毫秒）、stop（"sceneEnd"|"specEnd"，默认 sceneEnd）；'
            + 'audio 不进画面，成片渲染时自动混音（回执 audioTracks 列出；anim_preview 抽帧无音频）。'
            + '全片 BGM 的标准写法：第一幕放 audio 图层，loop:true + stop:"specEnd"。'
            + 'video 用 src:"asset:<assetId>" 引用视频资产，props 可带 time（源内起点秒）、playbackRate、loop、width/height；嵌入实拍片段用。'
            + 'transition 可选 none/fade/slideLeft/slideUp/slideRight/slideDown/zoomIn；'
            + 'scene.exit 同形（fade/slide 系列）在幕尾整体退场，占用本幕最后 exit.durationMs。'
            + '缓动除 linear/easeIn/easeOut/easeInOut/cubicBezier/spring 外还有 bounce（弹跳落定）/elastic（弹性超调）/back（回勾起手）及各自的 In/InOut 变体（如 bounceIn/backInOut），强调类入场优先用 out 形态。'
            + '所有时间都是场景内绝对毫秒。坐标系：props.x/y 的原点在画布中心（x 右正、y 下正），画布左上角是 (-宽/2, -高/2)——不是 web 的左上角原点，居中就是 x=0,y=0；'
            + 'rotation 单位是度、正值顺时针；scale 1 = 原始大小。返回的 warnings 要逐条处理（尤其「疑似左上角原点」与缺尺寸/缺描边兜底），改完再写下一幕。',
        },
        index: { type: 'number', description: '插入位置，省略则追加到末尾' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // inverse 可能包含整幕数据，卡片用不着，不进 meta
        presentationMeta: (args, value) => {
          const v = value as Record<string, unknown>
          const scene = jsonLike(args.scene) as { name?: unknown } | null
          const sceneName = typeof scene?.name === 'string' && scene.name !== '' ? scene.name : undefined
          const { inverse: _inverse, ...rest } = v
          return { ...rest, ...(sceneName ? { sceneName } : {}) } as never
        },
      },
      presentCall: args => ({ card: 'generic', title: `写入场景 → ${args.specId}`, kind: 'edit' }),
      execute: (args, exec) =>
        Promise.resolve(
          opDraftScene(
            deps,
            {
              specId: args.specId,
              scene: coerceJsonParam(args.scene, 'scene') as never,
              index: args.index,
            },
            emitFor(exec),
          ) as never,
        ),
    }),
  )

  /* --- anim_get --- */
  register(
    defineTool({
      name: 'anim_get',
      description:
        '读取 spec 的片段或时间线摘要。整份 spec 通常太长，优先用 JSON Pointer 精确读取，如 /scenes/1/layers/0；' +
        'paths 可一次批量读取多段（单段找不到只在该段报 error，不影响其他段）；' +
        'view:"summary" 返回时间线摘要（各幕起止/图层规模/音频图层/资产引用计数），做节奏复查或删资产前查引用用它；' +
        '省略 path/paths/view 返回整份（会被截断）。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        path: { type: 'string', description: 'JSON Pointer，如 /scenes/0/layers/1/tracks/0' },
        paths: { type: 'array', description: '批量读取：JSON Pointer 数组，一次取多段', items: { type: 'string' } },
        view: { type: 'string', description: 'summary = 返回时间线摘要而非 spec 片段' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // value 本体可能巨大，meta 只带定位信息；内容客户端按需拉 /api/spec
        presentationMeta: (_args, value) =>
          ({
            specId: (value as { specId?: unknown }).specId,
            path: (value as { path?: unknown }).path,
            view: (value as { view?: unknown }).view,
            durationMs: (value as { durationMs?: unknown }).durationMs,
          }) as never,
      },
      presentCall: args => ({
        card: 'generic',
        title: `读取 ${args.specId}${args.view === 'summary' ? '（摘要）' : args.path ?? ''}`,
        kind: 'read',
      }),
      execute: args => Promise.resolve(opGet(deps, args) as never),
    }),
  )

  /* --- anim_patch：唯一的写途径 --- */
  register(
    defineTool({
      name: 'anim_patch',
      description:
        '用结构化补丁修改 spec（add/remove/replace/move，JSON Patch 子集）。这是除 anim_draft_scene 外唯一的写途径：改一个关键帧不该重写整份 JSON。返回的 inverse 可直接作为 ops 再调一次来撤销。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        ops: {
          type: 'array',
          required: true,
          description:
            '补丁数组，如 [{ op: "replace", path: "/scenes/0/layers/1/tracks/0/keys/2/atMs", value: 2400 }]',
          items: { type: 'json' },
        },
        note: { type: 'string', description: '修改说明，会显示在工作台的修改历史里' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // 修改历史卡片：版本、规模、说明。inverse 不进 meta（撤销走 anim_undo）
        presentationMeta: (args, value) => {
          const { inverse: _inverse, ...rest } = value as Record<string, unknown>
          return { ...rest, note: args.note } as never
        },
      },
      presentCall: args => ({ card: 'generic', title: `修改 ${args.specId}（${args.ops.length} 条）`, kind: 'edit' }),
      execute: (args, exec) =>
        Promise.resolve(opPatch(deps, { specId: args.specId, ops: coerceOps(args.ops), note: args.note }, emitFor(exec)) as never),
    }),
  )

  /* --- anim_undo --- */
  register(
    defineTool({
      name: 'anim_undo',
      description: '撤销 spec 的最后一次修改。等价于把上一次 anim_patch 返回的 inverse 再应用一次。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        presentationMeta: (_args, value) => {
          const { inverse: _inverse, ...rest } = value as Record<string, unknown>
          return { ...rest, note: '撤销上一步' } as never
        },
      },
      presentCall: args => ({ card: 'generic', title: `撤销 ${args.specId}`, kind: 'edit' }),
      async execute(args, exec) {
        const inverse = deps.store.undo(args.specId)
        if (!inverse) throw new Error(`spec ${args.specId} 没有可撤销的修改`)
        return await opPatch(deps, { specId: args.specId, ops: inverse, note: '撤销上一步' }, emitFor(exec)) as never
      },
    }),
  )

  /* --- anim_asset_import：素材进 spec.assets，图层用 src="asset:<id>" 引用 --- */
  register(
    defineTool({
      name: 'anim_asset_import',
      description:
        '登记一份素材（图片/svg/音频/字体/视频）进 spec 的 assets，返回 assetId。'
        + '本地文件会被复制进插件资产目录，http URL 原样登记。素材是共享资源：一次导入，多个图层可用。'
        + '五类都已接通渲染：image/svg 在图层 props 里用 src="asset:<assetId>" 引用；'
        + 'font 导入后 text/code 图层的 fontFamily 直接填 assetId 即生效；'
        + 'audio 用 audio 图层的 src="asset:<assetId>" 引用（volume/loop/stop 控制播放）；'
        + 'video 用 video 图层的 src="asset:<assetId>" 引用（time/playbackRate/loop 控制播放）。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        assetId: { type: 'string', required: true, description: '资产标识（字母/数字/._-），如 gradient-icon' },
        kind: { type: 'string', required: true, description: '资产类型：image / svg / audio / font / video' },
        src: { type: 'string', required: true, description: '本地文件路径（任意位置，会被复制）或 http(s) URL' },
        alt: { type: 'string', description: '可读说明' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        presentationMeta: (_args, value) => value as never,
      },
      presentCall: args => ({ card: 'generic', title: `导入素材 ${args.assetId} → ${args.specId}`, kind: 'edit' }),
      execute: (args, exec) => {
        const kind = args.kind as AssetKind
        if (!ASSET_KINDS.includes(kind)) throw new Error(`资产类型应为 ${ASSET_KINDS.join(' / ')}`)
        return Promise.resolve(opAssetImport(deps, { ...args, kind }, emitFor(exec)) as never)
      },
    }),
  )

  /* --- anim_preview --- */
  register(
    defineTool({
      name: 'anim_preview',
      description:
        '渲染若干预览帧（降分辨率）用来检查效果。传入关键时间点（毫秒）抽查，不要整片预览——慢且没必要。'
        + '注意：预览帧无音频（音频只在成片渲染尾步混入），画面效果与成片一致。'
        + '抽帧点全部落在同一幕、且该幕已有渲染段缓存（anim_render 留下的）时自动升级为单幕直放：回执 clip 给出段视频，原画质带音频，零渲染等待。'
        + '宿主支持后台任务时立即返回 jobId，帧清单用 job_output 收集；否则同步等待到出帧。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        atMs: { type: 'array', description: '抽帧时间点（绝对毫秒）', items: { type: 'number' } },
        scale: { type: 'number', description: '降采样倍数：2 = 长宽各一半（默认），4 = 四分之一。只接受 1/2/4；传小于 1 的值会按缩放系数解释（0.25 等价于 4）' },
        renderer: { type: 'string', description: '渲染后端名，省略用默认' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // meta 投影整个回执：kind/jobId 要到卡片，frames 数组是同步回执的主体
        presentationMeta: (_args, value) => value as never,
      },
      presentCall: args => ({ card: 'terminal', title: `anim preview ${args.specId}` }),
      presentResult: (_args, result) => {
        // 纯函数：从回执里区分「已转后台」「单幕直放」「同步出帧」三种回执
        let title = '预览帧就绪'
        try {
          const first = result.content[0] as { text?: string } | undefined
          const parsed = typeof first?.text === 'string' ? (JSON.parse(first.text) as { kind?: string; clip?: unknown }) : undefined
          if (parsed?.kind === 'background') title = '预览已转后台任务'
          else if (parsed?.clip !== undefined) title = '单幕直放（段缓存命中）'
        } catch {
          /* 解析不出就维持默认标题 */
        }
        return { card: 'generic', title, content: result.content }
      },
      async execute(args, exec) {
        const owner = (exec as { agent?: unknown }).agent
        return (await opPreview(deps, args, exec.signal, emitFor(exec), probeJobs(ctx, options.jobsBox), owner)) as never
      },
    }),
  )

  /* --- anim_render --- */
  register(
    defineTool({
      name: 'anim_render',
      description:
        '把 spec 渲染成 MP4。耗时操作：先用 anim_preview 确认效果再调它；可只渲染指定场景抽查。'
        + '长片（≥1 分钟）渲染耗时以分钟计，回执的 expectedFrames 是目标帧数；微调后用 scenes 只渲部分场景抽查能省大量时间。'
        + '段缓存默认开启：没改过的幕直接复用上次渲染结果，只重渲变更幕（回执 incremental 报告命中数）；'
        + '怀疑缓存产物有问题时传 cache:false 强制全量重渲。'
        + 'spec 带 audio 图层时自动混音，回执 audioTracks 列出已混入的音轨。'
        + 'spec 写了 narration.cues 且宿主配置了 TTS 命令时自动配音：cue 在 atMs 处发声、字幕跟随语音时长，'
        + '回执 speechNotes 报告每条语音的实测时长与溢出（溢出时用 anim_patch 挪时间轴，工具不会自动改）；'
        + '未配置 TTS 时旁白只出字幕（设计内形态，anim_diagnose 的 tts 报告可确认）。'
        + '宿主支持后台任务时立即返回 jobId 并开始渲染，进度以渲染事件可见，结果用 job_output 收集、job_kill 可终止；'
        + '否则同步等待到出片为止。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        outputPath: { type: 'string', description: '输出 MP4 路径，省略则用默认目录' },
        scenes: { type: 'array', description: '只渲染这些场景（0 基索引），省略则整片', items: { type: 'number' } },
        scale: { type: 'number', description: '降采样倍数：1 = 原始分辨率（默认），2 = 长宽各一半；小于 1 的值按缩放系数解释' },
        cache: { type: 'boolean', description: '段缓存开关，默认开启；传 false 强制全量渲染（忽略所有已缓存段）' },
        renderer: { type: 'string', description: '渲染后端名，省略用默认' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        // 产物事实存进 meta，回放旧会话时卡片照样能重建
        presentationMeta: (_args, value) => value as never,
      },
      presentCall: args => ({ card: 'terminal', title: `anim render ${args.specId}` }),
      presentResult: (_args, result) => {
        // 纯函数：从已渲染内容里区分「已转后台」与「同步出片」两种回执
        let title = '渲染完成'
        try {
          const first = result.content[0] as { text?: string } | undefined
          const parsed = typeof first?.text === 'string' ? (JSON.parse(first.text) as { kind?: string }) : undefined
          if (parsed?.kind === 'background') title = '渲染已转后台任务'
        } catch {
          /* 解析不出就维持默认标题 */
        }
        return { card: 'generic', title, content: result.content }
      },
      async execute(args, exec) {
        const owner = (exec as { agent?: unknown }).agent
        return (await opRender(deps, args, exec.signal, emitFor(exec), probeJobs(ctx, options.jobsBox), owner)) as never
      },
    }),
  )

  return () => {
    for (const d of disposers.reverse()) d()
  }
}
