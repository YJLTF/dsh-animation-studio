/**
 * anim_render 卡片：渲染成片（0.4.0 §5.4 自 cards.tsx 纯移动）。
 * 同步成片直接播；后台票据轮询 /dsh-anim/api 直到出片。
 *
 * 0.6.0 §6.2：轮询收敛到 useJobPolling；运行中可「终止任务」、失败可「重试
 * 渲染」（面板指令）；拼贴图点帧 → 视频 seek 到对应画面。
 */

import type { ReactNode } from 'react'
import { useRef } from 'react'

import { isSettled, killJobInstruction, num, readArgs, readReceipt, renderSpecInstruction, str, strings, type Receipt, type ToolViewProps } from '../protocol.ts'
import { PanelActions } from './actions.tsx'
import { Card, ContactSheet, Fallback, IncrementalNotes, Notes, ProgressBar, RenderWarnings, VideoPanel } from './primitives.tsx'
import { errorText, muted, row } from './styles.ts'
import { useJobPolling } from './useJobPolling.ts'

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

/** 成片 + 拼贴图联动（0.6.0 §6.2）：点拼贴图的某一格，视频 seek 到对应画面。 */
function RenderDone(props: {
  path: string
  meta: Receipt
  openFile?: ToolViewProps['openFile']
  contactSheet?: string
}): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const durationMs = num(props.meta, 'durationMs')
  const notes = props.meta.speechNotes as Array<{ index?: unknown; text?: unknown; atMs?: unknown; audioMs?: unknown; overflowMs?: unknown }> | undefined
  return (
    <>
      <VideoPanel path={props.path} meta={props.meta} openFile={props.openFile} videoRef={videoRef} />
      {props.contactSheet !== undefined && (
        <ContactSheet
          path={props.contactSheet}
          onSeek={
            durationMs !== undefined && durationMs > 0
              ? fraction => {
                  const video = videoRef.current
                  if (video) video.currentTime = (fraction * durationMs) / 1000
                }
              : undefined
          }
        />
      )}
      <IncrementalNotes receipt={props.meta} />
      {notes !== undefined && notes.length > 0 && <Notes title="旁白配音：" items={speechNoteLines(notes)} />}
      <RenderWarnings items={strings(props.meta, 'warnings')} />
    </>
  )
}

/** anim_render 的后台票据：共享轮询；运行中可终止，失败可重试。 */
function BackgroundTicket(props: { receipt: Receipt; openFile?: ToolViewProps['openFile'] }): ReactNode {
  const jobId = str(props.receipt, 'jobId')
  const outputPath = str(props.receipt, 'outputPath') ?? ''
  const specId = str(props.receipt, 'specId')
  const sessionId = str(props.receipt, 'sessionId')
  const { status, unreachable } = useJobPolling(jobId)

  const title = `渲染${specId ? `：${specId}` : ''}`
  if (status !== null && status.status === 'completed') {
    const statusReceipt = status as unknown as Receipt
    return (
      <Card title={`渲染完成${specId ? `：${specId}` : ''}`}>
        <RenderDone
          path={status.outputPath || outputPath}
          meta={statusReceipt}
          openFile={props.openFile}
          contactSheet={str(statusReceipt, 'contactSheet')}
        />
      </Card>
    )
  }
  if (status !== null && (status.status === 'failed' || status.status === 'killed')) {
    return (
      <Card title={`渲染${status.status === 'failed' ? '失败' : '已终止'}${specId ? `：${specId}` : ''}`}>
        {status.error !== undefined && <div style={errorText}>{status.error}</div>}
        <div style={{ ...muted, wordBreak: 'break-all' }}>{status.outputPath || outputPath}</div>
        {status.status === 'failed' && specId !== undefined && (
          <PanelActions sessionId={sessionId} actions={[{ label: '重试渲染', instruction: renderSpecInstruction(specId) }]} />
        )}
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
      <PanelActions
        sessionId={sessionId}
        actions={jobId !== undefined && specId !== undefined ? [{ label: '终止任务', instruction: killJobInstruction(specId, jobId) }] : []}
      />
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
      <RenderDone
        path={path}
        meta={receipt}
        openFile={props.openFile}
        contactSheet={str(receipt, 'contactSheet')}
      />
      <Notes title="大纲对账：" items={strings(receipt, 'outlineNotes')} />
    </Card>
  )
}
