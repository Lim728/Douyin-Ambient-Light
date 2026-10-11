# 抖音氛围光 · Douyin Ambient Light

为**中国抖音网页版** `https://www.douyin.com/` 的视频播放器添加类似电影院 / Philips Ambilight
的动态环境光：把画面划分成 **3×3 独立采样分区**（可切换 4×4），每个分区分别取色、分别平滑、
分别发光，再在视频周围合成一大片柔和、平滑跟随的高斯模糊光晕。

> 目标站点是**中国抖音（douyin.com）**，不是国际版 TikTok。所有 URL 匹配、DOM 适配与测试都以
> `www.douyin.com` 为准。

- Manifest V3，Chrome / Edge / Chromium 系浏览器
- 只用 `storage` + 抖音域名的 host 权限
- 视频画面**仅在本地浏览器中用于颜色分析，不上传视频内容**
- 无 analytics / 无 telemetry / 无网络请求代码

---

## 1. 效果

| 画面 | 结果 |
| --- | --- |
| 黑暗场景 | 页面背景变成深灰 / 黑色柔光，光晕自然变暗 |
| 蓝色场景 | 视频四周出现蓝色扩散光 |
| 切换成红色 | 背景经过紫 → 红**平滑过渡**，不跳色 |
| 只有左上角是红色 | **只有左上角**出现红色环境光，其余三边保持黑暗 |
| 左侧红色、右侧蓝色 | 左边红、右边蓝，两者不会被平均成紫红 |
| 某一边是纯黑 | 那一边**完全不发光**，不会被相邻分区的颜色污染 |
| 切换视频 / 无限滚动 | 自动跟随当前正在播放的视频 |
| 暂停 | 停止采样，CPU 归零 |
| 关闭插件 | 页面完全恢复原样（不留任何残留属性 / DOM） |

一句话概括空间独立性：**哪里亮就哪里亮，哪里不亮就哪里不亮。**

光晕默认使用**强制覆盖模式（overlay）**：一个固定在视口上的图层画在页面最上层，并把**视频区域
精确镂空**。因此即使抖音用不透明容器、`z-index`、`transform` 制造了自己的层叠上下文，把传统
`z-index: -1` 背景层完全遮住，光晕也一定可见；同时被镂空的视频画面**绝不会被盖住**。也可以在
设置里切回传统的 `z-index: -1`「页面背景」模式。

---

## 2. 安装与构建

```bash
npm install
npm run icons     # 生成 icons/*.png（已提交，通常不需要重新运行）
npm run build     # 产出 dist/（即可加载的扩展目录）

npm run lint      # ESLint
npm run typecheck # tsc --checkJs（JSDoc 校验）
npm test          # Vitest 单元测试
npm run test:e2e  # Playwright 端到端测试（需先 build）
npm run verify    # lint + typecheck + test + build
```

浏览器加载：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 打开右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择本仓库的 `dist/` 目录；
4. 打开 `https://www.douyin.com/` 并播放视频。

---

## 3. 项目结构

```
src/
  manifest.json              扩展清单（MV3）
  content/
    index.js                 内容脚本入口：装配各模块、监听 storage、响应消息
    video-detector.js        视频检测与打分（面积 / 居中 / 播放状态 / e2e 标记）
    color-sampler.js         低分辨率 Canvas 取色、3×3 分区、分辨率自适应、内嵌黑边裁剪
    color-smoother.js        时间平滑（线性光空间的指数插值）
    ambient-renderer.js      光晕渲染（色块网格 + 多层印章 + CSS 合成滤镜）
    animation-controller.js  采样/渲染循环（rVFC、限帧、暂停/隐藏时停止）
    douyin-adapter.js        抖音 SPA 集成（检测调度、祖先透明、全屏、状态）
  main-world/
    cors-patcher.js          MAIN world：让抖音 CDN 视频可被 Canvas 读取
  options/
    options.html/.js        完整设置页（含使用真实渲染代码的实时预览）
    preview-stage.js        预览用的动态场景 + 真实采样/渲染管线
    settings-ui.js          由 OPTION_SCHEMA 生成的设置控件（弹窗与设置页共用）
  popup/
    popup.html/.js          弹窗：状态行 + 主开关 + 光效 / 更多 标签页
  background/
    service-worker.js       键盘快捷键与打开设置页（无状态、无网络）
  shared/
    config.js               默认值、取值域、预设、设置项描述
    color.js                sRGB/线性光转换、线性光颜色混合、hex/rgba 解析
    storage.js              chrome.storage 读写 + 变更订阅（含内存回退）
    utils.js                clamp / debounce / throttle / rAF 合并 / 可见性判断
    messages.js             弹窗 / 后台 / 内容脚本之间的消息常量
  styles/
    content.css             注入到抖音页面的页面样式（透明背景等）
    ui.css                  弹窗与设置页的界面样式
tests/                      单元测试（Vitest）
tests/e2e/                  Playwright 端到端测试 + 抖音卡片结构仿真页
tools/probe-douyin.mjs      对真实 douyin.com 的探测脚本（只打印事实，不做断言）
```

`foto/`（如果存在）只存放本机用的 UI 参考稿截图，已写入 `.gitignore`，既不随扩展分发也不提交到
仓库；运行时代码不会引用里面任何图片。

---

## 4. 实现原理

