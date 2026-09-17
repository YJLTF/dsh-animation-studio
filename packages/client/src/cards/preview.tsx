/**
 * anim_preview 卡片：抽帧缩略图（0.4.0 §5.4 自 cards.tsx 纯移动；§5.3 起
 * 同步回执直接展示，后台票据复用 BackgroundTicket 的「落定停表 + 不可达
 * 退避」轮询模式）。
 */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { fetchRenderStatus, formatMs, isSettled, list, mediaUrl, num, readArgs, readReceipt, str, strings, type Receipt, type RenderStatus, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback, RenderWarnings } from './primitives.tsx'
import { caption, figure, thumb, thumbs } from './styles.ts'

/** 帧清单网格：同步回执与后台票据完成态共用一份 DOM。 */
function FrameGrid(props: { frames: Receipt[] }): ReactNode {
  return (
    <div style={thumbs}>
      {props.frames.map((frame, i) => {
        const path = frame.path as string
        return (
          <figure key={i} style={figure} title={path}>
            {/* 路由不可达/文件被清理时隐藏图块，保留时间标注；点图在新标签看原帧 */}
            <a href={mediaUrl(path)} target="_blank" rel="noreferrer">
              <img
                style={thumb}
                src={mediaUrl(path)}
                alt={str(frame, 'atMs') !== undefined ? `${formatMs(num(frame, 'atMs'))} 处画面` : '预览帧'}
                loading="lazy"
                onError={event => {
                  ;(event.currentTarget as HTMLImageElement).style.visibility = 'hidden'
                }}
              />
            </a>
            <figcaption style={caption}>{formatMs(num(frame, 'atMs'))}</figcaption>
          </figure>
        )
      })}
    </div>
  )
}

/** anim_preview 的后台票据：轮询 /dsh-anim/api/state 直到帧清单落定（§5.3）。 */
function PreviewTicket(props: { receipt: Receipt }): ReactNode {
  const jobId = str(props.receipt, 'jobId')
  const specId = str(props.receipt, 'specId')
  const [status, setStatus] = useState<RenderStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  useEffect(() => {
    if (!jobId) return
    const id: string = jobId
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined = setInterval(tick, 2000)
    let misses = 0
    // 与渲染票据同一纪律：落定即停表，连续不可达退避到 10s
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

  if (status !== null && status.status === 'completed') {
    const frames = list(status as unknown as Receipt, 'frames')
    return (
      <Card title={`预览帧 ×${frames.length}${specId ? `：${specId}` : ''}`}>
        {frames.length > 0 ? (
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
  if (str(receipt, 'kind') === 'background') return <PreviewTicket receipt={receipt} />
  const frames = list(receipt, 'frames').filter(f => typeof f.path === 'string')
  if (!receipt || frames.length === 0) return <Fallback {...props} running="抽帧预览" />
  return (
    <Card title={`预览帧 ×${frames.length}${str(receipt, 'specId') ? `：${str(receipt, 'specId')}` : ''}`}>
      <FrameGrid frames={frames} />
      <RenderWarnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}
