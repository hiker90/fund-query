import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY,
  DEFAULT_ASSET_TARGETS,
  STRATEGY_PRESETS,
  classifyAssetClass,
  computeFundMetrics,
  computePosition,
  computeThreeAssetAllocation,
  computeValuationLevel,
  recommendAssetScheme,
  resolveStrategyByKey,
  simulateAdd,
  summarizeAttention,
  validateStrategy
} from '../js/strategy.js';
import { VERSION, normalizeState } from '../js/store.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function close(actual, expected, tolerance = 1e-6, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label || '数值'} 期望 ${expected}，实际 ${actual}`
  );
}

function fundWith(trades, overrides = {}) {
  return {
    id: 'f1',
    code: '110022',
    name: '测试基金',
    nav: 1,
    navDate: '2026-11-13',
    navHistory: [],
    strategyOverride: null,
    trades,
    tierState: [],
    logicIntact: true,
    ...overrides
  };
}

const buy = (date, nav, amount, extra = {}) => ({
  id: `${date}-${amount}`,
  type: 'BUY',
  date,
  nav,
  amount,
  shares: amount / nav,
  fee: 0,
  source: 'BASE',
  tierIndex: null,
  closed: false,
  createdAt: 1,
  ...extra
});

test('摊薄成本与原文示例一致：10000@1.000 + 1200@0.900 → 0.989', () => {
  const position = computePosition([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })]);
  close(position.cost, 11200, 1e-6, '剩余本金');
  close(position.avgCost, 11200 / (10000 + 1200 / 0.9), 1e-9, '平均成本');
  close(position.avgCost, 0.989, 1e-3, '平均成本对照');
});

test('补仓后规则线换锚：止损 0.870、止盈 1.187', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })]);
  fund.nav = 0.9;
  const metrics = computeFundMetrics(fund, DEFAULT_STRATEGY);
  close(metrics.avgCost, 11200 / (10000 + 1200 / 0.9), 1e-9, '平均成本');
  close(metrics.stopLossNav, metrics.avgCost * 0.88, 1e-9, '止损线');
  close(metrics.stopLossNav, 0.87, 1e-3, '止损线对照');
  close(metrics.takeProfitNav, metrics.avgCost * 1.2, 1e-9, '止盈线');
  close(metrics.takeProfitNav, 1.187, 2e-3, '止盈线对照');
});

test('下跌 6% 触发第一档补仓，未触发第二档', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })]);
  fund.nav = 0.94;
  const metrics = computeFundMetrics(fund, DEFAULT_STRATEGY);
  assert.equal(metrics.triggeredTiers.length, 1);
  assert.equal(metrics.triggeredTiers[0].index, 0);
  assert.equal(metrics.status, 'add');
  assert.equal(metrics.nextTier.index, 1);
});

test('补仓档位以底仓成本为锚，不随摊薄成本漂移', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })]);
  const metrics = computeFundMetrics(fund, DEFAULT_STRATEGY);
  close(metrics.baseCost, 1, 1e-9, '底仓成本');
  close(metrics.tierAnchor, 1, 1e-9, '档位锚');
  close(metrics.tiers[0].triggerNav, 0.95, 1e-9, '第一档触发净值');
  close(metrics.tiers[1].triggerNav, 0.9, 1e-9, '第二档触发净值');
});

test('卖出后成本和已实现收益正确', () => {
  const position = computePosition([
    buy('2026-01-01', 1, 10000),
    {
      id: 's1',
      type: 'SELL',
      date: '2026-03-01',
      nav: 1.2,
      amount: 4800,
      shares: 4000,
      fee: 0,
      source: 'BASE',
      createdAt: 2
    }
  ]);
  close(position.shares, 6000, 1e-6, '剩余份额');
  close(position.cost, 6000, 1e-6, '剩余成本');
  close(position.avgCost, 1, 1e-9, '卖出后成本');
  close(position.realized, 800, 1e-6, '已实现收益');
});

