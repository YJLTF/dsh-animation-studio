/**
 * @dsh-anim/render-mc —— AnimationSpec 的 Motion Canvas 渲染适配器。
 *
 * 分两层，边界很清楚：
 * - `codegen.ts` 只做 spec → 源码字符串，**零渲染依赖**，能在任何环境跑（含 CI、浏览器）。
 * - `adapter.ts` / `runtime.ts` 才需要 vite + puppeteer + ffmpeg，是 host 侧的东西。
 *
 * 这样「改一个关键帧生成了什么代码」这类问题可以纯函数式地测，
 * 不必每次都起一次浏览器。
 */
export * from './codegen.ts'
export * from './contract.ts'
export * from './adapter.ts'
export * from './runtime.ts'
