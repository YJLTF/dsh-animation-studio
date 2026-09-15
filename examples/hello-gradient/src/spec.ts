import type { AnimationSpec } from '@dsh-anim/spec'

/**
 * 样例：一部 8 秒的《梯度下降》教学动画。
 *
 * 这个文件是「脚本生成」阶段的产物形态——agent 产出的就是这样的 IR，
 * 而不是 Motion Canvas 代码。改这里 → 重新 generate → 重新 build 即可。
 */
export const spec: AnimationSpec = {
  version: 1,
  meta: {
    id: 'gradient-descent-intro',
    title: '梯度下降：直觉理解',
    fps: 30,
    size: { width: 1280, height: 720 },
    background: '#101418',
    locale: 'zh-CN',
  },
  theme: {
    colors: {
      background: '#101418',
      text: '#F2F5F7',
      muted: '#8B97A3',
      primary: '#4C9AFF',
      accent: '#FFB020',
    },
    font: { family: 'Noto Sans CJK SC', size: 48 },
  },
  assets: {},

  scenes: [
    {
      id: 'title',
      name: '概念引入：一句话讲清梯度下降',
      durationMs: 2500,
      layers: [
        {
          id: 'title-main',
          name: '主标题',
          type: 'text',
          props: { text: '梯度下降', fontSize: 104, fill: '#F2F5F7', fontWeight: 700, x: 0, y: -60 },
          tracks: [
            {
              id: 'title-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 0, value: 0 },
                { atMs: 700, value: 1, ease: { kind: 'easeOut' } },
                { atMs: 2100, value: 1 },
                { atMs: 2500, value: 0, ease: { kind: 'easeIn' } },
              ],
            },
            {
              id: 'title-rise',
              target: 'props.y',
              keys: [
                { atMs: 0, value: -20 },
                { atMs: 700, value: -60, ease: { kind: 'easeOut' } },
              ],
            },
          ],
        },
        {
          id: 'title-sub',
          name: '副标题',
          type: 'text',
          props: { text: '沿着最陡的方向，一步步走到最低点', fontSize: 40, fill: '#8B97A3', x: 0, y: 60 },
          tracks: [
            {
              id: 'sub-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 300, value: 0 },
                { atMs: 1100, value: 1, ease: { kind: 'easeOut' } },
                { atMs: 2100, value: 1 },
                { atMs: 2400, value: 0, ease: { kind: 'easeIn' } },
              ],
            },
          ],
        },
      ],
    },

    {
      id: 'visual',
      name: '可视化：小球滚向谷底',
      durationMs: 3000,
      transition: { kind: 'fade', durationMs: 350 },
      layers: [
        {
          id: 'axis',
          name: '横轴',
          type: 'rect',
          props: { width: 620, height: 4, fill: '#4C9AFF', radius: 2, x: 0, y: 170 },
          tracks: [
            {
              id: 'axis-grow',
              target: 'props.width',
              keys: [
                { atMs: 0, value: 0 },
                { atMs: 600, value: 620, ease: { kind: 'easeOut' } },
              ],
            },
            {
              id: 'axis-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 0, value: 0 },
                { atMs: 400, value: 1 },
              ],
            },
          ],
        },
        {
          id: 'ball',
          name: '小球',
          type: 'circle',
          props: { size: 64, fill: '#FFB020', x: -240, y: -150 },
          tracks: [
            {
              id: 'ball-x',
              target: 'props.x',
              keys: [
                { atMs: 200, value: -240 },
                { atMs: 2600, value: 60, ease: { kind: 'easeInOut' } },
              ],
            },
            {
              id: 'ball-y',
              target: 'props.y',
              keys: [
                { atMs: 200, value: -150 },
                { atMs: 1900, value: 138, ease: { kind: 'easeIn' } },
                { atMs: 2400, value: 100, ease: { kind: 'spring', stiffness: 180, damping: 14 } },
                { atMs: 2900, value: 138, ease: { kind: 'easeInOut' } },
              ],
            },
          ],
        },
        {
          id: 'ball-label',
          name: '说明文字',
          type: 'text',
          props: { text: '每一步都朝着更低的地方走', fontSize: 38, fill: '#F2F5F7', x: 0, y: -230 },
          tracks: [
            {
              id: 'label-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 800, value: 0 },
                { atMs: 1300, value: 1, ease: { kind: 'easeOut' } },
                { atMs: 2700, value: 1 },
                { atMs: 3000, value: 0 },
              ],
            },
          ],
        },
      ],
    },

    {
      id: 'summary',
      name: '收尾：引出学习率',
      durationMs: 2500,
      transition: { kind: 'fade', durationMs: 350 },
      layers: [
        {
          id: 'sum-main',
          name: '要点',
          type: 'text',
          props: { text: '下一步：学习率决定每步走多远', fontSize: 56, fill: '#F2F5F7', x: 0, y: -30 },
          tracks: [
            {
              id: 'sum-pop',
              target: 'props.scale',
              keys: [
                { atMs: 400, value: 0.85 },
                { atMs: 1100, value: 1, ease: { kind: 'spring', stiffness: 200, damping: 15 } },
              ],
            },
            {
              id: 'sum-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 400, value: 0 },
                { atMs: 900, value: 1 },
                { atMs: 2200, value: 1 },
                { atMs: 2500, value: 0 },
              ],
            },
          ],
        },
        {
          id: 'sum-tip',
          name: '补充',
          type: 'text',
          props: { text: '步子太大容易来回震荡，太小则收敛太慢', fontSize: 32, fill: '#8B97A3', x: 0, y: 70 },
          tracks: [
            {
              id: 'tip-fade',
              target: 'props.opacity',
              keys: [
                { atMs: 1000, value: 0 },
                { atMs: 1500, value: 1, ease: { kind: 'easeOut' } },
                { atMs: 2200, value: 1 },
                { atMs: 2500, value: 0 },
              ],
            },
          ],
        },
      ],
    },
  ],
}