test('补仓模拟器重算成本与规则线', () => {
  const position = computePosition([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })]);
  const result = simulateAdd(position, 2000, 0.85, DEFAULT_STRATEGY);
  const expectedShares = 10000 + 1200 / 0.9 + 2000 / 0.85;
  const expectedCost = 13200 / expectedShares;
  assert.equal(result.valid, true);
  close(result.newShares, expectedShares, 1e-6, '补仓后份额');
  close(result.newAvgCost, expectedCost, 1e-6, '补仓后成本');
  close(result.newStopLossNav, expectedCost * 0.88, 1e-6, '新止损线');
  close(result.newTakeProfitNav, expectedCost * 1.2, 1e-6, '新止盈线');
});

test('移动止盈：峰值达到止盈线后回撤 8% 触发', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000)], {
    nav: 1.18,
    navHistory: [
      { date: '2026-10-01', nav: 1.3 },
      { date: '2026-11-01', nav: 1.18 }
    ]
  });
  const metrics = computeFundMetrics(fund, DEFAULT_STRATEGY);
  close(metrics.peakNav, 1.3, 1e-9, '峰值净值');
  close(metrics.trailingStopNav, 1.196, 1e-9, '移动止盈线');
  assert.equal(metrics.trailingArmed, true);
  assert.equal(metrics.trailingHit, true);
  assert.equal(metrics.status, 'trailing');
});

test('止损触发状态', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000)], { nav: 0.87 });
  const metrics = computeFundMetrics(fund, DEFAULT_STRATEGY);
  assert.equal(metrics.stopLossHit, true);
  assert.equal(metrics.status, 'stop');
});

test('策略校验：档位跌幅必须严格递增', () => {
  const errors = validateStrategy({
    ...DEFAULT_STRATEGY,
    addTiers: [
      { dropPct: 10, amount: 1000 },
      { dropPct: 5, amount: 2000 }
    ]
  });
  assert.ok(errors.some((message) => message.includes('严格递增')));
});

test('策略校验：合法默认模板无错误', () => {
  assert.deepEqual(validateStrategy(DEFAULT_STRATEGY), []);
});

// ===== 三资产再平衡 computeThreeAssetAllocation =====

function metricsOf(marketValue, shares) {
  return { position: { shares }, marketValue };
}

test('三资产：按大类聚合市值、偏差与调仓金额', () => {
  const state = {
    settings: { assetTargets: { equity: 60, bond: 30, gold: 10 } },
    funds: [
      { id: 'a', assetClass: 'EQUITY' },
      { id: 'b', assetClass: 'EQUITY' },
      { id: 'c', assetClass: 'BOND' },
      { id: 'd', assetClass: 'GOLD' }
    ]
  };
  const metricsMap = new Map([
    ['a', metricsOf(40000, 40000)],
    ['b', metricsOf(20000, 20000)],
    ['c', metricsOf(30000, 30000)],
    ['d', metricsOf(10000, 10000)]
  ]);
  const result = computeThreeAssetAllocation(state, metricsMap);
  close(result.totalMarketValue, 100000, 1e-9, '总市值');
  close(result.classes[0].actualPct, 60, 1e-9, '权益实际占比');
  close(result.classes[0].deviation, 0, 1e-9, '权益偏差');
  close(result.classes[1].deviation, 0, 1e-9, '债券偏差');
  close(result.classes[2].deviation, 0, 1e-9, '黄金偏差');
  close(result.classes[0].adjustAmount, 0, 1e-9, '权益调仓金额');
  assert.equal(result.targetTotalOk, true);
});

test('三资产：超配为正偏差、需卖出；低配为负偏差、需买入', () => {
  const state = {
    settings: { assetTargets: { equity: 50, bond: 30, gold: 20 } },
    funds: [
      { id: 'a', assetClass: 'EQUITY' },
      { id: 'b', assetClass: 'GOLD' }
    ]
  };
  const metricsMap = new Map([
    ['a', metricsOf(80000, 80000)], // 权益实际 80%，目标 50% → 超配 30%，需卖出 30000
    ['b', metricsOf(20000, 20000)]  // 黄金实际 20%，目标 20% → 达标
  ]);
  const result = computeThreeAssetAllocation(state, metricsMap);
  // classes 顺序固定为 EQUITY / BOND / GOLD
  close(result.classes[0].deviation, 30, 1e-9, '权益偏差');
  close(result.classes[0].adjustAmount, -30000, 1e-9, '权益需卖出');
  close(result.classes[2].actualPct, 20, 1e-9, '黄金实际占比');
  close(result.classes[2].adjustAmount, 0, 1e-9, '黄金达标');
  close(result.classes[1].actualPct, 0, 1e-9, '债券实际 0%');
  close(result.classes[1].deviation, -30, 1e-9, '债券低配');
  close(result.classes[1].adjustAmount, 30000, 1e-9, '债券需买入 30000');
});

