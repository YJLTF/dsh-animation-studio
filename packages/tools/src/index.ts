/**
 * `dsh-anim-studio` —— 教学动画工作台的 host 插件。
 *
 * 四个导出是 cordis 插件的契约：`name` / `inject` / `Config` / `apply`。
 * 注册全部走 `ctx.effect`，插件卸载（含 HMR）时自动回滚。
 */

import { resolve } from 'node:path'

import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { AnimEvent } from './events.ts'
import type { AnimDeps } from './ops.ts'
import { registerAnimTools, resolveEventSink } from './register.ts'
import type { AnimRenderer } from './render.ts'
import { AnimRendererRegistry } from './render.ts'
import { SpecStore, foldEvents } from './store.ts'

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
 * 渲染后端注册表挂在 ctx 上。
 *
 * 正统做法是把注册表声明成一个 cordis Service（`AnimRendererRegistry` 作为
 * 服务定义，provider 插件 `inject: ['animRenderers']`），这需要跑在真 dsh 上验证
 * 服务名与生命周期。这里先用 Symbol 挂载，等阶段 1 在真机上跑通后换成 Service——
 * 换的时候消费者（anim_* 工具）一行都不用改，因为它们只认这个 getter。
 */
const RENDERERS = Symbol.for('dsh-anim.renderers')

export function animRenderers(ctx: Context): AnimRendererRegistry {
  const holder = ctx as unknown as Record<symbol, AnimRendererRegistry | undefined>
  let registry = holder[RENDERERS]
  if (!registry) {
    registry = new AnimRendererRegistry()
    holder[RENDERERS] = registry
  }
  return registry
}

/** 供 provider 插件调用：注册一个渲染后端。 */
export function provideRenderer(ctx: Context, renderer: AnimRenderer, options?: { isDefault?: boolean }): () => void {
  return animRenderers(ctx).register(renderer, options)
}

/* ------------------------------------------------------------------ 插件 */

export async function apply(ctx: Context, config: Partial<Config> = {}): Promise<void> {
  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR
  const store = new SpecStore()

  // 会话恢复：从会话事件流 fold 出 store 的入口（foldEvents）已就绪，
  // dsh 的会话读取 API 在真机上确认后接进来即可。
  const deps: AnimDeps = { store, renderers: animRenderers(ctx), outputDir }

  ctx.effect(() => registerAnimTools(ctx, { deps, sink: resolveEventSink(ctx) }))
  // 异步 effect：cordis 会 await 拿到注销函数；不能把 disposer 直接传给
  // ctx.effect——那会被当成 effect body 立即调用，等于注册完马上注销。
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
    return provideRenderer(ctx, renderer, { isDefault: true })
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
export { SpecStore, SpecStoreError } from './store.ts'