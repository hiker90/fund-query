import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY,
  computeFundMetrics,
  computePosition,
  simulateAdd,
  validateStrategy
} from '../js/strategy.js';

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

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