test('三资产：无持仓基金不计入分母，非法 assetClass 归为权益', () => {
  const state = {
    settings: { assetTargets: { equity: 60, bond: 30, gold: 10 } },
    funds: [
      { id: 'a', assetClass: 'WRONG' },  // 非法 → EQUITY
      { id: 'b', assetClass: 'BOND' },
      { id: 'c', assetClass: 'EQUITY' }  // 无持仓 → 不计入
    ]
  };
  const metricsMap = new Map([
    ['a', metricsOf(50000, 50000)],
    ['b', metricsOf(50000, 50000)],
    ['c', metricsOf(0, 0)]
  ]);
  const result = computeThreeAssetAllocation(state, metricsMap);
  close(result.totalMarketValue, 100000, 1e-9, '总市值不含空仓基金');
  close(result.classes[0].actualPct, 50, 1e-9, '非法大类归入权益');
  close(result.classes[1].actualPct, 50, 1e-9, '债券占比');
  assert.equal(result.classes[0].fundCount, 1);
});

test('三资产：assetTargets 缺失或非法回退默认值并钳制 0–100', () => {
  const r1 = computeThreeAssetAllocation({ settings: {}, funds: [] }, new Map());
  assert.deepEqual(r1.classes.map((c) => c.targetPct),
    [DEFAULT_ASSET_TARGETS.equity, DEFAULT_ASSET_TARGETS.bond, DEFAULT_ASSET_TARGETS.gold]);
  const r2 = computeThreeAssetAllocation(
    { settings: { assetTargets: { equity: 250, bond: -5, gold: 'abc' } }, funds: [] },
    new Map()
  );
  assert.deepEqual(r2.classes.map((c) => c.targetPct), [100, 0, DEFAULT_ASSET_TARGETS.gold]);
  assert.equal(r2.targetTotalOk, false);
});

// 宏观推荐方案：规则与宏观页方向速览一致，优先级 曲线倒挂 > 分位低位 > 分位高位 > 实际利率 > 平衡
test('推荐方案：美债曲线倒挂 → 防守', () => {
  const rec = recommendAssetScheme({ equityBond: { ratioPercentile: 80 }, usTermSpreadBp: -5, usRealRate: -1 });
  assert.equal(rec.key, 'defensive');
  assert.deepEqual(rec.targets, { equity: 40, bond: 40, gold: 20 });
});

test('推荐方案：股债分位低位 → 防守；高位 → 进攻', () => {
  assert.equal(recommendAssetScheme({ equityBond: { ratioPercentile: 20 }, usTermSpreadBp: 40, usRealRate: 1.5 }).key, 'defensive');
  assert.equal(recommendAssetScheme({ equityBond: { ratioPercentile: 70 }, usTermSpreadBp: 40, usRealRate: 1.5 }).key, 'aggressive');
});

test('推荐方案：实际利率 ≤0 且分位中性 → 偏金', () => {
  const rec = recommendAssetScheme({ equityBond: { ratioPercentile: 50 }, usTermSpreadBp: 40, usRealRate: -0.3 });
  assert.equal(rec.key, 'goldHedge');
  assert.deepEqual(rec.targets, { equity: 55, bond: 25, gold: 20 });
});

test('推荐方案：宏观数据缺失或指标缺失 → 平衡兜底', () => {
  assert.equal(recommendAssetScheme(null).key, 'balanced');
  assert.equal(recommendAssetScheme({}).key, 'balanced');
  const rec = recommendAssetScheme({ equityBond: { ratioPercentile: NaN }, usRealRate: NaN, usTermSpreadBp: NaN });
  assert.equal(rec.key, 'balanced');
});

