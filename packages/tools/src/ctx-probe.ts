/**
 * cordis Context 的安全属性读取。
 *
 * cordis 的 Context 是代理，读取未 inject 的服务属性会直接抛错（而不是返回
 * undefined）。宿主侧类型不在本包类型面上的服务（session / jobs / emit /
 * logger…）全靠结构探测，探测就必须吞错——此前 index.ts 与 register.ts
 * 各有一份一模一样的实现（优化清单 O8），收敛到这里。
 */
import type { Context } from '@deepseek-ai/cordis'

export function probe(ctx: Context, key: string): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}
