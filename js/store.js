import {
  DEFAULT_ASSET_TARGETS,
  STRATEGY_KEYS,
  STRATEGY_PRESETS,
  cloneStrategyPreset,
  classifyAssetClass,
  num,
  strategyKeyFromLegacy
} from './strategy.js';

const STORAGE_KEY = 'fundpilot.v1';
export const VERSION = 6;

export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 三资产大类合法值（与 strategy.js::ASSET_CLASSES 对齐） */
const ASSET_CLASS_KEYS = ['EQUITY', 'BOND', 'GOLD'];

/** 三资产目标比例清洗：缺失回退默认值，数值钳制 0–100 */
function sanitizeAssetTargets(raw) {
  const targets = { ...DEFAULT_ASSET_TARGETS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(targets)) {
      const value = Number(raw[key]);
      if (Number.isFinite(value)) targets[key] = Math.min(100, Math.max(0, value));
    }
  }
  return targets;
}

/**
 * 定投计划清洗：非法/空 → null（未启用）。
 * v6 起定投不再逐笔落 trades，改为聚合累计：totalShares/totalAmount/lastDate。
 * 历史字段缺失按 0/'' 补齐（迁移保证幂等）。
 */
function sanitizeSip(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const freq = raw.freq === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
  const weekdayRaw = Number(raw.weekday);
  const weekday = Number.isInteger(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 5 ? weekdayRaw : 1;
  const startDate = typeof raw.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)
    ? raw.startDate
    : '';
  const totalShares = Number(raw.totalShares);
  const totalAmount = Number(raw.totalAmount);
  const lastDate = typeof raw.lastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDate)
    ? raw.lastDate
    : '';
  return {
    enabled: true,
    freq,
    weekday,
    amount,
    startDate,
    totalShares: Number.isFinite(totalShares) && totalShares > 0 ? totalShares : 0,
    totalAmount: Number.isFinite(totalAmount) && totalAmount > 0 ? totalAmount : 0,
    lastDate
  };
}

export function defaultState() {
  return {
    version: VERSION,
    settings: {
      defaultStrategy: 'NORMAL', // 'NORMAL' | 'AGGRESSIVE'
      assetTargets: { ...DEFAULT_ASSET_TARGETS },
      strategies: {
        NORMAL: cloneStrategyPreset('NORMAL'),
        AGGRESSIVE: cloneStrategyPreset('AGGRESSIVE')
      }
    },
    categories: [],
    funds: []
  };
}

/** 清洗单个用户自定义策略对象（缺字段回退工厂默认） */
function sanitizeStrategy(key, raw) {
  const preset = cloneStrategyPreset(key);
  if (!raw || typeof raw !== 'object') return preset;
  const merged = { ...preset };
  for (const f of ['stopLossPct', 'takeProfitPct', 'takeProfitSellRatio', 'trailingStopPct',
                   'reserveAmount', 'reserveTriggerPct', 'addPositionSellPct']) {
    const v = Number(raw[f]);
    if (Number.isFinite(v) && v >= 0) merged[f] = v;
  }
  if (Array.isArray(raw.addTiers) && raw.addTiers.length > 0) {
    const tiers = raw.addTiers
      .map((t) => ({ dropPct: Number(t && t.dropPct), amount: Number(t && t.amount) }))
      .filter((t) => Number.isFinite(t.dropPct) && t.dropPct > 0 && Number.isFinite(t.amount) && t.amount >= 0);
    if (tiers.length > 0) merged.addTiers = tiers;
  }
  return merged;
}

function sanitizeTrade(trade) {
  if (!trade || typeof trade !== 'object') return null;
  const type = trade.type === 'SELL' ? 'SELL' : 'BUY';
  return {
    id: typeof trade.id === 'string' ? trade.id : uid(),
    type,
    date: typeof trade.date === 'string' && trade.date ? trade.date : '',
    nav: num(trade.nav),
    amount: num(trade.amount),
    shares: num(trade.shares),
    fee: num(trade.fee),
    source: ['ADD', 'SIP', 'MANUAL', 'AUTO'].includes(trade.source) ? trade.source : 'BASE',
    tierIndex: Number.isInteger(trade.tierIndex) ? trade.tierIndex : null,
    note: typeof trade.note === 'string' ? trade.note : '',
    closed: Boolean(trade.closed),
    createdAt: num(trade.createdAt) || Date.now()
  };
}