// ===== 双预置策略 STRATEGY_PRESETS / resolveStrategyByKey =====

test('预置方案：普通与激进参数符合预期，DEFAULT_STRATEGY = 普通', () => {
  assert.equal(DEFAULT_STRATEGY, STRATEGY_PRESETS.NORMAL);
  close(STRATEGY_PRESETS.NORMAL.stopLossPct, 12, 1e-9, '普通止损');
  close(STRATEGY_PRESETS.NORMAL.takeProfitPct, 20, 1e-9, '普通止盈');
  assert.equal(STRATEGY_PRESETS.NORMAL.addTiers[2].amount, 2800);
  close(STRATEGY_PRESETS.AGGRESSIVE.stopLossPct, 8, 1e-9, '激进止损');
  close(STRATEGY_PRESETS.AGGRESSIVE.takeProfitPct, 25, 1e-9, '激进止盈');
  close(STRATEGY_PRESETS.AGGRESSIVE.takeProfitSellRatio, 50, 1e-9, '激进首层卖出');
  close(STRATEGY_PRESETS.AGGRESSIVE.trailingStopPct, 10, 1e-9, '激进移动止盈');
  close(STRATEGY_PRESETS.AGGRESSIVE.reserveAmount, 3000, 1e-9, '激进储备');
  close(STRATEGY_PRESETS.AGGRESSIVE.reserveTriggerPct, 15, 1e-9, '激进储备触发');
  close(STRATEGY_PRESETS.AGGRESSIVE.addPositionSellPct, 8, 1e-9, '激进了结');
  assert.deepEqual(
    STRATEGY_PRESETS.AGGRESSIVE.addTiers.map((tier) => [tier.dropPct, tier.amount]),
    [[4, 1500], [8, 2500], [12, 3500]]
  );
});

test('resolveStrategyByKey：NONE → null，覆盖优先，非法跟随全局', () => {
  // 不启用 → null（不计算任何规则线）
  assert.equal(resolveStrategyByKey('NORMAL', 'NONE'), null);
  assert.equal(resolveStrategyByKey('AGGRESSIVE', 'NONE'), null);
  // 单基金覆盖优先于全局
  assert.equal(resolveStrategyByKey('NORMAL', 'AGGRESSIVE'), STRATEGY_PRESETS.AGGRESSIVE);
  assert.equal(resolveStrategyByKey('AGGRESSIVE', 'NORMAL'), STRATEGY_PRESETS.NORMAL);
  // 覆盖为 null / 非法字符串 / undefined → 跟随全局
  assert.equal(resolveStrategyByKey('AGGRESSIVE', null), STRATEGY_PRESETS.AGGRESSIVE);
  assert.equal(resolveStrategyByKey('AGGRESSIVE', 'oops'), STRATEGY_PRESETS.AGGRESSIVE);
  assert.equal(resolveStrategyByKey('NORMAL', undefined), STRATEGY_PRESETS.NORMAL);
  // 全局缺省 / 非法 → 普通兜底
  assert.equal(resolveStrategyByKey(null, null), STRATEGY_PRESETS.NORMAL);
  assert.equal(resolveStrategyByKey({}, null), STRATEGY_PRESETS.NORMAL);
});

test('resolveStrategyByKey：旧对象型全局模板按 stopLossPct 映射', () => {
  assert.equal(resolveStrategyByKey({ stopLossPct: 10 }, null), STRATEGY_PRESETS.AGGRESSIVE);
  assert.equal(resolveStrategyByKey({ stopLossPct: 10.5 }, null), STRATEGY_PRESETS.NORMAL);
  assert.equal(resolveStrategyByKey({ takeProfitPct: 30 }, null), STRATEGY_PRESETS.NORMAL); // 缺 stopLossPct → NORMAL
});

test('NONE 覆盖：不计算规则线、状态为 none、档位为空、不提示了结', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy('2026-02-01', 0.9, 1200, { source: 'ADD' })], {
    nav: 0.85,
    strategyOverride: 'NONE'
  });
  const metrics = computeFundMetrics(fund, 'NORMAL');
  assert.equal(metrics.strategy, null);
  assert.equal(metrics.status, 'none');
  close(metrics.stopLossNav, 0, 1e-9, '无止损线');
  close(metrics.takeProfitNav, 0, 1e-9, '无止盈线');
  assert.deepEqual(metrics.tiers, []);
  assert.deepEqual(metrics.triggeredTiers, []);
  assert.equal(metrics.nextTier, null);
  assert.equal(metrics.stopLossHit, false);
  assert.ok(metrics.addBatches.every((batch) => batch.suggestClose === false));
});

