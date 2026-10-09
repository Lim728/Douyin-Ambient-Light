# 隐私政策 / Privacy Policy

最后更新：2026-10-07

## 中文

**抖音氛围光**（Douyin Ambient Light，以下简称“本扩展”）是一个为
`https://www.douyin.com/` 的视频添加动态环境光效果的浏览器扩展。

### 本扩展处理的数据

- **视频画面**：本扩展只在你浏览器中打开的 `www.douyin.com` / `live.douyin.com` 页面上运行，
  把正在播放的视频帧绘制到一个 **48 像素**左右的小画布上，读取该小画布的像素、把它切成
  **3×3（或 4×4）个独立采样分区**并逐区计算颜色（分区只在内存里用于空间布局，不会离开本机），
  再用颜色结果绘制背景光。**视频画面仅在本地浏览器中用于颜色分析，不上传视频内容。**
  原始帧不会被保存，小画布在内存中复用，不写入任何存储。
- **封面图（fallback）**：如果浏览器因跨域拒绝读取视频像素，本扩展会尝试把**视频自己的封面图
  （`video.poster`，页面本来就已经加载的资源）**加载到同一块本地小画布上取色。这个请求由你的
  浏览器直接发给抖音 CDN，不经过任何第三方，也不会把图片或颜色发送出去。
- **光晕图层**：默认的“强制覆盖”模式只在页面里创建一个属于本扩展的、`pointer-events: none` 的
  独立图层（Shadow DOM 隔离），不使用、不读取、不上传任何页面内容。
- **扩展设置**：你在弹窗或设置页调整的参数（开关、模糊、强度、饱和度、帧率等）通过
  `chrome.storage.sync` 保存在浏览器自身的同步存储中。该存储由浏览器厂商管理；本扩展不会把
  这些数据发送到任何开发者服务器。

### 本扩展不会

- 收集、上传、出售或与任何第三方分享任何数据；
- 读取你的抖音账号、Cookie、私信、评论、点赞、浏览记录或其他个人信息；
- 使用任何统计、分析（analytics）、埋点（telemetry）、广告或 A/B 服务；
- 连接任何开发者服务器（本扩展没有任何网络请求代码）；
- 下载、上传或修改视频内容，也不修改抖音的播放逻辑、推荐算法或任何账号行为。

### 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存你的设置 |
| `https://www.douyin.com/*`、`https://live.douyin.com/*`（host permissions） | 只在抖音页面上注入内容脚本、读取当前标签页状态；这也是内容脚本 `matches` 所必需的 |

扩展没有申请 `tabs`、`webRequest`、`cookies`、`downloads`、`<all_urls>` 等与功能无关的权限。

### 关于“兼容取色模式”

抖音的视频由 `*.douyinvod.com` 等 CDN 提供。为了让浏览器允许把视频帧画到 canvas 上并读回像素，
扩展会在视频开始加载前为 `<video>` 元素加上 `crossorigin="anonymous"` 属性（仅针对已知的抖音
CDN 域名）。这**不会**改变视频本身，也不会额外发送任何数据：该请求仍然是浏览器对同一个视频
URL 的正常请求，只是以 CORS 模式发出（抖音 CDN 已返回 `Access-Control-Allow-Origin: *`）。
该属性只会加在**尚未开始加载**（`networkState === 0`）的视频上，并且带有看门狗：一旦加了 CORS
之后视频报错，属性会被立即移除，绝不会影响视频播放。即使完全不取色成功，本扩展也会退化为使用
封面图颜色或你在设置里指定的“取色失败底色”，而不会上传任何数据、也不会停止工作。
你可以在设置页关闭“兼容取色模式”，此时扩展不再修改任何页面属性。

### 删除数据

卸载扩展即会删除它保存的全部设置（同步存储中的条目）。你也可以在设置页点击“恢复默认”。

### 变更

如果隐私做法有变化，会更新本文件并在扩展更新说明中告知。本扩展的全部源代码公开，可随时查验。

## English

**Douyin Ambient Light** adds a dynamic ambient light effect to videos on `https://www.douyin.com/`.

- **Video frames** are drawn into a ~48 px canvas inside your browser and read back only to
  compute an average colour. Frames stay in memory, are never stored, and never leave your
  device. There is no network code in this extension.
- **Settings** are stored with `chrome.storage.sync`, which is managed by your browser vendor.
- The extension does **not** collect, transmit, sell or share any data, does not read your
  account, cookies, messages or browsing history, and contains no analytics, telemetry or ads.
- Permissions: `storage` (settings) plus host access to `www.douyin.com` / `live.douyin.com`
  (content script injection and tab status only).
- The optional "CORS compatibility" mode only adds `crossorigin="anonymous"` to `<video>`
  elements whose source is a known Douyin CDN host, before loading starts. Douyin's CDN already
  answers with `Access-Control-Allow-Origin: *`. It is only applied to elements that have not
  started loading yet, a watchdog removes it again if the video errors, and it can be disabled in
  the settings page.
- If pixels cannot be read (cross origin without CORS), the extension falls back to the video's own
  `poster` image and then to a configurable solid colour. Neither leaves your device.
- The default "overlay" layer mode adds one `pointer-events: none` layer owned by the extension
  (isolated in a shadow root) and does not read or modify page content.
