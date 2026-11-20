/**
 * 纯计算模块：持仓成本、策略规则线、分档补仓、移动止盈、补仓模拟、估值水平。
 * 不依赖 DOM，可被浏览器与 Node 测试直接复用。
 */

/**
 * 双预置策略方案（只读）：普通 / 激进。
 * 策略不再支持自由编辑参数，仅允许选择预置与单基金覆盖。
 */
export const STRATEGY_PRESETS = Object.freeze({
  NORMAL: Object.freeze({
    stopLossPct: 12,
    takeProfitPct: 20,
    takeProfitSellRatio: 40,
    trailingStopPct: 8,
    addTiers: Object.freeze([
      { dropPct: 5, amount: 1200 },
      { dropPct: 10, amount: 2000 },
      { dropPct: 15, amount: 2800 }
    ]),
    reserveAmount: 2400,
    reserveTriggerPct: 20,
    addPositionSellPct: 6
  }),
  AGGRESSIVE: Object.freeze({
    stopLossPct: 8,
    takeProfitPct: 25,
    takeProfitSellRatio: 50,
    trailingStopPct: 10,
    addTiers: Object.freeze([
      { dropPct: 4, amount: 1500 },
      { dropPct: 8, amount: 2500 },
      { dropPct: 12, amount: 3500 }
    ]),
    reserveAmount: 3000,
    reserveTriggerPct: 15,
    addPositionSellPct: 8
  })
});

export const STRATEGY_KEYS = Object.freeze(['NORMAL', 'AGGRESSIVE']);

/** 兼容旧引用：默认策略 = 预置「普通」 */
export const DEFAULT_STRATEGY = STRATEGY_PRESETS.NORMAL;

const EPS = 1e-9;

export function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 策略原始值 → 预置 key（数据迁移与解析共用）。
 * - 字符串：'NONE' 保留（不启用），NORMAL/AGGRESSIVE 保留，其余非法 → 'NORMAL'
 * - 旧对象型策略：stopLossPct ≤ 10 → 'AGGRESSIVE'，否则 'NORMAL'；字段缺失/非法 → 'NORMAL'
 * - 空/缺失 → 'NORMAL'
 */
export function strategyKeyFromLegacy(raw) {
  if (typeof raw === 'string') {
    if (raw === 'NONE') return 'NONE';
    return STRATEGY_KEYS.includes(raw) ? raw : 'NORMAL';
  }
  if (raw && typeof raw === 'object') {
    const stopLoss = Number(raw.stopLossPct);
    if (Number.isFinite(stopLoss) && stopLoss > 0) {
      return stopLoss <= 10 ? 'AGGRESSIVE' : 'NORMAL';
    }
  }
  return 'NORMAL';
}

/**
 * 策略解析唯一入口。
 * @param {*} defaultKey 全局默认（'NORMAL'|'AGGRESSIVE'，兼容传入旧对象型）
 * @param {*} fundStrategyKey 单基金覆盖（null/空=跟随全局 | 'NORMAL'|'AGGRESSIVE'|'NONE'）
 * @returns null（NONE，不启用策略）或冻结的预置策略对象
 */
export function resolveStrategyByKey(defaultKey, fundStrategyKey) {
  if (fundStrategyKey === 'NONE') return null;
  const fundKey =
    typeof fundStrategyKey === 'string' && STRATEGY_KEYS.includes(fundStrategyKey)
      ? fundStrategyKey
      : null;
  const effectiveKey = fundKey || strategyKeyFromLegacy(defaultKey);
  return STRATEGY_PRESETS[effectiveKey] || STRATEGY_PRESETS.NORMAL;
}

