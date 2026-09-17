/**
 * 卡片共享外壳与信息块（0.4.0 §5.4 自 cards.tsx 纯移动，DOM 零改动）。
 *
 * Card 是所有卡片的统一外壳（「动画」徽标 + 标题行）；Fallback 是没有可用
 * 收据时的兜底；Notes/Warnings/RenderWarnings/IncrementalNotes 是回执信息
 * 的分级呈现；VideoPanel 是成片播放器；ProgressBar 是后台任务进度条。
 */

import type { ReactNode } from 'react'

import { formatMs, isSettled, mediaUrl, num, readArgs, str, type Receipt, type ToolViewProps } from '../protocol.ts'
import { badge, headRow, link, linkRow, muted, progressBarInner, progressBarOuter, preBox, row, titleStyle, videoBox, warnBox, card } from './styles.ts'

export function Card(props: { title: string; children?: ReactNode }): ReactNode {
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
export function Fallback(props: ToolViewProps & { running: string }): ReactNode {
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

export function Warnings(props: { items: string[] }): ReactNode {
  if (props.items.length === 0) return null
  return <div style={warnBox}>{props.items.map((item, i) => <div key={i}>{item}</div>)}</div>
}

/** 中性信息块：自动纠正 / 大纲对账 / 已自动处理的降级——是信息，不是告警。 */
export function Notes(props: { title: string; items: string[] }): ReactNode {
  if (props.items.length === 0) return null
  return (
    <div style={muted}>
      <div>{props.title}</div>
      {props.items.map((item, i) => <div key={i}>{item}</div>)}
    </div>
  )
}

/** 工具边界自动纠正清单：中性色——是「已替你修好」的信息，不是警告。 */
export function Repairs(props: { items: string[] }): ReactNode {
  return <Notes title="已自动纠正：" items={props.items} />
}

/**
 * 渲染期降级警告的两类拆分（0.4.0 N4）：「已忽略/不可动画/未登记」意味着
 * 模型的意图没有进成片，保留黄色权重；「兜底/换算/解析」类是工具已代劳的
 * 信息，降为中性，别稀释真告警的视觉分量。按消息关键词分类是刻意取舍——
 * 结构化警告类别值得等 M1 动 codegen 时再做。
 */
function splitRenderWarnings(items: string[]): { attention: string[]; handled: string[] } {
  const attention: string[] = []
  const handled: string[] = []
  for (const item of items) {
    ;(/已忽略|不可动画|未登记|越界/.test(item) ? attention : handled).push(item)
  }
  return { attention, handled }
}

/** 渲染/预览回执的 warnings 区块：两类拆分后各归各位。 */
export function RenderWarnings(props: { items: string[] }): ReactNode {
  const { attention, handled } = splitRenderWarnings(props.items)
  return (
    <>
      <Notes title="已自动处理：" items={handled} />
      <Warnings items={attention} />
    </>
  )
}

/**
 * 增量渲染命中情况（0.4.0 §3.4）：中性信息——「省了多少」是好事，不是告警。
 * fallback 时也保持中性：回退本身是自动兜底，原因已在 warnings 里给到。
 */
export function IncrementalNotes(props: { receipt: Receipt }): ReactNode {
  const inc = props.receipt.incremental as { scenesTotal?: unknown; scenesReused?: unknown; fallback?: unknown } | undefined
  if (!inc || typeof inc.scenesTotal !== 'number') return null
  const total = inc.scenesTotal
  const reused = typeof inc.scenesReused === 'number' ? inc.scenesReused : 0
  const label =
    inc.fallback === true
      ? `增量流程已回退全量（${total} 幕现渲）`
      : reused === 0
        ? `段缓存已建立：${total} 幕全部现渲，下次未变幕将直接复用`
        : `${reused}/${total} 幕命中段缓存，只重渲了变更幕`
  return <Notes title="渲染提速：" items={[label]} />
}

/** 成片播放器 + 元信息 + 打开方式。 */
export function VideoPanel(props: { path: string; meta: Receipt; openFile?: ToolViewProps['openFile'] }): ReactNode {
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

/** 后台任务进度条（0.4.0 §5.4 自 BackgroundTicket 内联 JSX 提取，DOM 零改动）。 */
export function ProgressBar(props: { percent: number }): ReactNode {
  return (
    <div style={progressBarOuter}>
      <div style={{ ...progressBarInner, width: `${props.percent}%` }} />
    </div>
  )
}