### 4.1 取色（`color-sampler.js`）

```
<video>  ──drawImage──▶  96×54 / 54×96 小画布  ──getImageData──▶  一次性像素缓冲
                                                                    │
       3×3 分区逐格均值（默认）+ 四边分带均值 + 全画面均值（线性光空间平均） ◀──┘
```

- 画布最长边默认 **96 px**（16:9 横屏 96×54，9:16 竖屏 54×96，共 5184 像素，约 576 像素 /
  分区）；每次采样只做 **一次** `getImageData`。
- **采样分辨率与源分辨率解耦**：缓冲区尺寸只由 `videoWidth / videoHeight` 的**宽高比**决定，
  绝不跟随绝对分辨率。所以 360p / 720p / 1080p / 4K 的单次采样代价完全相同，抖音在后台把
  画质从 720p 切到 1080p 时 CPU / GPU 占用不会跟着涨。切换画质只会重算「源帧 → 缓冲区」的
  映射、分区边界与黑边历史（见 4.5）。
- **分区采样（默认 3×3 = 9 格）**：画面被切成等大的 9 个格子，每个格子单独求均值，得到
  `zones[0..8]`（row-major：`tl tc tr / ml mc mr / bl bc br`）。**没有任何一步把这些格子合成
  成一个全局颜色**，渲染器逐格读取。设置里可以切到 4×4（16 格，中心 4 格不渲染）。
- 同时仍然计算**左 / 右 / 上 / 下四条边缘带**（带宽为画面短边的 26%）与全画面均值，用于诊断
  面板的「主色」显示；由于光晕已经完全由分区驱动，这个主色只作为参考信息。
- 颜色平均在**线性光空间**进行（`shared/color.js`）：物理上等价于真实屏幕发出的光被模糊，
  且不会像在 gamma 空间平均那样整体偏暗。
- 内嵌黑边（上下黑边 / 左右黑边）会先被检测并裁掉，避免光晕发灰；整帧都暗的夜景会被排除在
  检测之外（不会把黑夜误判成黑边），并且需要连续两次检测一致才生效。**只有「细」黑边会被裁**：
  单侧黑边超过画面尺寸的 **1/4** 就一律当成真实内容保留 —— 否则「上排红/绿/蓝 + 下方黑」这类
  画面里，暗的左、右两列会被当成 pillarbox 裁掉，整幅画被挤到中间那一列，分区独立性（哪里亮
  哪里亮，哪里黑哪里黑）就彻底失效了。
- `object-fit` 感知：`cover` 时按实际可见区域裁剪源帧；`contain` 时按视频真实宽高比计算画面矩形，
  竖屏视频放进横向容器时不会把容器黑边当成画面边缘。
- 像素读取失败（跨域）会被捕获并标记 `tainted`，但**不会**让效果消失：渲染器继续工作，先用
  视频封面（poster）颜色、再用设置里的「取色失败底色」，并每 3 秒重试真实像素；诊断面板会显示
  `Canvas sampling: CORS BLOCKED`。

每个分区各自记录 **颜色 + 亮度（`zoneLevel`）+ 发光增益（`zoneIntensity`）+ 平滑状态**。
`zoneLevel` 取 HSV 的「最大通道」而不是 Rec.709 亮度 —— 纯红的亮度只有 0.21，用 luma 会把
一整片红色误判成暗区；最大通道才回答得了「这块画面到底亮不亮」。

### 4.2 平滑（`color-smoother.js`）

```
current = mix(current, target, 1 - exp(-dt / tau))
```

- 帧率无关的指数滤波：无论采样是 5 fps 还是 60 fps，1 秒后的颜色都一致。
- 混合在**线性光空间**进行，因此蓝 → 红会自然经过紫，而不是经过灰。
- 内部使用**浮点通道**，不做 8bit 量化，避免低采样率下因四舍五入而停在目标前一两个色阶。
- `tau` 由「平滑 Smoothness」滑杆控制，0.035 s ~ 1.15 s。
- **每个分区各自平滑**：过滤器对 `zones[0..8]` 逐格迭代，只有时间常数是共享的。因此左边
  突然变红时只有左边渐变，右边纹丝不动；不会出现「一个全局状态把九块绑在一起」。

### 4.3 光晕（`ambient-renderer.js`）

```
div.dal-root (position: fixed; inset: 0)                ← Shadow DOM 宿主，隔离抖音 CSS
  └─ #shadow-root (open)
       canvas.dal-canvas                                ← 低分辨率（长边约 480px）工作画布
       div.dal-noise                                    ← 极淡的抖色，消除暗部色带
```

图层模式（设置项 Layer mode）：

- **overlay（默认，强制可见）**：`z-index: 2147483000`、追加到 `<html>` 末尾，画在页面最上层；
  画完光晕后用 `destination-out` 把视频矩形**镂空**（带 ~11px 羽化），因此永远不遮挡视频；
- **background**：传统方案，`z-index: -1` 位于页面内容之后，配合「透传页面背景」把视频祖先设为
  透明才看得见 —— 一旦抖音的容器不透明就会失效，所以不再是默认值。

所有内联样式都以 `!important` 写入，并且 `canvas` / 抖动层位于 **Shadow DOM** 内，抖音的
`canvas { display: none !important }` 之类的全局重置无法影响它。

