# 前端路由系统改造

## 功能概述

系统现在使用 URL Hash 路由记录页面状态，刷新后自动恢复到之前的页面和参数。

## 实现方式

### 路由格式

```
#/view?param1=value1&param2=value2
```

### 支持的视图和参数

| 视图 | 路由路径 | 支持参数 | 示例 |
|------|---------|---------|------|
| 工作台 | `/workbench` | `symbol`, `interval`, `date` | `#/workbench?symbol=BTCUSDT&interval=1m` |
| 汇总 | `/summary` | `date`, `filter` | `#/summary?date=2026-09-08&filter=OPEN_LONG` |
| 历史记录 | `/history` | `date` | `#/history?date=2026-09-08` |
| 模拟交易 | `/trading-simulation` | 无 | `#/trading-simulation` |
| AI 设置 | `/settings` | 无 | `#/settings` |
| 交易设置 | `/trading` | 无 | `#/trading` |

## 使用场景

### 1. 分享特定币种页面

```
http://localhost:5173/#/workbench?symbol=ETHUSDT&interval=15m
```

直接打开 ETHUSDT 的 15 分钟图表。

### 2. 分享特定日期的汇总

```
http://localhost:5173/#/summary?date=2026-09-07&filter=OPEN_LONG
```

打开 9月7日的汇总页面，筛选做多信号。

### 3. 刷新后保持状态

- 在工作台查看 BTCUSDT，刷新后仍然显示 BTCUSDT
- 在汇总页切换日期和筛选器，刷新后保持相同的日期和筛选器
- 在历史记录页查看特定日期，刷新后保持该日期

### 4. 浏览器前进/后退

- 使用浏览器后退按钮返回之前查看的币种或页面
- 使用前进按钮回到后面的页面
- 完整的历史记录支持

## 技术实现

### Router 类 (`src/router.js`)

```javascript
import { router } from './router.js';

// 导航到新页面
router.push('workbench', { symbol: 'BTCUSDT', interval: '1m' });

// 替换当前页面（不产生历史记录）
router.replace('summary', { date: '2026-09-08' });

// 更新当前页面参数
router.updateParams({ filter: 'OPEN_LONG' });

// 获取当前状态
const state = router.getState();
console.log(state.view, state.params);

// 监听路由变化
const unsubscribe = router.onChange((newState) => {
  console.log('路由变化:', newState);
});

// 浏览器导航
router.back();    // 后退
router.forward(); // 前进
```

### App.vue 集成

#### 1. 页面加载时恢复状态

```javascript
onMounted(async () => {
  const routeState = router.getState();
  activeView.value = routeState.view || 'workbench';

  if (routeState.params.symbol) {
    activeSymbol.value = routeState.params.symbol;
  }
  if (routeState.params.date) {
    historyDate.value = routeState.params.date;
  }
  // ... 其他参数恢复
});
```

#### 2. 监听路由变化

```javascript
router.onChange((newState) => {
  activeView.value = newState.view;
  if (newState.params.symbol) {
    selectSymbol(newState.params.symbol);
  }
  // ... 其他状态同步
});
```

#### 3. 用户操作时更新 URL

```javascript
// 切换视图
@change-view="(view) => {
  activeView = view;
  router.push(view, params);
}"

// 选择币种
async function selectSymbol(symbol) {
  activeSymbol.value = symbol;
  router.updateParams({ symbol });
  // ...
}

// 更新日期
@update:date="(date) => {
  historyDate = date;
  router.updateParams({ date });
}"
```

## URL 参数映射

### Workbench（工作台）

- `symbol`: 当前查看的币种（如 `BTCUSDT`）
- `interval`: K线周期（如 `1m`, `15m`, `1h`）
- `date`: 历史日期（可选，用于查看历史K线）

### Summary（汇总）

- `date`: 查看日期（默认今天）
- `filter`: 筛选器（`ALL`, `OPEN_LONG`, `OPEN_SHORT`, `WAIT`）

### History（历史记录）

- `date`: 查看日期（默认今天）

## 优点

1. **用户体验**
   - 刷新不丢失当前状态
   - 支持浏览器前进/后退
   - 可以复制 URL 分享给他人

2. **开发体验**
   - 简单易用的 API
   - 自动编码/解码 URL 参数
   - 完整的历史记录管理

3. **SEO 友好**
   - URL 包含语义化信息
   - 便于搜索引擎索引

## 示例场景

### 场景 1: 分析师分享交易信号

分析师发现 ETHUSDT 出现做多信号，复制 URL：
```
http://localhost:5173/#/workbench?symbol=ETHUSDT&interval=15m
```

交易员点击链接，直接看到 ETHUSDT 的 15 分钟图表和分析结果。

### 场景 2: 回顾历史表现

交易员想回顾 9月7日的交易信号，访问：
```
http://localhost:5173/#/summary?date=2026-09-07&filter=OPEN_LONG
```

刷新后仍然停留在该日期和筛选条件。

### 场景 3: 调试特定币种

开发者发现某个币种有问题，记录 URL：
```
http://localhost:5173/#/workbench?symbol=IOSTUSDT&interval=1m
```

下次打开浏览器，直接定位到该币种。

## 注意事项

1. **URL 长度限制**：避免在 URL 中存储大量数据（如完整的配置对象）
2. **敏感信息**：不要在 URL 中存储敏感信息（如 API Key）
3. **兼容性**：所有现代浏览器都支持 Hash 路由
4. **默认值**：参数为空或默认值时自动省略，保持 URL 简洁

## 未来扩展

1. **分析结果分享**：支持通过 URL 参数传递分析记录 ID
2. **布局状态**：保存侧边栏展开/折叠状态
3. **自定义视图**：支持用户自定义工作台布局并保存到 URL
4. **深度链接**：支持直接链接到特定的分析记录详情
