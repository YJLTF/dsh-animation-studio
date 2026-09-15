# dsh Animation Studio

给 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness/) 做的**教学动画制作工作台**插件：一套内置在教学会话里的"教学视频 agent"。

你用自然语言说"做一支讲梯度下降的 30 秒短片"，AI 就通过 9 个 `anim_*` 工具完成 **分镜 → 时间线 → 动画 → 预览 → 微调 → 渲染出 MP4** 的完整流程——中途可以随时抽查画面、把某个关键帧挪几百毫秒、或者撤销上一步。模型全程不写动画代码，只读写一份数据文档。

基于 **dsh 0.1.5-rc.2**（cordis 4.0.2 / dsh-tools 0.1.5-rc.2）的类型开发与验证，peer 依赖声明为 `>=0.1.5-rc.2`，可无缝配合 [dsh-plugin-offline-packager](https://github.com/YJLTF/dsh-plugin-offline-packager) 打成自包含离线安装包。

---

## 它是怎么工作的

核心思路：**把"时间线"从代码里提出来，变成一份可回放的 JSON IR（AnimationSpec）**，再用 dsh 的扩展点接进平台。

```
模型 ──anim_*工具──▶ AnimationSpec (JSON IR) ──▶ 渲染适配器 ──▶ MP4
                         │                           │
                         └── 每步变更落成 anim/* 事件    └── Motion Canvas（首发）
                             面板 fold 事件即得状态        后续可换 Remotion / Manim
```

模型不写动画代码，只写和改这份数据文档。于是：

- **微调 = 改一个数字**：说"把这个关键帧从 1.2s 挪到 1.8s"，就是一条 JSON Patch，而不是让模型重写 800 行动画代码；
- **换渲染后端不动工具**：工具、事件、UI 只认 IR，Motion Canvas 只是第一个"渲染 Provider"；
- **每一步天然可回放、可撤销、可分叉**：全部状态来自事件流。

## 特性

- **9 个面向模型的工具**：`anim_diagnose`（环境自检）、`anim_create_spec`、`anim_plan`（分镜大纲 + 节奏体检）、`anim_draft_scene`（逐幕写入）、`anim_get`（按 JSON Pointer 精确读取）、`anim_patch`（结构化补丁，返回 inverse）、`anim_undo`、`anim_preview`（降分辨率抽帧）、`anim_render`（整片 MP4）。
- **绝对毫秒时间线 IR**：所有时间都是场景内绝对毫秒，可动画属性统一收进轨道关键帧；内置 linear / easeIn/Out/InOut / cubicBezier / spring 缓动。
- **写入走 JSON Patch（RFC 6902 子集）**：改完整份校验，不通过整批回滚；每次修改同时记录正向 ops 与反向 inverse，撤销不需要重新推理。补丁入参在边界上做收敛校验，坏 op 立刻以可读的报错返回。
- **事件溯源**：spec 的每次变更都是一条自包含事件（`anim/spec-created` / `anim/spec-patched` / …），`foldEvents` 从事件流还原状态——可回放、可 fork，恢复与撤销共用同一份历史。事件载荷在边界上做了深清理，能通过 dsh 的无损 JSON 严格校验。
- **事件不进宿主会话日志，落插件自有 sidecar**：`anim/*` 事件按会话写到 `<outputDir>/sessions/<sessionId>.jsonl`。dsh 的读回路径对未知事件类型 fail-closed（记录须带 `SessionEvent.ignorable` 信封整个会话才可加载），而宿主 0.1.6-alpha.1 的 `session.append` 不提供 ignorable 入口——写会话日志等于毒化该会话（0.2.0 真机事故实证）。恢复时 sidecar 优先；宿主日志里旧版写入的 anim/* 事件用 `scripts/repair-session-log.py` 补标记后仍可作回退来源。
- **开箱即用的 Motion Canvas 渲染**：插件启动时自动挂载渲染 Provider。自动处理 Motion Canvas 3.17 没有官方 CLI、WebGL 上下文、帧落盘子目录、尾部静止提前停帧等一整串坑；渲染超时或中断会显式报错，绝不静默产出残片。渲染前 `anim_diagnose` 会把缺 ffmpeg / 缺浏览器 / 缺中文字体说成可操作的修复建议。
- **渲染默认走后台任务**：宿主提供 `ctx.jobs` 时，`anim_render` 立即返回 jobId 并开始渲染，进度以事件可见，模型用 `job_output` / `job_kill`（dsh-tool-jobs）收集与终止；宿主没有 jobs 服务或任务发布失败时自动退回同步渲染。
- **渲染过程可见**：渲染按序落 `anim/render-start` / `anim/render-progress`（5% 一档节流，不灌水）/ `anim/render-finished` 事件，工作台面板与回放都能重建进度；有头调试模式下浏览器窗口标题栏同时显示进度，渲染完成后自动关闭。
- **会话恢复**：工具执行时按会话**懒恢复**（fold）出工作台状态，含撤销历史——宿主重启、会话重开之后，旧 spec 照常 `anim_patch` / `anim_undo`，不丢不重。事件来源：插件 sidecar 优先，宿主会话日志里的旧 anim/* 事件作回退。
- **渲染器可替换**：渲染能力是一个标准 seam（注册表 + `provideRenderer`），想接 Remotion/Manim 就写一个 Provider 顶掉默认项，工具与事件零改动。
- **离线分发友好**：`dsh.bundle` 声明 + esbuild 单文件构建，工作区内部包用 alias 内联、与包管理器无关，配合 offline-packager 一条命令打成自包含 tgz。

## 包结构

| 目录 | 职责 |
| --- | --- |
| `packages/spec` | AnimationSpec IR：类型、零依赖校验、时间线求值、patch 引擎。纯数据层，host / client 共享 |
| `packages/store` | spec 状态容器：内存 store + 事件流 fold（含撤销历史）。纯逻辑，host / client 共享同一份状态还原 |
| `packages/render-mc` | Motion Canvas 渲染适配器：`codegen.ts`（IR→源码，零渲染依赖）+ `adapter.ts`/`runtime.ts`（vite + 浏览器 + ffmpeg） |
| `packages/tools` | dsh 宿主插件：`anim_*` 工具、spec store、会话事件、渲染 seam |
| `examples/hello-gradient` | 端到端样例：一份中文教学动画 spec → MP4 |
| `scripts/smoke.ts` / `scripts/smoke-host.mjs` | 冒烟测试：纯逻辑冒烟 + 真实 cordis 环境挂载冒烟 |
| `docs/设计草案.md` | 设计与选型记录：dsh 平台事实、AnimationSpec IR 设计、事件模型、实施路线与踩坑 |

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
pnpm build            # esbuild 打包出 lib/index.js

# 挂进你的 dsh profile（web 为例；注意路径用绝对路径）
dsh plugin --profile web add F:\path\to\dsh-animation-studio
```

重启 DSH 后，会话里就会出现 9 个 `anim_*` 工具。

### 方式二：打包成离线安装包（无网络环境）

在**联网机器**上用 [dsh-plugin-offline-packager](https://github.com/YJLTF/dsh-plugin-offline-packager) 打包，推荐直接在 DSH Web UI 里说：

```
请将 F:/path/to/dsh-animation-studio 打包为离线安装包
```

打包器会：复制源码到暂存目录（跳过 node_modules / .git）→ `npm install` 生产依赖（`@deepseek-ai/*` 是 peer，由 dsh 宿主提供，不打入）→ 通过 `bundleDependencies` 把 vite、puppeteer-core、Motion Canvas 等全部运行时依赖闭包塞进 tarball → 出自包含的 `dsh-animation-studio-0.2.0.tgz`。`package.json` 的 `files` 白名单保证包内只有 `lib/` 与 `cordis.patch.yml`，干净且小。

构建环节是免维护的：`build.mjs` 用 esbuild alias 解析工作区内部包，暂存目录里没有 pnpm 软链也能构建——源码目录里**已经跑过 `pnpm build`** 就直接用现成的 `lib/`，没跑过打包器也会自动构建，两种情况都不需要手工干预。

拷到离线机器后：

```bash
dsh plugin --profile web add ./dsh-animation-studio-0.1.0.tgz
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

你会拿到的每个工具回执都带"下一步该做什么"的引导；`anim_patch` 返回的 `inverse` 可以直接喂回给 `anim_patch` 撤销，`anim_undo` 则是它的快捷方式。

### 工具一览

| 工具 | 作用 |
| --- | --- |
| `anim_diagnose` | 环境自检：后端、ffmpeg、浏览器、中文字体 |
| `anim_create_spec` | 新建一份时间线文档，返回 specId |
| `anim_plan` | 记录分镜大纲 + 节奏体检 |
| `anim_draft_scene` | 逐幕写入图层与关键帧 |
| `anim_get` | 按 JSON Pointer 精确读取 spec 片段 |
| `anim_patch` | 结构化补丁修改（唯一写途径），返回 inverse |
| `anim_undo` | 撤销上一次修改 |
| `anim_preview` | 低分辨率抽帧检查效果（只渲染到最晚抽帧点，不渲整片） |
| `anim_render` | 渲染成 MP4（可只渲指定场景抽查；宿主支持时转后台任务，立即返回 jobId） |

### 不装 DSH 也能跑：样例工程

`examples/hello-gradient` 是一条 8 秒的中文教学片《梯度下降：直觉理解》，走通"IR → Motion Canvas 源码 → MP4"全链路：

```bash
pnpm install
cd examples/hello-gradient
node --import tsx scripts/generate.ts   # spec → Motion Canvas 源码（src/ 下）
node --import tsx scripts/render.ts     # 源码 → output/output.mp4（需要渲染环境）
```

## 开发

```bash
pnpm install
pnpm typecheck   # 三个包全量类型检查（对真实 @deepseek-ai/dsh-tools@0.1.5-rc.2 类型）
pnpm build       # esbuild 打包插件 → lib/index.js
pnpm smoke       # 纯逻辑冒烟 + 构建 + 真实 cordis 宿主挂载冒烟（含 rc.2 无损 JSON 事件校验，无需浏览器）
```

冒烟测试覆盖 spec 校验 / patch 可逆 / 时间线展开与截短 / codegen 结构 / store 回滚撤销 / 事件流 fold / 渲染注册表 / 渲染后台化的事件序与同步回退，以及构建产物在真实 cordis 环境里的挂载、执行与会话恢复链路。浏览器渲染链路（vite / puppeteer / ffmpeg）不在冒烟范围内，由 `examples/hello-gradient` 的 `scripts/render.ts` 走与 `anim_render` 完全相同的运行时路径，可当渲染链路的手动诊断入口用。

## 已知限制与说明

- 图层类型目前支持 `text / rect / circle / image`，`group` 预留未实现；不支持的属性会以警告形式降级而不是失败。
- 旁白 / 字幕轨道是 IR 里预留的字段，本轮未实现（涉及 TTS 与音画对齐）。
- **插件事件与宿主会话日志的关系**（0.2.0 真机事故的完整记录）：宿主读回会话时对词汇表外的记录类型 fail-closed——除非该记录带 `SessionEvent.ignorable: true` 信封，否则**整个会话拒读**（报错形如「contains event type … unknown to this harness and not marked ignorable」）。宿主 0.1.6-alpha.1 的 `session.append` API 不提供 ignorable 入口，因此插件任何写入 `anim/*` 事件的构建（0.2.0-rc 之前曾以 `exec.agent.session.append` 落盘）都会让该会话无法再次加载。现行为：事件只写 sidecar；受影响的旧日志用 `python scripts/repair-session-log.py <session.v3.jsonl.zstd>` 修复（自动备份 `.bak`，给 anim/* 记录补 ignorable 标记，已用宿主自身 `Session.fromRestore` 校验通过）。若宿主未来开放 ignorable 写入，可再评估把事件切回会话日志以获得统一的会话导出/回放体验。
- 渲染依赖 Motion Canvas 3.17 的编辑器 UI 自动化（官方无 CLI），单次渲染有约 4 秒的编辑器加载等待，长片渲染耗时以分钟计。Edge 152 起新 headless 配合 SwiftShader 可完整出帧，渲染**默认 headless 无窗口**（`headless: false` 仅作调试后门，Linux 无显示时该模式需要 Xvfb）。后台渲染依赖宿主的 `ctx.jobs` 服务，无此服务时自动退回同步渲染。
- `dsh plugin add` 在部分 Windows 环境会把 pnpm 转发给 cmd 执行；若 cmd 按 PATH 找不到 pnpm（本机实测出现过），直接在 profile 目录里 `pnpm add <插件路径>` 并把插件名写进 profile `package.json` 的 `dsh.profile.bundles` 即可。
