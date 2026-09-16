/**
 * id → 文件名/URL 安全串的唯一权威实现。
 *
 * 同一条净化规则此前在 codegen（资产 URL）、adapter（资产落盘）、tools
 * （资产复制、sidecar 文件名）各有内联拷贝——两边不一致时资产 404、会话
 * 恢复读不到事件文件（0.3.x 优化清单 O8），所以收敛到这里共享。
 */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}
