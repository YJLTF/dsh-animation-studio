/**
 * 把插件打成单文件 ESM：packages/tools/src/index.ts → lib/index.js。
 *
 * 工作区内部包（@dsh-anim/spec、@dsh-anim/render-mc）连同 TS 源码一起内联进产物；
 * 以下保持 external，运行时由 DSH 宿主（peer）或插件自带依赖（npm 安装）提供：
 * - @deepseek-ai/*：dsh 宿主在 profile 里提供，打进包反而会实例化两份；
 * - vite / puppeteer-core / @motion-canvas/*：体量大且含动态加载，作为
 *   dependencies 随离线包携带，由 node_modules 解析。
 *
 * 工作区包靠 alias 解析而不是 node_modules 软链：本仓库是 pnpm workspace，
 * 而 dsh-plugin-offline-packager 在暂存目录里用 npm 安装依赖（npm 不认
 * pnpm-workspace.yaml，不会建工作区软链）——alias 让「拷走源码就能构建」
 * 与包管理器无关，打包器的自动构建路径因此可用。
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

await build({
  entryPoints: ['packages/tools/src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  alias: {
    '@dsh-anim/spec': resolve('packages/spec/src/index.ts'),
    '@dsh-anim/store': resolve('packages/store/src/index.ts'),
    '@dsh-anim/render-mc': resolve('packages/render-mc/src/index.ts'),
  },
  external: [
    '@deepseek-ai/*',
    'vite',
    'puppeteer-core',
    '@motion-canvas/*',
  ],
  logLevel: 'info',
})
