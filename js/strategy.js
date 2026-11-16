/**
 * 纯计算模块：持仓成本、策略规则线、分档补仓、移动止盈、补仓模拟。
 * 不依赖 DOM，可被浏览器与 Node 测试直接复用。
 */

export const DEFAULT_STRATEGY = Object.freeze({
  stopLossPct: 12,
  takeProfitPct: 20,
  takeProfitSellRatio: 40,
  trailingStopPct: 8,
  addTiers: [
    { dropPct: 5, amount: 1200 },
    { dropPct: 10, amount: 2000 },
    { dropPct: 15, amount: 2800 }
  ],
  reserveAmount: 2400,
  reserveTriggerPct: 20,
  addPositionSellPct: 6
});

const NUMERIC_KEYS = [
  'stopLossPct',
  'takeProfitPct',
  'takeProfitSellRatio',
  'trailingStopPct',
  'reserveAmount',
  'reserveTriggerPct',
  'addPositionSellPct'
];

const EPS = 1e-9;

export function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function cloneStrategy(strategy = DEFAULT_STRATEGY) {
  return {
    ...strategy,
    addTiers: (strategy.addTiers || []).map((tier) => ({ ...tier }))
  };
}

export function normalizeTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((tier) => ({ dropPct: num(tier && tier.dropPct), amount: num(tier && tier.amount) }))
    .filter((tier) => tier.dropPct > 0 && tier.amount >= 0)
    .sort((a, b) => a.dropPct - b.dropPct);
}

export function mergeStrategy(base = DEFAULT_STRATEGY, override = null) {
  const merged = cloneStrategy(base);
  if (!override || typeof override !== 'object') return merged;
  NUMERIC_KEYS.forEach((key) => {
    const value = Number(override[key]);
    if (Number.isFinite(value)) merged[key] = value;
  });
  if (Array.isArray(override.addTiers) && override.addTiers.length > 0) {
    merged.addTiers = normalizeTiers(override.addTiers);
  }
  return merged;
}

export function resolveStrategy(defaultStrategy, fund) {
  return mergeStrategy(defaultStrategy, fund && fund.strategyOverride);
}

/**
 * 按时间顺序回放交易，计算剩余份额、摊薄成本、已实现收益。
 * 摊薄成本 =（累计买入金额 + 买入手续费 − 卖出对应成本）/ 剩余份额
 */
export function computePosition(trades = []) {
  const list = [...trades].sort((a, b) => {
    const dateDiff = String(a.date || '').localeCompare(String(b.date || ''));
    return dateDiff !== 0 ? dateDiff : num(a.createdAt) - num(b.createdAt);
  });

  let shares = 0;
  let cost = 0;
  let realized = 0;
  let invested = 0;
  let proceeds = 0;
  let fees = 0;
  let baseAmount = 0;
  let baseShares = 0;

  for (const trade of list) {
    const amount = num(trade.amount);
    const fee = num(trade.fee);
    let tradeShares = num(trade.shares);

    if (trade.type === 'SELL') {
      if (tradeShares <= 0 && num(trade.nav) > 0) tradeShares = amount / num(trade.nav);
      const sellShares = Math.min(Math.max(tradeShares, 0), shares);
      const avg = shares > EPS ? cost / shares : 0;
      realized += amount - fee - avg * sellShares;
      cost -= avg * sellShares;
      shares -= sellShares;
      if (shares < 1e-6) {
        shares = 0;
        cost = 0;
      }
      proceeds += amount;
    } else {
      if (tradeShares <= 0 && num(trade.nav) > 0) tradeShares = amount / num(trade.nav);
      shares += Math.max(tradeShares, 0);
      cost += amount + fee;
      invested += amount;
      if (trade.source !== 'ADD') {
        baseAmount += amount;
        baseShares += Math.max(tradeShares, 0);
      }
    }
    fees += fee;
  }

  const avgCost = shares > EPS ? cost / shares : 0;
  return {
    shares,
    cost,
    avgCost,
    baseCost: baseShares > EPS ? baseAmount / baseShares : avgCost,
    invested,
    proceeds,
    fees,
    realized
  };
}

