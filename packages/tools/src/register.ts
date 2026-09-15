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

import type { Context, Disposable } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { JsonValue, PatchOp } from '@dsh-anim/spec'

import type { AnimEvent } from './events.ts'
import type { AnimDeps, AnimJobsService } from './ops.ts'
import {
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
 * dsh 0.1.5-rc.2 的会话 API 是 `session.append(type, data)`，且 append 处会
 * 严格校验 data 的「无损 JSON」合法性：任何一个对象属性值为 undefined
 * （更不用说函数、循环引用）都会让整条事件在 append 现场抛错。而可选字段
 * （如 anim_patch 的 note、大纲条目的 narration）在 TS 语义里天然可能带着
 * undefined 属性值，所以这里在边界上做一次深清理——构建新对象、跳过
 * undefined 属性——对三条退路（session / 事件总线 / 日志）统一生效。
 *
 * 除此之外没有更通用的落盘入口，所以这里仍是一个可替换的桥：优先走
 * session，其次退到 cordis 事件总线，最后退到日志。其余代码只认这个接口，
 * 不认具体实现。
 *
 * 注意：cordis 的 Context 是代理，读取未 inject 的服务属性会直接抛错
 * （而不是返回 undefined），所以所有属性探测都必须裹进 try/catch。
 */
export interface EventSink {
  append(event: AnimEvent): void
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

/** 读取 ctx 上的属性；cordis 代理对未注入服务的访问会抛错，这里统一吞掉。 */
function probe(ctx: Context, key: string): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * 探测宿主的 ctx.jobs 服务（结构探测：宿主侧类型不在本包的类型面上）。
 * 没有该服务时渲染类工具自动走同步路径，行为与 0.1.x 一致。
 */
function probeJobs(ctx: Context): AnimJobsService | undefined {
  const jobs = probe(ctx, 'jobs') as { start?: unknown } | undefined
  return jobs && typeof jobs.start === 'function' ? (jobs as AnimJobsService) : undefined
}

export function resolveEventSink(ctx: Context): EventSink {
  return {
    append(event) {
      const data = stripUndefined(event.data)
      const session = probe(ctx, 'session') as { append?(type: string, data: unknown): void } | undefined
      if (typeof session?.append === 'function') {
        session.append(event.type, data)
        return
      }
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

/* ------------------------------------------------------------------ 注册 */

export interface RegisterOptions {
  deps: AnimDeps
  sink: EventSink
}

/** 注册全部 `anim_*` 工具，返回一次性注销函数（`ctx.effect` 会自动调用）。 */
export function registerAnimTools(ctx: Context, options: RegisterOptions): Disposable {
  const { deps, sink } = options
  const emit = (event: AnimEvent): void => sink.append(event)
  const disposers: Array<() => void> = []
  const register = (definition: Parameters<typeof ctx.tools.register>[0]) => {
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
      },
      presentCall: () => ({ card: 'generic', title: '检查渲染环境', kind: 'read' }),
      async execute(args) {
        return await opDiagnose(deps, args) as never
      },
    }),
  )

  /* --- anim_create_spec --- */
  register(
    defineTool({
      name: 'anim_create_spec',
      description:
        '新建一份动画 spec（时间线文档）。给定标题与画布参数，返回 specId；之后所有操作都用这个 id。一份 spec = 一支片子。'
        + '坐标系为「中心原点」：后续写图层的 props.x/y 时，原点在画布中心（x 右正、y 下正），不要按 web 的左上角原点。',
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
      },
      presentCall: args => ({ card: 'generic', title: `新建动画：${args.title}`, kind: 'other' }),
      execute: args => Promise.resolve(opCreateSpec(deps, args, emit) as never),
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
      },
      presentCall: args => ({ card: 'generic', title: `规划分镜：${args.specId}`, kind: 'edit' }),
      execute: args => {
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
        return Promise.resolve(opPlan(deps, { specId: args.specId, outline }, emit) as never)
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
            '场景对象：{ id, name, durationMs, layers: [{ id, name, type: text|rect|circle|image, props: {...}, tracks: [{ id, target: "props.x", keys: [{ atMs, value, ease }] }] }], transition?: { kind, durationMs } }。'
            + '所有时间都是场景内绝对毫秒。坐标系：props.x/y 的原点在画布中心（x 右正、y 下正），画布左上角是 (-宽/2, -高/2)——不是 web 的左上角原点，居中就是 x=0,y=0；'
            + 'rotation 单位是度、正值顺时针；scale 1 = 原始大小。返回的 warnings 要逐条处理（尤其「疑似左上角原点」），改完再写下一幕。',
        },
        index: { type: 'number', description: '插入位置，省略则追加到末尾' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
      },
      presentCall: args => ({ card: 'generic', title: `写入场景 → ${args.specId}`, kind: 'edit' }),
      execute: args =>
        Promise.resolve(
          opDraftScene(
            deps,
            {
              specId: args.specId,
              scene: coerceJsonParam(args.scene, 'scene') as never,
              index: args.index,
            },
            emit,
          ) as never,
        ),
    }),
  )

  /* --- anim_get --- */
  register(
    defineTool({
      name: 'anim_get',
      description:
        '读取 spec 的片段。整份 spec 通常太长，优先用 JSON Pointer 精确读取，如 /scenes/1/layers/0；省略 path 返回整份（会被截断）。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        path: { type: 'string', description: 'JSON Pointer，如 /scenes/0/layers/1/tracks/0' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
      },
      presentCall: args => ({ card: 'generic', title: `读取 ${args.specId}${args.path ?? ''}`, kind: 'read' }),
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
      },
      presentCall: args => ({ card: 'generic', title: `修改 ${args.specId}（${args.ops.length} 条）`, kind: 'edit' }),
      execute: args =>
        Promise.resolve(opPatch(deps, { specId: args.specId, ops: coerceOps(args.ops), note: args.note }, emit) as never),
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
      },
      presentCall: args => ({ card: 'generic', title: `撤销 ${args.specId}`, kind: 'edit' }),
      async execute(args) {
        const inverse = deps.store.undo(args.specId)
        if (!inverse) throw new Error(`spec ${args.specId} 没有可撤销的修改`)
        return await opPatch(deps, { specId: args.specId, ops: inverse, note: '撤销上一步' }, emit) as never
      },
    }),
  )

  /* --- anim_preview --- */
  register(
    defineTool({
      name: 'anim_preview',
      description:
        '渲染若干预览帧（降分辨率）用来检查效果。传入关键时间点（毫秒）抽查，不要整片预览——慢且没必要。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        atMs: { type: 'array', description: '抽帧时间点（绝对毫秒）', items: { type: 'number' } },
        scale: { type: 'number', description: '降采样倍数：2 = 长宽各一半（默认），4 = 四分之一。只接受 1/2/4；传小于 1 的值会按缩放系数解释（0.25 等价于 4）' },
        renderer: { type: 'string', description: '渲染后端名，省略用默认' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(JSON.stringify(value, null, 2)),
        presentationMeta: (_args, value) => ((value as { frames?: unknown[] }).frames ?? []) as unknown as JsonValue,
      },
      presentCall: args => ({ card: 'terminal', title: `anim preview ${args.specId}` }),
      async execute(args, exec) {
        return (await opPreview(deps, args, exec.signal)) as never
      },
    }),
  )

  /* --- anim_render --- */
  register(
    defineTool({
      name: 'anim_render',
      description:
        '把 spec 渲染成 MP4。耗时操作：先用 anim_preview 确认效果再调它；可只渲染指定场景抽查。'
        + '宿主支持后台任务时立即返回 jobId 并开始渲染，进度以渲染事件可见，结果用 job_output 收集、job_kill 可终止；'
        + '否则同步等待到出片为止。',
      parameters: {
        specId: { type: 'string', required: true, description: 'spec id' },
        outputPath: { type: 'string', description: '输出 MP4 路径，省略则用默认目录' },
        scenes: { type: 'array', description: '只渲染这些场景（0 基索引），省略则整片', items: { type: 'number' } },
        scale: { type: 'number', description: '降采样倍数：1 = 原始分辨率（默认），2 = 长宽各一半；小于 1 的值按缩放系数解释' },
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
        return (await opRender(deps, args, exec.signal, emit, probeJobs(ctx), owner)) as never
      },
    }),
  )

  return () => {
    for (const d of disposers.reverse()) d()
  }
}
