/**
 * 会话事件映射的合并声明。
 *
 * dsh 的持久会话状态靠扩展 `SessionEventMap`：新增事件类型时在这里声明一次，
 * 事件与类型就都对上了（`'anim/spec-created'` 的载荷会被推导成
 * `AnimSpecCreatedData`，写错字段编译期就炸）。
 *
 * 自 dsh 0.1.5-rc.2 起 `@deepseek-ai/dsh-session` 已发布真实类型，这里的
 * `declare module` 是对官方 `SessionEventMap` 的标准模块扩充（interface 自动
 * 合并），合并后的 `anim/*` 键会进入 `SessionEventType`——官方类型里注明该
 * 接口就是为插件合并设计的（merge-extensible）。
 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'anim/spec-created': import('./events.ts').AnimSpecCreatedData
    'anim/outline-updated': import('./events.ts').AnimOutlineData
    'anim/spec-patched': import('./events.ts').AnimSpecPatchedData
    'anim/render-finished': import('./events.ts').AnimRenderFinishedData
  }
}