/** 本地日期 YYYY-MM-DD（纯函数，无 DOM 依赖） */
export function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
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
  const strategy = resolveStrategyByKey(defaultStrategy, fund && fund.strategyOverride);
  const position = computePosition(fund.trades);
  const nav = num(fund.nav);
  const avgCost = position.avgCost;
  const tierAnchor = position.baseCost > EPS ? position.baseCost : avgCost;

  // 当日买入的份额：成本与市值均按成交净值（trade.nav，即当日收盘净值）计算，
  // 不参与当日涨跌（今日买入份额无昨日基准）。当日买入成本口径不变（amount = shares × nav）。
  const todayIso = todayISO();
  const sharesOfTrade = (trade) => {
    const shares = num(trade.shares);
    if (shares > EPS) return shares;
    return num(trade.nav) > EPS ? num(trade.amount) / num(trade.nav) : 0;
  };
  const todayBuys = (fund.trades || []).filter(
    (trade) => trade.type === 'BUY' && trade.date === todayIso
  );
  const todayShares = todayBuys.reduce((sum, trade) => sum + Math.max(sharesOfTrade(trade), 0), 0);
  const todayNavValue = todayBuys.reduce(
    (sum, trade) => sum + Math.max(sharesOfTrade(trade), 0) * num(trade.nav),
    0
  );
  const settledShares = Math.max(position.shares - todayShares, 0);

  const marketValue = settledShares * nav + todayNavValue;
  const holdingPnl = marketValue - position.cost;
  const holdingPnlPct = position.cost > EPS ? (holdingPnl / position.cost) * 100 : 0;
  const drawdownPct = avgCost > EPS && nav > 0 ? ((avgCost - nav) / avgCost) * 100 : 0;

  const stopLossNav = strategy && avgCost > EPS ? avgCost * (1 - strategy.stopLossPct / 100) : 0;
  const takeProfitNav = strategy && avgCost > EPS ? avgCost * (1 + strategy.takeProfitPct / 100) : 0;

  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const peakNav = Math.max(
    nav,
    ...history.map((item) => num(item.nav)),
    ...(fund.trades || []).filter((t) => t.type !== 'SELL').map((t) => num(t.nav))
  );

  const tiers = strategy
    ? strategy.addTiers.map((tier, index) => ({
        ...tier,
        index,
        executed: Boolean((fund.tierState || [])[index]),
        triggerNav: tierAnchor > EPS ? tierAnchor * (1 - tier.dropPct / 100) : 0
      }))
    : [];

  const triggeredTiers = tiers.filter(
    (tier) => !tier.executed && tierAnchor > EPS && nav > 0 && nav <= tier.triggerNav + EPS
  );
  const nextTier = tiers.find((tier) => !tier.executed && nav > tier.triggerNav) || null;

  const stopLossHit = Boolean(strategy) && avgCost > EPS && nav > 0 && nav <= stopLossNav + EPS;
  const takeProfitHit = Boolean(strategy) && avgCost > EPS && nav > 0 && nav >= takeProfitNav - EPS;
  const trailingArmed = Boolean(strategy) && takeProfitNav > EPS && peakNav >= takeProfitNav - EPS;
  const trailingStopNav = strategy ? peakNav * (1 - strategy.trailingStopPct / 100) : 0;
  const trailingHit =
    !takeProfitHit && trailingArmed && nav > 0 && nav <= trailingStopNav + EPS;
  const nearStop =
    Boolean(strategy) &&
    !stopLossHit &&
    avgCost > EPS &&
    nav > 0 &&
    nav <= stopLossNav * 1.02 + EPS;

  let status = 'normal';
  if (!strategy) status = 'none';
  else if (stopLossHit) status = 'stop';
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
        suggestClose: Boolean(strategy) && returnPct >= strategy.addPositionSellPct
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
      newStopLossNav: strategy ? avgCost * (1 - strategy.stopLossPct / 100) : 0,
      newTakeProfitNav: strategy ? avgCost * (1 + strategy.takeProfitPct / 100) : 0,
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
    newStopLossNav: strategy ? newAvgCost * (1 - strategy.stopLossPct / 100) : 0,
    newTakeProfitNav: strategy ? newAvgCost * (1 + strategy.takeProfitPct / 100) : 0,
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

/** 今日关注条目的严重度排序（stop 最前；normal/none 不产条目） */
export const ATTENTION_ORDER = Object.freeze(['stop', 'trailing', 'takeProfit', 'add', 'nearStop']);

