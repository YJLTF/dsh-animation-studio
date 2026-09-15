/**
 * 把插件打成单文件 ESM：packages/tools/src/index.ts → lib/index.js。
 *
 * 工作区内部包（@dsh-anim/spec、@dsh-anim/render-mc）连同 TS 源码一起内联进产物；
 * 以下保持 external，运行时由 DSH 宿主（peer）或插件自带依赖（npm 安装）提供：
 * - @deepseek-ai/*：dsh 宿主在 profile 里提供，打进包反而会实例化两份；
 * - vite / puppeteer-core / @motion-canvas/*：体量大且含动态加载，作为
 *   dependencies 随离线包携带，由 node_modules 解析。
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['packages/tools/src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  external: [
    '@deepseek-ai/*',
    'vite',
    'puppeteer-core',
    '@motion-canvas/*',
  ],
  logLevel: 'info',
})