每一帧（都发生在很小的工作画布上）：

1. 把 9 个分区的颜色写进一张 **3×3 的「分区点阵」小画布**（每个 texel = 一个分区），
   texel 的 **alpha = 该分区的发光增益**；
2. 把这张点阵按 **16 层递增尺寸、递减透明度**向外盖印；用 `imageSmoothing` 放大点阵，
   离散的 9 个格子就自然过渡成平滑的空间渐变；
3. （仅 background 模式）底色填充；（开启「全页背景」时）用**同一张点阵**（而不是某个全局
   主色）拉伸铺满整页，再叠一个以视频中心为圆心的径向遮罩；
4. 用 `ctx.drawImage` 合成到工作画布，再由 CSS 在合成器上完成
   `blur() saturate() brightness()` 与 `opacity`（强度）；
5. （仅 overlay 模式）把视频区域镂空。

**黑色分区如何真正保持黑暗**（本次升级的核心）：

- `zoneLevel(zone)`（最大通道 / 255）低于「黑电平 Black level」阈值时，`zoneIntensity()`
  直接返回 **0**，于是点阵上那个 texel 的 alpha 就是 0；
- alpha 为 0 的 texel 在放大、盖印、模糊的整条链路上都不会贡献任何像素，**相邻的亮分区
  无法把它染亮** —— 颜色和透明度是逐 texel 独立的，不存在任何全局平均；
- 「分区对比 Zone contrast」控制这条阈值曲线的陡峭程度：越高，暗分区熄灭得越彻底。

缓存与开销控制：

- 重绘与采样同频（≤ 采样帧率，默认 12 fps）；滚动 / 缩放只重新计算矩形并复用缓存颜色，
  不重新读取视频像素；
- 画布长边约 480 px，屏幕上的放大由 GPU 完成，因此每帧代价与**光晕**规模相关，而与屏幕分辨率
  无关；
- 没有为效果创建大量 DOM：整个图层只有 1 个 div + 1 个 canvas + 1 个抖动 div。

### 4.4 循环（`animation-controller.js`）

- 任何时刻只存在**一个**循环；切换视频时先取消旧的 `requestVideoFrameCallback` / timer。
- 优先使用 `requestVideoFrameCallback`：视频暂停、卡顿、标签页不可见时回调自然不再触发，
  此时 CPU 占用**为零**。
- 用时间戳闸门强制「采样帧率」上限（5 / 8 / 10 / 12 / 15 / 20 / 30 / 60 fps）。
- 暂停 / 缓冲时停止采样（可关闭），页面隐藏时停止采样，插件关闭时完全停止。
- 不使用持续运行的 `requestAnimationFrame`；渲染由「采样完成」「滚动」「尺寸变化」驱动，
  并用 rAF 合并。

### 4.5 分辨率 / 画质自适应采样（`color-sampler.js` + `animation-controller.js`）

抖音会在**同一个 `<video>` 元素**上换流：清晰度切换（360p ↔ 720p ↔ 1080p）、媒体源重载、
`load()` 复用元素。`video.videoWidth / videoHeight`（真实媒体分辨率，不是 CSS 尺寸）会随之
变化，并在换流的瞬间掉到 `0`。插件对此的处理：

- **采样缓冲区尺寸只看宽高比，不看绝对分辨率。** `sampleSizeFor(videoWidth, videoHeight)`
  把最长边固定为 96 px，所以 640×360、1280×720、1920×1080 都映射到同一张 96×54 画布，
  单次采样成本**恒定**，高清画质不会让计算量按原始像素数暴涨。
- **只在必要时重算映射。** `ColorSampler.noteMedia()` 记录 `media` / `mediaSignature` /
  `currentSrc`，一旦发现分辨率或媒体源变化就重算「源帧 → 缓冲区」映射、分区边界，并把黑边
  检测的两帧迟滞重置（旧的黑边比例属于上一幅画面）。首个有效帧只建立基线，**不计入切换次数**。
- **绝不重建渲染层。** 换流不会重建 Shadow DOM、不会重建渲染画布、不会重置 UI 状态，也不会
  清空已经生效的颜色 —— 光效不会消失或闪烁。诊断里的 `resolutionChanges` 只用于统计。
- **`videoWidth === 0` 是「还没有帧」，不是错误。** `AnimationController.mediaSize()` 会在
  `videoWidth / videoHeight` 为 0 时回退到**上一次有效**的尺寸，`resolveFrame()` 返回
  `null` 让本次采样跳过；循环**不会**因此 `stop()`，保留最后一帧的颜色与几何，等新画面就绪后
  自动继续。`emptied`（换流开始）也不再丢平滑状态。
- **事件驱动，而不是轮询。** `loadedmetadata` / `durationchange` / `resize` / `seeked` 触发
  `handleMediaChange()`（重算几何 + 唤醒循环）；`loadeddata` / `canplay` / `progress` 触发
  `ensureRunning()`（仅在「本该在跑却没跑」时重启）。循环的 idle 判定只认 `paused / ended`，
  **缓冲不再算 idle** —— 缓冲正是换流时的样子，停循环就会让光晕卡住。
- 采样帧率可选到 **60 fps**：每个 `requestVideoFrameCallback` 周期读一次帧，但读的始终是那张
  96×54 的小画布，不扫描原始像素。