test('单基金覆盖为激进：止损线与档位随预置变化（全局仍为普通）', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000)], { nav: 0.96, strategyOverride: 'AGGRESSIVE' });
  const metrics = computeFundMetrics(fund, 'NORMAL');
  assert.equal(metrics.strategy, STRATEGY_PRESETS.AGGRESSIVE);
  close(metrics.stopLossNav, 0.92, 1e-6, '激进止损 8%');
  close(metrics.tiers[0].triggerNav, 0.96, 1e-6, '激进第一档 4%');
});

// ===== 当日买入口径（成交净值计市值，不参与当日涨跌） =====

const now = new Date();
const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

test('当日买入：市值按成交净值计，不参与当日涨跌', () => {
  // 昨日买入 10000@1.0，今日买入 5000@1.0；当前净值 0.95（尚未更新为今日收盘）
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy(todayIso, 1, 5000)], {
    nav: 0.95,
    navDate: '2026-11-18'
  });
  const metrics = computeFundMetrics(fund, 'NORMAL');
  close(metrics.position.shares, 15000, 1e-6, '总份额含今日买入');
  // 已结算份额 10000 × 0.95 + 今日买入 5000 × 成交净值 1.0 = 14500
  close(metrics.marketValue, 14500, 1e-6, '今日买入按成交净值计市值');
  close(metrics.holdingPnl, -500, 1e-6, '持仓盈亏不含今日涨跌');
});

test('当日买入：净值更新为今日收盘后与整体口径一致', () => {
  const fund = fundWith([buy('2026-01-01', 1, 10000), buy(todayIso, 1, 5000)], {
    nav: 1,
    navDate: todayIso
  });
  const metrics = computeFundMetrics(fund, 'NORMAL');
  close(metrics.marketValue, 15000, 1e-6, '今日收盘净值 = 成交净值');
  close(metrics.holdingPnl, 0, 1e-6, '今日买入份额无盈亏');
});

test('当日买入：shares 缺失时按 amount/nav 推导市值', () => {
  const trade = { id: 't1', type: 'BUY', date: todayIso, nav: 2, amount: 4000, shares: 0, fee: 0, source: 'BASE', closed: false };
  const fund = fundWith([buy('2026-01-01', 1, 10000), trade], { nav: 1.9, navDate: '2026-11-18' });
  const metrics = computeFundMetrics(fund, 'NORMAL');
  // 已结算 10000 × 1.9 + 今日买入 2000 份 × 成交净值 2 = 23000
  close(metrics.marketValue, 23000, 1e-6, 'shares 缺失按 amount/nav 推导');
});

// ===== 基金自动归类 classifyAssetClass（F10 FTYPE → 三资产） =====

test('自动归类：债券类型 → BOND', () => {
  assert.equal(classifyAssetClass('债券型-混合二级'), 'BOND');
  assert.equal(classifyAssetClass('被动债券型基金'), 'BOND');
});

test('自动归类：黄金类型 / 指数型-其他且跟踪 AU9999 → GOLD', () => {
  assert.equal(classifyAssetClass('股票型-黄金'), 'GOLD');
  assert.equal(classifyAssetClass('指数型-其他', 'AU9999'), 'GOLD');
  assert.equal(classifyAssetClass('指数型-其他', 'au9999'), 'GOLD'); // 大小写不敏感
  // 「指数型-其他」但非黄金标的 → 权益
  assert.equal(classifyAssetClass('指数型-其他', 'H30269'), 'EQUITY');
});

