# 基金策略管理 Web 应用（FundPilot）实施计划

## 一、摘要

基于 DeepSeek 分享的「一次性建仓 + 闲置资金补仓」策略，构建一个纯静态、可托管在 GitHub Pages 的移动端 Web 应用（PWA）。核心能力：

1. 手动添加/删除监控基金（输入 6 位代码，自动补全名称与最新净值）
2. 按策略模板设定交易规则（哨兵线、分档补仓、补仓后重算锚点、移动止盈、独立了结）
3. 成本管理（买卖流水、摊薄成本、持仓收益率、补仓成本模拟）
4. 手动一键刷新最新净值（东方财富公开接口，已验证支持 CORS；失败可手动录入）
5. iOS Safari 优先适配（安全区、底部标签栏、16px 输入防缩放、PWA 添加到主屏）

全部数据保存在浏览器 localStorage，无后端、无账号、无数据上传。

## 二、策略要点提炼（作为规则引擎依据，来自分享原文）

- 底仓框架：1 万元底仓，止损 **12%**，**+20% 先卖 40%**，剩余部分采用 **8% 移动止盈**。
- 补仓前置校验：先判断基金逻辑是否破坏（经理变更、风格漂移、清盘风险、指数规则重大调整）；逻辑破坏则不动用补仓资金。应用以「逻辑未坏」确认勾选项承载，不代替用户判断。
- 闲置资金：预留 **20%–30%** 作最终储备，不设自动触发，仅在跌超 20% 的深度回撤时择机启用。
- 补仓分档（以底仓成本为锚，每 5% 一档，金额递增）：
  | 档位 | 触发跌幅 | 金额示例（可补 8000 元） |
  | --- | --- | --- |
  | 第一档 | -5% | 1200 元 |
  | 第二档 | -10% | 2000 元 |
  | 第三档 | -15% | 2800 元 |
  | 最终储备 | -20% 及以下 | 2000–3000 元择机 |
- 补仓后「换锚」：止损/止盈线必须基于**新的平均持仓成本**重算。
  原文示例：10000 元 @1.000 + 1200 元 @0.900 → 平均成本 ≈ 0.989；新止损 ≈ 0.870；新止盈 ≈ 1.187。
- 移动止盈阈值 8% 不随补仓改变，它跟踪持仓期间最高浮盈点。
- 补仓份额可「独立了结」：相对其买入价获得 5%–8% 即优先卖出，回收资金回储备池。

## 三、现状分析

- `/Users/yh/private` 为空目录，无既有代码、无构建配置，属于全新项目。
- 目标托管环境 GitHub Pages 只能提供静态文件，因此**不能有服务端代理**，数据持久化用 localStorage。
- 净值接口验证结果（2026-11-16 实测）：
  - `GET https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=20&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=110022,000001`
  - 返回 `Access-Control-Allow-Origin: *`，浏览器可直接 fetch；字段：`FCODE / SHORTNAME / PDATE / NAV / NAVCHGRT`。
  - 支持一次请求多只基金（`Fcodes` 逗号分隔），适合「一键刷新全部」。
  - `fundgz.1234567.com.cn` 目前返回 404，**不使用**。
  - `api.fund.eastmoney.com/f10/lsjz` 可返回历史净值但无 CORS 头，**不依赖**；历史净值改由本地快照累积。

## 四、技术方案

- 技术栈：原生 HTML + CSS + ES Modules，零构建、零依赖；直接 push 到 GitHub Pages 即可运行。
- 路由：hash 路由（`#/holdings`、`#/fund/:id`、`#/strategy`、`#/about`），无刷新、可前进后退。
- 状态：单一 store + 订阅重渲染；所有写操作立即落 localStorage。
- 视觉：iOS 原生风格（系统字体 `-apple-system`、分组卡片、毛玻璃底部 Tab、深浅色跟随 `prefers-color-scheme`）。
- 部署：分支 `main` 根目录发布；所有资源用相对路径（`./js/...`），兼容 `https://<user>.github.io/<repo>/` 子路径。

## 五、数据模型（localStorage key：`fundpilot.v1`）

