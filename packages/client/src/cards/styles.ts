/**
 * 卡片样式常量（0.4.0 §5.4 自 cards.tsx 纯移动，值零改动）。
 *
 * 颜色全部走 dsh web 的 --dsw-alias-* 变量并带兜底值，面板与主题联动。
 */

import type { CSSProperties } from 'react'

export const card: CSSProperties = {
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

export const headRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
export const badge: CSSProperties = {
  flex: 'none',
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 8px',
  borderRadius: 999,
  background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, 0.18))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}
export const titleStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, inherit)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
export const muted: CSSProperties = { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' }
export const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px', minWidth: 0 }
export const warnBox: CSSProperties = {
  color: 'var(--dsw-alias-state-warning-primary, #b8860b)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
export const errorText: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #d33)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
export const preBox: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontFamily: 'var(--dsw-font-markdown-code-block-small, ui-monospace, monospace)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflowY: 'auto',
}
export const videoBox: CSSProperties = {
  width: '100%',
  maxHeight: 380,
  borderRadius: 8,
  background: '#000',
  display: 'block',
}
export const linkRow: CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }
export const link: CSSProperties = {
  color: 'var(--dsw-alias-interactive-primary, #4c9aff)',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
}
export const progressBarOuter: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,0.2))',
  overflow: 'hidden',
}
export const progressBarInner: CSSProperties = {
  height: '100%',
  borderRadius: 3,
  background: 'var(--dsw-alias-interactive-primary, #4c9aff)',
  transition: 'width 0.6s ease',
}
export const thumbs: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
export const figure: CSSProperties = { margin: 0, maxWidth: 220 }
export const thumb: CSSProperties = { maxWidth: 220, maxHeight: 130, borderRadius: 6, display: 'block' }
export const caption: CSSProperties = { ...muted, fontSize: 11, marginTop: 2 }
