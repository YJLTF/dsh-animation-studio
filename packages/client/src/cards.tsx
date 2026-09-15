/**
 * anim_* 工具的会话内卡片（P0 只读工作台 + P1 视频预览/进度）。
 *
 * 每张卡片是一次工具调用的纯函数视图：props 只有 dsh 递来的调用块，
 * 数据来自 presentationMeta（回执）与参数；不依赖任何运行时状态，
 * 直播流与日志回放两条路径渲染结果一致。
 *
 * 视频预览是本面板存在的核心理由——dsh Web 客户端没有视频预览能力，
 * 渲染产物经 /dsh-anim/media 同源路由进 <video>/<img>。
 */

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'

import {
  fetchRenderStatus,
  formatMs,
  isSettled,
  list,
  mediaUrl,
  num,
  readArgs,
  readReceipt,
  str,
  strings,
  type Receipt,
  type RenderStatus,
  type ToolViewProps,
} from './protocol.ts'

/* ---------------------------------------------------------------- 样式 */

const card: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.4))',
  borderRadius: 12,
  padding: '10px 14px 12px',
  margin: '4px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 720,
  fontSize: 13,
  lineHeight: 1.55,
  overflow: 'hidden',
}

const headRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const badge: CSSProperties = {
  flex: 'none',
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 8px',
  borderRadius: 999,
  background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, 0.18))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}
const titleStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, inherit)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const muted: CSSProperties = { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' }
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px', minWidth: 0 }
const warnBox: CSSProperties = {
  color: 'var(--dsw-alias-state-warning-primary, #b8860b)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
const errorText: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #d33)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
const preBox: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontFamily: 'var(--dsw-font-markdown-code-block-small, ui-monospace, monospace)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflowY: 'auto',
}
const videoBox: CSSProperties = {
  width: '100%',
  maxHeight: 380,
  borderRadius: 8,
  background: '#000',
  display: 'block',
}
const linkRow: CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }
const link: CSSProperties = {
  color: 'var(--dsw-alias-interactive-primary, #4c9aff)',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
}
const progressBarOuter: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,0.2))',
  overflow: 'hidden',
}
const progressBarInner: CSSProperties = {
  height: '100%',
  borderRadius: 3,
  background: 'var(--dsw-alias-interactive-primary, #4c9aff)',
  transition: 'width 0.6s ease',
}
const thumbs: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const figure: CSSProperties = { margin: 0, maxWidth: 220 }
const thumb: CSSProperties = { maxWidth: 220, maxHeight: 130, borderRadius: 6, display: 'block' }
const caption: CSSProperties = { ...muted, fontSize: 11, marginTop: 2 }

/* ---------------------------------------------------------------- 外壳 */

function Card(props: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div style={card} data-anim-card="">
      <div style={headRow}>
        <span style={badge}>动画</span>
        <span style={titleStyle}>{props.title}</span>
      </div>
      {props.children}
    </div>
  )
}

/** 没有可用收据时的兜底：运行态给一行标题，落定态折叠展示原始文本。 */
function Fallback(props: ToolViewProps & { running: string }): ReactNode {
  const { block } = props
  if (!isSettled(block)) {
    const specId = str(readArgs(block), 'specId')
    return <Card title={`${props.running}${specId ? `：${specId}` : ''}`} />
  }
  const text = block.content.find(b => b.type === 'text' && typeof b.text === 'string')?.text ?? ''
  return (
    <Card title={props.running}>
      {text !== '' && (
        <details>
          <summary style={{ ...muted, cursor: 'pointer' }}>展开回执</summary>
          <pre style={preBox}>{text}</pre>
        </details>
      )}
    </Card>
  )
}

function Warnings(props: { items: string[] }): ReactNode {
  if (props.items.length === 0) return null
  return <div style={warnBox}>{props.items.map((item, i) => <div key={i}>{item}</div>)}</div>
}

/* ------------------------------------------------------- 建档 / 大纲 / 场景 */

/** anim_create_spec：片子名片。 */
export function CreatedCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="新建动画" />
  const size = receipt.size as { width?: unknown; height?: unknown } | undefined
  return (
    <Card title={`新建动画：${str(receipt, 'title') ?? str(receipt, 'specId') ?? ''}`}>
      <div style={row}>
        <span>{str(receipt, 'specId')}</span>
        {size && typeof size.width === 'number' && typeof size.height === 'number' && (
          <span style={muted}>
            {size.width}×{size.height}
          </span>
        )}
        {num(receipt, 'fps') !== undefined && <span style={muted}>{num(receipt, 'fps')} fps</span>}
      </div>
    </Card>
  )
}