```js
{
  version: 1,
  settings: {
    defaultStrategy: {
      stopLossPct: 12,            // 止损线（相对平均成本）
      takeProfitPct: 20,          // 第一层止盈
      takeProfitSellRatio: 40,    // 第一层止盈卖出比例 %
      trailingStopPct: 8,         // 移动止盈回撤
      addTiers: [                 // 分档补仓，金额递增
        { dropPct: 5,  amount: 1200 },
        { dropPct: 10, amount: 2000 },
        { dropPct: 15, amount: 2800 }
      ],
      reserveAmount: 2400,        // 最终储备金额（不自动触发）
      reserveTriggerPct: 20,      // 深度回撤展示阈值
      addPositionSellPct: 6       // 补仓份额独立了结收益
    }
  },
  funds: [{
    id: "uuid", code: "110022", name: "易方达消费行业股票",
    nav: 2.98, navDate: "2026-11-13", navUpdatedAt: 1763... ,
    navHistory: [{ date: "2026-11-13", nav: 2.98 }],   // 每次刷新累积的本地快照
    strategyOverride: null,                           // 部分字段覆盖，null 表示全用模板
    trades: [{
      id, type: "BUY" | "SELL", date, nav, amount, shares, fee,
      source: "BASE" | "ADD", tierIndex: null | 0 | 1 | 2,
      note
    }],
    tierState: [false, false, false],                 // 各档是否已执行
    logicIntact: true                                 // 补仓前置校验勾选
  }]
}
```

存储模块需提供：读取时结构校验与默认值补齐、导出 JSON、导入 JSON（校验 version）、清空数据。

## 六、关键算法（`js/strategy.js`，纯函数，可单元测试）

1. **持仓汇总**
   - `shares = Σ买入份额 − Σ卖出份额`
   - `totalIn = Σ买入金额 + 买入手续费 − Σ卖出金额 − 卖出手续费`
   - `avgCost = shares > 0 ? totalIn / shares : 0`（摊薄成本，与原文示例一致）
   - `marketValue = shares × 最新净值`；`holdingPnl = marketValue − totalIn`；`holdingPnlPct = totalIn > 0 ? holdingPnl / totalIn × 100 : 0`
   - 份额换算：`shares = amount / nav`（未填份额时自动计算，保留 2 位小数展示、全精度存储）
2. **规则线（以当前平均成本为锚）**
   - `stopLossNav = avgCost × (1 − stopLossPct/100)`
   - `takeProfitNav = avgCost × (1 + takeProfitPct/100)`
   - `currentDrawdownPct = (1 − nav / avgCost) × 100`（正数表示浮亏）
3. **分档触发**：跌幅首次 ≥ 某档 `dropPct` 且该档 `tierState` 为 false → 标记「待补仓」。给出该档建议金额与「登记补仓」入口；登记后写入 `ADD` 流水并置 `tierState=true`。支持手动重置档位状态。
4. **移动止盈**：`peakNav = max(navHistory)`（自最近一次减仓/重置后）；当 `peakNav ≥ takeProfitNav` 且 `nav ≤ peakNav × (1 − trailingStopPct/100)` → 「移动止盈触发」，展示峰值、回撤点、剩余份额建议卖出。
5. **补仓模拟器（核心）**：输入拟补金额 `A` 与成交净值 `P`
   - 新份额 `S' = S + A/P`，新成本 `C' = (S×C + A)/S'`
   - 输出新止损 `C'×(1−12%)`、新止盈 `C'×(1+20%)`、成本下降幅度、摊薄后的回本涨幅
6. **补仓独立了结**：对 `source="ADD"` 的批次计算 `(nav / buyNav − 1)×100`，≥ `addPositionSellPct` 时提示「可独立了结」，并提供卖出登记。
7. **测试**：`tests/strategy.test.mjs` 使用 `node --test`。必须覆盖原文示例（10000@1.000 + 1200@0.900 → 0.989 / 0.870 / 1.187，允许 1e-3 误差）、分档触发、移动止盈、卖出后成本。

## 七、文件结构与各文件职责

