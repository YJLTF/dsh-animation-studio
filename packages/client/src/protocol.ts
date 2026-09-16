/**
 * 客户端面与宿主的数据协议：纯类型 + 纯函数。
 *
 * 官方硬规则：client 绝不 import host 实现代码进浏览器 bundle。所以这里的
 * 类型全部按结构手写（对齐 dsh-client-ui-tool 的 ToolCallOwnerProps 与本插件
 * host 侧 presentationMeta 的形状），运行时依赖只有 react 与同源 fetch。
 *
 * 卡片数据两档来源：
 * 1. `tool/result.meta` —— host 工具用 `output.presentationMeta` 投影的结构化
 *    收据（持久化在会话日志里，回放旧会话照样能重建卡片），首选；
 * 2. content 首个 text 块的 JSON —— meta 缺失（旧版本插件写的日志）时的回退。
 */

/** 工具调用视图的最小结构（dsh ToolCallOwnerProps 的投影）。 */
export interface ToolViewProps {
  callId: string
  toolName: string
  /** 运行中的调用或已落定的结果节点（dsh ToolCallBlock）。 */
  block: ToolCallBlockView
  cwd?: string | undefined
  openFile?: ((path: string, options?: { line?: number }) => void) | undefined
}

/** 运行中：只有调用头。 */
export interface RunningCallView {
  callId: string
  name: string
  argsRaw: string
}

export interface ContentTextView {
  type: string
  text?: string
}

/** 已落定：dsh ToolResultNode 的投影。 */
export interface SettledCallView {
  callId: string
  call: { name: string; argsRaw: string } | null
  content: readonly ContentTextView[]
  isError: boolean
  error?: { name: string; code: string; reason?: string }
  meta?: unknown
}

export type ToolCallBlockView = RunningCallView | SettledCallView

export function isSettled(block: ToolCallBlockView): block is SettledCallView {
  return 'content' in block
}

export type Receipt = Record<string, unknown>

/** 读工具回执：meta 优先，content JSON 兜底；解析不出返回 null。 */
export function readReceipt(block: ToolCallBlockView): Receipt | null {
  if (!isSettled(block)) return null
  const meta = block.meta
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) return meta as Receipt
  const text = block.content.find(b => b.type === 'text' && typeof b.text === 'string')?.text
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Receipt) : null
  } catch {
    return null
  }
}

/** 读调用参数（运行态显示 specId 等定位信息用）。 */
export function readArgs(block: ToolCallBlockView): Receipt | null {
  const raw = (isSettled(block) ? block.call?.argsRaw : block.argsRaw) ?? ''
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Receipt) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 取值 */

export function str(receipt: Receipt | null, key: string): string | undefined {
  const v = receipt?.[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function num(receipt: Receipt | null, key: string): number | undefined {
  const v = receipt?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function list(receipt: Receipt | null, key: string): Receipt[] {
  const v = receipt?.[key]
  if (!Array.isArray(v)) return []
  return v.filter((item): item is Receipt => item !== null && typeof item === 'object')
}

export function strings(receipt: Receipt | null, key: string): string[] {
  const v = receipt?.[key]
  if (!Array.isArray(v)) return []
  return v.filter((item): item is string => typeof item === 'string')
}

/** 毫秒 → 「3.5s」；1 秒内保留毫秒。 */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/* -------------------------------------------------------------- Web 路由 */

/**
 * 渲染产物的同源 URL。与 host 侧 web.ts 的 ANIM_ROUTE_PREFIX 必须一致：
 * dsh Web 客户端没有视频/图片预览能力，工作台面板全靠这条路由把磁盘上的
 * MP4 / 预览帧送进浏览器。
 */
export const mediaUrl = (path: string): string => `/dsh-anim/media?p=${encodeURIComponent(path)}`

/** /dsh-anim/api/state 里的一条渲染任务。 */
export interface RenderStatus {
  jobId: string
  specId: string
  status: 'running' | 'completed' | 'killed' | 'failed'
  outputPath: string
  percent: number
  done?: number
  total?: number
  error?: string
  frameCount?: number
  durationMs?: number
  width?: number
  height?: number
  /** 生成期降级警告（同类已合并），完成卡片由此展示（0.4.0 N4）。 */
  warnings?: string[]
  /** 增量渲染命中情况（0.4.0 规划 §3.4），未走增量时缺省。 */
  incremental?: {
    scenesTotal: number
    scenesReused: number
    fallback?: boolean
  }
  /** 混入成片的音轨（0.4.0 规划 §4.1），无声成片缺省。 */
  audioTracks?: string[]
}

/** 从工作台状态 API 里找一条渲染任务；路由不可达返回 null。 */
export async function fetchRenderStatus(jobId: string, signal?: AbortSignal): Promise<RenderStatus | null> {
  const res = await fetch('/dsh-anim/api/state', { signal })
  if (!res.ok) return null
  const data: unknown = await res.json()
  const renders = (data as { renders?: unknown }).renders
  if (!Array.isArray(renders)) return null
  for (const item of renders) {
    const job = item as RenderStatus
    if (job && typeof job === 'object' && job.jobId === jobId) return job
  }
  return null
}
