/**
 * `dsh-anim-studio` —— 教学动画工作台的 host 插件。
 *
 * 四个导出是 cordis 插件的契约：`name` / `inject` / `Config` / `apply`。
 * 注册全部走 `ctx.effect`，插件卸载（含 HMR）时自动回滚。
 */

import { resolve } from 'node:path'

import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { foldEvents, SpecStore } from '@dsh-anim/store'

import type { AnimDeps } from './ops.ts'
import { registerAnimTools, resolveEventSink } from './register.ts'
import type { AnimRenderer } from './render.ts'
import { AnimRendererRegistry } from './render.ts'

export const name = 'dsh-anim-studio'

/** 只依赖工具注册表；渲染后端由 provider 按需挂进来（见 apply 末尾）。 */
export const inject = ['tools'] as const

export interface Config {
  /** 渲染产物与中间工作目录的根目录。 */
  outputDir: string
}

export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().default('./.dsh/anim').description('渲染产物与中间工作目录的根目录'),
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

/** 读取 ctx 上的服务属性；cordis 代理对未注入服务的访问会抛错，这里统一吞掉。 */
function probe(ctx: Context, key: string): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * 从会话事件流 fold 出工作台状态（spec 内容 + 撤销历史）。
 *
 * dsh 是事件溯源的：`anim/*` 事件落在会话日志里，插件挂载（含宿主重启、会话
 * resume）时把历史读回来 fold 一遍，工具就能继续编辑重启前的 spec。读取走
 * `session.snapshotEvents()`（rc.2 的 Session 读 API），按结构探测——宿主侧
 * 类型不在本包的类型面上，拿不到就跳过（冒烟等无宿主环境照常工作）。
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

/* ------------------------------------------------------------------ 插件 */

export async function apply(ctx: Context, config: Partial<Config> = {}): Promise<void> {
  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR
  const store = new SpecStore()

  // 恢复先于一切注册：模型随后的 anim_get / anim_patch 才能看到重启前的状态
  restoreFromSession(ctx, store)

  const registry = new AnimRendererRegistry()
  const deps: AnimDeps = { store, renderers: registry, outputDir }

  ctx.effect(() => ctx.reflect.provide(REGISTRY_NAME, registry))
  // 异步 effect：cordis 会 await 拿到注销函数；不能把 disposer 直接传给
  // ctx.effect——那会被当成 effect body 立即调用，等于注册完马上注销。
  ctx.effect(() => registerAnimTools(ctx, { deps, sink: resolveEventSink(ctx) }))
  ctx.effect(() => mountMotionCanvas(ctx, outputDir))
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
    // vite.config.ts 由运行时在每次渲染前生成（project 要写绝对路径）。
    const workDir = resolve(outputDir, 'work')

    const renderer = new MotionCanvasRenderer({
      runtime: createDefaultRuntime({ outputDir: 'output' }),
      workDir,
    })
    provideRenderer(ctx, renderer, { isDefault: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      ctx.logger('dsh-anim-studio').warn(`Motion Canvas 渲染后端加载失败，渲染类工具不可用：${message}`)
    } catch {
      console.warn(`[dsh-anim-studio] Motion Canvas 渲染后端加载失败：${message}`)
    }
  }
  // 注册表自身的生命周期由 provide effect 管理，这里无需额外注销
  return () => {}
}

export { foldEvents }
export type { AnimEvent, AnimEventDataMap } from './events.ts'
export type { AnimRenderer, PreviewResult, RenderResult, RenderDiagnostics } from './render.ts'
export { AnimRendererRegistry } from './render.ts'
export { SpecStore, SpecStoreError } from '@dsh-anim/store'