```
/Users/yh/private/
├── index.html                # 应用外壳：viewport/apple meta、manifest、各视图容器、底部 Tab
├── css/styles.css            # 设计变量、深浅色、卡片/表单/进度条、iOS 安全区与动效
├── js/app.js                 # 启动、hash 路由、事件委托、视图切换、刷新净值流程
├── js/store.js               # localStorage 读写、默认值、导入导出、uuid
├── js/strategy.js            # 纯计算：成本、规则线、档位、移动止盈、模拟器
├── js/quote.js               # 东财 fetch（超时/错误处理）、批量刷新、手动录入入口
├── js/views.js               # 各视图渲染函数（返回 HTML 字符串）
├── js/ui.js                  # 格式化（金额/百分比/日期）、toast、底部弹层、确认框
├── tests/strategy.test.mjs   # node --test 单元测试
├── manifest.webmanifest      # PWA：名称、主题色、standalone、图标
├── sw.js                     # 静态资源缓存（cache-first），API 走 network
├── icon.svg                  # 应用图标（H 型/基金曲线，契合主题）
├── .nojekyll                 # 防止 GitHub Pages 忽略下划线文件
└── README.md                 # 部署步骤、功能说明、数据与免责声明
```

## 八、页面与交互设计

底部 Tab（固定，`padding-bottom: env(safe-area-inset-bottom)`）：**持仓 / 策略 / 数据**。详情页为栈式页面，顶部返回。

1. **持仓页 `#/holdings`**
   - 顶部汇总卡：总投入、总市值、累计盈亏（红涨绿跌，A 股习惯）、今日已更新数量。
   - 基金卡片：名称+代码、最新净值与日期、摊薄成本、持仓收益率，三条进度线（距止损 / 距止盈 / 下一补仓档），状态徽标：`正常` / `接近止损` / `触发补仓` / `触发止盈` / `移动止盈`。
   - 右上「刷新净值」按钮：拉取全部基金，按钮转圈，逐只更新；部分失败 toast 提示并提供手动录入。
   - 右下「＋」悬浮按钮：添加基金（代码 → 自动带出名称/净值；初始底仓金额、成交净值、日期可留空；可选覆盖策略）。
   - 空状态：引导添加第一只基金。
2. **基金详情 `#/fund/:id`**
   - 概览：份额、成本、市值、浮盈、已实现盈亏。
   - 规则线可视化：纵向刻度标出止损线、成本线、止盈线、当前净值，并给出触发距离百分比。
   - 补仓档位表：档位/触发跌幅/触发价（基于成本）/建议金额/状态/「登记补仓」。
   - 补仓模拟器：输入金额与净值 → 即时显示新成本、新止损、新止盈。
   - 交易流水：按日期倒序，标记底仓/补仓批次，补仓批次显示独立收益率与「独立了结」按钮；支持新增买入/卖出、删除错误流水。
   - 策略覆盖开关（覆盖止损/止盈/补仓档位等任意字段，未填即继承模板）。
   - 危险操作：重置档位状态、删除基金（二次确认）。
3. **策略页 `#/strategy`**
   - 全局模板表单：止损%、止盈%、止盈卖出比例%、移动止盈%、补仓档位（可增删/编辑跌幅与金额）、储备金额与深度回撤阈值、独立了结收益%。
   - 表单实时校验（0–100 的百分比、金额 > 0、档位跌幅严格递增）；保存后全局提示，已覆盖的字段不受影响。
   - 策略说明折叠区：简述分档逻辑与「换锚」规则，附原文关键结论，避免用户误用。
4. **数据页** 合并进策略页底部或独立 `#/data`：导出 JSON、导入 JSON、清空全部数据、版本号、免责声明（非投资建议）。
5. **交互细节**：所有危险操作二次确认；表单校验错误就近提示；保存成功轻提示；无后端，不出现登录入口。

## 九、iOS 适配清单（必须逐项落地）

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- `apple-mobile-web-app-capable=yes`、`apple-mobile-web-app-status-bar-style=black-translucent`、`theme-color`（亮/暗两套）
- 布局高度用 `100dvh`，并提供 `100vh` 回退；底部 Tab 使用 `env(safe-area-inset-bottom)`，顶部标题栏用 `env(safe-area-inset-top)`
- 输入框 `font-size: 16px`（防聚焦自动放大）；金额/净值用 `inputmode="decimal"`，代码用 `inputmode="numeric"` + `pattern="[0-9]*"`
- 点击目标 ≥ 44×44px；`-webkit-tap-highlight-color: transparent`；`:active` 反馈替代 hover（`@media (hover: hover)` 才启用 hover）
- `touch-action: manipulation`、`overscroll-behavior-y: contain`、`-webkit-overflow-scrolling: touch`
- 底部弹层用 `padding-bottom: max(16px, env(safe-area-inset-bottom))`，避免被 Home Indicator 遮挡
- 日期使用原生 `<input type="date">`，不做自定义日期控件
- 数字/金额统一由 `ui.js` 格式化，避免长数字撑破卡片（`font-variant-numeric: tabular-nums`）
- PWA：manifest + apple-touch-icon + standalone 显示，添加到主屏后无地址栏