/**
 * 持仓页「今日关注」聚合：从 metrics 列表提取需要行动的基金。
 * 输入元素为 computeFundMetrics 结果（含 fund/status/triggeredTiers/strategy），
 * 仅 stop/trailing/takeProfit/add/nearStop 产生条目，normal/none 只计数。
 * 纯函数：非法/缺失输入按 normal 计数，不抛错。
 */
export function summarizeAttention(metricsList) {
  const counts = { stop: 0, trailing: 0, takeProfit: 0, add: 0, nearStop: 0, normal: 0, none: 0 };
  const items = [];
  for (const m of Array.isArray(metricsList) ? metricsList : []) {
    const status = counts.hasOwnProperty(m && m.status) ? m.status : 'normal';
    counts[status] += 1;
    if (!ATTENTION_ORDER.includes(status)) continue;
    const name = String((m.fund && (m.fund.name || m.fund.code)) || '').trim();
    let text = '';
    if (status === 'stop') {
      text = '触发止损 → 按策略评估卖出';
    } else if (status === 'trailing') {
      text = '移动止盈触发 → 峰值回撤达阈值，评估止盈';
    } else if (status === 'takeProfit') {
      const ratio = Math.round(num(m.strategy && m.strategy.takeProfitSellRatio));
      text = ratio > 0 ? `触发止盈 → 可按预设先卖 ${ratio}%` : '触发止盈 → 评估部分止盈';
    } else if (status === 'add') {
      const tiers = Array.isArray(m.triggeredTiers) ? m.triggeredTiers : [];
      const indexes = tiers.map((tier) => `第 ${num(tier.index) + 1} 档`).join('、');
      const total = tiers.reduce((sum, tier) => sum + num(tier.amount), 0);
      text = `${indexes}触发 → 可补仓 ${Math.round(total)} 元`;
    } else if (status === 'nearStop') {
      text = '接近止损 → 复核基金逻辑，评估是否减仓';
    }
    items.push({ fundId: (m.fund && m.fund.id) || '', name, status, text });
  }
  items.sort((a, b) => ATTENTION_ORDER.indexOf(a.status) - ATTENTION_ORDER.indexOf(b.status));
  return { counts, items };
}

/**
 * 基金类型（东财 F10 FTYPE 原值）→ 三资产类别（EQUITY/BOND/GOLD）。
 * - FTYPE 含「债券」→ BOND
 * - FTYPE 含「黄金」或「指数型-其他」且跟踪标的为 AU9999 → GOLD
 * - 其余（股票型/指数型/混合型/QDII/货币等）→ EQUITY
 * 纯函数：空值/非法输入一律归 EQUITY。
 */
export function classifyAssetClass(ftype, indexCode = '') {
  const type = String(ftype || '');
  const idx = String(indexCode || '').toUpperCase();
  if (type.includes('债券')) return 'BOND';
  if (type.includes('黄金') || (type.startsWith('指数型-其他') && idx === 'AU9999')) return 'GOLD';
  return 'EQUITY';
}

/**
 * 估值分位分级：percentile ≤ 30 → '低估'（down）；≥ 70 → '高估'（warn）；其余 → '正常'（flat）。
 * 非法分位返回 null。
 */
export function gradeValuationPercentile(percentile) {
  if (!Number.isFinite(percentile)) return null;
  if (percentile <= 30) return { label: '低估', tone: 'down' };
  if (percentile >= 70) return { label: '高估', tone: 'warn' };
  return { label: '正常', tone: 'flat' };
}

/**
 * 估值水平：当前值在历史序列中的分位 + 分级。
 * percentile = 序列中 ≤ 当前值的样本数 / 样本总数 × 100
 * @param {number[]} values 历史样本（非法值自动过滤）
 * @param {number} current 当前值（缺省取序列最后一项）
 * @param {{invert?: boolean}} opts invert=true：分位取反。用于债券收益率口径：
 *   收益率越低 = 债券越贵 = 估值分位越高（100 − 原分位）
 * - 分级阈值见 gradeValuationPercentile
 * - 有效样本 < 20 条或当前值非法 → null（界面不显示标签）
 */
