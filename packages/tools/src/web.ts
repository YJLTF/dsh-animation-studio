/**
 * 工作台的 Web 面：`/dsh-anim` 前缀下的媒体路由与状态 API。
 *
 * 为什么插件要自己占 HTTP 路由：dsh Web 客户端没有视频/图片预览能力，渲染出的
 * MP4 只躺在磁盘上，模型与用户都看不见。宿主的 webServer 服务开放路由注册
 * （client-modules 的 /plugins bundle 路由就是同一机制），插件挂一个前缀即可：
 * - `GET /dsh-anim/media?p=<绝对路径>` —— 把渲染产物（MP4 / 预览帧 PNG）送进
 *   浏览器，面板卡片里的 <video>/<img> 直接引用，与 Web UI 同源、无 CORS、
 *   支持 Range（视频拖动进度条必需）；
 * - `GET /dsh-anim/api/state` —— 工作台状态（specs + 渲染任务），后台渲染
 *   卡片靠它把「已转后台」的 jobId 轮询成进度和成片；
 * - `GET /dsh-anim/api/spec?id=<specId>` —— 整份 spec JSON。
 *
 * 没挂 webServer 的宿主形态（headless CLI）里 ctx.inject(['webServer']) 永远
 * 不触发，这条路整段不存在，零副作用。
 *
 * 实现分两层：`createAnimKernel` 是纯请求内核（不依赖 node:http 的类型，
 * 直接可测）；`mountAnimWebRoutes` 负责等服务、注册路由、把 node 的
 * req/res 适配到内核。
 */

