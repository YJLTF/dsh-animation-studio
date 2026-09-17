/** anim_diagnose 卡片：环境自检（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { readReceipt, str, strings, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback, Warnings } from './primitives.tsx'
import { muted, row } from './styles.ts'

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