export function computeValuationLevel(values, current = null, opts = {}) {
  const list = (Array.isArray(values) ? values : []).map(num).filter((v) => v > EPS);
  if (list.length < 20) return null;

  const currentVal = Number.isFinite(current) && current > EPS ? current : list[list.length - 1];
  if (!(currentVal > EPS)) return null;

  const belowOrEqual = list.filter((v) => v <= currentVal + EPS).length;
  let percentile = (belowOrEqual / list.length) * 100;
  if (opts && opts.invert) percentile = 100 - percentile;

  const grade = gradeValuationPercentile(percentile);
  return grade ? { percentile, ...grade } : null;
}

/**
 * 计算资产配置分析。
 * 口径：统一用 marketValue = shares * currentNav 做占比，无持仓（shares=0）不计入分母。
 * 返回各分类别的实际占比、目标占比、偏差，以及未分类基金。
 */
export function computeAllocation(state, metricsMap) {
  const categories = state.categories || [];
  const funds = state.funds || [];

  // 按类别聚合市值
  const byCategory = new Map();
  let totalMarketValue = 0;
  const uncategorizedFunds = [];

  for (const fund of funds) {
    const metrics = metricsMap.get(fund.id);
    if (!metrics) continue;
    const mv = metrics.marketValue;
    // 只有有持仓的才计入
    if (metrics.position.shares <= EPS || mv <= EPS) continue;
    totalMarketValue += mv;

    const cat = (fund.category || '').trim();
    if (!cat) {
      uncategorizedFunds.push({ fund, marketValue: mv });
    } else {
      const entry = byCategory.get(cat) || { name: cat, marketValue: 0, fundCount: 0, funds: [] };
      entry.marketValue += mv;
      entry.fundCount += 1;
      entry.funds.push({ fund, marketValue: mv });
      byCategory.set(cat, entry);
    }
  }

  // 合并用户配置的 categories 和实际出现的 category
  const result = categories.map((config) => {
    const actual = byCategory.get(config.name);
    const actualValue = actual ? actual.marketValue : 0;
    const actualPct = totalMarketValue > EPS ? (actualValue / totalMarketValue) * 100 : 0;
    const targetPct = num(config.targetPct);
    const deviation = actualPct - targetPct; // 正=超配，负=低配
    // 再平衡金额：达到目标占比需要的调仓额。正=需买入，负=需卖出
    const targetValue = (targetPct / 100) * totalMarketValue;
    const adjustAmount = targetValue - actualValue;
    return {
      name: config.name,
      targetPct,
      actualValue,
      actualPct,
      deviation,
      adjustAmount,
      fundCount: actual ? actual.fundCount : 0,
      funds: actual ? actual.funds : []
    };
  });

  // 把有实际市值但没配置目标的 category 也列出来（targetPct=0）
  const configuredNames = new Set(categories.map((c) => c.name));
  for (const [name, actual] of byCategory) {
    if (!configuredNames.has(name)) {
      const actualPct = totalMarketValue > EPS ? (actual.marketValue / totalMarketValue) * 100 : 0;
      result.push({
        name,
        targetPct: 0,
        actualValue: actual.marketValue,
        actualPct,
        deviation: actualPct,
        fundCount: actual.fundCount,
        funds: actual.funds,
        unconfigured: true
      });
    }
  }

  // 按 |偏差| 降序排列，偏离最大的放前面
  result.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

  const uncategorizedValue = uncategorizedFunds.reduce((sum, item) => sum + item.marketValue, 0);
  const uncategorizedPct = totalMarketValue > EPS ? (uncategorizedValue / totalMarketValue) * 100 : 0;
  const configuredTargetTotal = categories.reduce((sum, c) => sum + num(c.targetPct), 0);

  return {
    totalMarketValue,
    configuredTargetTotal,
    categories: result,
    uncategorizedFunds,
    uncategorizedValue,
    uncategorizedPct
  };
}

/** 资产大类定义（权益 / 债券 / 黄金） */
export const ASSET_CLASSES = Object.freeze([
  { key: 'EQUITY', label: '权益' },
  { key: 'BOND', label: '债券' },
  { key: 'GOLD', label: '黄金' }
]);

export const DEFAULT_ASSET_TARGETS = Object.freeze({ equity: 60, bond: 30, gold: 10 });

