/**
 * `dsh-anim-studio` —— 教学动画工作台的 host 插件。
 *
 * 四个导出是 cordis 插件的契约：`name` / `inject` / `Config` / `apply`。
 * 注册全部走 `ctx.effect`，插件卸载（含 HMR）时自动回滚。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { foldEvents, SpecStore } from '@dsh-anim/store'
import { safeName } from '@dsh-anim/spec'

import { probe } from './ctx-probe.ts'
import type { AnimDeps } from './ops.ts'
import { registerAnimTools, resolveEventSink } from './register.ts'
import type { AnimRenderer } from './render.ts'
import { AnimRendererRegistry } from './render.ts'
import { createTtsService, type TtsConfig } from './tts.ts'
import { MediaIndex, mountAnimWebRoutes, RenderTracker } from './web.ts'

export const name = 'dsh-anim-studio'

/** 只依赖工具注册表；渲染后端由 provider 按需挂进来（见 apply 末尾）。 */
export const inject = ['tools'] as const

export interface Config {
  /** 渲染产物与中间工作目录的根目录。 */
  outputDir: string
  /** 配音（TTS）配置（0.5.0 规划 §5）：不配置则旁白只出字幕、不发声。 */
  tts?: TtsConfig
}

export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().default('./.dsh/anim').description('渲染产物与中间工作目录的根目录'),
  tts: Schema.object({
    command: Schema.array(String).role('table').description(
      'TTS 命令模板（数组，逐项替换占位符后直接执行，不经 shell）。占位符：{text} {outFile} {voice} {rate} {stdin}。'
      + 'edge-tts 示例：["edge-tts","--voice","{voice}","--rate","{rate}","--text","{text}","--write-media","{outFile}"]。'
      + '注意：TTS 会把旁白文本送进这条命令（可能出网），离线环境请用 piper 等本地引擎',
    ),
    voice: Schema.string().description('默认声音（cue.voice 缺省时用），如 zh-CN-XiaoxiaoNeural'),
    voices: Schema.dict(String).description('声音映射表：cue.voice 名 → 引擎声音标识'),
    rate: Schema.string().description('默认语速占位值（edge-tts 形如 "+0%"，引擎语义各异）'),
    volume: Schema.number().description('旁白音量 0~1，默认 1'),
    timeoutMs: Schema.number().description('单条合成超时（毫秒），默认 120000'),
  }).description('配音配置：留空 = 旁白只出字幕不发声'),
})

const DEFAULT_OUTPUT_DIR = './.dsh/anim'

/* ------------------------------------------------------- 渲染后端注册表 */

/**
 * 渲染后端注册表是正经的 cordis 服务（`ctx.animRenderers`）：
 * - provider 想注册后端可以 `inject: ['animRenderers']` 显式声明依赖；
 * - 注册表随本插件的 fiber 卸载自动注销，HMR / 热插拔不用自己管生命周期。
 *
 * 消费者（anim_* 工具）只认 `animRenderers(ctx)` 这个 getter——从 Symbol 挂载
 * 换成服务时它们一行都没改。
 */
const REGISTRY_NAME = 'animRenderers'

/** 读取渲染注册表；插件未启动（或已卸载）时给出可读报错而不是 cordis 代理异常。 */
export function animRenderers(ctx: Context): AnimRendererRegistry {
  try {
    return ctx.animRenderers
  } catch {
    throw new Error('渲染后端注册表未就绪：dsh-anim-studio 未启动或已卸载')
  }
}

/** 供 provider 插件调用：注册一个渲染后端。 */
export function provideRenderer(ctx: Context, renderer: AnimRenderer, options?: { isDefault?: boolean }): () => void {
  return animRenderers(ctx).register(renderer, options)
}

/* ------------------------------------------------------------------ 会话恢复 */

/**
 * 挂载时从 ctx.session 的会话事件流 fold 出工作台状态（spec 内容 + 撤销历史）。
 *
 * 只对「ctx 上有 session 服务」的宿主形态 / 冒烟环境生效；真机的恢复走
 * makeSessionHydrator 的按会话懒恢复（sidecar 优先，宿主日志里的旧
 * anim/* 事件作回退）。读取走 `session.snapshotEvents()`，按结构探测——
 * 宿主侧类型不在本包的类型面上，拿不到就跳过。
 */