分区独立性、黑色区域保持黑暗、overlay 镂空等行为在换流前后完全不变：换流只改变**映射**，
不改变**算法**。

---

## 5. 抖音适配

### 5.1 视频检测（`video-detector.js`）

抖音是 SPA，`<video>` 会被创建、销毁、复用，同一时刻可能有多个（相邻卡片、预加载、广告、
直播预览）。检测器**不依赖单一 selector**，而是给每个可见 `<video>` 打分：

| 因素 | 权重 |
| --- | --- |
| 视口内可见面积 | 基础分 |
| 覆盖视口中心 | ×2.4 |
| 正在播放（未暂停、未结束、readyState ≥ 2） | ×1.7 |
| 已有可绘制画面（videoWidth > 0） | ×1.15 |
| 时钟真的在前进（`currentTime` 在 1.5 s 窗口内前进 > 25%） | ×1.35 |
| 位于 `[data-e2e="feed-active-video"]` / `[data-e2e="feed-video"]` / `#sliderVideo` 内 | ×1.45 |
| 位于 `.xgplayer` 内 | ×1.2 |
| 是当前全屏元素（或其后代） | ×4 |
| 是上一次使用的元素（防抖） | ×1.25 |

硬性排除：不可见（`checkVisibility` / 计算样式 / 视口裁剪面积为 0）、尺寸小于 96 px、完全没有媒体数据。
同时会扫描播放器类元素的 shadow root（上限 200 个宿主），以应对 Web Component 化。

**为什么用打分而不是固定 selector**：`data-e2e` 与 `.xgplayer` 只是加分项。即使抖音改版把这些
标记全部换掉，扩展也会退化为「面积最大、居中、正在播放的可见视频」，仍然可用，而不是直接失效。

### 5.2 SPA / 视频切换（`douyin-adapter.js`）

同时使用多种低成本信号，全部经过防抖 / 节流：

| 信号 | 作用 | 开销控制 |
| --- | --- | --- |
| `document` 捕获阶段监听 `play/playing/pause/ended/loadedmetadata/loadeddata/emptied/waiting` | 立刻感知播放器状态变化（媒体事件不冒泡，但能到达捕获监听器） | 150 ms 防抖 |
| `MutationObserver(documentElement, {childList, subtree})` | 页面结构变化（切换视频、无限滚动） | 只监听 childList（不监听属性），400 ms 防抖 |
| `ResizeObserver(documentElement + 播放器容器)` | 播放器尺寸变化 / 窗口缩放 / 网页全屏 | 直接标记几何失效 |
| `scroll`（捕获、passive） | 光晕跟随滚动 | 80 ms 节流 + rAF 合并 |
| `fullscreenchange` / `webkitfullscreenchange` | 全屏时把光晕图层移进全屏元素 | — |
| `visibilitychange` | 页面隐藏时停止采样 | — |
| 1500 ms 轮询 | 兜底：任何信号都没触发时仍能找到新视频 | 每次只做一次打分 |

每次更新都会重新检测「当前视频」，如果变了就：解绑旧视频监听、取消旧循环、重置平滑器与黑边状态、
重新标记祖先透明节点。

扩展**完全不依赖页面 URL**：源码里没有任何 `location.pathname` / `search` / `history` 判断，检测只看
「哪个 `<video>` 可见且正在播放」。因此 `https://www.douyin.com/?recommend=1`、`/jingxuan`、
`/video/<id>` 之间的 SPA 跳转（`history.pushState`）都不会影响效果；manifest 的
`matches` / `host_permissions` 使用 `https://www.douyin.com/*`，其中 `/*` 同样覆盖带 query string
的 URL（已在 Playwright 中用真实扩展验证）。

### 5.3 全屏与尺寸

- 全屏时图层被移动到 `document.fullscreenElement` 内部（仍为 `position: fixed`），返回时移回 `body`。
- 全屏元素本身也被设为透明，否则浏览器绘制的不透明背景会遮住光晕。
- 视频的显示矩形每帧都重新读取（`getBoundingClientRect`），因此播放器尺寸变化、网页全屏、
  窗口缩放都会被立即反映；`ResizeObserver` 也会触发一次强制重绘。

### 5.4 让光晕透出来

**overlay 模式（默认）完全不修改抖音页面**：图层是 `position: fixed`、`z-index: 2147483000` 的
独立元素，样式全部内联 `!important` 且放在 Shadow DOM 里，抖音的 CSS 无法隐藏或重排它；视频区域
被镂空，所以既不会被页面遮住，也不会遮住视频。光晕可见性与抖音的 DOM / 层叠上下文无关。

**background 模式**（可切换）才会修改页面：`<html>` 被设为我们自己的底色，`<body>` 与**视频的祖先
链路**（直到 body 为止，跳过 `input/textarea/dialog` 等）被标记 `data-dal-clear` 并设为透明背景。
这些修改是可逆的：关闭插件 / 找不到视频 / 出错时属性会被移除，页面恢复原样。设置页也可以关闭
「透传页面背景」以完全避免修改页面样式。