/**
 * 三资产预置分配方案（宏观指标驱动自动切换）。
 * 目标比例完全由 recommendAssetScheme 决定，不支持手动自定义。
 */
export const ASSET_SCHEMES = Object.freeze([
  { key: 'aggressive', label: '进攻', targets: { equity: 70, bond: 20, gold: 10 } },
  { key: 'balanced', label: '平衡', targets: { equity: 60, bond: 30, gold: 10 } },
  { key: 'goldHedge', label: '偏金', targets: { equity: 55, bond: 25, gold: 20 } },
  { key: 'defensive', label: '防守', targets: { equity: 40, bond: 40, gold: 20 } }
]);

/**
 * 根据宏观指标推荐三资产方案（纯函数，规则与宏观页方向速览一致）。
 * 优先级：美债曲线倒挂 / 股债分位低位 → 防守；分位高位 → 进攻；
 * 实际利率 ≤0 → 偏金；其余 → 平衡。宏观数据缺失 → 平衡兜底。
 */
export function recommendAssetScheme(macro) {
  const eb = macro && macro.equityBond;
  const percentile = eb && Number.isFinite(eb.ratioPercentile) ? eb.ratioPercentile : null;
  const usBp = macro && Number.isFinite(macro.usTermSpreadBp) ? macro.usTermSpreadBp : null;
  const realRate = macro && Number.isFinite(macro.usRealRate) ? macro.usRealRate : null;
  const pick = (scheme, reason) => ({ ...scheme, reason });
  if (usBp !== null && usBp < 0) {
    return pick(ASSET_SCHEMES[3], '美债收益率曲线倒挂，衰退风险上升，建议防守配置');
  }
  if (percentile !== null && percentile <= 30) {
    return pick(ASSET_SCHEMES[3], `股债性价比分位低位（${Math.round(percentile)}%），债券相对更优，建议防守配置`);
  }
  if (percentile !== null && percentile >= 70) {
    return pick(ASSET_SCHEMES[0], `股债性价比分位高位（${Math.round(percentile)}%），权益吸引力强，建议进攻配置`);
  }
  if (realRate !== null && realRate <= 0) {
    return pick(ASSET_SCHEMES[2], '美国实际利率为负，黄金配置价值上升，建议偏金配置');
  }
  return pick(ASSET_SCHEMES[1], '宏观指标中性，维持均衡配置');
}

/**
 * 三资产再平衡：按 fund.assetClass（EQUITY/BOND/GOLD）聚合市值，
 * 与 settings.assetTargets 目标比例比较，输出实际占比、偏差与调仓金额。
 * 口径与 computeAllocation 一致：无持仓（shares=0 / 市值≤0）的基金不计入。
 * assetTargets 缺失/非法时回退默认值 { equity:60, bond:30, gold:10 }。
 */
export function computeThreeAssetAllocation(state, metricsMap) {
  const funds = state.funds || [];
  const rawTargets = (state.settings && state.settings.assetTargets) || {};
  const targets = {};
  for (const cls of ASSET_CLASSES) {
    const key = cls.key.toLowerCase();
    const value = Number(rawTargets[key]);
    targets[cls.key] = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_ASSET_TARGETS[key];
  }

  const byClass = new Map(ASSET_CLASSES.map((cls) => [cls.key, []]));
  let totalMarketValue = 0;

  for (const fund of funds) {
    const metrics = metricsMap.get(fund.id);
    if (!metrics) continue;
    const mv = metrics.marketValue;
    if (metrics.position.shares <= EPS || mv <= EPS) continue;
    totalMarketValue += mv;
    const cls = ASSET_CLASSES.some((c) => c.key === fund.assetClass) ? fund.assetClass : 'EQUITY';
    byClass.get(cls).push({ fund, marketValue: mv });
  }

  const classes = ASSET_CLASSES.map((cls) => {
    const items = byClass.get(cls.key);
    const actualValue = items.reduce((sum, item) => sum + item.marketValue, 0);
    const actualPct = totalMarketValue > EPS ? (actualValue / totalMarketValue) * 100 : 0;
    const targetPct = targets[cls.key];
    const deviation = actualPct - targetPct; // 正=超配，负=低配
    const targetValue = (targetPct / 100) * totalMarketValue;
    return {
      key: cls.key,
      label: cls.label,
      targetPct,
      actualValue,
      actualPct,
      deviation,
      adjustAmount: targetValue - actualValue, // 正=需买入，负=需卖出
      fundCount: items.length,
      funds: items
    };
  });

  const targetTotal = Object.values(targets).reduce((sum, v) => sum + v, 0);

  return {
    totalMarketValue,
    classes,
    targetTotal,
    targetTotalOk: Math.abs(targetTotal - 100) < 0.01
  };
}

