import {
  DEFAULT_ASSET_TARGETS,
  STRATEGY_KEYS,
  num,
  strategyKeyFromLegacy
} from './strategy.js';

const STORAGE_KEY = 'fundpilot.v1';
export const VERSION = 3;

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

export function defaultState() {
  return {
    version: VERSION,
    settings: {
      defaultStrategy: 'NORMAL', // 'NORMAL' | 'AGGRESSIVE'
      assetTargets: { ...DEFAULT_ASSET_TARGETS }
    },
    categories: [],
    funds: []
  };
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
    source: trade.source === 'ADD' ? 'ADD' : 'BASE',
    tierIndex: Number.isInteger(trade.tierIndex) ? trade.tierIndex : null,
    note: typeof trade.note === 'string' ? trade.note : '',
    closed: Boolean(trade.closed),
    createdAt: num(trade.createdAt) || Date.now()
  };
}

function sanitizeFund(fund) {
  if (!fund || typeof fund !== 'object') return null;
  const trades = (Array.isArray(fund.trades) ? fund.trades : [])
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

  return {
    id: typeof fund.id === 'string' && fund.id ? fund.id : uid(),
    code: String(fund.code || '').trim(),
    name: String(fund.name || '').trim(),
    nav: num(fund.nav),
    navDate: typeof fund.navDate === 'string' ? fund.navDate : '',
    navUpdatedAt: num(fund.navUpdatedAt),
    navHistory,
    category: typeof fund.category === 'string' ? fund.category.trim() : '',
    assetClass: ASSET_CLASS_KEYS.includes(fund.assetClass) ? fund.assetClass : 'EQUITY',
    strategyOverride,
    trades,
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