export function computeFundMetrics(fund, defaultStrategy) {
  const strategy = resolveStrategy(defaultStrategy, fund);
  const position = computePosition(fund.trades);
  const nav = num(fund.nav);
  const avgCost = position.avgCost;
  const tierAnchor = position.baseCost > EPS ? position.baseCost : avgCost;

  const marketValue = position.shares * nav;
  const holdingPnl = marketValue - position.cost;
  const holdingPnlPct = position.cost > EPS ? (holdingPnl / position.cost) * 100 : 0;
  const drawdownPct = avgCost > EPS && nav > 0 ? ((avgCost - nav) / avgCost) * 100 : 0;

  const stopLossNav = avgCost > EPS ? avgCost * (1 - strategy.stopLossPct / 100) : 0;
  const takeProfitNav = avgCost > EPS ? avgCost * (1 + strategy.takeProfitPct / 100) : 0;

  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const peakNav = Math.max(
    nav,
    ...history.map((item) => num(item.nav)),
    ...(fund.trades || []).filter((t) => t.type !== 'SELL').map((t) => num(t.nav))
  );

  const tiers = strategy.addTiers.map((tier, index) => ({
    ...tier,
    index,
    executed: Boolean((fund.tierState || [])[index]),
    triggerNav: tierAnchor > EPS ? tierAnchor * (1 - tier.dropPct / 100) : 0
  }));

  const triggeredTiers = tiers.filter(
    (tier) => !tier.executed && tierAnchor > EPS && nav > 0 && nav <= tier.triggerNav + EPS
  );
  const nextTier = tiers.find((tier) => !tier.executed && nav > tier.triggerNav) || null;

  const stopLossHit = avgCost > EPS && nav > 0 && nav <= stopLossNav + EPS;
  const takeProfitHit = avgCost > EPS && nav > 0 && nav >= takeProfitNav - EPS;
  const trailingArmed = takeProfitNav > EPS && peakNav >= takeProfitNav - EPS;
  const trailingStopNav = peakNav * (1 - strategy.trailingStopPct / 100);
  const trailingHit =
    !takeProfitHit && trailingArmed && nav > 0 && nav <= trailingStopNav + EPS;
  const nearStop =
    !stopLossHit && avgCost > EPS && nav > 0 && nav <= stopLossNav * 1.02 + EPS;

  let status = 'normal';
  if (stopLossHit) status = 'stop';
  else if (trailingHit) status = 'trailing';
  else if (takeProfitHit) status = 'takeProfit';
  else if (triggeredTiers.length > 0) status = 'add';
  else if (nearStop) status = 'nearStop';

  const addBatches = (fund.trades || [])
    .filter((trade) => trade.type === 'BUY' && trade.source === 'ADD' && !trade.closed)
    .map((trade) => {
      const buyNav = num(trade.nav);
      const returnPct = buyNav > EPS && nav > 0 ? (nav / buyNav - 1) * 100 : 0;
      return {
        ...trade,
        buyNav,
        returnPct,
        suggestClose: returnPct >= strategy.addPositionSellPct
      };
    });

  return {
    fund,
    strategy,
    position,
    nav,
    avgCost,
    baseCost: position.baseCost,
    tierAnchor,
    marketValue,
    holdingPnl,
    holdingPnlPct,
    drawdownPct,
    stopLossNav,
    takeProfitNav,
    peakNav,
    trailingStopNav,
    trailingArmed,
    tiers,
    nextTier,
    triggeredTiers,
    status,
    nearStop,
    stopLossHit,
    takeProfitHit,
    trailingHit,
    addBatches
  };
}

export function computePortfolio(state, metricsMap) {
  let cost = 0;
  let value = 0;
  let updatedAt = 0;
  for (const fund of state.funds || []) {
    const metrics = metricsMap.get(fund.id);
    if (!metrics) continue;
    cost += metrics.position.cost;
    value += metrics.marketValue;
    updatedAt = Math.max(updatedAt, num(fund.navUpdatedAt));
  }
  const pnl = value - cost;
  return {
    cost,
    value,
    pnl,
    pnlPct: cost > EPS ? (pnl / cost) * 100 : 0,
    count: (state.funds || []).length,
    updatedAt
  };
}

/** 补仓后按新平均成本「换锚」 */
export function simulateAdd(position, amount, nav, strategy) {
  const addAmount = Math.max(num(amount), 0);
  const price = Math.max(num(nav), 0);
  const shares = Math.max(num(position.shares), 0);
  const cost = Math.max(num(position.cost), 0);
  const avgCost = shares > EPS ? cost / shares : 0;

  if (addAmount <= 0 || price <= 0) {
    return {
      valid: false,
      newShares: shares,
      newAvgCost: avgCost,
      newStopLossNav: avgCost * (1 - strategy.stopLossPct / 100),
      newTakeProfitNav: avgCost * (1 + strategy.takeProfitPct / 100),
      costDropPct: 0,
      costChangePct: 0,
      breakevenPct: 0,
      newMarketValue: shares * price
    };
  }

  const newShares = shares + addAmount / price;
  const newAvgCost = (cost + addAmount) / newShares;

  return {
    valid: true,
    newShares,
    newAvgCost,
    newStopLossNav: newAvgCost * (1 - strategy.stopLossPct / 100),
    newTakeProfitNav: newAvgCost * (1 + strategy.takeProfitPct / 100),
    costDropPct: avgCost > EPS ? ((avgCost - newAvgCost) / avgCost) * 100 : 0,
    costChangePct: avgCost > EPS ? ((newAvgCost / avgCost - 1) * 100) : 0,
    breakevenPct: newAvgCost > EPS ? (newAvgCost / price - 1) * 100 : 0,
    newMarketValue: newShares * price
  };
}

/** 表单策略参数校验，返回错误信息数组 */
export function validateStrategy(draft) {
  const errors = [];
  const pct = (value, label, max, min = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) errors.push(`${label}必须是数字`);
    else if (n < min || n > max) errors.push(`${label}需在 ${min}–${max} 之间`);
  };
  pct(draft.stopLossPct, '止损比例', 100);
  pct(draft.takeProfitPct, '止盈比例', 500);
  pct(draft.takeProfitSellRatio, '第一层止盈卖出比例', 100);
  pct(draft.trailingStopPct, '移动止盈回撤', 100);
  pct(draft.reserveTriggerPct, '储备触发跌幅', 100);
  pct(draft.addPositionSellPct, '独立了结收益', 100);
  if (!Number.isFinite(Number(draft.reserveAmount)) || Number(draft.reserveAmount) < 0) {
    errors.push('储备金额不能为负');
  }
  if (!Array.isArray(draft.addTiers) || draft.addTiers.length === 0) {
    errors.push('至少保留一个补仓档位');
  } else {
    let last = 0;
    draft.addTiers.forEach((tier, index) => {
      const drop = Number(tier.dropPct);
      const amount = Number(tier.amount);
      if (!Number.isFinite(drop) || drop <= 0 || drop > 100) {
        errors.push(`第 ${index + 1} 档跌幅需在 0–100 之间`);
      } else if (drop <= last) {
        errors.push('补仓档位跌幅需严格递增');
      } else {
        last = drop;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        errors.push(`第 ${index + 1} 档金额不能为负`);
      }
    });
  }
  return errors;
}