/**
 * 解析批量导入文本。极致精简格式：每行 3 列「代码,持仓金额,持仓收益率」。
 * - 分隔符支持半角逗号、中文逗号、制表符（可直接从 Excel 复制粘贴）
 * - 首行若是表头（首格不是 6 位数字）自动跳过
 * - 「#」或「//」开头的行视为注释
 * - 收益率可省略，省略时按 0 处理；支持负数（亏损）
 * 返回 { rows, errors }，rows 内同代码去重（保留最后一次出现）
 */
export function parseBatchText(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    const lineNo = idx + 1;
    const cells = line.split(/[,\t，、]/).map((c) => c.trim());
    const firstCell = cells[0] || '';

    // 表头行：仅在首格包含非数字字符（如「代码」「code」）时跳过
    if (rows.length === 0 && errors.length === 0 && firstCell !== '' && /[^\d\s]/.test(firstCell)) return;

    const code = firstCell;
    if (!/^\d{6}$/.test(code)) {
      errors.push({ lineNo, code, reason: '代码必须是 6 位数字' });
      return;
    }

    const amount = Number(cells[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ lineNo, code, reason: '持仓金额必须大于 0' });
      return;
    }

    let returnPct = 0;
    if (cells.length >= 3 && cells[2] !== '') {
      returnPct = Number(cells[2]);
      if (!Number.isFinite(returnPct)) {
        errors.push({ lineNo, code, reason: `收益率「${cells[2]}」不是数字` });
        return;
      }
    }

    rows.push({ code, amount, returnPct, lineNo });
  });

  // 同代码去重，保留最后一行
  const byCode = new Map();
  for (const row of rows) byCode.set(row.code, row);

  return { rows: [...byCode.values()], errors };
}

/**
 * 策略回测：用基金本地净值快照（[{date,nav}]，升序）回放预设策略自动执行效果。
 * 回放口径（与 computeFundMetrics 对齐）：
 * - 首日按收盘净值全仓买入 initialAmount（底仓语义，tierAnchor = 首日买入价）
 * - 逐日按 trailing > stop > takeProfit > add 链序处理：
 *   移动止盈（armed 且回撤达标 → 清余仓离场）；止损（清仓离场）；
 *   止盈（每周期按 takeProfitSellRatio% 卖份额，净值回落至止盈线下方重置）；
 *   补仓（未执行档位 nav ≤ anchor×(1−dropPct) → 买入 tier.amount，成本换锚）
 * - maxDrawdown 基于「市值+现金」账户总权益曲线
 * 有效样本（nav>0）< 20 → { ok:false, reason }；纯函数，脏数据过滤不抛错。
 */
