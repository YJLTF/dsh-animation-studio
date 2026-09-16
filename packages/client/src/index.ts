/**
 * dsh-animation-studio 的浏览器面（`exports['./client']` → `lib/client.js`）。
 *
 * 职责单一：把 10 个 anim_* 工具的会话卡片注册进 keyed 工具视图插槽
 * （`tool.call.toolview`，dsh-client-ui-tool 声明的开放 key 域——按线上工具名
 * 认领渲染权，自带工具一行不改）。注册方式与官方 read/search toolview 同构：
 *
 *   ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key }, view))
 *
 * 卡片本体在 cards.tsx；数据协议在 protocol.ts。本文件保持「注册表」定位，
 * 不写任何视图逻辑——官方硬规则：client 绝不 import host 实现代码。
 *
 * 产物包装（build.mjs 以 banner/footer 生成）：脚本执行只调
 * `window.__ModuleLoader__.load({ id: 'dsh-animation-studio', factory })` 登记，
 * 工厂闭包里的副作用在模块物化时才跑（lazy CJS 契约）。
 */

import type { ComponentType } from 'react'

import {
  AssetCard,
  CreatedCard,
  DiagnoseCard,
  PatchCard,
  PlanCard,
  PreviewCard,
  ReadCard,
  RenderCard,
  SceneCard,
  UndoCard,
} from './cards.tsx'
import type { ToolViewProps } from './protocol.ts'

export const name = 'dsh-anim-studio-client'

/** slots 由 dsh web shell 提供；没有该服务的环境里本插件不会激活。 */
export const inject = ['slots'] as const

/** slots 服务的最小结构面（对齐 dsh-client-ui-slots 的 inject/register 用法）。 */
interface SlotsService {
  inject(slot: string, register: () => () => void): void
  register(options: { name: string; key: string }, component: ComponentType<never>): () => void
}

/** 工具名 → 卡片。key 域是线上工具名，必须与 host 侧 register.ts 严格一致。 */
const VIEWS: Readonly<Record<string, ComponentType<ToolViewProps>>> = {
  anim_diagnose: DiagnoseCard,
  anim_create_spec: CreatedCard,
  anim_plan: PlanCard,
  anim_draft_scene: SceneCard,
  anim_get: ReadCard,
  anim_patch: PatchCard,
  anim_undo: UndoCard,
  anim_preview: PreviewCard,
  anim_render: RenderCard,
  anim_asset_import: AssetCard,
}

interface ClientContext {
  slots: SlotsService
}

/** 浏览器 cordis 插件契约：宿主 shell 物化本模块后调用。 */
export function apply(ctx: ClientContext): void {
  for (const [key, view] of Object.entries(VIEWS)) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key }, view as ComponentType<never>),
    )
  }
}