function restoreFromSession(ctx: Context, store: SpecStore): void {
  const session = probe(ctx, 'session') as { snapshotEvents?: () => unknown } | undefined
  const snapshot = session?.snapshotEvents
  if (typeof snapshot !== 'function') return

  let events: unknown
  try {
    events = snapshot.call(session)
  } catch {
    return
  }
  if (!Array.isArray(events)) return

  const animEvents = events
    .filter((e): e is { type: string; data: unknown } => {
      const t = (e as { type?: unknown } | null)?.type
      return typeof t === 'string' && t.startsWith('anim/')
    })
    .map(e => ({ type: e.type, data: e.data }))
  if (animEvents.length === 0) return

  try {
    store.adopt(foldEvents(animEvents))
    try {
      ctx.logger('dsh-anim-studio').info(`会话恢复：从 ${animEvents.length} 条事件 fold 出 ${store.list().length} 份 spec`)
    } catch {
      /* logger 不可用不打扰恢复 */
    }
  } catch (err) {
    // 恢复失败不拖垮插件启动：工具照常注册，只是旧 spec 不可见
    const message = err instanceof Error ? err.message : String(err)
    try {
      ctx.logger('dsh-anim-studio').warn(`会话恢复失败：${message}`)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 按会话懒恢复：工具执行时把该会话的 `anim/*` 事件 fold 进 store（每会话
 * 只做一次）。事件来源两档：
 * 1. **sidecar**（`<sessionsDir>/<sessionId>.jsonl`，主路径）——本插件写入
 *    的事件文件，有则权威；
 * 2. `exec.agent.session.snapshotEvents()`——宿主会话日志里的 `anim/*` 事件。
 *    只对「插件曾以 session.append 落盘」的旧日志（修复脚本补过 ignorable
 *    标记后可加载）生效；新写入不再产生这类事件。
 *
 * 为什么是懒恢复而不是挂载时恢复：宿主是「一个 profile 多个会话」的形态，
 * 插件挂载在根上下文、拿不到任何具体会话；而工具执行上下文天然带着当次
 * agent（`exec.agent.session`）。第一次工具调用把该会话的历史 fold 进来，
 * 之后的变更经事件 sink 增量落盘，两边无缝衔接。
 */
export function makeSessionHydrator(
  store: SpecStore,
  options: { sessionsDir?: string } = {},
): (agent: unknown) => void {
  const hydrated = new Set<string>()
  const fold = (events: Array<{ type: string; data: unknown }>): boolean => {
    const animEvents = events.filter(e => typeof e.type === 'string' && e.type.startsWith('anim/'))
    if (animEvents.length === 0) return false
    store.adopt(foldEvents(animEvents))
    return true
  }
  return agent => {
    const session = (agent as { session?: { id?: unknown; snapshotEvents?: unknown } } | undefined)?.session
    if (!session || typeof session.id !== 'string') return
    if (hydrated.has(session.id)) return
    hydrated.add(session.id)
    try {
      // 1. sidecar 优先：本插件的事件文件，行即事件
      if (options.sessionsDir) {
        const file = resolve(options.sessionsDir, `${safeName(session.id)}.jsonl`)
        if (existsSync(file)) {
          const events = readFileSync(file, 'utf8')
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => JSON.parse(line) as { type: string; data: unknown })
          if (fold(events)) return
          // sidecar 存在但为空/无 anim 事件：继续尝试会话日志（无损）
        }
      }
      // 2. 宿主会话日志（旧日志回退路径）
      if (typeof session.snapshotEvents === 'function') {
        const events = (session.snapshotEvents as () => unknown)() as unknown
        if (Array.isArray(events)) fold(events as Array<{ type: string; data: unknown }>)
      }
    } catch {
      // 恢复失败不拖垮工具调用；store 以当前内存状态为准
    }
  }
}

/* ------------------------------------------------------------------ 插件 */

export async function apply(ctx: Context, config: Partial<Config> = {}): Promise<void> {
  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR
  // anim/* 事件的 sidecar 目录：本插件自有的事件溯源文件，按会话一文件。
  // 放 outputDir 下不新增配置面；绝不写宿主会话日志（会毒化读回，见
  // resolveEventSink 的注释）。
  const sessionsDir = resolve(outputDir, 'sessions')
  const store = new SpecStore()
  // Web 面的内存态：渲染任务簿（/api/state 的进度来源）与产物媒体索引
  // （outputDir 之外的回执产物按「工具出过这个路径」放行）
  const tracker = new RenderTracker()
  const media = new MediaIndex()

  // 恢复先于一切注册。真机上 ctx 没有 session 服务，这条探测不会命中——
  // 真正生效的是 makeSessionHydrator 的按会话懒恢复（工具执行时从
  // exec.agent.session fold）；这条留给提供 ctx.session 的宿主形态与冒烟环境。
  restoreFromSession(ctx, store)

  const registry = new AnimRendererRegistry()
  // 配音服务（0.5.0 §5）：配置了 tts.command 才可用；未配置时旁白只出字幕
  const tts = config.tts?.command && config.tts.command.length > 0 ? createTtsService(config.tts as TtsConfig) : undefined
  const deps: AnimDeps = { store, renderers: registry, outputDir, ...(tts ? { tts } : {}) }
  const hydrate = makeSessionHydrator(store, { sessionsDir })

  ctx.effect(() => ctx.reflect.provide(REGISTRY_NAME, registry))
  // 异步 effect：cordis 会 await 拿到注销函数；不能把 disposer 直接传给
  // ctx.effect——那会被当成 effect body 立即调用，等于注册完马上注销。
  ctx.effect(() =>
    registerAnimTools(ctx, { deps, sink: resolveEventSink(ctx, { sessionsDir }), sessionsDir, hydrate, tracker, media }),
  )
  ctx.effect(() => mountMotionCanvas(ctx, outputDir))
  // /dsh-anim 路由：宿主有 webServer（dsh web）才挂得上，headless 形态整段不存在
  mountAnimWebRoutes(ctx, { store, tracker, media, outputDir })
}

/**
 * 内置挂载 Motion Canvas 渲染后端，让 `anim_render` / `anim_preview` 开箱即用。
 *
 * 渲染依赖（vite / puppeteer-core）加载失败时不拖垮整个插件：工具照常注册，
 * `anim_diagnose` 会把缺什么、去哪装说清楚。想换渲染后端的 provider 只需
 * 调 `provideRenderer(ctx, renderer, { isDefault: true })` 顶掉默认项。
 */
async function mountMotionCanvas(ctx: Context, outputDir: string): Promise<Disposable> {
  try {
    const { MotionCanvasRenderer, createDefaultRuntime } = await import('@dsh-anim/render-mc')

    // 生成物（project.tsx / scenes/）落在 work 下，vite 以 work 为根解析；
    // vite.config.mts 由运行时在每次渲染前生成（project 要写绝对路径）。
    const workDir = resolve(outputDir, 'work')

    const renderer = new MotionCanvasRenderer({
      runtime: createDefaultRuntime({ outputDir: 'output' }),
      workDir,
    })
    provideRenderer(ctx, renderer, { isDefault: true })
    // 插件卸载（含 HMR）时释放常驻浏览器与 vite 实例（0.4.0 规划 §3.2）
    return async () => {
      try {
        await renderer.dispose()
      } catch {
        /* 卸载期的释放失败不拖垮宿主 */
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      ctx.logger('dsh-anim-studio').warn(`Motion Canvas 渲染后端加载失败，渲染类工具不可用：${message}`)
    } catch {
      console.warn(`[dsh-anim-studio] Motion Canvas 渲染后端加载失败：${message}`)
    }
    return () => {}
  }
}

export { foldEvents }
export type { AnimEvent, AnimEventDataMap } from './events.ts'
export type { AnimRenderer, PreviewResult, RenderResult, RenderDiagnostics } from './render.ts'
export { AnimRendererRegistry } from './render.ts'
export { SpecStore, SpecStoreError } from '@dsh-anim/store'
export { createAnimKernel, MediaIndex, RenderTracker } from './web.ts'
export type { KernelRequest, KernelResponse, RenderStatusView } from './web.ts'
