/**
 * 图层属性别名的唯一权威表：别名（模型按 SVG / CSS 习惯写的名字）→ IR 规范名。
 *
 * 同一批错形此前在两处各有一份手工实现且覆盖面互不一致——codegen 在渲染期
 * 静默改写 strokeWidth/color，coerceScene 只在写库边界纠正 strokeWidth——
 * 0.4.0 规划 N2 收敛为一张表：codegen（静态属性 + 轨道目标）与 coerceScene
 * （写库边界）都从这里读，新增别名只改这一处，冒烟有断言盯着三处消费。
 *
 * 统一语义：**规范名已显式给出时别名不覆盖**（规范名优先），冗余别名按
 * 「不支持」告警忽略——归一化绝不静默丢值。
 */
export const PROP_ALIASES: Readonly<Record<string, string>> = {
  strokeWidth: 'lineWidth',
  color: 'fill',
}