**「纯黑背景」开关**（可选，弹窗与设置页都有）是唯一会在 **overlay 模式**下写页面的选项：它把视频
祖先链路 + `<body>` + `<html>` 的背景内联设为 `#000000`（`background-image: none`，均为 `!important`），
让光晕落在纯黑的墙面上。写入前会先记录每个元素的原始内联 `background-color` / `background-image`，
而且**只记录一次**，因此反复应用绝不会把自己写进去的黑色当成「原值」而把页面卡死；关闭开关 / 切换
视频 / 关闭插件时逐条还原（原本没有内联值的元素会被 `removeProperty`，回到页面自己的 CSS）。
`<video>` 本身永远不被修改；与视频无关的元素（侧栏、标题、其它卡片）只会在它出现在视频祖先链路上
时才被涂黑，`input / textarea / select / button / [role="dialog"]` 会跳过。在 `background` 模式下页面
不能被涂黑（否则会遮住位于页面之后的光晕），此时开关改为让渲染器的底色填充变成纯黑。

### 5.4.1 找不到视频时：异常回退与调试

- **取色失败不回退为「无效果」**：如果 `drawImage` / `getImageData` 因跨域被拒绝，扩展会依次降级为
  **视频封面（poster）颜色 → 设置里的「取色失败底色」**，并每 3 秒重试真实像素；渲染器始终保持工作。
- **Debug / Force 模式**：设置页「调试」一栏可以忽略视频、直接用固定颜色（红 `#ff0000` / 蓝
  `#0064ff`）绘制光晕，用来单独验证渲染链路。该模式在**没有任何 `<video>` 的页面上也能工作**
  （会用一个居中的合成矩形）。
- **状态 / 诊断面板**：设置页顶部实时显示 `Douyin detected / Video detected / Video playing /
  Video size / Canvas sampling / Ambient renderer / Current color / Sampling resolution /
  Sampling FPS / Pure black background`；其中 **Sampling resolution** 形如
  `媒体 1920 × 1080 → 采样缓冲 96x54（画质切换 2 次）`，
  是排查「换了清晰度之后没光」的第一手信息。内容脚本还会把同一份快照写入
  `<html data-dal-status="…">`（纯 JSON），方便在 devtools 里直接查看；当前挂载的图层另写在
  `<html data-dal-layer="overlay|background">`，与诊断快照分开，互不覆盖。

### 5.5 跨域取色（CORS）

抖音视频来自 `*.douyinvod.com` 等 CDN。本项目用 HEAD + `Origin: https://www.douyin.com` 实测确认：

```
access-control-allow-origin: *
access-control-allow-methods: GET,HEAD,POST,OPTIONS
access-control-allow-headers: range
```

因此 `main-world/cors-patcher.js` 会在 `document_start`（页面脚本之前）把
`crossorigin="anonymous"` 加在**即将开始加载**的 `<video>` 上：

- 通过劫持 `HTMLMediaElement.prototype.src` 的 setter、`Element.prototype.setAttribute`、
  `HTMLSourceElement.prototype.src`，保证属性早于 `src` 生效（事后修改 `crossorigin` 会重新开始
  加载，所以时机很关键）；
- 通过 `MutationObserver` 覆盖「HTML 里已经带 src」的情况；
- 只对白名单内的抖音域名生效；
- 带**看门狗**：如果加了 CORS 之后视频报错，立即移除该属性让页面恢复，绝不会让视频播不了。

真实页面探测（`tools/probe-douyin.mjs`）显示，抖音页面上的 `<video>` 元素本身就已经带有 `crossOrigin: "anonymous"`，
所以这个补丁主要是兜底。设置页可以关闭「兼容取色模式」，此时扩展完全不修改页面属性。

**万一仍然读不到像素（CORS 被拒）也不会失效**：取色结果会按
`video 画面 → video.poster 封面 → fallbackColor 纯色` 的顺序降级，渲染链路继续工作，并每 3 秒重试
一次真实画面。同时看门狗保证：一旦加了 `crossorigin` 导致视频报错，属性会被立刻移除，视频照常播放；
`prepare()` 也只会作用于**尚未开始加载**（`networkState === 0`）的元素，避免打断正在进行的请求。

---

## 6. 设置

弹窗按参考稿分成三块：顶部状态行 + 主开关，两个标签页 **光效**（模糊 / 强度 / 扩散 / 平滑 /
分区对比）与 **更多**（采样频率 / 全页背景 / 纯黑背景），底部是「全部设置」按钮与快捷键。
设置页提供全部 22 项，并带有**使用真实采样 + 渲染代码**的实时预览
（每 6 秒切换一次场景，用来观察过渡是否平滑）。