test('自动归类：股票/指数/混合/QDII/空值 → EQUITY', () => {
  assert.equal(classifyAssetClass('指数型-股票'), 'EQUITY');
  assert.equal(classifyAssetClass('股票型'), 'EQUITY');
  assert.equal(classifyAssetClass('混合型-偏股'), 'EQUITY');
  assert.equal(classifyAssetClass('指数型-海外股票'), 'EQUITY');
  assert.equal(classifyAssetClass(''), 'EQUITY');
  assert.equal(classifyAssetClass(null), 'EQUITY');
  assert.equal(classifyAssetClass(undefined, ''), 'EQUITY');
});

test('自动归类：FTYPE 原值与 ftype 缺省兼容（normalizeState 补齐）', () => {
  const legacy = normalizeState({
    version: VERSION,
    funds: [{ code: '000961', name: 'x', nav: 1 }]
  });
  assert.equal(legacy.funds[0].ftype, '');
  assert.equal(legacy.funds[0].assetClassAuto, true);
});

// ===== 今日关注聚合 summarizeAttention =====

function attentionMetrics(status, extra = {}) {
  return {
    fund: { id: extra.id || 'f1', name: extra.name || '测试基金', code: '000001' },
    status,
    triggeredTiers: extra.triggeredTiers || [],
    strategy: extra.strategy === undefined ? { takeProfitSellRatio: 40 } : extra.strategy,
    ...extra
  };
}

test('关注聚合：混合状态计数正确，非法状态按 normal 计数', () => {
  const summary = summarizeAttention([
    attentionMetrics('stop'),
    attentionMetrics('add'),
    attentionMetrics('add'),
    attentionMetrics('takeProfit'),
    attentionMetrics('nearStop'),
    attentionMetrics('normal'),
    attentionMetrics('none'),
    { fund: { id: 'f8', name: 'x' }, status: 'bogus' }
  ]);
  assert.deepEqual(summary.counts, {
    stop: 1, trailing: 0, takeProfit: 1, add: 2, nearStop: 1, normal: 2, none: 1
  });
  assert.equal(summary.items.length, 5);
});

test('关注聚合：条目按严重度排序（stop 最前，nearStop 最后）', () => {
  const summary = summarizeAttention([
    attentionMetrics('nearStop', { id: 'a' }),
    attentionMetrics('add', { id: 'b' }),
    attentionMetrics('stop', { id: 'c' }),
    attentionMetrics('trailing', { id: 'd' })
  ]);
  assert.deepEqual(
    summary.items.map((i) => i.status),
    ['stop', 'trailing', 'add', 'nearStop']
  );
});

test('关注聚合：takeProfit 文案带预设卖出比例；add 多档合并金额求和', () => {
  const summary = summarizeAttention([
    attentionMetrics('takeProfit', { strategy: { takeProfitSellRatio: 40 } }),
    attentionMetrics('add', {
      triggeredTiers: [
        { index: 0, amount: 1200 },
        { index: 2, amount: 2800 }
      ]
    })
  ]);
  assert.equal(summary.items[0].text, '触发止盈 → 可按预设先卖 40%');
  assert.equal(summary.items[1].text, '第 1 档、第 3 档触发 → 可补仓 4000 元');
});

test('关注聚合：normal/none 不产条目；空列表全零；名称缺失兜底基金代码', () => {
  const empty = summarizeAttention([]);
  assert.equal(empty.items.length, 0);
  assert.deepEqual(empty.counts, {
    stop: 0, trailing: 0, takeProfit: 0, add: 0, nearStop: 0, normal: 0, none: 0
  });
  const noName = summarizeAttention([{ fund: { id: 'f9', code: '888888' }, status: 'stop' }]);
  assert.equal(noName.items[0].name, '888888');
  assert.equal(summarizeAttention(null).items.length, 0);
});

// ===== 估值水平 computeValuationLevel（通用序列分位 + 分级 + 债券取反） =====