/** anim_plan：分镜大纲 + 节奏体检。 */
export function PlanCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="规划分镜" />
  const outline = list(receipt, 'outline')
  const totalMs = num(receipt, 'totalMs')
  return (
    <Card title={`分镜大纲：${str(receipt, 'specId') ?? ''}`}>
      {outline.map((item, i) => (
        <div key={i} style={row}>
          <span style={muted}>{i + 1}.</span>
          <span>{str(item, 'name') ?? str(item, 'id') ?? '(未命名)'}</span>
          <span style={muted}>{formatMs(num(item, 'durationMs'))}</span>
          {str(item, 'intent') !== undefined && <span style={muted}>{str(item, 'intent')}</span>}
        </div>
      ))}
      <div style={row}>
        <span style={muted}>
          {outline.length} 幕{totalMs !== undefined ? ` · 全片 ${formatMs(totalMs)}` : ''}
        </span>
      </div>
      <Warnings items={strings(receipt, 'pacing')} />
    </Card>
  )
}

/** anim_draft_scene：一幕入库。 */
export function SceneCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="写入场景" />
  const index = num(receipt, 'index')
  const count = num(receipt, 'sceneCount')
  return (
    <Card title={`写入场景：${str(receipt, 'sceneName') ?? str(receipt, 'sceneId') ?? ''}`}>
      <div style={row}>
        {index !== undefined && count !== undefined && (
          <span style={muted}>
            第 {index + 1}/{count} 幕
          </span>
        )}
        <span style={muted}>{formatMs(num(receipt, 'durationMs'))}</span>
      </div>
      <Warnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}

/* ------------------------------------------------------- 修改历史 */

function PatchRows(props: { receipt: Receipt }): ReactNode {
  const { receipt } = props
  return (
    <div style={row}>
      {num(receipt, 'version') !== undefined && <span style={muted}>v{num(receipt, 'version')}</span>}
      {num(receipt, 'applied') !== undefined && <span style={muted}>{num(receipt, 'applied')} 条变更</span>}
      <span style={muted}>时长 {formatMs(num(receipt, 'durationMs'))}</span>
      {str(receipt, 'note') !== undefined && <span>{str(receipt, 'note')}</span>}
    </div>
  )
}

/** anim_patch：一次结构化修改。 */
export function PatchCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="修改 spec" />
  return (
    <Card title={`修改 ${str(receipt, 'specId') ?? ''}`}>
      <PatchRows receipt={receipt} />
      <Warnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}

/** anim_undo：撤销上一步。 */
export function UndoCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="撤销" />
  return (
    <Card title={`撤销 ${str(receipt, 'specId') ?? ''}`}>
      <PatchRows receipt={receipt} />
    </Card>
  )
}

/** anim_get：读 spec。内容客户端要用时再拉 /dsh-anim/api/spec，卡片只带定位。 */
export function ReadCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="读取 spec" />
  return (
    <Card title={`读取 ${str(receipt, 'specId') ?? ''}`}>
      <div style={row}>
        <span style={muted}>{str(receipt, 'path') ?? '(整份)'}</span>
        <span style={muted}>时长 {formatMs(num(receipt, 'durationMs'))}</span>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------- 预览与渲染（P1 核心） */

/** anim_preview：抽帧缩略图。 */
export function PreviewCard(props: ToolViewProps): ReactNode {
  const { block } = props
  if (!isSettled(block)) {
    const specId = str(readArgs(block), 'specId')
    return <Card title={`抽帧预览中${specId ? `：${specId}` : ''}`} />
  }
  if (block.isError) return <Card title="抽帧预览失败">{block.error?.reason ?? str(readReceipt(block), 'error')}</Card>
  const receipt = readReceipt(block)
  const frames = list(receipt, 'frames').filter(f => typeof f.path === 'string')
  if (!receipt || frames.length === 0) return <Fallback {...props} running="抽帧预览" />
  return (
    <Card title={`预览帧 ×${frames.length}${str(receipt, 'specId') ? `：${str(receipt, 'specId')}` : ''}`}>
      <div style={thumbs}>
        {frames.map((frame, i) => {
          const path = frame.path as string
          return (
            <figure key={i} style={figure} title={path}>
              {/* 路由不可达/文件被清理时隐藏图块，保留时间标注与路径提示 */}
              <img
                style={thumb}
                src={mediaUrl(path)}
                alt={str(frame, 'atMs') !== undefined ? `${formatMs(num(frame, 'atMs'))} 处画面` : '预览帧'}
                loading="lazy"
                onError={event => {
                  ;(event.currentTarget as HTMLImageElement).style.visibility = 'hidden'
                }}
              />
              <figcaption style={caption}>{formatMs(num(frame, 'atMs'))}</figcaption>
            </figure>
          )
        })}
      </div>
    </Card>
  )
}

/** 成片播放器 + 元信息 + 打开方式。 */
function VideoPanel(props: { path: string; meta: Receipt; openFile?: ToolViewProps['openFile'] }): ReactNode {
  const meta = props.meta
  const dims =
    num(meta, 'width') !== undefined && num(meta, 'height') !== undefined
      ? `${num(meta, 'width')}×${num(meta, 'height')}`
      : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* dsh 不支持视频预览——工作台面板是片子的唯一出口 */}
      <video style={videoBox} controls preload="metadata" src={mediaUrl(props.path)} />
      <div style={row}>
        {dims !== undefined && <span style={muted}>{dims}</span>}
        {num(meta, 'frameCount') !== undefined && <span style={muted}>{num(meta, 'frameCount')} 帧</span>}
        {num(meta, 'durationMs') !== undefined && <span style={muted}>时长 {formatMs(num(meta, 'durationMs'))}</span>}
        {str(meta, 'renderer') !== undefined && <span style={muted}>{str(meta, 'renderer')}</span>}
      </div>
      <div style={linkRow}>
        <a style={link} href={mediaUrl(props.path)} target="_blank" rel="noreferrer">
          在新标签打开
        </a>
        <a style={link} href={mediaUrl(props.path)} download>
          下载
        </a>
        {props.openFile && (
          <button style={link} type="button" onClick={() => props.openFile?.(props.path)}>
            定位文件
          </button>
        )}
      </div>
    </div>
  )
}

