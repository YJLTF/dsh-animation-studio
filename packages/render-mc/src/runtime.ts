/**
 * Motion Canvas 的默认运行时：起 vite dev server + 有头 Chromium + 点 Render。
 *
 * 为什么是这个形状——Motion Canvas 3.17 **没有 CLI**：官方只在编辑器 UI 里提供
 * RENDER 按钮，落盘机制是浏览器把每帧 base64 通过 dev server 的 WebSocket 发回来
 * （见 vite-plugin 的 exporterPlugin）。所以要自动渲染，只能把编辑器开起来再按按钮。
 *
 * 浏览器必须「有头」：Stage 需要 WebGL，纯 headless Chromium 拿不到 GL 上下文，
 * 渲染器会在 reloadScenes 阶段崩掉。桌面系统（Windows/macOS）有真实显示服务器，
 * 直接开有头浏览器即可；无显示的 Linux 服务器则由 Xvfb 提供虚拟显示。
 */

import { exec as execCallback, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createRequire } from 'node:module'

import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

import { collectFrames, resetDir } from './adapter.ts'
import type { MotionCanvasRuntime } from './adapter.ts'
import type { RenderDiagnostics } from './contract.ts'

const exec = promisify(execCallback)

export interface DefaultRuntimeOptions {
  /** vite dev server 端口。 */
  port?: number
  /** 输出目录，相对 workDir。 */
  outputDir?: string
  /** Chromium/Chrome 可执行文件路径；省略时依次查 CHROME_PATH 与各平台常见位置。 */
  chromiumPath?: string
  /** Xvfb 显示号（仅 Linux 无 DISPLAY 时使用）。 */
  display?: string
  /** 单次渲染的墙钟上限，默认 30 分钟。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT = 30 * 60 * 1000

/* ------------------------------------------------------------- 环境探测 */

/**
 * 按 CHROME_PATH → 平台常见位置 的顺序找出可用的浏览器。
 * Windows 上没有全局 chromium 命令，Chrome/Edge 的安装路径就是默认值。
 */
function findChromium(explicit?: string): string | undefined {
  const candidates = explicit
    ? [explicit]
    : [
        process.env.CHROME_PATH,
        ...(process.platform === 'win32'
          ? [
              join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
              join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
              join(process.env['LOCALAPPDATA'] ?? '', 'Google/Chrome/Application/chrome.exe'),
              // 64 位 Windows 上 Edge 默认装在 Program Files (x86)，两个都要查
              join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
              join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
            ]
          : process.platform === 'darwin'
            ? [
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              ]
            : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']),
      ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  return candidates.find(p => existsSync(p))
}

/**
 * 依赖自检。
 *
 * 这一层的价值在于**报错要可操作**：说「渲染失败」没用，要说「缺 ffmpeg，装它」。
 * 依赖清单不是猜的，是踩出来的：Xvfb 缺失 = 拿不到 GL；字体缺失 = 中文变豆腐块。
 */
export async function probeEnvironment(options: { chromiumPath?: string } = {}): Promise<RenderDiagnostics> {
  const issues: string[] = []
  const details: Record<string, string> = {}

  const chromium = findChromium(options.chromiumPath)
  if (chromium) details['chromium'] = chromium
  else {
    issues.push(
      process.platform === 'win32'
        ? '未找到 Chrome/Edge：请安装，或用环境变量 CHROME_PATH 指向浏览器可执行文件'
        : '未找到 Chromium：可用 CHROME_PATH 指定（apt install chromium）',
    )
  }

  const ffmpeg = await which('ffmpeg')
  if (ffmpeg) details['ffmpeg'] = ffmpeg
  else issues.push('未找到 ffmpeg：帧合成 MP4 需要它（apt install ffmpeg / winget install ffmpeg）')

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const xvfb = await which('Xvfb')
    if (xvfb) details['Xvfb'] = xvfb
    else issues.push('未找到 Xvfb：无显示的 Linux 需要虚拟显示才能拿到 WebGL 上下文（apt install xvfb）')
  }

  // 中文字体：缺了不会报错，只会渲成方块，所以必须主动查
  const cjk = await probeCjkFonts()
  if (cjk) details['cjkFonts'] = cjk
  else issues.push('未找到中文字体：中文会渲成豆腐块（apt install fonts-noto-cjk）')

  return { renderer: 'motion-canvas', ok: issues.length === 0, issues, details }
}

/** 找一个能覆盖中文的字体名，供诊断报告引用；找不到返回 undefined。 */
async function probeCjkFonts(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    for (const f of ['msyh.ttc', 'simsun.ttc', 'simhei.ttf']) {
      if (existsSync(join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', f))) return f
    }
    return undefined
  }
  const fonts = await execQuiet('fc-list :lang=zh').catch(() => '')
  const lines = fonts.split('\n').filter(Boolean)
  if (lines.length === 0) return undefined
  const sans = lines.find(l => l.includes('Noto Sans CJK'))
  return sans ? (sans.split(':')[1]?.trim() ?? sans) : `${lines.length} 个`
}

async function which(bin: string): Promise<string | undefined> {
  // cmd.exe 没有 command -v，等价物是 where
  const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`
  const out = await execQuiet(cmd).catch(() => '')
  return out.trim().split(/\r?\n/)[0] || undefined
}

/* ------------------------------------------------------- work 目录模块解析 */

/**
 * 让 work 目录能解析到渲染依赖。
 *
 * work 目录（`<outputDir>/work`）通常悬在用户的输出目录下，往上找不到任何
 * node_modules；而 vite 的虚拟编辑器模块会 import `@motion-canvas/ui`、生成的
 * 场景会 import `@motion-canvas/2d`——解析不到就是 500，浏览器里只剩一个
 * Internal Server Error 页，渲染永远 0 帧。这里把含 Motion Canvas 的
 * node_modules 以 junction/软链形式钉进 work 目录，一次解决全部裸导入。
 *
 * 从本模块的编译产物位置向上找（bundle 在 <插件根>/lib/ 下），能同时覆盖
 * 源码仓库、pnpm profile 安装、离线 tgz 三种布局。
 */
export function ensureWorkDirModules(workDir: string): void {
  const target = findModulesDir()
  if (!target) return
  const link = join(workDir, 'node_modules')
  if (existsSync(link)) return
  mkdirSync(workDir, { recursive: true })
  try {
    // Windows 上 junction 不需要管理员权限；其他平台用 dir 软链
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // 建不出来就退回 CWD 的 node_modules 解析链——样例工程等场景本来就能解析
  }
}

let cachedModulesDir: string | null | undefined

function findModulesDir(): string | null {
  if (cachedModulesDir !== undefined) return cachedModulesDir
  cachedModulesDir = null
  try {
    // 先用 require.resolve 确认 @motion-canvas/core 真的可解析，再定位它所在的
    // node_modules——只找目录不验证包，会把 junction 钉到一个空壳上
    createRequire(import.meta.url).resolve('@motion-canvas/core')
  } catch {
    return cachedModulesDir
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(join(candidate, '@motion-canvas', 'core'))) {
      cachedModulesDir = candidate
      return cachedModulesDir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cachedModulesDir
}

/**
 * 找到包实际所在的 node_modules 目录（pnpm 下是 .pnpm 深处的真实路径）。
 * vite 的 fs.allow 按「浏览器的真实请求路径」判定，符号链接不算数，
 * 所以白名单必须基于 realpath 而不是链接位置。
 */
function containingModulesDir(pkgName: string): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve(pkgName)
    let dir = dirname(realpathSync(entry))
    while (true) {
      if (basename(dir) === 'node_modules') return dir
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

async function execQuiet(cmd: string): Promise<string> {
  const { stdout } = await exec(cmd, { encoding: 'utf8' })
  return String(stdout ?? '')
}

/* ------------------------------------------------------------- 默认运行时 */

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): MotionCanvasRuntime {
  const port = options.port ?? 5179
  const display = options.display ?? ':99'
  const chromiumPath = findChromium(options.chromiumPath)
  const outputDir = options.outputDir ?? 'output'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  return {
    async probe() {
      return probeEnvironment({ chromiumPath: options.chromiumPath })
    },

    async materialize(files, workDir) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      ensureWorkDirModules(workDir)
      for (const file of files) {
        const target = join(workDir, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content, 'utf8')
      }
    },

    async renderProject({ workDir, expectedFrames, signal, onProgress }) {
      const rootDir = join(workDir, outputDir)
      // 清掉上一轮产物：旧帧混进新片是最难发现的一类错误
      resetDir(rootDir)

      // Linux 服务器无显示时用 Xvfb 提供虚拟显示；已有 DISPLAY（桌面 Linux）或
      // 桌面系统（Windows/macOS）直接用真实显示
      const linuxNoDisplay = process.platform === 'linux' && !process.env.DISPLAY
      const xvfb = linuxNoDisplay ? spawn('Xvfb', [display, '-screen', '0', '1920x1080x24'], { stdio: 'ignore' }) : undefined
      if (linuxNoDisplay) await new Promise(r => setTimeout(r, 2000))
      if (chromiumPath === undefined) {
        xvfb?.kill()
        throw new Error('未找到可用的 Chrome/Chromium：设置 CHROME_PATH 环境变量或安装浏览器后重试')
      }

      // project 与 output 都必须写绝对路径：MC 的 vite-plugin 会把它们原样
      // 塞进虚拟模块/导出器配置里按相对路径处理，而虚拟模块的相对导入与
      // exporter 的落盘目录都按 process.cwd() 解析——dsh 的 cwd 是启动目录
      // 而不是 workDir，相对路径在这里要么 500 要么把帧写到天南海北
      const configPath = join(workDir, 'vite.config.ts')
      mkdirSync(workDir, { recursive: true })
      const uiModulesDir = containingModulesDir('@motion-canvas/ui')
      writeFileSync(
        configPath,
        viteConfigSource(
          join(workDir, 'project.tsx').replace(/\\/g, '/'),
          join(workDir, outputDir).replace(/\\/g, '/'),
          [workDir, ...(uiModulesDir ? [uiModulesDir, dirname(uiModulesDir)] : [])],
        ),
        'utf8',
      )

      const server = await createServer({
        // 场景源码都物化在 workDir 下，vite 的 root 必须钉在这里，
        // 否则 project: './project.tsx' 会相对进程 cwd 解析而落空
        root: workDir,
        configFile: join(workDir, 'vite.config.ts'),
        // 依赖预打包缓存必须钉在 workDir 自己身上：workDir/node_modules 是指向
        // 插件真实 node_modules 的 junction，默认 cacheDir 会落到共享缓存里，
        // 与其他项目/其他 spec 的优化产物串台，跑出双 core 实例的经典错乱
        cacheDir: join(workDir, '.vite'),
        server: { port, strictPort: true },
        logLevel: 'warn',
      })
      await server.listen()

      let browser
      try {
        browser = await puppeteer.launch({
          executablePath: chromiumPath,
          headless: false,
          env: linuxNoDisplay ? { ...process.env, DISPLAY: display } : process.env,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            // 编辑器靠 rAF 驱动渲染：窗口被遮挡/最小化时 Chromium 会节流 rAF，
            // 帧就永远出不来（实测 Windows 上浏览器窗口可能以最小化状态启动）
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--window-position=40,40',
            '--window-size=1600,900',
          ],
        })
        const page = await browser.newPage()
        await page.setViewport({ width: 1600, height: 900 })
        await page.bringToFront()

        await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle2', timeout: 120_000 })
        await page.waitForSelector('canvas', { timeout: 60_000 })
        await new Promise(r => setTimeout(r, 4000)) // 等编辑器完成场景加载

        // 按文本找按钮：MC 的 class 名带构建哈希，不能依赖。
        // 用 $$eval 而不是 evaluateHandle —— 后者返回的 ElementHandle<Node> 没法直接 click。
        const clicked = await page.$$eval('button', buttons => {
          const target = buttons.find(b => (b.textContent ?? '').trim() === 'Render')
          if (!target) return false
          target.click()
          return true
        })
        if (!clicked) throw new Error('找不到 Render 按钮——Motion Canvas 版本可能变了，请重新确认编辑器 UI')

        // 注意顺序：先等帧、再定位帧目录。exporter 的输出子目录是在首帧落盘时
        // 才创建的，点完 Render 立刻找目录只会拿到空的 output 根目录——而等待
        // 用的 collectFrames 会递归扫一层子目录，帧再多也救不回早已定错的目录。
        const count = await waitForFrames(rootDir, expectedFrames, timeoutMs, signal, onProgress)
        return { frameDir: findImageDir(rootDir), frameCount: count }
      } finally {
        await browser?.close()
        await server.close()
        xvfb?.kill()
      }
    },
  }
}

/** 等帧写满；帧数停滞即判定结束（渲染可能少出或多出 1-2 帧缓冲）。 */
async function waitForFrames(
  dir: string,
  expected: number,
  timeoutMs: number,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const started = Date.now()
  let last = -1
  let stableSince = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (signal.aborted) throw new Error('渲染已取消')
    const n = safeCount(dir)
    if (n !== last) {
      last = n
      stableSince = Date.now()
      onProgress?.(n, expected)
    }
    if (n >= expected && Date.now() - stableSince > 3000) break
    // 0 帧停滞：编辑器没起来（依赖解析失败→页面 500）或窗口被最小化（rAF 被
    // 节流）。不快速失败的话，一次失败渲染要挂满整个超时才返回。
    if (n === 0 && Date.now() - stableSince > 90_000) {
      throw new Error(
        '渲染器 90 秒没有产出任何帧。常见原因：浏览器窗口被最小化或关闭了；'
        + 'Motion Canvas 编辑器加载失败（检查 <workDir> 下 vite 的报错）。恢复窗口或修复后重试。',
      )
    }
    // 帧断流：MC 偶尔少出 1-2 帧缓冲帧，可接受；差得多就是渲染中断，
    // 与其静默出一条短几秒的片子，不如报错让上层重试
    if (n > 0 && Date.now() - stableSince > 15_000) {
      if (n >= expected - 2) break
      throw new Error(`帧产出在 ${n}/${expected} 处停滞超过 15 秒，渲染中断。请重试；若反复出现，降低分辨率或缩短时长。`)
    }
    await new Promise(r => setTimeout(r, 800))
  }
  return safeCount(dir)
}

function safeCount(dir: string): number {
  try {
    return collectFrames(dir).length
  } catch {
    return 0
  }
}

/** 在 `output/` 下找到真正存帧的子目录。 */
function findImageDir(root: string): string {
  try {
    for (const top of readdirSync(root)) {
      const full = join(root, top)
      if (statSync(full).isDirectory()) {
        if (readdirSync(full).some(f => f.endsWith('.png') || f.endsWith('.jpg'))) return full
      }
    }
  } catch {
    // fallthrough
  }
  return root
}

/** 生成插件工作目录用的 vite 配置：项目入口与帧输出都在 workDir 下。 */
export function viteConfigSource(
  projectPath?: string,
  outputPath?: string,
  allowDirs: string[] = [],
): string {
  // 缺省时保持相对写法（样例工程里 config 与 project 同目录，cwd 也是它）
  const project = projectPath ? JSON.stringify(projectPath) : "'./project.tsx'"
  const output = outputPath ? JSON.stringify(outputPath) : "'./output'"
  const allow = JSON.stringify(allowDirs.map(d => d.replace(/\\/g, '/')))
  return `import { defineConfig } from 'vite';
import motionCanvasPlugin from '@motion-canvas/vite-plugin';

const motionCanvas = (motionCanvasPlugin as unknown as { default?: typeof motionCanvasPlugin }).default ?? motionCanvasPlugin;

export default defineConfig({
  plugins: [motionCanvas({ project: ${project}, output: ${output} })],
  esbuild: { jsx: 'automatic', jsxImportSource: '@motion-canvas/2d' },
  server: {
    fs: {
      // workDir/node_modules 是指向插件真实 node_modules 的 junction，
      // 编辑器的样式与脚本从那里加载，必须放进白名单，否则编辑器裸奔无样式
      allow: ${allow},
    },
  },
});
`
}
