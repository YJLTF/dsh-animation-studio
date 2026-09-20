/**
 * anim_preview 卡片：抽帧缩略图（0.4.0 §5.4 自 cards.tsx 纯移动；§5.3 起
 * 同步回执直接展示，后台票据复用共享轮询 hook）。
 *
 * 0.6.0 §6.2：缩略图点开为卡内灯箱（放大/翻页/Esc 关闭），不再打断会话流跳
 * 新标签；后台票据轮询收敛到 useJobPolling，运行中可点「终止任务」。
 */

import type { ReactNode } from 'react'
import { useState } from 'react'

import { formatMs, isSettled, killJobInstruction, list, mediaUrl, num, readArgs, readReceipt, str, strings, type Receipt, type ToolViewProps } from '../protocol.ts'
import { PanelActions } from './actions.tsx'
import { Card, Fallback, Lightbox, RenderWarnings } from './primitives.tsx'
import { caption, figure, thumb, thumbs, videoBox } from './styles.ts'
import { useJobPolling } from './useJobPolling.ts'

/** 帧清单网格：同步回执与后台票据完成态共用一份 DOM；点图开灯箱。 */
function FrameGrid(props: { frames: Receipt[] }): ReactNode {
  const [open, setOpen] = useState<number | null>(null)
  const items = props.frames.map(frame => ({
    src: mediaUrl(frame.path as string),
    caption: str(frame, 'atMs') !== undefined ? `${formatMs(num(frame, 'atMs'))} 处画面` : '预览帧',
  }))
  return (
    <>
      <div style={thumbs}>
        {props.frames.map((frame, i) => {
          const path = frame.path as string
          return (
            <figure key={i} style={figure} title={path}>
              <img
                style={thumb}
                src={mediaUrl(path)}
                alt={str(frame, 'atMs') !== undefined ? `${formatMs(num(frame, 'atMs'))} 处画面` : '预览帧'}
                loading="lazy"
                onClick={() => setOpen(i)}
                onError={event => {
                  ;(event.currentTarget as HTMLImageElement).style.visibility = 'hidden'
                }}
              />
              <figcaption style={caption}>{formatMs(num(frame, 'atMs'))}</figcaption>
            </figure>
          )
        })}
      </div>
      <Lightbox items={items} index={open} onClose={() => setOpen(null)} onNavigate={setOpen} />
    </>
  )
}

/** 单幕直放（0.5.0 规划 §3.2）：段缓存命中时回放原画质段视频（带音频）。 */
function ClipPanel(props: { clip: Receipt; specId?: string }): ReactNode {
  const path = str(props.clip, 'path') ?? ''
  const sceneIndex = num(props.clip, 'sceneIndex')
  const durationMs = num(props.clip, 'durationMs')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <video style={videoBox} controls preload="metadata" src={mediaUrl(path)} />
      <div style={caption}>
        单幕直放
        {sceneIndex !== undefined ? `：第 ${sceneIndex} 幕` : ''}
        {durationMs !== undefined ? ` · ${formatMs(durationMs)}` : ''}
        {props.specId ? ` · ${props.specId}` : ''}
      </div>
    </div>
  )
}

/** anim_preview 的后台票据：共享轮询 hook，落定渲染结果，运行中可终止。 */
function PreviewTicket(props: { receipt: Receipt }): ReactNode {
  const jobId = str(props.receipt, 'jobId')
  const specId = str(props.receipt, 'specId')
  const sessionId = str(props.receipt, 'sessionId')
  const { status, unreachable } = useJobPolling(jobId)

  if (status !== null && status.status === 'completed') {
    const frames = list(status as unknown as Receipt, 'frames')
    const clipReceipt = (status as unknown as Receipt).clip as Receipt | undefined
    return (
      <Card title={clipReceipt ? `单幕直放${specId ? `：${specId}` : ''}` : `预览帧 ×${frames.length}${specId ? `：${specId}` : ''}`}>
        {clipReceipt ? (
          <ClipPanel clip={clipReceipt} specId={specId} />
        ) : frames.length > 0 ? (
          <FrameGrid frames={frames} />
        ) : (
          <div style={{ ...caption }}>任务已完成但没有帧清单（可能由宿主重启）。可用 job_output 重新收集。</div>
        )}
        <RenderWarnings items={strings(status as unknown as Receipt, 'warnings')} />
      </Card>
    )
  }
  if (status !== null && (status.status === 'failed' || status.status === 'killed')) {
    return (
      <Card title={`抽帧预览${status.status === 'failed' ? '失败' : '已终止'}${specId ? `：${specId}` : ''}`}>
        {status.error !== undefined && <div style={{ ...caption, whiteSpace: 'pre-wrap' }}>{status.error}</div>}
      </Card>
    )
  }
  return (
    <Card title={`抽帧预览中${specId ? `：${specId}` : ''}`}>
      <div style={{ ...caption }}>后台抽帧进行中…</div>
      <PanelActions
        sessionId={sessionId}
        actions={jobId !== undefined && specId !== undefined ? [{ label: '终止任务', instruction: killJobInstruction(specId, jobId) }] : []}
      />
      {unreachable && <div style={caption}>工作台服务不可达（可能由宿主重启）。结果可用 job_output 收集。</div>}
    </Card>
  )
}

export function PreviewCard(props: ToolViewProps): ReactNode {
  const { block } = props
  if (!isSettled(block)) {
    const specId = str(readArgs(block), 'specId')
    return <Card title={`抽帧预览中${specId ? `：${specId}` : ''}`} />
  }
  if (block.isError) return <Card title="抽帧预览失败">{block.error?.reason ?? str(readReceipt(block), 'error')}</Card>
  const receipt = readReceipt(block)
  if (receipt && str(receipt, 'kind') === 'background') return <PreviewTicket receipt={receipt} />
  const clip = receipt?.clip as Receipt | undefined
  if (clip && typeof clip.path === 'string') {
    const specId = str(receipt, 'specId')
    return (
      <Card title={`单幕直放${specId ? `：${specId}` : ''}`}>
        <ClipPanel clip={clip} specId={specId} />
        <RenderWarnings items={strings(receipt, 'warnings')} />
      </Card>
    )
  }
  const frames = list(receipt, 'frames').filter(f => typeof f.path === 'string')
  if (!receipt || frames.length === 0) return <Fallback {...props} running="抽帧预览" />
  return (
    <Card title={`预览帧 ×${frames.length}${str(receipt, 'specId') ? `：${str(receipt, 'specId')}` : ''}`}>
      <FrameGrid frames={frames} />
      <RenderWarnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}