import { createReadStream, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { extname, isAbsolute, relative, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { specDurationMs } from '@dsh-anim/spec'
import type { SpecStore } from '@dsh-anim/store'

import type { AnimEvent } from './events.ts'

/** 工作台路由前缀：与 client 面的 mediaUrl() 必须一致。 */
export const ANIM_ROUTE_PREFIX = '/dsh-anim'

/* ---------------------------------------------------------------- 渲染任务簿 */

/** 一条渲染任务的可展示状态（/api/state 的 renders 项）。 */
export interface RenderStatusView {
  jobId: string
  specId: string
  status: 'running' | 'completed' | 'killed' | 'failed'
  outputPath: string
  percent: number
  done?: number
  total?: number
  startedAt: number
  finishedAt?: number
  frameCount?: number
  durationMs?: number
  width?: number
  height?: number
  error?: string
}

/**
 * 渲染任务的内存簿。事件在流过 sink 的同时灌进这里，/api/state 才能把
 * 「已转后台」的任务讲出进度。只反映本进程见过的任务：宿主重启后簿子
 * 是空的——重启也确实杀掉了所有后台任务，语义刚好一致。
 */
export class RenderTracker {
  readonly #jobs = new Map<string, RenderStatusView>()

  observe(event: AnimEvent): void {
    if (event.type === 'anim/render-start') {
      const d = event.data
      this.#jobs.set(d.jobId, {
        jobId: d.jobId,
        specId: d.specId,
        status: 'running',
        outputPath: d.outputPath,
        percent: 0,
        startedAt: Date.now(),
      })
      return
    }
    if (event.type === 'anim/render-progress') {
      const d = event.data
      const job = this.#jobs.get(d.jobId)
      if (job && job.status === 'running') {
        job.percent = d.percent
        job.done = d.done
        job.total = d.total
      }
      return
    }
    if (event.type === 'anim/render-finished') {
      const d = event.data
      const job = this.#jobs.get(d.jobId)
      if (!job) return
      job.status = d.status ?? 'completed'
      job.finishedAt = Date.now()
      if (d.frameCount !== undefined) job.frameCount = d.frameCount
      if (d.durationMs !== undefined) job.durationMs = d.durationMs
      if (d.width !== undefined) job.width = d.width
      if (d.height !== undefined) job.height = d.height
      if (d.error !== undefined) job.error = d.error
    }
  }

  /** 全部任务，按开始时间升序。 */
  snapshot(): RenderStatusView[] {
    return [...this.#jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }
}

/* ---------------------------------------------------------------- 媒体索引 */

/**
 * outputDir 之外的产物白名单。渲染回执允许自定义绝对路径（model 可以把片子
 * 导出到任何地方），这类路径不在 outputDir 内，媒体路由按「工具回执里出现过
 * 才可服务」精确放行——由 registerAnimTools 在每次工具成功后调用 add()。
 */
export class MediaIndex {
  readonly #paths = new Set<string>()

  add(path: string): void {
    this.#paths.add(normalizePath(path))
  }

  has(path: string): boolean {
    return this.#paths.has(normalizePath(path))
  }
}

/** Windows 路径大小写不敏感，比较前统一小写。 */
function normalizePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/* ---------------------------------------------------------------- 请求内核 */

/** 内核入参：node IncomingMessage 的最小投影。 */
export interface KernelRequest {
  method: string
  url: string
  headers: Record<string, string | undefined>
}

export interface KernelResponse {
  status: number
  headers: Record<string, string>
  /** 小响应体（JSON）。与 stream 互斥。 */
  body?: Uint8Array
  /** 文件流（媒体）。与 body 互斥。 */
  stream?: Readable
}

/** 内核依赖：工作台全部状态与放行规则的数据面。 */
export interface AnimWebState {
  store: SpecStore
  tracker: RenderTracker
  media: MediaIndex
  /** 渲染产物默认根目录：其中的媒体文件天然可服务。 */
  outputDir: string
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function json(status: number, value: unknown): KernelResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  }
}

function isInside(rootResolved: string, targetResolved: string): boolean {
  const rel = relative(rootResolved, targetResolved)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 媒体放行判定。两档：
 * 1. outputDir 内的文件（realpath 比对，`..` 和符号链接逃逸都进不来）；
 * 2. 回执索引精确命中的文件（自定义绝对路径导出的产物）。
 * 外加扩展名白名单——媒体路由绝不变成任意文件读。
 */
function resolveMedia(state: AnimWebState, rawParam: string | null): string | null {
  if (!rawParam || !isAbsolute(rawParam)) return null
  const ext = extname(rawParam).toLowerCase()
  if (!(ext in MEDIA_TYPES)) return null
  let real: string
  try {
    real = realpathSync(rawParam)
  } catch {
    return null
  }
  let outputReal: string
  try {
    outputReal = realpathSync(state.outputDir)
  } catch {
    outputReal = resolve(state.outputDir)
  }
  if (isInside(normalizePath(outputReal), normalizePath(real))) return real
  if (state.media.has(real)) return real
  return null
}

interface ByteRange {
  start: number
  end: number
}

/** 解析 Range: bytes=…；格式坏返回 'invalid'（416），无 Range 返回 undefined。 */
function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | undefined {
  if (!header) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return 'invalid'
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    // bytes=-N：末尾 N 字节
    const suffix = Number(rawEnd)
    if (suffix === 0 || !Number.isInteger(suffix)) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isInteger(start) || start >= size) return 'invalid'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isInteger(end) || end < start) return 'invalid'
  return { start, end }
}

/**
 * 工作台请求内核。返回纯数据响应，方便在冒烟里直接断言，
 * 不用伪造 node 的 req/res 流。
 */
export function createAnimKernel(state: AnimWebState): (req: KernelRequest) => Promise<KernelResponse> {
  return async req => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(405, { error: 'method not allowed' })
    }
    let parsed: URL
    try {
      parsed = new URL(req.url, 'http://anim.local')
    } catch {
      return json(400, { error: 'bad url' })
    }
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    if (pathname === `${ANIM_ROUTE_PREFIX}/api/state`) {
      return json(200, buildState(state))
    }
    if (pathname === `${ANIM_ROUTE_PREFIX}/api/spec`) {
      const id = parsed.searchParams.get('id')
      if (!id || !state.store.has(id)) return json(404, { error: `spec 不存在：${id ?? '(缺 id)'}` })
      return json(200, { specId: id, spec: state.store.get(id), record: { version: state.store.record(id).version } })
    }
    if (pathname === `${ANIM_ROUTE_PREFIX}/media`) {
      return serveMedia(state, req, parsed.searchParams.get('p'))
    }
    return json(404, { error: 'not found' })
  }
}