function sanitizeFund(fund) {
  if (!fund || typeof fund !== 'object') return null;
  let trades = (Array.isArray(fund.trades) ? fund.trades : [])
    .map(sanitizeTrade)
    .filter(Boolean);
  const navHistory = (Array.isArray(fund.navHistory) ? fund.navHistory : [])
    .map((item) => ({ date: String(item && item.date), nav: num(item && item.nav) }))
    .filter((item) => item.date && item.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  // 策略覆盖清洗：字符串 ∈ NORMAL/AGGRESSIVE/NONE 保留，其余非法字符串 → null；
  // 旧对象型覆盖（非空）→ 预置 key（stopLossPct ≤ 10 → 'AGGRESSIVE'，否则 'NORMAL'）；
  // 空对象/null/缺失 → null（跟随全局）
  let strategyOverride = null;
  const rawOverride = fund.strategyOverride;
  if (typeof rawOverride === 'string') {
    if (rawOverride === 'NONE' || STRATEGY_KEYS.includes(rawOverride)) {
      strategyOverride = rawOverride;
    }
  } else if (rawOverride && typeof rawOverride === 'object' && Object.keys(rawOverride).length > 0) {
    strategyOverride = strategyKeyFromLegacy(rawOverride);
  }

  // 资产大类完全由 FTYPE 自动归类（v4 起取消手动指定）：
  // 1. ftype 含「债券」→ BOND；2. ftype 含「黄金」→ GOLD；
  // 3. 原大类为 GOLD 保留（防「指数型-其他」靠 INDEXCODE=AU9999 归类的黄金基金迁移时被打回）；
  // 4. 其余按 classifyAssetClass(ftype)（缺省 EQUITY；手动错标 BOND 的基金会被回正为 EQUITY）
  let assetClass;
  const rawClass = ASSET_CLASS_KEYS.includes(fund.assetClass) ? fund.assetClass : 'EQUITY';
  const ftype = typeof fund.ftype === 'string' ? fund.ftype.trim() : '';
  if (ftype.includes('债券')) assetClass = 'BOND';
  else if (ftype.includes('黄金')) assetClass = 'GOLD';
  else if (rawClass === 'GOLD') assetClass = 'GOLD';
  else assetClass = classifyAssetClass(ftype);

  // 底仓迁移（幂等）：基金没有任何 BASE 买入记录时，尝试从旧版 holdingBase 结构
  // （{ source: 'TRADE'|'PNL', amount, pct, nav, date }）反推生成一条底仓交易，
  // 保证交易明细 / 持仓成本对老数据可见。无法反推（字段缺失/非法）则保持空仓。
  const hasBaseTrade = trades.some((t) => t.type === 'BUY' && t.source === 'BASE');
  if (!hasBaseTrade) {
    const hb = fund.holdingBase && typeof fund.holdingBase === 'object' ? fund.holdingBase : null;
    const hbAmount = num(hb && hb.amount);
    const hbPct = num(hb && hb.pct);
    const hbNav = num(hb && hb.nav);
    if (hb && hbAmount > 0) {
      let baseShares = 0;
      let baseCost = 0;
      let baseNav = 0;
      if ((hb.source || '') === 'PNL') {
        // PNL：amount=当前市值，pct=收益率；成本 = 市值 / (1 + pct%)，份额用 holdingBase.nav 或最新 navHistory
        const navForShares = hbNav > 0 ? hbNav : (navHistory.length ? navHistory[navHistory.length - 1].nav : 0);
        if (navForShares > 0) {
          baseCost = hbAmount / (1 + hbPct / 100);
          baseShares = hbAmount / navForShares;
          baseNav = baseCost / baseShares;
        }
      } else {
        // TRADE：amount=投入本金，nav=成交净值
        if (hbNav > 0) {
          baseCost = hbAmount;
          baseShares = hbAmount / hbNav;
          baseNav = hbNav;
        }
      }
      if (baseShares > 0 && baseNav > 0) {
        trades.push({
          id: uid(),
          type: 'BUY',
          date: typeof hb.date === 'string' && hb.date ? hb.date : (navHistory.length ? navHistory[0].date : ''),
          nav: baseNav,
          amount: baseCost,
          shares: baseShares,
          fee: num(hb.fee),
          source: 'BASE',
          tierIndex: null,
          note: '底仓迁移（holdingBase 反推）',
          closed: false,
          createdAt: Date.now()
        });
      }
    }
  }

  // 定投迁移（幂等）：v5 及以前定投逐笔落 trades（source='SIP'），v6 起聚合到 fund.sip
  // 的 totalShares/totalAmount/lastDate 并从 trades 移除逐笔记录。
  // 停用后转换的聚合 BUY 记录（source='SIP' 且无对应启用计划）保留在 trades 不动。
  if (fund.sip && fund.sip.enabled === true) {
    const sipTrades = trades.filter((t) => t.source === 'SIP');
    if (sipTrades.length > 0) {
      const aggAmount = sipTrades.reduce((sum, t) => sum + num(t.amount), 0);
      const aggShares = sipTrades.reduce((sum, t) => sum + num(t.shares), 0);
      const aggLastDate = sipTrades.reduce((latest, t) => (String(t.date) > latest ? String(t.date) : latest), '');
      const sip = sanitizeSip(fund.sip);
      // trades 为权威（逐笔已发生），聚合字段取两者较大者防重复迁移叠加
      fund.sip = {
        ...sip,
        totalShares: Math.max(sip.totalShares, aggShares),
        totalAmount: Math.max(sip.totalAmount, aggAmount),
        lastDate: aggLastDate > sip.lastDate ? aggLastDate : sip.lastDate
      };
      trades = trades.filter((t) => t.source !== 'SIP');
    } else {
      fund.sip = sanitizeSip(fund.sip);
    }
  } else {
    fund.sip = sanitizeSip(fund.sip);
  }

  return {
    id: typeof fund.id === 'string' && fund.id ? fund.id : uid(),
    code: String(fund.code || '').trim(),
    name: String(fund.name || '').trim(),
    nav: num(fund.nav),
    navDate: typeof fund.navDate === 'string' ? fund.navDate : '',
    navUpdatedAt: num(fund.navUpdatedAt),
    navHistory,
    category: typeof fund.category === 'string' ? fund.category.trim() : '',
    assetClass,
    ftype,
    strategyOverride,
    trades,
    sip: fund.sip,
    tierState: Array.isArray(fund.tierState) ? fund.tierState.map(Boolean) : [],
    logicIntact: fund.logicIntact !== false
  };
}

export function normalizeState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;

  // 策略迁移（幂等，兼容 version 2/3）：
  // - 旧对象型策略 → 预置 key（stopLossPct ≤ 10 → 'AGGRESSIVE'，否则 'NORMAL'；字段缺失/非法 → 'NORMAL'）
  // - 新版字符串 ∈ NORMAL/AGGRESSIVE 保留，其余（含缺失/NONE/空）→ 'NORMAL'
  if (raw.settings && typeof raw.settings === 'object') {
    const rawDefault = raw.settings.defaultStrategy;
    if (typeof rawDefault === 'string') {
      state.settings.defaultStrategy = STRATEGY_KEYS.includes(rawDefault) ? rawDefault : 'NORMAL';
    } else if (rawDefault && typeof rawDefault === 'object') {
      state.settings.defaultStrategy = strategyKeyFromLegacy(rawDefault);
    }
  }

  state.settings.assetTargets = sanitizeAssetTargets(
    raw.settings && typeof raw.settings === 'object' ? raw.settings.assetTargets : null
  );

  // v5 新增：用户可编辑的策略参数；缺失时种子工厂默认
  const rawStrategies = raw.settings && typeof raw.settings === 'object' && raw.settings.strategies;
  state.settings.strategies = {
    NORMAL: sanitizeStrategy('NORMAL', rawStrategies && rawStrategies.NORMAL),
    AGGRESSIVE: sanitizeStrategy('AGGRESSIVE', rawStrategies && rawStrategies.AGGRESSIVE)
  };

  state.categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((cat) => ({
      name: typeof cat.name === 'string' ? cat.name.trim() : '',
      targetPct: num(cat.targetPct)
    }))
    .filter((cat) => cat.name);

  state.funds = (Array.isArray(raw.funds) ? raw.funds : []).map(sanitizeFund).filter(Boolean);
  return state;
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn('读取本地数据失败，使用默认配置', error);
    return defaultState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error('保存本地数据失败', error);
    return false;
  }
}

export function clear() {
  localStorage.removeItem(STORAGE_KEY);
}

export function exportPayload(state) {
  return JSON.stringify(
    { app: 'FundPilot', version: VERSION, exportedAt: new Date().toISOString(), data: state },
    null,
    2
  );
}

export function importPayload(text) {
  const parsed = JSON.parse(text);
  const raw = parsed && parsed.data ? parsed.data : parsed;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.funds)) {
    throw new Error('文件格式不正确：缺少 funds 列表');
  }
  return normalizeState(raw);
}