export function backtestStrategy(navHistory, strategyKey, initialAmount = 10000) {
  const strategy = resolveStrategyByKey(strategyKey, null) || STRATEGY_PRESETS.NORMAL;
  const series = (Array.isArray(navHistory) ? navHistory : [])
    .map((p) => ({ date: String((p && p.date) || ''), nav: Number(p && p.nav) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.nav) && p.nav > 0);
  if (series.length < 20) {
    return { ok: false, reason: '净值样本不足 20 天，暂无法回测' };
  }

  const firstNav = series[0].nav;
  let shares = initialAmount / firstNav;
  let cash = 0;
  let invested = initialAmount;
  let tierAnchor = firstNav;
  let avgCost = firstNav;
  let peak = firstNav;
  let peakEquity = initialAmount;
  let takeProfitSold = false;
  let closed = false; // 止损/移动止盈清仓后不再交易
  const tierState = (strategy.addTiers || []).map(() => false);
  const counts = { stopLoss: 0, takeProfit: 0, trailing: 0, addBuys: 0 };
  let addTotalAmount = 0;
  let maxDrawdownPct = 0;

  const stopLossNav = () => avgCost * (1 - strategy.stopLossPct / 100);
  const takeProfitNav = () => avgCost * (1 + strategy.takeProfitPct / 100);

  for (let i = 1; i < series.length; i++) {
    const { nav } = series[i];

    if (!closed && shares > EPS) {
      // 移动止盈：峰值达到止盈线后，回撤达标清余仓
      const armed = peak >= takeProfitNav() - EPS;
      const trailingNav = peak * (1 - strategy.trailingStopPct / 100);
      if (armed && nav <= trailingNav + EPS) {
        cash += shares * nav;
        counts.trailing += 1;
        shares = 0;
        closed = true;
      } else if (nav <= stopLossNav() + EPS) {
        // 止损：一次性清仓
        cash += shares * nav;
        counts.stopLoss += 1;
        shares = 0;
        closed = true;
      } else if (nav >= takeProfitNav() - EPS && !takeProfitSold) {
        // 止盈：按预设比例卖出份额，成本按平均成本结转
        const sellShares = shares * (strategy.takeProfitSellRatio / 100);
        cash += sellShares * nav;
        shares -= sellShares;
        counts.takeProfit += 1;
        takeProfitSold = true;
      }
    }

    // 补仓：仅在持仓状态下执行（清仓后不再买回）
    if (!closed && shares > EPS) {
      (strategy.addTiers || []).forEach((tier, index) => {
        if (tierState[index]) return;
        const triggerNav = tierAnchor * (1 - tier.dropPct / 100);
        if (nav <= triggerNav + EPS) {
          tierState[index] = true;
          const buyShares = tier.amount / nav;
          avgCost = (avgCost * shares + tier.amount) / (shares + buyShares);
          shares += buyShares;
          invested += tier.amount;
          addTotalAmount += tier.amount;
          counts.addBuys += 1;
        }
      });
    }

    if (!closed && shares > EPS) peak = Math.max(peak, nav);
    // 止盈周期重置：净值回落至止盈线下方后才允许下一轮止盈（当日触发不算）
    if (nav < takeProfitNav() - EPS) takeProfitSold = false;

    // 账户总权益回撤
    const equity = shares * nav + cash;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > EPS) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
    }
  }

  const lastNav = series[series.length - 1].nav;
  const finalMarketValue = shares * lastNav;
  return {
    ok: true,
    sampleSize: series.length,
    startDate: series[0].date,
    endDate: series[series.length - 1].date,
    initialAmount,
    totalInvested: invested,
    finalMarketValue,
    finalCash: cash,
    finalAvgCost: shares > EPS ? avgCost : 0,
    totalReturnPct: ((finalMarketValue + cash - invested) / invested) * 100,
    buyHoldReturnPct: (lastNav / firstNav - 1) * 100,
    maxDrawdownPct,
    counts,
    addTotalAmount
  };
}

/**
 * sparkline 采样：navHistory 尾部 ≤samples 点归一化到 68×24 视口（内缩 1px）。
 * 有效样本（nav>0）< 5 → null；max===min 走水平中线；dir 按首尾涨跌（up/down/flat）。
 * 纯函数，脏数据过滤不抛错。
 */
export function sparklineData(history, samples = 60) {
  const series = (Array.isArray(history) ? history : [])
    .map((p) => (typeof p === 'number' ? p : Number(p && p.nav)))
    .filter((nav) => Number.isFinite(nav) && nav > 0)
    .slice(-samples);
  if (series.length < 5) return null;

  const W = 68;
  const H = 24;
  const PAD = 1;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const step = span > EPS ? (W - PAD * 2) / (series.length - 1) : 0;
  const points = series
    .map((nav, i) => {
      const x = PAD + step * i;
      const y = span > EPS ? PAD + (1 - (nav - min) / span) * (H - PAD * 2) : H / 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const last = series[series.length - 1];
  const dir = last > series[0] + EPS ? 'up' : last < series[0] - EPS ? 'down' : 'flat';
  return { points, dir };
}
