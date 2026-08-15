# @tps/fonts

中文字体子集（TP-1-04，设计稿 17.5）。

## 为什么需要这个包

官方 Playwright 镜像**不含中文字体**。不处理的话，PNG 与 PDF 里中文全部是豆腐块
（□□□），而 17.2 的 `data-render-status="ready"` 只等字体**加载**完成、不检测字体是否
**存在** —— 故障会静默通过，任务状态是 `SUCCEEDED`。

## 内容

| 文件                        | 说明                                             |
| --------------------------- | ------------------------------------------------ |
| `src/charset.ts`            | 子集字符集定义（GB 2312 + ASCII + 少量补充符号） |
| `src/families.ts`           | 字体清单、CSS 字体栈、`@font-face` 生成          |
| `assets/*.woff2`            | 9 个子集产物（3 族 × 3 字重），**入库**          |
| `assets/manifest.json`      | 每个产物的 sha256、体积、字符集指纹              |
| `scripts/build-fonts.mjs`   | 下载源字体 → 子集化 → 写 assets                  |
| `scripts/scan-coverage.mjs` | 扫描源码文案，报出子集未覆盖的字符               |

字符集共 7592 个码点：GB 2312 汉字 6763 + 符号区 728 + ASCII 可打印 95 + 6 个补充符号。
单文件 1046–1424 KB（Inter 31 KB），合计 7.3MB。

## 常用命令

```sh
pnpm --filter @tps/fonts fonts:build            # 重新生成子集（需联网，下载 ~42MB 源字体）
pnpm --filter @tps/fonts fonts:scan             # 列出源码文案里未覆盖的字符
pnpm --filter @tps/fonts fonts:scan -- --strict # 同上，有未覆盖字符则退出码 1（CI 用）
pnpm --filter @tps/fonts test                   # 校验入库产物与 charset 一致
```

改了 `charset.ts` 后**必须**重跑 `fonts:build`。忘了重跑时 `assets.test.ts` 会失败 ——
`manifest.json` 里记的字符集指纹与当前 charset 不再相符。

## 系统字体：为什么镜像里还要 apt 安装完整 Noto CJK

子集只含 GB 2312。用户内容里的生僻字（地名如「氹仔」、菜名用字）不在其中。
渲染镜像里额外 `apt-get install fonts-noto-cjk`，作用有两层：

1. **逐字回退**。CSS 栈是 `'Noto Sans SC', 'Noto Sans CJK SC', …` —— 子集在前，
   完整字体在后。子集覆盖的字用子集渲染（体积小、可预期），未覆盖的字逐字回退到
   完整字体，得到字形略有差异但**可读**的结果，而不是豆腐块。
2. **CSS 覆盖不到的元素**。`<input>`、SVG `<text>`、emoji 回退等不受
   `@font-face` 约束，需要系统级字体才有中文字形（17.5 第 3 点的原意）。

顺序不能颠倒：完整字体放前面会让全部文字走系统字体，`@font-face` 的子集形同虚设，
且视觉基线立刻与 CI 不一致 —— 而页面看起来完全正常。`families.test.ts` 守护这一点。

## 与设计稿 17.5 的两处偏离

| 编号 | 17.5 原文                                         | 实际做法                               | 理由                                                                                                                                                                           |
| ---- | ------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | 「子集化后 woff2 与 ttf 各一份，ttf 给 PDF 嵌入」 | 只发 woff2                             | Chromium 导出 PDF 时嵌入的是**它渲染所用**字体的子集，与源文件格式无关 —— woff2 加载的字体一样会被正确嵌入。多发一份 ttf 会给仓库增加约 15MB 二进制，而没有对应的功能收益      |
| D-2  | 「字体安装进渲染镜像的系统字体目录并 `fc-cache`」 | 系统目录装的是 apt 的**完整** Noto CJK | 装子集会让回退字体也缺生僻字，豆腐块风险不变；且系统与 `@font-face` 同名会造成 fontconfig 匹配歧义。装完整字体覆盖范围严格更大，L-04（`fc-list \| grep -ci noto` ≥ 1）同样满足 |

两处偏离都使保证不弱于原设计。设计稿已按 R-15 同步修订。

## 许可

三个字体族均为 **SIL Open Font License 1.1**，允许自托管、子集化、嵌入 PDF 与再分发。
许可全文见 `OFL.txt`（三份版权声明逐一保留，OFL 1.1 第 2 条要求）。

### 为什么子集化后可以沿用原字体名

OFL 1.1 第 3 条只限制**保留字体名**（Reserved Font Name）。三个字体的声明是：

| 字体          | 版权行                           | 保留字体名          |
| ------------- | -------------------------------- | ------------------- |
| Noto Sans SC  | Copyright 2014-2021 Adobe        | `Source`（非 Noto） |
| Noto Serif SC | Copyright 2012 Google Inc.       | 无                  |
| Inter         | Copyright 2020 The Inter Project | 无                  |

Noto Sans SC 的保留名是 `Source`（它派生自 Source Han Sans），我们的产物不含该词，
其余两个没有保留名。因此 `Noto Sans SC` 等原名可以继续使用。

上游来源固定在 `google/fonts` 的 commit `352f6b7d`（见 `manifest.json` 的
`fontsRepoRef`）。用 `main` 会让同一份代码在不同时间构建出不同字体，
视觉基线（TP-1-16）随之在某天突然失败，且与当次改动毫无关系。