## 十、实施步骤

1. 搭建外壳：`index.html`、`css/styles.css`（设计变量、Tab、卡片、表单、安全区）、hash 路由骨架、空状态。
2. 实现 `store.js`（默认值、读写、导入导出）与 `strategy.js`（全部纯函数），同时写 `tests/strategy.test.mjs` 并跑通 `node --test`。
3. 实现 `quote.js`：批量请求、超时（AbortController 8s）、去重、错误信息、请求后合并 `navHistory`。
4. 实现 `views.js` + `app.js`：持仓页、详情页、策略页、添加基金流程、交易表单、补仓模拟器。
5. 接入刷新净值（全部/单只）与手动兜底录入；处理离线与接口失败态。
6. iOS/PWA 收尾：安全区、动效、manifest、`sw.js`、图标、README、`.nojekyll`。
7. 本地验证并修复：桌面浏览器 + Chrome 设备模拟（iPhone 15 / iOS Safari）+ 手机实机通过局域网访问。

## 十一、部署方式（README 中写明）

1. GitHub 新建仓库，将根目录文件推送到 `main`。
2. Settings → Pages → Source 选择 `Deploy from a branch`，分支 `main`、目录 `/ (root)`。
3. 访问 `https://<user>.github.io/<repo>/`；子路径已通过相对路径适配。
4. 若公司网络屏蔽东方财富接口，应用自动降级为手动录入，不影响其他功能。

## 十二、验证与测试用例

**自动化**
- `node --test tests/strategy.test.mjs` 全部通过，重点断言原文示例（0.989 / 0.870 / 1.187）。

**手工验收**
1. 添加 `110022`：自动带出「易方达消费行业股票」、净值 2.9800、日期 2026-11-13。
2. 录入底仓 10000 元 @1.000，再补仓 1200 元 @0.900：成本 ≈0.989，止损 ≈0.870，止盈 ≈1.187。
3. 将最新净值手动改为 0.875：状态显示触发补仓（跌幅 ≥10% 档）且接近止损；档位表正确序列。
4. 模拟器输入补仓 2000 元 @0.85：新成本、新止损、新止盈即时更新，数值与手算一致。
5. 移动止盈：连续刷新构造峰值 ≥ 止盈线后回落 8%，显示移动止盈触发与建议卖出份额。
6. 刷新净值：在线成功更新全部基金且 `navHistory` 增加；断网时提示失败并可手动录入。
7. 策略页修改全局止损为 10%：未覆盖的基金规则线立即变化，已覆盖的基金不受影响。
8. 导出 JSON → 清空 → 导入：数据完整恢复。
9. iOS Safari：无横向滚动；Tab 不被底部横条遮挡；输入聚焦不放大；返回可正常回退；添加到主屏后独立显示。

## 十三、假设与边界

- 无账号与云同步；换设备/清缓存会丢数据，靠导出/导入 JSON 迁移。
- 仅使用公开净值接口，不做净值估算（接口在非交易时段 `GSZ` 可能为空）；不保证第三方接口长期可用，因此保留手动录入。
- 历史净值通过「每次刷新累积本地快照」获得，首次使用时曲线数据为空，需多日刷新积累；不做图表曲线（V1 用规则线刻度替代），避免依赖不可用的历史接口。
- 分红方式默认「红利再投资」，流水按份额记账；现金分红用户可手动登记为买入份额或调整成本。
- 策略为规则提醒工具，不自动下单，不构成投资建议。
- 不做多用户、不做后端、不做行情推送（iOS Web 推送受限）。

## 十四、非目标

- 不接入券商/基金账户，不实现自动交易。
- 不做 K 线/技术指标、不做组合相关性分析。
- 不做云同步与登录鉴权。
- 不为 Android/桌面做专门布局优化（响应式可正常使用）。