| 设置 | 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| Ambient Light | 开/关 | 开 | 总开关，关闭后立即停止取色并还原页面 |
| Layer mode 图层模式 | 强制覆盖 / 页面背景 | 强制覆盖 | 强制覆盖 = 画在页面最上层并把视频镂空（必定可见） |
| 分区数量 Zones | 3×3 / 4×4 | 3×3 | 画面被切成多少块独立采样区，每块单独取色、单独发光 |
| Blur 模糊 | 0–100 | 62 | 光晕柔和程度 |
| Intensity 强度 | 0–200% | 110 | 整体亮度 |
| Spread 扩散 | 0–100 | 62 | 光晕向四周扩散的距离 |
| Saturation 饱和度 | 0–200% | 125 | 色彩浓度 |
| Brightness 亮度 | 0–200% | 104 | 明暗 |
| Smoothness 平滑 | 0–100 | 72 | 颜色跟随的缓冲时间 |
| Zone contrast 分区对比 | 0–100 | 72 | 分区之间的明暗对比：越高，暗的分区越彻底熄灭 |
| Black level 黑电平 | 0–100 | 15 | 低于该亮度的分区视为纯黑、不发光 |
| Sampling FPS 采样帧率 | 5/8/10/12/15/20/30/60 | 12 | 每秒读取画面的次数（60 需要更强的 GPU） |
| Full-page background | 开/关 | 开 | 是否让颜色铺满整个页面背景 |
| 纯黑背景 Pure black background | 开/关 | 关 | 把视频周围的背景刷成纯黑 `#000000`；关闭后恢复页面原本的背景 |
| 暂停时降频 | 开/关 | 开 | 暂停 / 缓冲时停止采样 |
| 裁剪黑边 | 开/关 | 开 | 忽略内嵌黑边 |
| 透传页面背景 | 开/关 | 开 | 是否把视频祖先背景设为透明 |
| 兼容取色模式 | 开/关 | 开 | 是否允许给视频加 `crossorigin` |
| 背景底色 | 颜色 | `#0b0b10` | 光晕之外的页面底色 |
| 取色失败底色 Fallback | 颜色 | `#3a5a8c` | CORS 禁止读取像素时使用的环境光底色 |
| 调试：强制光晕 | 开/关 | 关 | 忽略取色，直接用调试颜色绘制光晕（渲染链路自检） |
| 调试颜色 | 颜色 | `#ff0000` | 调试模式使用的颜色（红 `#ff0000` / 蓝 `#0064ff`） |

预设：**影院**（默认）、**浓郁**、**轻淡**、**省电**。所有设置通过 `chrome.storage.sync`
保存（拖动滑杆时先本地即时生效，停止拖动 350 ms 后写一次，避免触发 sync 写入配额）。

快捷键：`Alt+Shift+A` 开关氛围光。

---

## 7. 性能

| 措施 | 说明 |
| --- | --- |
| 限制采样帧率 | 时间戳闸门，5–60 fps 可选，默认 12 |
| 分辨率无关的取色画布 | 取色画布最长边固定 96 px（96×54），代价与源分辨率（360p / 1080p / 4K）无关 |
| 画质自适应零重建 | 换流只重算「源帧 → 缓冲区」映射，不重建渲染层、不清空颜色 |
| 低分辨率渲染画布 | 渲染画布最长边约 480 px |
| 只在播放时处理 | 使用 `requestVideoFrameCallback`，暂停 / 卡顿 / 隐藏时回调不再触发 |
| 暂停降频 | 监听 `pause/waiting/ended`，默认直接停止循环 |
| 页面隐藏停止 | `visibilitychange` |
| 关闭即停止 | 关闭总开关会 `stop()` 循环、`cancelAnimationFrame`、移除图层 |
| 单循环保证 | 模块级单例 + 切换视频时取消旧回调；全文档只有一个控制器 |
| 少 DOM | 只有 1 个 div + 1 个 canvas + 1 个抖动 div，无节点抖动 |
| 监听节流 | MutationObserver 只监听 childList 且 400 ms 防抖；scroll 80 ms 节流；媒体事件 150 ms 防抖 |
| 几何与取色分离 | 滚动 / 缩放只重算矩形并复用缓存颜色，不读取视频像素 |
| 合成器承担模糊 | 高斯模糊 / 饱和度 / 亮度 / 强度都在 CSS 上，由 GPU 完成 |

端到端测试中实测：暂停 1.5 秒后画布内容完全相同（采样确实停止）。

---

## 8. 开源调研与许可证

开发前调研了 GitHub / npm 上已有的同类实现，结论：

