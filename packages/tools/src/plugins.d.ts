/**
 * 会话事件映射的合并声明。
 *
 * dsh 的持久会话状态靠扩展 `SessionEventMap`：新增事件类型时在这里声明一次，
 * 事件与类型就都对上了（`'anim/spec-created'` 的载荷会被推导成
 * `AnimSpecCreatedData`，写错字段编译期就炸）。
 *
 * 这个文件在仓库里是「待生效」的——`@deepseek-ai/dsh-session` 未发布到 npm，
 * 装不上，所以这里是 ambient 声明。把本包装进真 dsh 仓库后，它与官方的
 * `SessionEventMap` 自动合并；合并前它也不会引起编译错误。
 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'anim/spec-created': import('./events.ts').AnimSpecCreatedData
    'anim/outline-updated': import('./events.ts').AnimOutlineData
    'anim/spec-patched': import('./events.ts').AnimSpecPatchedData
    'anim/render-finished': import('./events.ts').AnimRenderFinishedData
  }
}
