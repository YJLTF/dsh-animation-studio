import motionCanvasPlugin from '@motion-canvas/vite-plugin'
import { defineConfig } from 'vite'

/**
 * vite-plugin 发布的是 CJS，而 vite 会把 config 当 ESM 加载，
 * 默认导出会落在 `.default` 上。这里做一次兜底解包。
 */
const motionCanvas = (motionCanvasPlugin as unknown as { default?: typeof motionCanvasPlugin })
  .default ?? motionCanvasPlugin

/**
 * Motion Canvas 的渲染发生在 `vite build` 期间：插件会把 project 交给
 * 无头浏览器逐帧截图，再交给 ffmpeg 合成。所以这里没有「渲染脚本」，
 * 构建即渲染。
 */
export default defineConfig({
  plugins: [
    motionCanvas({
      project: './src/project.tsx',
      output: './output',
    }),
  ],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@motion-canvas/2d',
  },
})