function buildState(state: AnimWebState): unknown {
  const renders = state.tracker.snapshot()
  return {
    generatedAt: Date.now(),
    outputDir: state.outputDir,
    specs: state.store.list().map(specId => {
      const record = state.store.record(specId)
      return {
        specId,
        version: record.version,
        meta: record.spec.meta,
        durationMs: specDurationMs(record.spec.scenes),
        sceneCount: record.spec.scenes.length,
        scenes: record.spec.scenes.map(s => ({
          id: s.id,
          name: s.name,
          durationMs: s.durationMs,
          layerCount: s.layers.length,
        })),
        revisions: record.history.slice(-20).map(h => ({ note: h.note ?? undefined, opCount: h.ops.length })),
        renders: renders.filter(r => r.specId === specId),
      }
    }),
    renders,
  }
}

function serveMedia(state: AnimWebState, req: KernelRequest, rawParam: string | null): KernelResponse {
  const file = resolveMedia(state, rawParam)
  if (!file) return json(404, { error: '媒体不存在或不在可服务范围内' })
  let stats
  try {
    stats = statSync(file)
  } catch {
    return json(404, { error: '媒体不存在' })
  }
  if (!stats.isFile()) return json(404, { error: '不是文件' })
  const size = stats.size
  const etag = `"${size}-${stats.mtimeMs}"`
  const base: Record<string, string> = {
    'content-type': MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=300',
    etag,
    'x-content-type-options': 'nosniff',
  }
  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch === etag) return { status: 304, headers: base }
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    return {
      status: 416,
      headers: { ...base, 'content-range': `bytes */${size}` },
    }
  }
  if (range) {
    return {
      status: 206,
      headers: {
        ...base,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      },
      stream: createReadStream(file, { start: range.start, end: range.end }),
    }
  }
  return {
    status: 200,
    headers: { ...base, 'content-length': String(size) },
    stream: createReadStream(file),
  }
}

/* ---------------------------------------------------------------- 挂载 */

/** webServer 服务的最小结构面（宿主侧类型不在本包类型面上，与 jobs 同一待遇）。 */
interface AnimWebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * 在宿主 webServer 上挂 `/dsh-anim` 前缀路由。webServer 是可选服务：
 * 用 ctx.inject 等它出现，headless 形态永远等不到、也就永远不注册。
 */
export function mountAnimWebRoutes(ctx: Context, state: AnimWebState): void {
  const kernel = createAnimKernel(state)
  ctx.inject(['webServer'], webCtx => {
    const server = (webCtx as unknown as { webServer: AnimWebServerService }).webServer
    if (typeof server?.register !== 'function') return
    ;(webCtx as unknown as Context).effect(
      () =>
        server.register({
          kind: 'prefix',
          path: ANIM_ROUTE_PREFIX,
          handler: (req, res) => void handleAnimRequest(kernel, req, res),
        }),
      'dsh-anim-studio: /dsh-anim 路由',
    )
  })
}

/** node req/res → 内核的薄适配。 */
export async function handleAnimRequest(
  kernel: ReturnType<typeof createAnimKernel>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawHeaders = req.headers
  const headers: Record<string, string | undefined> = {}
  for (const key of Object.keys(rawHeaders)) {
    const value = rawHeaders[key]
    headers[key] = Array.isArray(value) ? value.join(',') : value
  }
  let response: KernelResponse
  try {
    response = await kernel({ method: req.method ?? 'GET', url: req.url ?? '/', headers })
  } catch (err) {
    response = json(500, { error: err instanceof Error ? err.message : String(err) })
  }
  res.writeHead(response.status, response.headers)
  if (response.stream) {
    const stream = response.stream
    // 客户端断开（视频拖动会频繁发生）要停掉读文件，别把流拖到底
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy()
    })
    stream.pipe(res)
    return
  }
  res.end(response.body)
}