/** anim_render 的后台票据：轮询 /dsh-anim/api/state 直到出片。 */
function BackgroundTicket(props: { receipt: Receipt; openFile?: ToolViewProps['openFile'] }): ReactNode {
  const jobId = str(props.receipt, 'jobId')
  const outputPath = str(props.receipt, 'outputPath') ?? ''
  const specId = str(props.receipt, 'specId')
  const [status, setStatus] = useState<RenderStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  useEffect(() => {
    if (!jobId) return
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const job = await fetchRenderStatus(jobId)
        if (!alive) return
        setUnreachable(job === null)
        if (job !== null) setStatus(job)
      } catch {
        if (alive) setUnreachable(true)
      }
    }
    void tick()
    const timer = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [jobId])

  const title = `渲染${specId ? `：${specId}` : ''}`
  if (status !== null && status.status === 'completed') {
    return (
      <Card title={`渲染完成${specId ? `：${specId}` : ''}`}>
        <VideoPanel path={status.outputPath || outputPath} meta={status as unknown as Receipt} openFile={props.openFile} />
      </Card>
    )
  }
  if (status !== null && (status.status === 'failed' || status.status === 'killed')) {
    return (
      <Card title={`渲染${status.status === 'failed' ? '失败' : '已终止'}${specId ? `：${specId}` : ''}`}>
        {status.error !== undefined && <div style={errorText}>{status.error}</div>}
        <div style={{ ...muted, wordBreak: 'break-all' }}>{status.outputPath || outputPath}</div>
      </Card>
    )
  }
  return (
    <Card title={title}>
      <div style={progressBarOuter}>
        <div style={{ ...progressBarInner, width: `${status?.percent ?? 0}%` }} />
      </div>
      <div style={row}>
        <span style={muted}>{status?.percent !== undefined ? `${status.percent}%` : '排队/启动中…'}</span>
        <span style={{ ...muted, wordBreak: 'break-all' }}>{outputPath}</span>
      </div>
      {unreachable && (
        <div style={muted}>
          工作台服务不可达（可能由宿主重启）。结果可用 job_output 收集，成片将落在上方路径。
        </div>
      )}
    </Card>
  )
}

/** anim_render：渲染卡片（同步成片直接播，后台任务轮询进度）。 */
export function RenderCard(props: ToolViewProps): ReactNode {
  const { block } = props
  if (!isSettled(block)) {
    const args = readArgs(block)
    const specId = str(args, 'specId')
    return (
      <Card title={`渲染中${specId ? `：${specId}` : ''}`}>
        <div style={{ ...muted }}>浏览器加载编辑器 + 逐帧渲染，长片以分钟计…</div>
      </Card>
    )
  }
  if (block.isError) {
    return (
      <Card title="渲染失败">
        <div style={errorText}>{block.error?.reason ?? '(无原因信息)'}</div>
      </Card>
    )
  }
  const receipt = readReceipt(block)
  if (!receipt) return <Fallback {...props} running="渲染" />
  if (str(receipt, 'kind') === 'background') {
    return <BackgroundTicket receipt={receipt} openFile={props.openFile} />
  }
  const path = str(receipt, 'outputPath')
  if (!path) return <Fallback {...props} running="渲染" />
  return (
    <Card title={`渲染完成${str(receipt, 'specId') ? `：${str(receipt, 'specId')}` : ''}`}>
      <VideoPanel path={path} meta={receipt} openFile={props.openFile} />
    </Card>
  )
}

/** anim_diagnose：环境自检。 */
export function DiagnoseCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="检查渲染环境" />
  const issues = strings(receipt, 'issues')
  const ok = receipt.ok === true
  return (
    <Card title={`渲染环境${ok ? '就绪' : '有问题'}`}>
      <div style={row}>
        <span style={muted}>
          渲染后端 {str(receipt, 'renderer') ?? '—'} · {ok ? '可用' : `${issues.length} 项待修`}
        </span>
      </div>
      {issues.length > 0 && <Warnings items={issues} />}
    </Card>
  )
}

/** anim_asset_import：素材登记。 */
export function AssetCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="导入素材" />
  return (
    <Card title={`导入素材：${str(receipt, 'assetId') ?? ''}`}>
      <div style={row}>
        <span>{str(receipt, 'kind') ?? '—'}</span>
        <span style={muted}>{str(receipt, 'src')}</span>
      </div>
    </Card>
  )
}
