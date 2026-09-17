/**
 * anim_* 工具的会话内卡片（P0 只读工作台 + P1 视频预览/进度）。
 *
 * 每张卡片是一次工具调用的纯函数视图：props 只有 dsh 递来的调用块，
 * 数据来自 presentationMeta（回执）与参数；不依赖任何运行时状态，
 * 直播流与日志回放两条路径渲染结果一致。
 *
 * 视频预览是本面板存在的核心理由——dsh Web 客户端没有视频预览能力，
 * 渲染产物经 /dsh-anim/media 同源路由进 <video>/<img>。
 *
 * 0.4.0 §5.4 起本体按卡拆到 ./cards/（styles.ts 样式常量 + primitives.tsx
 * 共享外壳 + 一卡一文件）；本文件只做转发，index.ts 的注册表定位不变。
 */

export { AssetCard } from './cards/asset.tsx'
export { CreatedCard } from './cards/created.tsx'
export { DiagnoseCard } from './cards/diagnose.tsx'
export { PatchCard, UndoCard } from './cards/patch.tsx'
export { PlanCard } from './cards/plan.tsx'
export { PreviewCard } from './cards/preview.tsx'
export { ReadCard } from './cards/read.tsx'
export { RenderCard } from './cards/render.tsx'
export { SceneCard } from './cards/scene.tsx'
