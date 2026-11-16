import { DEFAULT_STRATEGY, cloneStrategy, normalizeTiers, num } from './strategy.js';

const STORAGE_KEY = 'fundpilot.v1';
export const VERSION = 2;

export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultState() {
  return {
    version: VERSION,
    settings: { defaultStrategy: cloneStrategy(DEFAULT_STRATEGY) },
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

  let strategyOverride = null;
  if (fund.strategyOverride && typeof fund.strategyOverride === 'object') {
    const override = {};
    Object.entries(fund.strategyOverride).forEach(([key, value]) => {
      if (key === 'addTiers') {
        const tiers = normalizeTiers(value);
        if (tiers.length) override.addTiers = tiers;
      } else if (Number.isFinite(Number(value))) {
        override[key] = Number(value);
      }
    });
    if (Object.keys(override).length) strategyOverride = override;
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
    strategyOverride,
    trades,
    tierState: Array.isArray(fund.tierState) ? fund.tierState.map(Boolean) : [],
    logicIntact: fund.logicIntact !== false
  };
}

export function normalizeState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;

  if (raw.settings && raw.settings.defaultStrategy) {
    const strategy = cloneStrategy(DEFAULT_STRATEGY);
    Object.keys(strategy).forEach((key) => {
      if (key === 'addTiers') {
        const tiers = normalizeTiers(raw.settings.defaultStrategy.addTiers);
        if (tiers.length) strategy.addTiers = tiers;
      } else if (Number.isFinite(Number(raw.settings.defaultStrategy[key]))) {
        strategy[key] = Number(raw.settings.defaultStrategy[key]);
      }
    });
    state.settings.defaultStrategy = strategy;
  }

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
