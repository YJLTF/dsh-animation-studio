/**
 * anim_render 卡片：渲染成片（0.4.0 §5.4 自 cards.tsx 纯移动）。
 * 同步成片直接播；后台票据轮询 /dsh-anim/api/state 直到出片。
 */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { fetchRenderStatus, isSettled, readArgs, readReceipt, str, strings, type Receipt, type RenderStatus, type ToolViewProps } from '../protocol.ts'
import { Card, ContactSheet, Fallback, IncrementalNotes, Notes, ProgressBar, RenderWarnings, VideoPanel } from './primitives.tsx'
import { errorText, muted, row } from './styles.ts'

/** 旁白配音对账清单（0.5.0 §5.3）→ 中性信息行。 */
function speechNoteLines(notes: Array<{ index?: unknown; text?: unknown; atMs?: unknown; audioMs?: unknown; overflowMs?: unknown }>): string[] {
  return notes.map(n => {
    const at = typeof n.atMs === 'number' ? n.atMs : 0
    const audio = typeof n.audioMs === 'number' ? n.audioMs : 0
    const over = typeof n.overflowMs === 'number' ? n.overflowMs : 0
    const text = typeof n.text === 'string' && n.text.length > 12 ? `${n.text.slice(0, 12)}…` : n.text ?? ''
    return `#${(typeof n.index === 'number' ? n.index : 0) + 1} 「${text}」 @${at}ms 语音 ${audio}ms${over > 300 ? `（超出 ${over}ms，建议挪时间轴）` : ''}`
  })
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
    const id: string = jobId
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined = setInterval(tick, 2000)
    let misses = 0
    // 落定（completed/failed/killed）即停表、连续不可达退避到 10s：渲染完成的
    // 卡片不该在余下的会话里每 2s 打一次状态 API（优化清单 O11）
    async function tick(): Promise<void> {
      try {
        const job = await fetchRenderStatus(id)
        if (!alive) return
        setUnreachable(job === null)
        if (job === null) {
          misses += 1
          if (misses === 3 && timer) {
            clearInterval(timer)
            timer = setInterval(tick, 10_000)
          }
          return
        }
        misses = 0
        setStatus(job)
        if (job.status !== 'running' && timer) {
          clearInterval(timer)
          timer = undefined
        }
      } catch {
        if (!alive) return
        setUnreachable(true)
        misses += 1
        if (misses === 3 && timer) {
          clearInterval(timer)
          timer = setInterval(tick, 10_000)
        }
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [jobId])

  const title = `渲染${specId ? `：${specId}` : ''}`
  if (status !== null && status.status === 'completed') {
    const statusReceipt = status as unknown as Receipt
    const contactSheet = str(statusReceipt, 'contactSheet')
    const notes = statusReceipt.speechNotes as Array<{ index?: unknown; text?: unknown; atMs?: unknown; audioMs?: unknown; overflowMs?: unknown }> | undefined
    return (
      <Card title={`渲染完成${specId ? `：${specId}` : ''}`}>
        <VideoPanel path={status.outputPath || outputPath} meta={statusReceipt} openFile={props.openFile} />
        {contactSheet !== undefined && <ContactSheet path={contactSheet} />}
        <IncrementalNotes receipt={statusReceipt} />
        {notes !== undefined && notes.length > 0 && <Notes title="旁白配音：" items={speechNoteLines(notes)} />}
        <RenderWarnings items={strings(statusReceipt, 'warnings')} />
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
      <ProgressBar percent={status?.percent ?? 0} />
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
  const contactSheet = str(receipt, 'contactSheet')
  const notes = receipt.speechNotes as Array<{ index?: unknown; text?: unknown; atMs?: unknown; audioMs?: unknown; overflowMs?: unknown }> | undefined
  return (
    <Card title={`渲染完成${str(receipt, 'specId') ? `：${str(receipt, 'specId')}` : ''}`}>
      <VideoPanel path={path} meta={receipt} openFile={props.openFile} />
      {contactSheet !== undefined && <ContactSheet path={contactSheet} />}
      <Notes title="大纲对账：" items={strings(receipt, 'outlineNotes')} />
      <IncrementalNotes receipt={receipt} />
      {notes !== undefined && notes.length > 0 && <Notes title="旁白配音：" items={speechNoteLines(notes)} />}
      <RenderWarnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}
