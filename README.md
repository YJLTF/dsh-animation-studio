# dsh Animation Studio

给 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness/) 做的**教学动画制作工作台**插件：一套内置在教学会话里的"教学视频 agent"。

你用自然语言说"做一支讲梯度下降的 30 秒短片"，AI 就通过 10 个 `anim_*` 工具完成 **分镜 → 时间线 → 动画 → 预览 → 微调 → 渲染出 MP4** 的完整流程——中途可以随时抽查画面、把某个关键帧挪几百毫秒、或者撤销上一步。模型全程不写动画代码，只读写一份数据文档。

基于 **dsh 0.1.6-alpha.1** 真机实证开发（类型开发基线 0.1.5-rc.2，peer 依赖声明为 `>=0.1.5-rc.2`），**0.1.6-alpha.2** 兼容性已验证——宿主挂载冒烟（工具注册、执行链路、sidecar 落盘、会话恢复、web 路由、client 卡片）在其内置生态（cordis 4.0.2 / dsh-tools 0.1.6-alpha.2 / schemastery 3.18.2）下全绿。可无缝配合 [dsh-plugin-offline-packager](https://github.com/YJLTF/dsh-plugin-offline-packager) 打成自包含离线安装包。

```
模型 ──anim_*工具──▶ AnimationSpec (JSON IR) ──▶ 渲染适配器 ──▶ MP4
     │                   │                           │
     │ 每步变更落 anim/* 事件                           └── Motion Canvas（首发）
     │ （插件自有 sidecar，不碰宿主日志）                    后续可换 Remotion / Manim
     └── 会话卡片读回执/presentationMeta 即得状态，
         视频预览走插件自有的 /dsh-anim 同源路由
```

设计选型、平台事实与各版本迭代过程的完整记录在 [`docs/`](docs/)（设计草案 + 各版本规划文档），本 README 只讲"是什么、有什么、怎么用"。

## 核心特性

- **模型只读写 JSON，不写动画代码**：时间线是一份 AnimationSpec IR——所有时间都是场景内绝对毫秒，可动画属性统一收进轨道关键帧，内置 linear / easeIn/Out/InOut / cubicBezier / spring / bounce / elastic / back 缓动。于是"微调 = 改一个数字"（一条 JSON Patch，而不是重写 800 行代码），换渲染后端不动工具，每一步天然可回放、可撤销、可分叉。
- **10 个面向模型的工具**：`anim_diagnose`（环境自检）、`anim_create_spec`、`anim_plan`（分镜大纲 + 节奏体检）、`anim_draft_scene`（逐幕写入）、`anim_get`（按 JSON Pointer 精确读取）、`anim_patch`（结构化补丁，返回 inverse）、`anim_undo`、`anim_asset_import`（图片/svg/音频/字体素材登记）、`anim_preview`（降分辨率抽帧）、`anim_render`（整片 MP4）。详见[工具一览](#工具一览)。
- **写入走 JSON Patch，撤销不用重新推理**：改完整份校验，不通过整批回滚；每次修改同时记录正向 ops 与反向 inverse，`anim_undo` 直接回放 inverse。坏 op 在边界上以可读的报错返回。
- **事件溯源 + 会话恢复**：spec 的每次变更都是一条自包含事件，`foldEvents` 从事件流还原状态（含撤销历史）。事件按会话写进插件自有 sidecar（`<outputDir>/sessions/<sessionId>.jsonl`），不写宿主会话日志——宿主读回对未知事件类型 fail-closed，写进去会毒化整个会话。宿主重启、会话重开后，旧 spec 照常修改与撤销。
- **开箱即用的 Motion Canvas 渲染**：自动处理 Motion Canvas 3.17 无官方 CLI、WebGL 上下文、headless 出帧、尾部静止提前停帧等一整串坑；渲染默认 headless 无窗口，超时或中断显式报错，绝不静默产出残片。段缓存默认开启（未变的幕直接复用），长片渲染耗时以分钟计。
- **渲染与预览自动后台化**：宿主提供 `ctx.jobs` 时立即返回 jobId，进度以事件可见，模型用 `job_output` / `job_kill`（dsh-tool-jobs）收集与终止；宿主没有 jobs 服务时自动退回同步执行（可用 `anim_diagnose` 的 host 报告确认）。渲染过程落 `anim/render-start` / `anim/render-progress` / `anim/render-finished` 事件，面板与回放都能重建进度。
- **会话内工作台卡片 + 视频预览（dsh Web）**：每个 `anim_*` 工具调用渲染成富卡片；`anim_render` 的成片直接内嵌 `<video>` 播放（Range 拖动、下载、定位文件），`anim_preview` 的抽帧渲染成缩略图墙；转后台的任务卡片自动轮询进度条，出片后原地变成播放器。headless（无 webServer）形态下整条路由不存在，零副作用。
- **卡片带最简交互按钮**：`anim_plan` 卡「渲染成片」、`anim_draft_scene` 卡「预览这一幕」、`anim_patch` 卡「撤销这步」。点击即把一条结构化指令（稳定前缀 `[anim-studio 面板指令]` + JSON）经宿主 `session/prompt` API 发回会话，agent 空闲则立即执行、运行中则排队；处理契约声明在 anim-studio 预设。详见[工作台面板](#工作台面板dsh-web)。
- **旁白字幕**：`/narration/cues` 写[{ atMs, text }]（全片绝对毫秒），渲染自动出底部字幕条——字号按画布高度自适应，超宽自动折行、底条随行数增高；底部字幕带是保留区，正文图层压进来时渲染会给软警告。TTS 语音合成规划在 0.5。
- **渲染器可替换**：渲染能力是一个标准 seam（注册表 + `provideRenderer`），想接 Remotion/Manim 就写一个 Provider 顶掉默认项，工具与事件零改动。
- **离线分发友好**：`dsh.bundle` 声明 + esbuild 单文件构建，工作区内部包用 alias 内联、与包管理器无关，配合 offline-packager 一条命令打成自包含 tgz。

## 包结构

| 目录 | 职责 |
| --- | --- |
| `packages/spec` | AnimationSpec IR：类型、零依赖校验、时间线求值、patch 引擎。纯数据层，host / client 共享 |
| `packages/store` | spec 状态容器：内存 store + 事件流 fold（含撤销历史）。纯逻辑，host / client 共享同一份状态还原 |
| `packages/render-mc` | Motion Canvas 渲染适配器：`codegen.ts`（IR→源码，零渲染依赖）+ `adapter.ts`/`runtime.ts`（vite + 浏览器 + ffmpeg） |
| `packages/tools` | dsh 宿主插件：`anim_*` 工具、spec store、会话事件、渲染 seam、`/dsh-anim` 媒体与状态路由 |
| `packages/client` | 浏览器面（`lib/client.js`）：anim_* 工具的会话卡片（React），经 keyed `tool.call.toolview` 插槽认领渲染权 |
| `examples/hello-gradient` | 端到端样例：一份中文教学动画 spec → MP4 |
| `config/agent-presets/anim-studio` | 会话级 agent preset：导演 persona + 分镜方法论提示词（拷到 `~/.dsh/.agent-presets/` 启用） |
| `scripts/` | 冒烟测试（`smoke.ts` 纯逻辑 + `smoke-host.mjs` 真实 cordis 挂载）与旧会话日志修复脚本 |
| `docs/` | 设计草案（平台事实、IR 设计、事件模型、踩坑）与各版本规划/迭代记录 |

## 环境要求

- Node.js ≥ 22，已安装 DSH ≥ 0.1.5-rc.2（`dsh` CLI 可用）
- **包管理器必须用 pnpm**（在 pnpm 12 上验证）：工作区包互相依赖用的是 `workspace:*` 协议，npm 不支持该协议（装不上），且根脚本直接调用 `pnpm -r` / `pnpm --filter`
- 渲染需要（不渲染只做脚本可以不装）：
  - **ffmpeg**（帧合成 MP4）
  - **Chrome / Edge / Chromium** 任一；非常见安装位置时用 `CHROME_PATH` 指定
  - Linux 服务器还需要 **Xvfb**（`apt install xvfb`）与中文字体（`apt install fonts-noto-cjk`）；Windows/macOS 有系统显示即可，中文字体一般已具备

## 安装

### 方式一：从源码安装

```bash
git clone <本仓库> dsh-animation-studio
cd dsh-animation-studio
pnpm install
pnpm build            # esbuild 打包出 lib/index.js（宿主面）+ lib/client.js（浏览器面）

# 挂进你的 dsh profile（web 为例；注意路径用绝对路径）
dsh plugin --profile web add F:\path\to\dsh-animation-studio
```

重启 DSH 后，会话里就会出现 10 个 `anim_*` 工具；`dsh web` 下每次工具调用还会渲染成会话卡片（含视频预览）。

### 方式二：打包成离线安装包（无网络环境）

在**联网机器**上用 [dsh-plugin-offline-packager](https://github.com/YJLTF/dsh-plugin-offline-packager) 打包，推荐直接在 DSH Web UI 里说：

```
请将 F:/path/to/dsh-animation-studio 打包为离线安装包
```

打包器会：复制源码到暂存目录（跳过 node_modules / .git）→ `npm install` 生产依赖（`@deepseek-ai/*` 是 peer，由 dsh 宿主提供，不打入）→ 通过 `bundleDependencies` 把 vite、puppeteer-core、Motion Canvas、`@lezer/*` 语言包等全部运行时依赖闭包塞进 tarball → 出自包含的 `dsh-animation-studio-<版本>.tgz`。`package.json` 的 `files` 白名单保证包内只有 `lib/` 与 `cordis.patch.yml`，干净且小。构建环节免维护：源码目录里已跑过 `pnpm build` 就直接用现成的 `lib/`，没跑过打包器也会自动构建。

拷到离线机器后：

```bash
dsh plugin --profile web add ./dsh-animation-studio-<版本>.tgz
```

> 两个已知的坑（都来自 offline-packager 的 README，装不上时先查这里）：
> - pnpm ≥ 11 的离线环境需要先在 profile 的 `pnpm-workspace.yaml` 里设置 `minimumReleaseAge: 0`，否则 `pnpm add` 会联网校验发布时间元数据而失败；
> - Windows 下离线 tgz 的存放路径不能包含空格（`dsh plugin add` 的转发限制）。

### 配置

```yaml
# cordis.yml 或 profile patch
- id: dsh-anim-studio
  name: dsh-animation-studio
  config:
    outputDir: ./.dsh/anim   # 渲染产物与中间工作目录的根，默认 ./.dsh/anim
```

### 验证安装

装好后先让 AI 调一次 `anim_diagnose`，它会逐项报告浏览器、ffmpeg、中文字体的就绪状态，并给出缺什么装什么的建议。

## 使用

### 让 AI 做一支片子

在 DSH 会话里直接说需求即可，典型流程是：

```
你：用动画讲一下"梯度下降"的直觉，30 秒以内，中文。
AI：anim_diagnose   → 环境自检
    anim_create_spec → 建立时间线文档（30fps，1280x720）
    anim_plan        → 写分镜大纲，工具做节奏体检（太短/太长/缺意图会提示）
    anim_draft_scene → 逐幕写入图层与关键帧（可反复调用）
    anim_preview     → 低分辨率抽几帧自查
    anim_patch       → "第二个关键帧挪到 1.8s""小球改橙色"
    anim_render      → 渲染成 MP4，报告输出路径
```

每个工具回执都带"下一步该做什么"的引导；`anim_patch` 返回的 `inverse` 可以直接喂回给 `anim_patch` 撤销，`anim_undo` 则是它的快捷方式。

### 用 anim-studio 预设（推荐）

仓库自带一个会话级 **agent preset**：`config/agent-presets/anim-studio/`，给会话配上「教学动画导演」身份 + 分镜方法论系统提示词（自检 → 分镜 → 逐幕细化 → 预览 → 微调 → 出片，含面板指令处理契约与字幕安全区等排版守则），让模型一句话主题就能按正确姿势出片。安装：

```bash
# 把预设目录拷到你的 DSH_HOME（默认 ~/.dsh）下的 .agent-presets/
cp -r config/agent-presets/anim-studio ~/.dsh/.agent-presets/anim-studio
```

然后在 `dsh web` **新开**一个会话，预设选择器里选「动画制作工作台」（preset 是会话级快照，已开的会话不生效）。说明：

- `anim_*` 工具由插件在**宿主层**注册、对所有会话可见，preset 不再重复挂载插件（重复挂载会再起一份 store / 路由）；
- preset 的增量是 persona 方法论提示词；不选它、直接在普通会话里说需求也能出片，只是没有这套导演式引导。

### 工作台面板（dsh Web）

在 `dsh web` 里，每次 `anim_*` 工具调用不再是原始 JSON，而是一张会话卡片：`anim_create_spec` → 片子名片；`anim_plan` → 分镜大纲 + 节奏体检；`anim_patch` / `anim_undo` → 修改历史；`anim_preview` → 抽帧缩略图墙；`anim_render` → 成片内嵌播放（Range 拖动、"在新标签打开 / 下载 / 定位文件"）；转后台的任务卡先显示进度条，出片后原地变成播放器 / 缩略图墙，失败/终止显示原因。卡片带三个交互按钮：「渲染成片」「预览这一幕」「撤销这步」。

实现上有两条数据通道 + 一条指令通道，都不经过模型：

1. **卡片数据**：host 工具用 `output.presentationMeta` 把结构化回执投影到 `tool/result.meta`（随会话日志持久化），浏览器卡片优先读 meta、回退解析回执文本——刷新、回放旧会话，卡片照常重建；
2. **媒体与状态**：插件向宿主 webServer 注册 `/dsh-anim` 前缀路由：`GET /dsh-anim/media?p=<绝对路径>` 把渲染产物送进浏览器（Range / ETag / 304 齐全），放行规则是「outputDir 内」或「工具回执里出现过的路径」，扩展名白名单，其余一律 404；`GET /dsh-anim/api/state` 输出工作台状态（specs + 渲染/预览任务簿），后台卡片的进度条与缩略图重建靠它；
3. **面板指令**：卡片按钮 → 同源 `POST /api/session/prompt`（与官方 client 同款信封，cookie 自动携带）→ 宿主 agent 收件箱 → 下一回合执行 anim_* 工具 → 事件流与卡片呈现结果。指令带会话章（sessionId），没有该章的旧卡片（分叉/回放产生）按钮整行隐藏。

面板功能依赖 `dsh web`（webServer 路由 + 浏览器插槽），headless CLI 会话只有工具回执、没有卡片。

### 工具一览

| 工具 | 作用 |
| --- | --- |
| `anim_diagnose` | 环境自检：后端、ffmpeg、浏览器、中文字体、宿主 jobs 服务 |
| `anim_create_spec` | 新建一份时间线文档，返回 specId |
| `anim_plan` | 记录分镜大纲 + 节奏体检 |
| `anim_draft_scene` | 逐幕写入图层与关键帧 |
| `anim_get` | 按 JSON Pointer 精确读取 spec 片段 |
| `anim_patch` | 结构化补丁修改（唯一写途径），返回 inverse |
| `anim_undo` | 撤销上一次修改 |
| `anim_asset_import` | 素材登记（image/svg/audio/font 四类均接通渲染）：image/svg 用 `src="asset:<id>"` 引用；font 导入后 text/code 的 `fontFamily` 填 assetId；audio 用 audio 图层引用 |
| `anim_preview` | 低分辨率抽帧检查效果（只渲染到最晚抽帧点，不渲整片；抽帧无音频） |
| `anim_render` | 渲染成 MP4（段缓存默认开启，回执 `incremental` 报告命中；spec 带 audio 图层时自动混音；宿主支持时转后台任务） |

### 不装 DSH 也能跑：样例工程

`examples/hello-gradient` 是一条约 14 秒的中文教学片《梯度下降：直觉理解》（5 幕，含代码演化 / zoomIn / fade 退场 / 旁白字幕演示幕），走通"IR → Motion Canvas 源码 → MP4"全链路：

```bash
pnpm install
cd examples/hello-gradient
node --import tsx scripts/generate.ts   # spec → Motion Canvas 源码（src/ 下）
node --import tsx scripts/render.ts     # 源码 → output/output.mp4（需要渲染环境）
```

## 开发

```bash
pnpm install
pnpm typecheck   # 全工作区类型检查（对真实 @deepseek-ai/dsh-tools 类型）
pnpm build       # esbuild 打包插件 → lib/index.js（宿主面）+ lib/client.js（浏览器面）
pnpm smoke       # 纯逻辑冒烟 + 构建 + 真实 cordis 宿主挂载冒烟（含无损 JSON 事件校验，无需浏览器）
```

冒烟覆盖 spec 校验 / patch 可逆 / 时间线展开与截短 / codegen 结构（含字幕折行与字幕安全区）/ store 回滚撤销 / 事件流 fold / 渲染注册表 / 渲染与预览后台化 / 面板指令信封 / `/dsh-anim` 请求内核，以及构建产物在真实 cordis 环境里的挂载、执行、会话恢复与卡片注册契约。浏览器渲染链路不在冒烟范围内，由 `examples/hello-gradient` 的 `scripts/render.ts` 走与 `anim_render` 完全相同的运行时路径，可当渲染链路的手动诊断入口用。

## 已知限制与说明

- **图层类型**：`text / rect / circle / ellipse / image / line / arrow / polygon / star / svg / code / math / group / audio`。要点：circle/ellipse 用 `size`（`radius` 自动换算）；line/arrow 用 `points` 定折线、`endArrow` 内建箭头；polygon/star 由 `sides`+`size` 生成；svg 内嵌字符串；image `src` 写 `asset:<id>`；code 用 `code`+`language`（自动高亮，`{{片段}}` 着色，`props.code` 多关键帧即代码演化 morph）；math 用 `tex` 写 LaTeX；group 用 `children` 引用成员；audio 引用音频资产（渲染尾步 ffmpeg 混入成片，不进画面）。不支持的属性以警告降级，不失败。
- **转场与缓动**：`transition.kind` 支持 `none/fade/slideLeft/slideUp/slideRight/slideDown/zoomIn`；`scene.exit`（fade/slide 系列）在幕尾整体退场；缓动另有 `bounce/elastic/back`（强调类入场）。
- **旁白字幕**：无 TTS（规划在 0.5）。字幕字号按画布高度约 4% 自适应（与正文字号解耦），超宽自动折行；底部字幕带是保留区，建议一条 cue ≤40 字、正文图层的 y 避开字幕带（重叠时渲染给软警告）。
- **字体**：font 资产导入后 text/code 图层 `fontFamily` 填 assetId 即生效；远端 http(s) 字体 URL 需要目标服务器允许跨源（CORS）。
- **后台任务**依赖宿主把 jobs 服务暴露给插件上下文；未暴露时 `anim_render` / `anim_preview` 自动走同步路径（设计内行为），`anim_diagnose` 的 host 报告（`jobsOnCtx`）可确认当前部署的形态。
- **媒体放行**：`/dsh-anim/media` 只放行「outputDir 内」或「工具回执里出现过的精确路径」+ 扩展名白名单（`mp4/webm/mov/png/jpg/jpeg/gif/webp/svg`）。
- **插件事件不进宿主会话日志**：宿主读回对未知事件类型 fail-closed，而宿主 `session.append` 不提供 ignorable 入口，写 anim/* 事件会毒化整个会话；事件因此只写插件 sidecar。极旧版本写入过 anim/* 事件的宿主日志，用 `python scripts/repair-session-log.py <session.v3.jsonl.zstd>` 补 ignorable 标记后仍可作恢复回退源（自动备份）。完整事故记录见 `docs/`。
- **渲染环境**：渲染依赖 Motion Canvas 3.17 的编辑器 UI 自动化（官方无 CLI）；Edge 152+ 的新 headless 配合 SwiftShader 可完整出帧；`headless: false` 仅作调试后门（Linux 无显示时需要 Xvfb）。浏览器与 vite dev server 常驻复用（空闲 10 分钟回收）。
- **Windows 安装**：`dsh plugin add` 在部分 Windows 环境会把 pnpm 转发给 cmd 执行；若 cmd 按 PATH 找不到 pnpm，直接在 profile 目录里 `pnpm add <插件路径>` 并把插件名写进 profile `package.json` 的 `dsh.profile.bundles` 即可。

## 文档

- [`docs/设计草案.md`](docs/设计草案.md)：dsh 平台事实、AnimationSpec IR 设计、事件模型、选型与踩坑
- [`docs/0.2.0-规划.md`](docs/0.2.0-规划.md) / [`docs/0.3.0-规划.md`](docs/0.3.0-规划.md) / [`docs/0.3.x-优化清单.md`](docs/0.3.x-优化清单.md) / [`docs/0.4.0-规划.md`](docs/0.4.0-规划.md) / [`docs/0.5.0-规划.md`](docs/0.5.0-规划.md)：各版本的范围、验收与迭代记录
