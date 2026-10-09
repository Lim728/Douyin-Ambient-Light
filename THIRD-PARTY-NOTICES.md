# 第三方组件与参考实现 / Third-party notices

本项目的全部运行时代码均为自行编写，**不包含任何第三方运行时依赖**（`package.json` 没有
`dependencies`，`src/` 里也没有任何 npm 包的 `import`，打包产物 `dist/` 中不含第三方代码）。
开发期依赖（esbuild / eslint / @eslint/js / globals / vitest / jsdom / typescript /
playwright-core）仅在构建与测试时使用，不随扩展分发，其许可证见各自的
`node_modules/<pkg>/LICENSE`。

设计过程中参考了以下 MIT 许可的开源项目，参考的是它们的**算法思路与页面结构**：本项目
针对抖音重新编写了自己的实现。由于参考了其核心思路，按照 MIT 许可的要求在此保留它们的
版权与许可声明（保留声明本身不构成对本项目新增的授权义务）。

如果你认为本仓库中还包含其他应当归属的项目，请开一个 Issue，我们会立刻补充声明。

---

## 1. Ambient light for YouTube — Wessel Kroos

- 仓库：https://github.com/WesselKroos/youtube-ambilight
- 许可证：MIT
- 版权：Copyright (c) 2017 Wessel Kroos

**本项目参考的部分**

- 「把视频帧缩小绘制到小画布，再投影成多层向外扩张的光晕，最后整体模糊」这一整体管线。
- 「颜色混合必须在近似线性光空间中进行，而不是在 gamma 编码的 sRGB 字节上直接插值」的处理方式。
- 「只读取低分辨率画布，避免逐帧读取全分辨率视频帧」的性能策略。

我们的实现是重写的：颜色采样改为**四边分带取色**（上/下/左/右 + 全画面均值），渲染改为
低分辨率 Canvas + 四角色块网格 + 多层印章 + CSS 合成滤镜，与上游的 WebGL 投影器无关。

```
MIT License

Copyright (c) 2017 Wessel Kroos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. B站氛围光 / Ambient Light for Bilibili — Miruko2

- 仓库：https://github.com/Miruko2/bilibili-ambient-light
- 许可证：MIT
- 版权：Copyright (c) 2026 Miruko2

**本项目参考的部分**

- 「把光晕层放在 `z-index: -1` 的固定定位元素上，并把视频祖先链路的背景设为透明」这一让光晕
  能透出到页面背景的 DOM 方案（本项目使用 `data-dal-clear` 属性 + 注入样式表实现）。
- 内嵌黑边（letterbox / pillarbox）检测的思路：比较四边缘的亮度、对全局偏暗的画面直接放弃
  检测、连续两次结果一致才生效。
- 暂停 / 缓冲时停止采样、页面不可见时停止采样的节能策略。

```
MIT License

Copyright (c) 2026 Miruko2

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. 抖音 DOM 相关的公开资料

抖音页面结构（`data-e2e="feed-active-video"`、`.xgplayer`、`#sliderVideo` 等标记）来自对
`https://www.douyin.com/` 的公开页面结构与社区里公开的用户脚本的观察，只借鉴了这些标记名：

- https://github.com/isxlan0/DouYinPlus (MIT) — 用于确认 `data-e2e="feed-active-video"` /
  `.xgplayer` / `#sliderVideo` 在真实页面上长期稳定存在。
- https://github.com/pansoul1/douyin-web-enhancer (MIT) — 同上（`[data-e2e="feed-active-video"]`、
  `.xgplayer`、`.xgplayer-playswitch`）。

本项目对这些标记只作为**加权提示**使用，取不到时会退化为「面积最大且正在播放的可见视频」。

---

## 4. 调研过、但未使用的项目 / Reviewed but not used

以下项目在立项调研阶段被查看过，最终**没有**在本项目中使用其任何代码，仅在此完整记录，
以免留下来源不明的印象：

- [iceorange-dev/bilibili-ambilight](https://github.com/iceorange-dev/bilibili-ambilight)
  — MIT（`LICENSE` 文件保留原始版权 `Copyright (c) 2017 Wessel Kroos`）。它是
  youtube-ambilight 的 B 站移植版，代码体量大且与 YouTube / B 站 DOM 深度耦合，不适合直接
  复用；本项目的渲染与取色均未采用它的实现。
- npm 上的 `ambient-light` / `ambient-light-sensor` 等包 — 均为操作系统光线传感器或 WebXR
  光照估算，与「视频边缘取色」需求无关，未引入任何依赖。