test('估值水平：高估 ≥70、低估 ≤30、中间正常（缺省当前值取序列末项）', () => {
  const build = (currentVal) => {
    const list = [];
    for (let i = 1; i <= 23; i += 1) list.push(i);
    list.push(currentVal); // 末项 = 当前值
    return list;
  };

  const high = computeValuationLevel(build(30)); // 24 条全部 ≤ 30 → 100%
  close(high.percentile, 100, 1e-9, '最高分位');
  assert.equal(high.label, '高估');
  assert.equal(high.tone, 'warn');

  const low = computeValuationLevel(build(5)); // ≤5 的 5 条 + 当前 → 6/24 = 25%
  close(low.percentile, 25, 1e-9, '低分位');
  assert.equal(low.label, '低估');
  assert.equal(low.tone, 'down');

  const mid = computeValuationLevel(build(12.5)); // ≤12.5：1–12 共 12 条 + 当前 → 13/24 ≈ 54.17%
  close(mid.percentile, (13 / 24) * 100, 1e-6, '中位分位');
  assert.equal(mid.label, '正常');
  assert.equal(mid.tone, 'flat');
});

test('估值水平：显式传入当前值 + 边界值 30 与 70', () => {
  const list = [1, 2, 3, 4, 5, 6, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63];

  // ≤56：1–6 共 6 条 + 50–56 共 7 条 = 13 → 13/20 = 65% → 正常
  close(computeValuationLevel(list, 56).percentile, 65, 1e-9, '65% 正常');
  assert.equal(computeValuationLevel(list, 56).label, '正常');

  // 边界 70：≤57 = 14 条 → 14/20 = 70% → 高估
  close(computeValuationLevel(list, 57).percentile, 70, 1e-9, '边界 70%');
  assert.equal(computeValuationLevel(list, 57).label, '高估');

  // 边界 30：≤6 = 6 条（含当前 6）→ 6/20 = 30% → 低估
  const b30 = [1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
  close(computeValuationLevel(b30, 6).percentile, 30, 1e-9, '边界 30%');
  assert.equal(computeValuationLevel(b30, 6).label, '低估');
});

test('估值水平：债券口径 invert=true 分位取反（收益率低=债贵=高估）', () => {
  // 20 条收益率样本：≤2.0 仅当前 1 条 → 原分位 5%（低估区间），取反后 95% → 高估
  const yields = [2.0, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8];
  const inverted = computeValuationLevel(yields, 2.0, { invert: true });
  close(inverted.percentile, 95, 1e-9, '100 − 5 = 95');
  assert.equal(inverted.label, '高估');
  assert.equal(inverted.tone, 'warn');

  // 不取反时同序列为低估
  const normal = computeValuationLevel(yields, 2.0);
  close(normal.percentile, 5, 1e-9, '原分位 5%');
  assert.equal(normal.label, '低估');
});

test('估值水平：指数价格分位 ≡ 常数盈利 PE 分位（价格同比例序列等价）', () => {
  // 价格序列与「价格 × 100 / 固定盈利」的 PE 序列分位完全一致
  const prices = Array.from({ length: 40 }, (_, i) => 3000 + i * 10); // 单调上涨
  const peFromPrices = prices.map((p) => p / 100); // EPS=100 的常数盈利近似
  close(computeValuationLevel(prices, prices[39]).percentile, 100, 1e-9, '价格分位');
  close(computeValuationLevel(peFromPrices, peFromPrices[39]).percentile, 100, 1e-9, 'PE 分位');
  assert.equal(computeValuationLevel(prices, prices[39]).label, computeValuationLevel(peFromPrices, peFromPrices[39]).label);
});

test('估值水平：样本不足 20 / 空 / 非法输入 / 非法当前值 → null', () => {
  assert.equal(computeValuationLevel([]), null);
  assert.equal(computeValuationLevel(null), null);
  assert.equal(computeValuationLevel(undefined), null);
  assert.equal(computeValuationLevel('oops'), null);
  assert.equal(computeValuationLevel([1, 2, 3]), null);
  const nineteen = Array.from({ length: 19 }, (_, i) => 1 + i / 100);
  assert.equal(computeValuationLevel(nineteen), null);
  assert.equal(computeValuationLevel(nineteen, 1.05), null); // 样本仍不足

  // 非法值（0/NaN/负数）被过滤，不影响分母
  const mixed = [0, Number.NaN, -1, ...Array.from({ length: 20 }, (_, i) => i + 1)];
  close(computeValuationLevel(mixed, 20).percentile, 100, 1e-9, '过滤后分母 20');

  // 过滤后样本不足 → null
  assert.equal(computeValuationLevel([0, Number.NaN, 1, 2, 3]), null);
});

// ===== store.normalizeState 策略迁移（version 2/3 兼容、幂等） =====

test('迁移：旧对象型 defaultStrategy 按 stopLossPct ≤10 映射为预置 key', () => {
  const aggressive = normalizeState({
    version: 2,
    settings: { defaultStrategy: { stopLossPct: 8, takeProfitPct: 30, addTiers: [{ dropPct: 4, amount: 1500 }] } },
    funds: []
  });
  assert.equal(aggressive.settings.defaultStrategy, 'AGGRESSIVE');
  assert.equal(aggressive.version, VERSION);

  const normal = normalizeState({
    version: 2,
    settings: { defaultStrategy: { stopLossPct: 12, takeProfitPct: 20 } },
    funds: []
  });
  assert.equal(normal.settings.defaultStrategy, 'NORMAL');
});

test('迁移：字段缺失/非法/NONE 的全局策略 → NORMAL，新 key 保留', () => {
  assert.equal(normalizeState({ version: 2, settings: { defaultStrategy: {} }, funds: [] }).settings.defaultStrategy, 'NORMAL');
  assert.equal(normalizeState({ version: 2, settings: {}, funds: [] }).settings.defaultStrategy, 'NORMAL');
  assert.equal(normalizeState({ version: 2, settings: null, funds: [] }).settings.defaultStrategy, 'NORMAL');
  assert.equal(normalizeState({ version: 3, settings: { defaultStrategy: 'NONE' }, funds: [] }).settings.defaultStrategy, 'NORMAL');
  assert.equal(normalizeState({ version: 3, settings: { defaultStrategy: 'oops' }, funds: [] }).settings.defaultStrategy, 'NORMAL');
  assert.equal(normalizeState({ version: 3, settings: { defaultStrategy: 'AGGRESSIVE' }, funds: [] }).settings.defaultStrategy, 'AGGRESSIVE');
});

test('迁移：fund 级覆盖（对象/空对象/null/NONE/合法与非法字符串）', () => {
  const state = normalizeState({
    version: 2,
    settings: { defaultStrategy: { stopLossPct: 12 } },
    funds: [
      { id: 'a', code: '000001', strategyOverride: { stopLossPct: 10, takeProfitPct: 30 } }, // 对象 → AGGRESSIVE
      { id: 'b', code: '000002', strategyOverride: {} }, // 空对象 → null 跟随全局
      { id: 'c', code: '000003', strategyOverride: null }, // null → null
      { id: 'd', code: '000004', strategyOverride: 'NONE' }, // NONE 保留
      { id: 'e', code: '000005', strategyOverride: 'AGGRESSIVE' }, // 合法字符串保留
      { id: 'f', code: '000006', strategyOverride: 'oops' }, // 非法字符串 → null
      { id: 'g', code: '000007' } // 缺失 → null
    ]
  });
  const overrideOf = (id) => state.funds.find((fund) => fund.id === id).strategyOverride;
  assert.equal(overrideOf('a'), 'AGGRESSIVE');
  assert.equal(overrideOf('b'), null);
  assert.equal(overrideOf('c'), null);
  assert.equal(overrideOf('d'), 'NONE');
  assert.equal(overrideOf('e'), 'AGGRESSIVE');
  assert.equal(overrideOf('f'), null);
  assert.equal(overrideOf('g'), null);
});

test('迁移：幂等（对迁移结果重复 normalize 完全一致）', () => {
  const raw = {
    version: 2,
    settings: { defaultStrategy: { stopLossPct: 9, takeProfitPct: 25 } },
    funds: [
      { id: 'a', code: '000001', strategyOverride: { stopLossPct: 11 }, trades: [buy('2026-01-01', 1, 1000)] },
      { id: 'b', code: '000002', strategyOverride: 'NONE' }
    ]
  };
  const once = normalizeState(raw);
  const twice = normalizeState(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.equal(once.settings.defaultStrategy, 'AGGRESSIVE');
  assert.equal(once.funds[0].strategyOverride, 'NORMAL'); // stopLossPct 11 > 10 → NORMAL
  assert.equal(once.funds[1].strategyOverride, 'NONE');
});

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
