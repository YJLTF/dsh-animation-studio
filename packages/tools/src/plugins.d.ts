/**
 * 会话事件映射与服务面的合并声明。
 *
 * 注意：本文件**必须是 module**（顶部的类型副作用导入就是为此）。
 * 无导入的全局脚本里 `declare module 'x'` 是 ambient 声明，会遮蔽真实模块——
 * 实测一次就把 @deepseek-ai/cordis 的全部导出从编译期抹掉了；作为 module 的
 * `declare module` 才是标准扩充（interface 自动合并）。
 *
 * dsh 的持久会话状态靠扩展 `SessionEventMap`：新增事件类型时在这里声明一次，
 * 事件与类型就都对上了（`'anim/spec-created'` 的载荷会被推导成
 * `AnimSpecCreatedData`，写错字段编译期就炸）。自 dsh 0.1.5-rc.2 起
 * `@deepseek-ai/dsh-session` 已发布真实类型，`SessionEventMap` 即为官方注明的
 * merge-extensible 接口。
 */
import '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'anim/spec-created': import('./events.ts').AnimSpecCreatedData
    'anim/outline-updated': import('./events.ts').AnimOutlineData
    'anim/spec-patched': import('./events.ts').AnimSpecPatchedData
    'anim/render-start': import('./events.ts').AnimRenderStartData
    'anim/render-progress': import('./events.ts').AnimRenderProgressData
    'anim/render-finished': import('./events.ts').AnimRenderFinishedData
    'anim/preview-start': import('./events.ts').AnimPreviewStartData
    'anim/preview-finished': import('./events.ts').AnimPreviewFinishedData
  }
}

/**
 * 本插件提供的 cordis 服务。渲染后端注册表以 `animRenderers` 为名 provide 在
 * ctx 上：渲染 Provider 插件声明 `inject: ['animRenderers']` 即可拿到它，
 * 插件卸载时随 fiber 自动注销。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    animRenderers: import('./render.ts').AnimRendererRegistry
  }
}
