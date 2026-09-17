/** anim_preview 卡片：抽帧缩略图（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { formatMs, isSettled, list, mediaUrl, num, readArgs, readReceipt, str, strings, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback, RenderWarnings } from './primitives.tsx'
import { caption, figure, thumb, thumbs } from './styles.ts'

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
      <RenderWarnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}