| 项目 | 许可证 | 结论 |
| --- | --- | --- |
| [WesselKroos/youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) | MIT（LICENSE 文件为 MIT；`package.json` 写的是 ISC） | **参考核心算法**：低分辨率画布 → 多层向外投影 → 整体模糊；线性光混合 |
| [Miruko2/bilibili-ambient-light](https://github.com/Miruko2/bilibili-ambient-light) | MIT | **参考实现思路**：`z-index: -1` 光晕层 + 祖先透明；黑边检测；暂停/隐藏停止采样 |
| [iceorange-dev/bilibili-ambilight](https://github.com/iceorange-dev/bilibili-ambilight) | MIT（youtube-ambilight 的 B 站移植） | 代码体量大、与 YouTube DOM 深度耦合，不适合直接复用 |
| [isxlan0/DouYinPlus](https://github.com/isxlan0/DouYinPlus) | MIT | 用于确认抖音页面标记 `data-e2e="feed-active-video"` / `.xgplayer` / `#sliderVideo` 长期稳定存在 |
| [pansoul1/douyin-web-enhancer](https://github.com/pansoul1/douyin-web-enhancer) | MIT | 同上，另外确认了 `.xgplayer-playswitch` |
| npm 上的 `ambient-light*` 包 | — | 均为 OS 光线传感器 / VR 光照，与本需求无关 |

上面这些项目在本项目里只作为**算法思路与页面结构**的参考：本项目的取色、平滑、渲染、视频
检测、SPA 调度、CORS 兼容与页面样式方案都是为抖音重新编写的，上游的 WebGL 投影器、
YouTube / B 站专用 DOM 逻辑、Sentry 上报等都无法直接用于抖音。

按 MIT 许可要求，相关版权与许可声明保留在 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。
本项目自身以 **MIT 许可证**发布，版权归 **Lim728**，完整许可证文本见 [`LICENSE`](./LICENSE)；
仓库地址：<https://github.com/Lim728/Douyin-Ambient-Light>。

> 说明：`youtube-ambilight` 也提供了可用于抖音的间接思路，但其 `package.json` 标注 ISC、
> LICENSE 文件标注 MIT。本项目按其 LICENSE 文件（更宽松的 MIT）理解并保留 MIT 声明。

---

## 9. 测试

### 单元测试（Vitest，133 个用例）

覆盖颜色数学（线性光混合、饱和/亮度、hex 解析）、设置归一化与钳制、storage 读写与订阅、
采样缓冲区算术（亮度剖面、黑边检测、四边分带、**3×3 逐格均值与中心格排除**、`object-fit` 裁剪）、
时间平滑（帧率无关性、单调收敛、紫中间色、**逐分区独立平滑**、分区状态不被丢弃）、
分区亮度门限（`zoneLevel` / `zoneIntensity` / 黑电平）、
分辨率自适应（640×360 / 1280×720 / 1920×1080 / 720×1280 都映射到同一张固定缓冲、同画面在不同
分辨率下分区完全相同、360p ↔ 1080p 互切不重建画布、`videoWidth = 0` 不崩溃且保留上一次有效值、
媒体源切换后重置黑边历史）、
视频打分（可见性、面积、播放状态、时钟前进、e2e 加分、防抖、shadow DOM），
以及取色失败时的降级链（fallback 底色 → poster 封面 → 每 3 秒重试）与 Debug / Force 渲染。
**「纯黑背景」开关单独一组**：开启后只涂黑视频祖先链路 + `<body>` + `<html>`、不碰 `<video>`、
不碰第二个播放器、不碰无关元素；重复应用不会把自己写的黑色记录成原值；关闭时逐条还原（原本没有
内联背景的元素回到「没有内联背景」）；页面在扩展持黑期间改写自己的背景时不会被旧快照覆盖；
视频切换时旧链路还原、新链路涂黑；`background` 模式不涂黑页面。

### 端到端测试（Playwright，62 项检查）

`tests/e2e/run.mjs` 用 Playwright 启动真实 Chromium 并加载构建产物 `dist/`，
再把 `https://www.douyin.com/` 与 `https://live.douyin.com/` 的所有请求（含 query string）重定向到仿真页 `tests/e2e/harness.html` —— 也就是说
**URL 匹配、内容脚本注入、MAIN world 脚本都是按真实规则执行的**。仿真页复刻抖音卡片结构
（`data-e2e="feed-active-video"` > `.xgplayer` > `<video>`），视频源是 `canvas.captureStream()`，
因此画面内容可控。

检查项包括：在 `https://www.douyin.com/?recommend=1` 上激活、`history.pushState` 路由变化后效果不失效、host 权限能匹配带 query string 的标签页、默认使用强制覆盖模式、高 `z-index`（2147483000）图层挂在 `<html>` 的 Shadow DOM 内、overlay 模式完全不修改页面背景、**图层自身保持透明（不会挡住抖音界面）**、蓝色场景变蓝、光晕确实绘制在视频周围、视频区域被镂空（`inside=0`）、
**空间独立性 A–G 七个场景**（整屏纯黑 → 所有分区熄灭；左上纯红 / 右上纯蓝 → 只有对应角发光；
左红右蓝中间黑 → 左右各自保持颜色且中间无光污染；上白下黑 → 上亮下暗；整屏纯白 → 整圈均匀；
上排红绿蓝 → 三块各保持自己的颜色），
同时存在两个播放器时只跟随可见的那个（另一个在屏幕外，涂成绿色也不会被采样）、
切换颜色后**先保持蓝色再过渡到红色**（验证平滑）、暂停后画布完全静止、播放后恢复采样、
播放器被销毁重建后仍能跟随、诊断快照写入 `<html data-dal-status>`、service worker 注册、弹窗状态、

**分辨率 / 画质切换**（同一张画面、同一个 `<video>` 元素依次切到 640×360 → 1920×1080 →
1280×720）：媒体分辨率被正确读到、采样缓冲恒为 `96x54`、渲染画布**没有被重建**、切换次数被统计、
每次切换后「左上红 / 右上蓝 / 下方黑」的分区仍然各自独立、播放不中断、光晕继续跟随画面。

弹窗写设置、Debug 红色 / 蓝色强制渲染、关闭后页面完全还原、
**弹窗布局**（主开关 + 光效 / 更多 两个标签页、光效页正好是 5 个滑杆且滑杆带实时填充、
切到更多页才显示采样频率 / 全页背景 / 纯黑背景、状态点颜色）、
**「纯黑背景」开关**（弹窗中存在且默认关闭、点击后写入 storage 并真的把页面涂黑、再点一次恢复
`rgb(22, 24, 35)` 原始背景、播放器重建后无残留标记、关闭开关后光晕仍在运行）、
设置页预览真实渲染、22 个设置项齐全、16 行诊断面板、移除全部播放器后页面完全还原、无控制台错误。

运行：

```bash
npm run build
npm run test:e2e
```

### 真实站点探测

`node tools/probe-douyin.mjs [url]` 会用加载了扩展的真实浏览器访问 douyin.com 并打印事实
（视频元素数量、被选中的视频、`getBoundingClientRect` / 计算样式 / 父链、画布是否可读、
图层与镂空状态、`data-dal-status` 快照等）；加 `--debug` 还会用扩展自身的 storage 强制红 / 蓝
调试色并截图。
本次开发环境（非中国大陆 IP）访问 `https://www.douyin.com/` 时，站点重定向到 `/jingxuan`（抖音精选），
播放器资源因网络/地区限制未能加载（页面只有 1 个 `height: 0`、无 `src` 的占位 `<video>`）。
在这种情况下扩展表现符合预期：不修改页面、不加 `data-dal`、无控制台错误、CPU 无占用。
不过在**真实的 `www.douyin.com` 域名 + 真实页面 CSS** 下，`--debug` 强制渲染已经实测成功：
`#ff0000 → 平均色 [254,0,0]`、`#0064ff → [0,101,254]`，截图 `probe-force-ff0000.png` /
`probe-force-0064ff.png` 可见「深色页面上一圈柔和光晕、中间视频区域被完整镂空」。
而真实播放器取色链路的最终确认需要在可正常播放抖音视频的网络环境中用
`node tools/probe-douyin.mjs --debug` 复核。

> **为什么会出现「装上了但没有光」？** 分区渲染切换到 3×3 点阵后，时间过滤器里的分区数组
> 曾被以错误的形状传递（把「分区数组」当成「整个颜色状态」读），于是 `zones` 被静默丢弃、
> 冻结在第一次采样的值上。抖音真实页面里，视频元素刚创建时的第一帧常常是黑的，分区就永远
> 冻在黑色 → **完全没有光**。同时全局主色仍在正常更新，所以诊断面板看起来一切正常，测试也只
> 检查了「有没有光」而没有检查「每一格是否各自独立」，因此没有被发现。
> 现已修正（并对该行为补了 4 个单元测试 + 7 个端到端场景）。
> 遇到类似「完全没有光」的问题时，请先打开设置里的 **调试：强制光晕 Debug / Force**：
> 出现红色光晕说明渲染层正常，问题在取色链路；没有光晕说明图层被隐藏。

---

## 10. 已知限制

- **跨域**：如果抖音未来更换 CDN 且不再返回 `Access-Control-Allow-Origin`，canvas 将无法读取像素，
  此时扩展**不会失效**：它会降级为封面图颜色 / 「取色失败底色」，并每 3 秒重试；诊断面板会显示
  `Canvas sampling: CORS BLOCKED`。视频播放始终不受影响。
- **纯黑画面**：整帧为黑时不会检测黑边，此时光晕自然变暗（符合预期）。
- **极高的模糊 / 扩散值**：在低端设备上将 Blur、Spread、Intensity 全部拉满、同时把采样帧率设为
  60 fps 会明显增加 GPU 负担（默认 12 fps；RTX 3050 级别显卡开 30 fps 无压力），建议使用「省电」预设。
- **live.douyin.com**：直播页也在匹配范围内，但未做针对性适配（直播弹幕、礼物特效等区域不会被
  特殊处理）。
- **排查顺序**：1) 看设置页诊断面板的 `Video detected / Video playing`；2) 打开「调试：强制光晕」
   确认渲染层；3) 若 `Canvas sampling: CORS BLOCKED`，说明视频像素不可读，此时会使用封面图 /
   「取色失败底色」，光晕仍然存在但不再跟随画面。

## 11. English summary

Manifest V3 extension that adds a cinema style ambient light to videos on the Chinese Douyin web
player (`https://www.douyin.com/`). The playing `<video>` is picked by a score based detector,
downscaled to a 96 px canvas, read back once per sample (5–60 fps, configurable), split into a 3x3
grid of **spatially independent zones** (optionally 4x4), averaged per zone in linear light. Every
zone keeps its own brightness gate and its own smoothing state, so a bright zone can never tint a
black one and only the zones that actually carry light glow. The zones are baked into a tiny texture
(one texel per zone, alpha = glow gain), stamped outwards and softened into a wide gaussian halo.
The sampling buffer is sized from the *aspect ratio* only, so a Douyin quality switch (360p -> 720p
-> 1080p, or a source swap on the same `<video>`) never changes the sampling cost: only the
source -> buffer mapping and the zone boundaries are recomputed, the renderer is never rebuilt, and
a transient `videoWidth === 0` keeps the last valid frame instead of stopping the loop.
The default layer mode paints a
`position: fixed` layer above the page inside a Shadow DOM and punches the video rectangle out of it,
so the glow stays visible no matter how the page stacks its own boxes, while the player itself is
never covered. If the pixels cannot be read (cross origin without CORS) the effect degrades to the
video poster colour and then to a configurable fallback colour instead of disappearing, and a
Debug / Force mode plus a live diagnostics panel make the whole chain easy to verify. All pixel work
happens locally; the extension contains no network code, no analytics and no telemetry.
Build with `npm run build` and load `dist/`. See `THIRD-PARTY-NOTICES.md` for the MIT licensed
projects whose algorithms inspired this implementation.
