# NOFX 前端主题优化 · 交付总览

> 基于 impeccable 设计规范，对 5 套预制主题进行系统级重构。
> 设计上下文已沉淀至 `.impeccable.md`，作为后续所有前端工作的依据。

## 核心改动

### 1. 字体系统：双字体 + 等宽数字

淘汰 Inter / Microsoft YaHei / 散落 Consolas 等 AI slop 与泛化字体，建立三段式字体系统：

| 角色 | 字体 | 用途 |
|------|------|------|
| 展示字 | **Space Grotesk** | h1/h2 标题、品牌标志、工作台大标题 |
| 正文字 | **IBM Plex Sans** | 正文、UI 文案、按钮 |
| 等宽数字 | **IBM Plex Mono** | 价格、K 线读数、symbol、坐标轴 |

- 字体通过 `index.html` 的 `preconnect` + `display=swap` 加载，避免 FOUT
- 全局 `font-variant-numeric: tabular-nums` + `font-kerning: normal`，行情数字等宽对齐不跳动
- 定义 CSS 变量 `--font-display` / `--font-body` / `--font-mono`，散落的硬编码字体栈全部替换

### 2. 色彩工程：oklch + color-mix

所有 5 套主题的颜色从硬编码 hex 迁移到现代 CSS 色彩工程：

- **oklch 表达**：感知均匀，明度阶梯视觉一致，便于色相统一控制
- **tinted neutral**：中性色加品牌色调（chroma 0.008-0.014），拒绝纯灰/纯黑
- **color-mix 派生衍生色**：`--brand-bg`、`--state-focus`、`--chart-volume-*` 等全部用 `color-mix(in oklch, ...)` 派生，减少手维护
- **深色模式深度**：用 surface 亮度差（oklch 15→22%）做层次，不用发光/阴影堆砌
- **浅色模式深度**：用带色调阴影（oklch 20% / 0.08-0.12）做层次

### 3. 交易色规约：A 股红涨绿跌

**核心翻转**：从加密货币"绿涨红跌"惯例改为中国 A 股"红涨绿跌"，贯穿所有主题：

| 语义 | 原配色（币安惯例） | 新配色（A 股规约） | oklch |
|------|---------|---------|-------|
| 涨 / long / profit / chart-up | 青绿 #00e0a8 | **红** | `oklch(64% 0.21 27)` |
| 跌 / short / loss / chart-down | 红 #ff6b6b | **绿** | `oklch(62% 0.16 145)` |

深色主题与浅色主题的涨跌色明度区分（浅色背景需更深 chroma 保证对比度）。

### 4. 5 套主题色相定位

| 主题 | 背景 hue | 品牌色 | 风格 |
|------|---------|--------|------|
| 深色专业版 | 200 冷蓝绿 | 青绿 hue 165 | 冷峻交易终端 |
| 蓝色现代版 | 240 蓝 | 蓝 hue 250 | 现代简约 |
| 紫色优雅版 | 290 紫 | 紫 hue 295 | 优雅高端 |
| 浅色简约版 | 200 冷蓝绿 | 蓝 hue 250 | 清爽明亮 |
| 绿色经典版 | 150 绿 | 绿 hue 155 | 原版优化 |

## 改动文件

| 文件 | 改动 |
|------|------|
| `.impeccable.md` | 新建，设计上下文（用户/品牌/美学/原则） |
| `index.html` | 加 Google Fonts preconnect + 三套字体 link |
| `src/style.css` | `:root` 全量 oklch 重写 + 字体变量 + tabular-nums + 标题展示字 |
| `src/workspace.css` | 散落 Consolas/Microsoft YaHei 替换为字体变量 + 工作台标题用展示字 |
| `src/themes.js` | 5 套主题全量 oklch + A 股红涨绿跌 + color-mix 重构 |

## 验证

- `npm run build` ✅ 0 错误，CSS 51.65 kB
- Dev server: http://127.0.0.1:5173/

## 如何查看效果

1. 打开 dev server，右上角「主题」下拉切换 5 套主题
2. 观察涨跌色：做多标签为红、做空为绿（A 股规约）
3. 观察字体：标题用 Space Grotesk 几何感，数字用 IBM Plex Mono 等宽
4. 观察色彩层次：深色主题用 surface 亮度差，浅色主题用带色调阴影

## 设计原则（来自 .impeccable.md）

1. 信息密度优先 — 交易终端第一要务是数据可读
2. 克制即专业 — 拒绝发光、毛玻璃、过度动画
3. A 股红涨绿跌 — 涨=红、跌=绿
4. 数字 tabular 等宽 — 行情数字等宽对齐不跳动
5. 现代色彩工程 — oklch / color-mix / light-dark
6. 展示字 + 正文双字体 — 标题有记忆点，正文精致可读
