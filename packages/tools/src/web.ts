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

/** 一条渲染/预览任务的可展示状态（/api/state 的 renders 项）。 */
export interface RenderStatusView {
  jobId: string
  specId: string
  status: 'running' | 'completed' | 'killed' | 'failed'
  outputPath: string
  percent: number
  /** 任务类别：缺省 render（旧簿子条目的兼容）；preview 为抽帧预览（§5.3）。 */
  kind?: 'render' | 'preview'
  done?: number
  total?: number
  startedAt: number
  finishedAt?: number
  frameCount?: number
  durationMs?: number
  width?: number
  height?: number
  error?: string
  /** 生成期降级警告（同类已合并），后台渲染的完成卡片由此展示（0.4.0 N4）。 */
  warnings?: string[]
  /** 增量渲染命中情况（0.4.0 规划 §3.4），未走增量时缺省。 */
  incremental?: {
    scenesTotal: number
    scenesReused: number
    fallback?: boolean
  }
  /** 混入成片的音轨（§4.1），无声成片缺省。 */
  audioTracks?: string[]
  /** 全片关键帧拼贴图（0.5.0 规划 §3.3），生成失败缺省。 */
  contactSheet?: string
  /** 旁白音画对账清单（0.5.0 规划 §5.3），纯字幕模式缺省。 */
  speechNotes?: Array<{ index: number; text: string; atMs: number; audioMs: number; overflowMs: number }>
  /** 后台预览的帧清单（§5.3），预览完成卡片由此重建缩略图。 */
  frames?: Array<{ atMs: number; path: string }>
  /** 单幕直放（0.5.0 规划 §3.2）：段缓存命中的预览，卡片回放段视频而非缩略图。 */
  clip?: { path: string; sceneId: string; sceneIndex: number; durationMs: number }
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
      if (d.warnings !== undefined) job.warnings = d.warnings
      if (d.incremental !== undefined) job.incremental = d.incremental
      if (d.audioTracks !== undefined) job.audioTracks = d.audioTracks
      if (d.contactSheet !== undefined) job.contactSheet = d.contactSheet
      if (d.speechNotes !== undefined) job.speechNotes = d.speechNotes
      return
    }
    // 预览任务与渲染同簿（§5.3）：条目小得多，没有进度，完成时带帧清单
    if (event.type === 'anim/preview-start') {
      const d = event.data
      this.#jobs.set(d.jobId, {
        jobId: d.jobId,
        specId: d.specId,
        status: 'running',
        outputPath: '',
        percent: 0,
        kind: 'preview',
        startedAt: Date.now(),
      })
      return
    }
    if (event.type === 'anim/preview-finished') {
      const d = event.data
      const job = this.#jobs.get(d.jobId)
      if (!job) return
      job.status = d.status ?? 'completed'
      job.finishedAt = Date.now()
      if (job.status === 'completed') job.percent = 100
      if (d.frames !== undefined) job.frames = d.frames
      if (d.error !== undefined) job.error = d.error
      if (d.warnings !== undefined) job.warnings = d.warnings
      if (d.clip !== undefined) job.clip = d.clip
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
  /**
   * 宿主 `connection` 服务的捕获盒（0.6.0 N9 鉴权）：按引用读——捕获时机
   * 可能晚于路由注册。服务在则逐请求 requestRejection（Host/Origin fence +
   * 签名 cookie），与宿主 `/api` 前缀同款。
   */
  auth?: { value?: unknown }
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
  // audio 资产（0.5.0 §2.2）：资产卡试听与音频产物的面板回放
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
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
    if (pathname === `${ANIM_ROUTE_PREFIX}/api/job`) {
      // 单任务查询（0.6.0 规划 §6.4）：卡片轮询不再为找一条记录拉全量 state
      const id = parsed.searchParams.get('id')
      const job = id ? state.tracker.snapshot().find(j => j.jobId === id) : undefined
      if (!job) return json(404, { error: `任务不在簿中：${id ?? '(缺 id)'}` })
      return json(200, { job })
    }
    if (pathname === `${ANIM_ROUTE_PREFIX}/api/spec`) {
      const id = parsed.searchParams.get('id')
      if (!id || !state.store.has(id)) return json(404, { error: `spec 不存在：${id ?? '(缺 id)'}` })
      return json(200, { specId: id, spec: state.store.get(id), record: { version: state.store.record(id).version } })
    }
    if (pathname === ANIM_ROUTE_PREFIX || pathname === `${ANIM_ROUTE_PREFIX}/index.html`) {
      // 工作台总览页（0.6.0 规划 §6.1）：specs + 任务簿一屏看清，零宿主插槽
      // 依赖——插件自有路由直接 serve，与卡片同一鉴权（同源 cookie）
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: Buffer.from(WORKBENCH_HTML, 'utf8'),
      }
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
        // 渲染状态（0.6.0 §3.1）：总览页据此展示「已渲染 / 渲染后已修改」
        ...(record.lastRender !== undefined ? { lastRender: record.lastRender } : {}),
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

/* ---------------------------------------------------------------- 总览页 */

/**
 * 工作台总览页（0.6.0 规划 §6.1）：`GET /dsh-anim/` 直接 serve 的单文件页面。
 *
 * 刻意做成自包含 HTML（内联 CSS/JS、零构建产物依赖）：本路由在 tsx 直跑源码、
 * esbuild 打包、离线 tgz 三种形态下行为完全一致，不存在「lib/ 资产没跟上的
 * 部署漂移」。页面只消费 /api/state（3s 轮询）与 /media，鉴权与卡片同款
 * （同源 cookie）。headless 形态整条路由不存在，零副作用。
 */
const WORKBENCH_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>动画工作台 · dsh-anim-studio</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; font: 14px/1.6 var(--dsw-font-body, system-ui, sans-serif);
    background: var(--dsw-alias-bg-canvas, #16181c); color: var(--dsw-alias-label-primary, #e8eaed);
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--dsw-alias-label-tertiary, #9aa0a6); margin: 0 0 20px; font-size: 12px; }
  h2 { font-size: 14px; margin: 24px 0 10px; color: var(--dsw-alias-label-secondary, #c4c7cc); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card {
    border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); border-radius: 10px;
    padding: 12px 14px; background: var(--dsw-alias-bg-input, rgba(127,127,127,.06));
    display: flex; flex-direction: column; gap: 6px; min-width: 0;
  }
  .card .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .scenes { font-size: 12px; color: var(--dsw-alias-label-secondary, #c4c7cc); }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: rgba(127,127,127,.15); }
  .bar span { height: 100%; }
  .bar span:nth-child(4n+1) { background: #4c9aff; } .bar span:nth-child(4n+2) { background: #ffb020; }
  .bar span:nth-child(4n+3) { background: #5dd39e; } .bar span:nth-child(4n+4) { background: #b58cff; }
  .render { font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
  a { color: var(--dsw-alias-interactive-primary, #4c9aff); text-decoration: none; word-break: break-all; }
  .state { border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px; }
  .running { background: rgba(76,154,255,.2); color: #79b2ff; }
  .completed { background: rgba(93,211,158,.18); color: #5dd39e; }
  .failed, .killed { background: rgba(255,122,107,.18); color: #ff7a6b; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
  th { color: var(--dsw-alias-label-tertiary, #9aa0a6); font-weight: 500; font-size: 12px; }
  .empty { color: var(--dsw-alias-label-tertiary, #9aa0a6); padding: 16px 0; }
  .unreachable { color: #ff7a6b; font-size: 12px; }
</style>
</head>
<body>
<h1>动画工作台</h1>
<p class="sub">dsh-anim-studio · 本页展示当前宿主进程内的工作台状态，3 秒自动刷新</p>
<div id="unreachable" class="unreachable" hidden>工作台服务不可达（可能由宿主重启）。</div>
<h2>片子（specs）</h2>
<div id="specs" class="grid"><div class="empty">加载中…</div></div>
<h2>渲染任务簿（本进程）</h2>
<div id="jobs"></div>
<script>
(function () {
  'use strict';
  var media = function (p) { return '/dsh-anim/media?p=' + encodeURIComponent(p); };
  var fmtMs = function (ms) {
    if (ms === undefined || ms === null) return '—';
    return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function renderSpec(spec) {
    var latest = spec.renders && spec.renders.length ? spec.renders[spec.renders.length - 1] : null;
    var lastRender = spec.lastRender;
    var stateText = '未渲染';
    if (latest) {
      if (latest.status === 'running') stateText = '渲染中 ' + (latest.percent || 0) + '%';
      else if (lastRender && lastRender.specVersionAtRender === spec.version) stateText = '已渲染（与当前版本一致）';
      else if (lastRender) stateText = '渲染后已修改（v' + lastRender.specVersionAtRender + ' → v' + spec.version + '）';
      else stateText = latest.status === 'completed' ? '已渲染' : latest.status === 'failed' ? '上次渲染失败' : '上次已终止';
    }
    var html = '<div class="card">';
    html += '<div class="title">' + esc(spec.meta && spec.meta.title || spec.specId) + '</div>';
    html += '<div class="meta"><span>' + esc(spec.specId) + '</span><span>v' + spec.version + '</span>'
      + '<span>' + esc(fmtMs(spec.durationMs)) + '</span><span>' + spec.sceneCount + ' 幕</span></div>';
    if (Array.isArray(spec.scenes) && spec.scenes.length > 0 && spec.durationMs > 0) {
      html += '<div class="bar" title="各幕时长占比">';
      for (var i = 0; i < spec.scenes.length; i++) {
        var s = spec.scenes[i];
        html += '<span style="width:' + Math.max(2, (s.durationMs || 0) / spec.durationMs * 100).toFixed(2) + '%" title="' + esc(s.name || s.id) + ' · ' + esc(fmtMs(s.durationMs)) + '"></span>';
      }
      html += '</div>';
      html += '<div class="scenes">' + spec.scenes.map(function (s) { return esc(s.name || s.id); }).join(' · ') + '</div>';
    }
    html += '<div class="meta"><span>' + esc(stateText) + '</span></div>';
    if (latest && latest.status === 'completed' && latest.outputPath) {
      html += '<div class="render"><a href="' + media(latest.outputPath) + '" target="_blank" rel="noreferrer">▶ 打开成片</a>';
      if (latest.contactSheet) html += '<a href="' + media(latest.contactSheet) + '" target="_blank" rel="noreferrer">拼贴图</a>';
      html += '<span class="meta">' + esc(fmtMs(latest.durationMs)) + '</span></div>';
    }
    html += '<div class="render"><a href="#" data-spec="' + esc(spec.specId) + '" class="view-spec">查看 spec JSON</a>';
    if (spec.revisions && spec.revisions.length) html += '<span class="meta">' + spec.revisions.length + ' 条近期修改</span>';
    html += '</div></div>';
    return html;
  }

  function renderJobs(renders) {
    if (!renders || renders.length === 0) return '<div class="empty">本进程暂无渲染/预览任务（宿主重启后任务簿清空，属设计内行为）。</div>';
    var rows = '';
    for (var i = renders.length - 1; i >= 0; i--) {
      var j = renders[i];
      rows += '<tr><td>' + esc(j.jobId) + '</td><td>' + esc(j.kind === 'preview' ? '抽帧' : '渲染') + '</td>'
        + '<td><span class="state ' + esc(j.status) + '">' + esc(j.status) + (j.status === 'running' ? ' ' + (j.percent || 0) + '%' : '') + '</span></td>'
        + '<td>' + esc(j.specId || '') + '</td>'
        + '<td>' + (j.outputPath ? '<a href="' + media(j.outputPath) + '" target="_blank" rel="noreferrer">' + esc(j.outputPath.split(/[\\\\/]/).pop()) + '</a>' : '—') + '</td>'
        + '<td>' + esc(j.error ? j.error : '') + '</td></tr>';
    }
    return '<table><thead><tr><th>jobId</th><th>类别</th><th>状态</th><th>spec</th><th>产物</th><th>错误</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function paint(data) {
    document.getElementById('unreachable').hidden = true;
    var specs = document.getElementById('specs');
    specs.innerHTML = (!data.specs || data.specs.length === 0)
      ? '<div class="empty">暂无 spec——在会话里让 AI 做一支片子，这里就会出现它的名片。</div>'
      : data.specs.map(renderSpec).join('');
    Array.prototype.forEach.call(specs.querySelectorAll('.view-spec'), function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.open('/dsh-anim/api/spec?id=' + encodeURIComponent(el.getAttribute('data-spec')), '_blank', 'noreferrer');
      });
    });
    document.getElementById('jobs').innerHTML = renderJobs(data.renders);
  }

  var misses = 0;
  function tick() {
    fetch('/dsh-anim/api/state').then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (data) {
      misses = 0;
      paint(data);
    }).catch(function () {
      misses += 1;
      if (misses >= 2) document.getElementById('unreachable').hidden = false;
    });
  }
  tick();
  setInterval(tick, 3000);
})();
</script>
</body>
</html>
`

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
 *
 * 鉴权（0.6.0 真机体检 N9）：`/dsh-anim/*` 此前完全绕开宿主鉴权——宿主只对
 * 自有路由（`/`、`/api/*`）做 token/cookie 校验，插件的媒体/状态路由一直
 * 是裸奔的（渲染产物与会话 spec 可被本机任意进程读取）。修复方式：宿主的
 * `connection` 服务（dsh-client-connection）暴露 `requestRejection(req)`——
 * 与 `/api` 前缀完全同款的 Host/Origin fence + 签名 cookie 校验；捕获盒里有
 * 该服务就逐请求校验，没有（老宿主/结构变更）则退回现状并保持可用。
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
          handler: (req, res) => {
            const auth = state.auth?.value as { requestRejection?: (r: unknown) => number | undefined } | undefined
            const rejection = typeof auth?.requestRejection === 'function' ? auth.requestRejection(req) : undefined
            if (rejection !== undefined && rejection !== 200) {
              res.writeHead(rejection)
              res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            return void handleAnimRequest(kernel, req, res)
          },
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
