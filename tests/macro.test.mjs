import { computePercentile, computeEquityBond, fetchKlineClose } from '../js/macro.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`);
  }
}

// computePercentile
{
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert('分位：最小值为 0', computePercentile(values, 1) === 0);
  assert('分位：最大值为 100', computePercentile(values, 10) === 100);
  assert('分位：中位数约 50', Math.abs(computePercentile(values, 5.5) - 50) < 6);
  assert('分位：样本不足返回 null', computePercentile([1], 1) === null);
  assert('分位：非法当前值返回 null', computePercentile(values, NaN) === null);
}

// computeEquityBond
{
  // 构造：价格从 100 涨到 200（盈利收益率减半），收益率恒定 2%
  const priceSeries = [];
  const yieldByDate = new Map();
  for (let i = 0; i < 300; i += 1) {
    const date = `2025-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`; // 唯一日期
    priceSeries.push({ date, close: 100 + (i * 100) / 299 });
    yieldByDate.set(date, 2);
  }
  const peNow = 10; // 盈利收益率 10%（priceNow=200, eps=20, E=10%）
  const eb = computeEquityBond(priceSeries, yieldByDate, peNow, 200);

  assert('股债性价比：结果生成', eb !== null);
  assert('盈利收益率 = 1/PE', Math.abs(eb.earningsYield - 10) < 1e-9);
  assert('股债收益比 = E/y', Math.abs(eb.ratio - 5) < 1e-9);
  assert('ERP = E − y', Math.abs(eb.erp - 8) < 1e-9);
  assert('分位在 0-100 之间', eb.ratioPercentile >= 0 && eb.ratioPercentile <= 100);
  // 价格上涨中，当前盈利收益率处于历史低位 → 分位应低于 50
  assert('上涨行情中分位低于 50', eb.ratioPercentile < 50, `got ${eb.ratioPercentile}`);
  assert('样本数等于有效日期数', eb.sampleSize === 300);
}

// 边界
{
  assert('PE 无效返回 null', computeEquityBond([], new Map(), 0, 100) === null);
  assert('序列太短返回 null', computeEquityBond([{ date: 'a', close: 1 }], new Map([['a', 2]]), 10, 100) === null);
}

import { computeSpreadBp, computeOilYoy, computeRealRate } from '../js/macro.js';

// computeSpreadBp 期限利差
{
  assert('利差：10Y−5Y = 0.5% → 50bp', computeSpreadBp(2.0, 1.5) === 50);
  assert('利差：倒挂 → 负 bp', Math.abs(computeSpreadBp(1.2, 1.5) - -30) < 1e-9);
  assert('利差：短端缺失返回 null', computeSpreadBp(2.0, NaN) === null);
  assert('利差：长端缺失返回 null', computeSpreadBp(undefined, 1.5) === null);
}

// computeOilYoy WTI 同比
{
  // 构造 366 天日频序列：一年前 80 元，当前 100 元 → 同比 +25%
  const series = [];
  for (let i = 0; i < 400; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    series.push({ date, close: i < 35 ? 80 : 100 });
  }
  const yoy = computeOilYoy(series);
  assert('WTI 同比：正收益约 +25%', yoy !== null && Math.abs(yoy - 25) < 1e-6, `got ${yoy}`);

  // 一年前 100 元，当前 80 元 → 同比 −20%
  const falling = series.map((p, i) => ({ date: p.date, close: i < 35 ? 100 : 80 }));
  const yoy2 = computeOilYoy(falling);
  assert('WTI 同比：负收益约 −20%', Math.abs(yoy2 - -20) < 1e-6, `got ${yoy2}`);

  // 边界：样本不足 / 非法收盘价
  assert('WTI 同比：样本不足返回 null', computeOilYoy(series.slice(0, 200)) === null);
  assert('WTI 同比：空序列返回 null', computeOilYoy([]) === null);
  // 非法收盘价点被过滤：剩余有效样本仍足够时正常计算
  const withStray = series.map((p, i) => (i === 30 ? { ...p, close: 0 } : p));
  const yoy3 = computeOilYoy(withStray);
  assert('WTI 同比：非法点被过滤后正常计算', Math.abs(yoy3 - 25) < 1e-6, `got ${yoy3}`);
}

// computeRealRate 美国实际利率（近似）
{
  assert('实际利率：4.5 − 2.5 = 2%', computeRealRate(4.5, 2.5) === 2);
  assert('实际利率：通胀高于名义 → 负值', Math.abs(computeRealRate(3.0, 5.5) - -2.5) < 1e-9);
  assert('实际利率：油价数据缺失返回 null', computeRealRate(4.5, null) === null);
  assert('实际利率：收益率缺失返回 null', computeRealRate(NaN, 2.5) === null);
}

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
