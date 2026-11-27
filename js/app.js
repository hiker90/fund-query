import * as store from './store.js';
import {
  backtestStrategy,
  classifyAssetClass,
  cloneStrategyPreset,
  computeFundMetrics,
  fundAssetKind,
  computeValuationLevel,
  computeSipTrades,
  num,
  parseBatchText,
  resolveStrategyByKey,
  resolveTradeNav,
  settlePendingTrades,
  simulateAdd,
  STRATEGY_KEYS,
  todayISO as strategyTodayISO
} from './strategy.js';
import { fetchQuotes, fetchFundBasicInfo, isFundCode } from './quote.js';
import { fetchMacroData, fetchKlineClose } from './macro.js';
import * as views from './views.js';
import {
  confirmDialog,
  downloadText,
  hideSheet,
  showSheet,
  toast,
  todayISO
} from './ui.js';

let state = store.load();
let refreshing = false;
let currentFundId = null;
let lastRouteKey = '';
let macroData = null;
let macroLoading = false;
const expandedAllocCats = new Set();
const expandedAssetClasses = new Set();
/** 持仓页复合筛选：空 Set 表示该维度不过滤 */
const holdingsFilterState = {
  statuses: new Set(),      // Set<'active'|'add'|'take'|'stop'|'other'>  5 类分组 key
  ftypes: new Set(),        // Set<string>  基金 ftype 原值
  assetClasses: new Set(),  // 'EQUITY' | 'BOND' | 'GOLD'
  strategies: new Set(),    // 'NORMAL' | 'AGGRESSIVE' | 'NONE' | 'GLOBAL'
  categories: new Set()     // category name 字符串；空字符串=未分类
};
/** 持仓页排序：维度 key + 升降序 */
let holdingsSortBy = 'status'; // 'status' | 'marketValue' | 'holdingPnlPct' | 'assetClass' | 'category'
let holdingsSortDir = 'asc';   // 'asc' | 'desc'

// 持仓页按需拉取：进入路由时自动拉一次，5 分钟内不重复（无定时器轮询）
let lastAutoFetchAt = 0;
const AUTO_FETCH_GAP_MS = 5 * 60 * 1000;

// 估值水平缓存：基金代码 → { level, fetchedAt }，内存 30 分钟（禁止写入 localStorage）
const valuationCache = new Map();
const VALUATION_TTL_MS = 30 * 60 * 1000;
let valuationLoading = false;

// 估值序列窗口：约 2 年自然日（≈500 个交易日），满足各类型分位样本要求
const VALUATION_KLINE_DAYS = 750;
const VALUATION_BEG = (() => {
  const d = new Date(Date.now() - VALUATION_KLINE_DAYS * 24 * 3600 * 1000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

// 债券/黄金估值序列标的：中债10Y收益率（分位取反）、COMEX 黄金
const BOND_YIELD_SECID = '171.CN10Y';
const GOLD_PRICE_SECID = '101.GC00Y';

/**
 * F10 基金类型自动归类三资产（v1.17 起完全自动，无手动指定）：
 * fund.ftype 始终更新为 FTYPE 原值，assetClass 恒按 classifyAssetClass 归类。
 * 返回是否有字段变化（需要持久化）。
 */
function applyFundClassification(fund, info) {
  if (!info || !info.ftype) return false;
  let changed = fund.ftype !== info.ftype;
  fund.ftype = info.ftype;
  const derived = classifyAssetClass(info.ftype, info.indexCode);
  if (derived !== fund.assetClass) {
    fund.assetClass = derived;
    changed = true;
  }
  return changed;
}

/**
 * 按基金类型确定估值口径（F10 基本信息优先，assetClass 兜底）：
 * - 债券（assetClass=BOND 或 FTYPE 含「债券」）→ 中债10Y收益率分位取反
 * - 黄金（assetClass=GOLD 或 FTYPE「指数型-其他」且 INDEXCODE=AU9999）→ 金价分位
 * - 指数股票（FTYPE「指数型-股票」+ 6 位 INDEXCODE + 交易所 0/1）→ 跟踪指数价格分位
 * - 主动/行业/QDII 基金 → null（不展示估值标签）
 */
function resolveValuationKind(fund, info) {
  const ftype = info ? String(info.ftype || '') : '';
  const indexCode = info ? String(info.indexCode || '') : '';
  const indexExchange = info ? String(info.indexExchange || '') : '';

  if (fund.assetClass === 'BOND' || ftype.includes('债券')) {
    return { kind: 'bond', key: 'bond' };
  }
  if (fund.assetClass === 'GOLD' || (ftype.startsWith('指数型-其他') && indexCode === 'AU9999')) {
    return { kind: 'gold', key: 'gold' };
  }
  if (
    ftype.startsWith('指数型-股票') &&
    /^\d{6}$/.test(indexCode) &&
    (indexExchange === '0' || indexExchange === '1')
  ) {
    return { kind: 'index', key: `index:${indexExchange}.${indexCode}`, secid: `${indexExchange}.${indexCode}` };
  }
  return null;
}

function valuationSecid(kind) {
  if (kind.kind === 'bond') return BOND_YIELD_SECID;
  if (kind.kind === 'gold') return GOLD_PRICE_SECID;
  return kind.secid;
}

/** 拉取某估值口径的分位结果；失败/样本不足返回 null（缓存期内不重试） */
async function fetchValuationLevelForKind(kind) {
  try {
    const series = await fetchKlineClose(valuationSecid(kind), VALUATION_BEG);
    if (!series || series.length < 20) return null;
    const closes = series.map((point) => point.close);
    return computeValuationLevel(closes, closes[closes.length - 1], { invert: kind.kind === 'bond' });
  } catch {
    return null;
  }
}

function maybeAutoFetchHoldings() {
  if (refreshing) return;
  const now = Date.now();
  if (lastAutoFetchAt !== 0 && now - lastAutoFetchAt < AUTO_FETCH_GAP_MS) return;
  if (state.funds.length === 0) return; // 无基金时不触发，避免空提示
  lastAutoFetchAt = now;
  refreshFunds().catch(() => {});
}

async function loadValuations() {
  if (valuationLoading) return;
  const now = Date.now();
  const targets = state.funds.filter((fund) => {
    const cached = valuationCache.get(fund.code);
    return !cached || now - cached.fetchedAt >= VALUATION_TTL_MS;
  });
  if (targets.length === 0) return;

  valuationLoading = true;
  let classificationChanged = false;
  try {
    // 1. F10 基本信息分流：确定每只基金的估值口径 + 自动归类三资产（主动/行业基金直接 null，不发后续请求）
    const kinds = await Promise.all(
      targets.map(async (fund) => {
        const info = await fetchFundBasicInfo(fund.code);
        if (applyFundClassification(fund, info)) classificationChanged = true;
        return [fund.code, resolveValuationKind(fund, info)];
      })
    );

    // 2. 同口径共享一条序列（债券/黄金全市场共用，指数按 secid 共用），去重后并发拉取
    const levelByKey = new Map(); // key → level（占位 null，拉取成功后覆盖）
    const jobs = [];
    for (const [, kind] of kinds) {
      if (!kind || levelByKey.has(kind.key)) continue;
      levelByKey.set(kind.key, null);
      jobs.push(
        fetchValuationLevelForKind(kind).then((level) => {
          levelByKey.set(kind.key, level);
        })
      );
    }
    await Promise.all(jobs);

    // 3. 写回基金级缓存（null 也写入，TTL 内不重试）
    for (const [code, kind] of kinds) {
      valuationCache.set(code, {
        level: kind ? levelByKey.get(kind.key) : null,
        fetchedAt: Date.now()
      });
    }
    if (classificationChanged) store.save(state); // 自动归类有变化时持久化（渲染统一走末尾）
  } finally {
    valuationLoading = false;
  }
  if (parseRoute().name === 'holdings') render(); // fetch 完成后更新估值标签
}

/** 基金代码 → 估值水平（仅返回已成功获取且未过期的） */
function buildValuationMap() {
  const map = new Map();
  const now = Date.now();
  for (const fund of state.funds) {
    const cached = valuationCache.get(fund.code);
    if (cached && cached.level && now - cached.fetchedAt < VALUATION_TTL_MS) {
      map.set(fund.code, cached.level);
    }
  }
  return map;
}

async function loadMacro({ force = false } = {}) {
  if (macroLoading) return;
  macroLoading = true;
  const name = parseRoute().name;
  if (name === 'macro') render();
  try {
    const data = await fetchMacroData({ force });
    macroData = data;
    // macro/holdings/detail 三路由都消费宏观数据（持仓/详情页用于宏观方向徽章）
    const after = parseRoute().name;
    if (name === after && ['macro', 'holdings', 'detail'].includes(after)) render();
  } finally {
    macroLoading = false;
  }
}

const app = document.getElementById('app');

function parseRoute() {
  const hash = String(location.hash || '').replace(/^#/, '');
  if (hash.startsWith('/fund/')) return { name: 'detail', id: hash.slice('/fund/'.length) };
  if (hash === '/holdings') return { name: 'holdings' };
  if (hash === '/trades') return { name: 'trades' };
  if (hash === '/strategy') return { name: 'strategy' };
  if (hash === '/allocation') return { name: 'allocation' };
  if (hash === '/data') return { name: 'data' };
  if (hash === '/macro') return { name: 'macro' };
  return { name: 'macro' };
}

function getFund(id) {
  return state.funds.find((fund) => fund.id === id) || null;
}

function metricsFor(fund) {
  return computeFundMetrics(fund, state.settings.defaultStrategy, state.settings.strategies);
}

function buildMetricsMap() {
  return new Map(state.funds.map((fund) => [fund.id, metricsFor(fund)]));
}

function updateTabs(route) {
  document.querySelectorAll('.tabbar a').forEach((link) => {
    const tab = link.dataset.tab;
    const active =
      tab === route.name ||
      (tab === 'holdings' && (route.name === 'detail' || route.name === 'trades'));
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/** 存在锁定类基金（债券/黄金/海外）时静默拉取宏观数据（供宏观方向徽章用，失败不提示） */
function ensureMacroForAdvice() {
  if (!macroData && !macroLoading && state.funds.some((fund) => fundAssetKind(fund) !== 'EQUITY')) {
    loadMacro().catch(() => {});
  }
}

function render() {
  const route = parseRoute();

  if (route.name === 'detail') {
    const fund = getFund(route.id);
    if (!fund) {
      location.hash = '#/holdings';
      return;
    }
    currentFundId = fund.id;
    app.innerHTML = views.detailPage(metricsFor(fund), macroData);
    ensureMacroForAdvice();
  } else if (route.name === 'trades') {
    currentFundId = null;
    app.innerHTML = views.tradesPage(state, buildMetricsMap());
  } else if (route.name === 'strategy') {
    currentFundId = null;
    app.innerHTML = views.strategyPage(state);
  } else if (route.name === 'allocation') {
    currentFundId = null;
    app.innerHTML = views.allocationPage(state, buildMetricsMap(), expandedAllocCats, macroData, expandedAssetClasses);
  } else if (route.name === 'data') {
    currentFundId = null;
    app.innerHTML = views.dataPage(state);
  } else if (route.name === 'macro') {
    currentFundId = null;
    app.innerHTML = views.macroPage(macroData, { refreshing: macroLoading });
    if (!macroData && !macroLoading) {
      loadMacro().catch((error) => {
        toast(`宏观数据加载失败：${error.message}`, 'error');
      });
    }
  } else {
    currentFundId = null;
    app.innerHTML = views.holdingsPage(state, buildMetricsMap(), {
      refreshing,
      filterState: holdingsFilterState,
      sortBy: holdingsSortBy,
      sortDir: holdingsSortDir,
      valuations: buildValuationMap(),
      macro: macroData
    });
    maybeAutoFetchHoldings();
    loadValuations().catch(() => {});
    ensureMacroForAdvice();
  }

  updateTabs(route);

  const routeKey = route.name === 'detail' ? `detail:${route.id}` : route.name;
  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    window.scrollTo(0, 0);
  }
}

function commit() {
  store.save(state);
  render();
}

function normalizeTierState(fund) {
  const strategy = resolveStrategyByKey(state.settings.defaultStrategy, fund.strategyOverride, state.settings.strategies);
  const tiers = (strategy && strategy.addTiers ? strategy.addTiers : []).length;
  const current = Array.isArray(fund.tierState) ? fund.tierState : [];
  fund.tierState = Array.from({ length: tiers }, (_, index) => Boolean(current[index]));
}

/** 结算某基金的暂存交易（净值到达后按当日净值确认）；返回结算笔数 */
function settleFundPending(fund) {
  const { trades, settledCount } = settlePendingTrades(fund);
  if (settledCount > 0) fund.trades = trades;
  return settledCount;
}

function applyQuote(fund, quote) {
  if (quote.name) fund.name = quote.name;
  if (!(quote.nav > 0)) return 0;
  fund.nav = quote.nav;
  fund.navDate = quote.navDate || fund.navDate;
  fund.navUpdatedAt = Date.now();

  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const existing = history.findIndex((item) => item.date === fund.navDate);
  if (existing >= 0) history[existing] = { date: fund.navDate, nav: quote.nav };
  else history.push({ date: fund.navDate, nav: quote.nav });
  history.sort((a, b) => a.date.localeCompare(b.date));
  fund.navHistory = history.slice(-365);
  // 净值到达后自动确认暂存交易（以当日净值生成记录）
  return settleFundPending(fund);
}

async function refreshFunds(ids = null) {
  if (refreshing) return;
  const funds = state.funds.filter((fund) => !ids || ids.includes(fund.id));
  if (funds.length === 0) {
    toast('请先添加需要监控的基金', 'warn');
    return;
  }

  refreshing = true;
  render();

  try {
    const quotes = await fetchQuotes(funds.map((fund) => fund.code));
    const missing = [];
    let updated = 0;
    let settled = 0;

    funds.forEach((fund) => {
      const quote = quotes.get(fund.code);
      if (!quote || !(quote.nav > 0)) {
        missing.push(fund.code);
        return;
      }
      settled += applyQuote(fund, quote);
      updated += 1;
    });

    store.save(state);
    applySip();
    if (updated > 0) toast(`已更新 ${updated} 只基金的净值`, 'success');
    if (settled > 0) toast(`已按当日净值确认 ${settled} 笔暂存交易`, 'success');
    if (missing.length > 0) toast(`未取到 ${missing.join('、')} 的净值，可手动录入`, 'warn');
  } catch (error) {
    toast(`刷新失败：${error.message}`, 'error');
  } finally {
    refreshing = false;
    render();
  }
}

function openAddFund() {
  showSheet({
    title: '添加监控基金',
    subtitle: '输入 6 位代码，可自动查询名称与净值',
    body: views.addFundSheetBody(state.categories || []),
    tall: true
  });
}

/* ============================ 定投（SIP） ============================ */

let sipWeekdayDraft = 1; // sheet 内临时选中的周几（1–5），确认时写入计划

/** 执行定投：聚合模式 —— 待执行列表累加进 sip.totalShares/totalAmount/lastDate（不落逐笔 trades） */
function applySip() {
  const today = strategyTodayISO();
  const sipFunds = state.funds.filter((fund) => fund.sip && fund.sip.enabled);
  if (sipFunds.length === 0) return false;
  let executedCount = 0;
  let executedAmount = 0;

  sipFunds.forEach((fund) => {
    const sip = fund.sip;
    const pending = computeSipTrades(fund, sip);
    if (pending.length === 0) return;
    pending.forEach((item) => {
      sip.totalShares += item.shares;
      sip.totalAmount += item.amount;
      sip.lastDate = item.date;
      executedCount += 1;
      executedAmount += item.amount;
    });
  });

  if (executedCount > 0) {
    store.save(state);
    const todayFunds = sipFunds.filter((fund) => fund.sip && fund.sip.lastDate === today);
    if (todayFunds.length > 0) {
      toast(`定投已执行：${todayFunds.map((f) => f.name || f.code).slice(0, 3).join('、')}${todayFunds.length > 3 ? ' 等' : ''}，共 ${executedCount} 期 ¥${Math.round(executedAmount)}`, 'success');
    } else {
      toast(`定投补记 ${executedCount} 期（累计 ¥${Math.round(executedAmount)}）`, 'success');
    }
    render();
  }
  return executedCount > 0;
}

function openSip(fundId) {
  const fund = getFund(fundId);
  if (!fund) return;
  sipWeekdayDraft = fund.sip && fund.sip.enabled ? Number(fund.sip.weekday) || 1 : 1;
  showSheet(views.sipSheet(fund, strategyTodayISO()));
}

function handleSip(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;
  const freq = form.elements.freq.value === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
  const amount = num(form.elements.amount.value);
  if (amount <= 0) {
    toast('请填写有效的定投金额', 'error');
    return;
  }
  const startDate = form.elements.startDate.value || strategyTodayISO();
  const prev = fund.sip && fund.sip.enabled ? fund.sip : null;
  // 更改策略（频率/金额/周几）自更改日生效：聚合累计与最近执行日原样保留，
  // 之后的待执行期按新 amount/freq 计算，之前的买入记录不受影响。
  fund.sip = {
    enabled: true,
    freq,
    weekday: freq === 'WEEKLY' ? sipWeekdayDraft : 1,
    amount,
    startDate: prev && prev.startDate ? prev.startDate : startDate,
    totalShares: prev ? prev.totalShares : 0,
    totalAmount: prev ? prev.totalAmount : 0,
    lastDate: prev ? prev.lastDate : ''
  };
  store.save(state);
  hideSheet();
  applySip();
  render();
  toast(prev ? '定投计划已更新，自下一执行期生效' : '定投计划已保存', 'success');
}

function stopSip(fundId) {
  const fund = getFund(fundId);
  if (!fund || !fund.sip) return;
  const sip = fund.sip;
  // 停止时把聚合累计转换为一条合成买入记录留在 trades（定投历史可追溯、持仓计算不变）
  if (sip.totalAmount > 0 && sip.totalShares > 0) {
    fund.trades.push({
      id: store.uid(),
      type: 'BUY',
      date: sip.lastDate || sip.startDate || strategyTodayISO(),
      nav: sip.totalAmount / sip.totalShares,
      amount: sip.totalAmount,
      shares: sip.totalShares,
      fee: 0,
      source: 'SIP',
      tierIndex: null,
      note: `定投累计（${sip.startDate || '—'} 至 ${sip.lastDate || '—'}）`,
      closed: false,
      createdAt: Date.now()
    });
  }
  fund.sip = null;
  store.save(state);
  render();
  toast('定投已停止，累计记录已并入交易记录', 'success');
}

let batchParsed = null;

function openBatchImport() {
  batchParsed = null;
  showSheet({
    title: '批量导入底仓',
    subtitle: '每行：代码, 持仓金额, 持仓收益率',
    body: views.batchImportSheetBody(),
    tall: true
  });
}

function handleBatchParse() {
  const form = document.querySelector('form[data-form="batch-import"]');
  if (!form) return;
  const text = String(form.elements.payload.value || '');
  const status = form.querySelector('#batch-parse-status');
  const previewBox = form.querySelector('#batch-preview');
  const confirmBtn = form.querySelector('#batch-import-btn');

  if (!text.trim()) {
    if (status) {
      status.textContent = '请先粘贴持仓数据';
      status.dataset.tone = 'error';
    }
    return;
  }

  batchParsed = parseBatchText(text);
  if (previewBox) previewBox.innerHTML = views.batchPreviewHtml(batchParsed, state);
  if (confirmBtn) confirmBtn.hidden = batchParsed.rows.length === 0;

  if (status) {
    if (batchParsed.rows.length === 0) {
      status.textContent = '未解析到有效数据行';
      status.dataset.tone = 'error';
    } else {
      status.textContent = `解析到 ${batchParsed.rows.length} 只基金`;
      status.dataset.tone = 'ok';
    }
  }
}

async function confirmBatchImport() {
  if (!batchParsed || !batchParsed.rows.length) return;
  const form = document.querySelector('form[data-form="batch-import"]');
  const confirmBtn = form?.querySelector('#batch-import-btn');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '查询净值并导入…';
  }

  try {
    const rows = batchParsed.rows;
    const quotes = await fetchQuotes(rows.map((r) => r.code));
    const today = todayISO();
    const newFunds = [];
    const noNavCodes = [];
    let patchedBaseCount = 0; // 已有基金补登记底仓的数量

    for (const row of rows) {
      const existing = state.funds.find((f) => f.code === row.code);
      if (existing) {
        // 已有基金：若无底仓记录则补登记底仓（净值优先用查询结果，回退基金当前净值）
        const quote = quotes.get(row.code);
        const nav = quote && quote.nav > 0 ? quote.nav : num(existing.nav);
        const hasBase = (existing.trades || []).some((t) => t.type === 'BUY' && t.source === 'BASE');
        if (!hasBase && nav > 0) {
          const shares = row.amount / nav;
          const cost = row.amount / (1 + row.returnPct / 100);
          existing.trades.push({
            id: store.uid(),
            type: 'BUY',
            date: today,
            nav: cost / shares,
            amount: cost,
            shares,
            fee: 0,
            source: 'BASE',
            tierIndex: null,
            note: '批量导入底仓（补登记）',
            closed: false,
            createdAt: Date.now()
          });
          patchedBaseCount += 1;
        }
        continue;
      }
      const quote = quotes.get(row.code);
      const nav = quote && quote.nav > 0 ? quote.nav : 0;
      const navDate = nav > 0 && quote.navDate ? quote.navDate : today;

      const fund = {
        id: store.uid(),
        code: row.code,
        name: (quote && quote.name) || `基金 ${row.code}`,
        category: '',
        assetClass: 'EQUITY',
        nav,
        navDate: nav > 0 ? navDate : '',
        navUpdatedAt: nav > 0 ? Date.now() : 0,
        navHistory: nav > 0 ? [{ date: navDate, nav }] : [],
        strategyOverride: null,
        trades: [],
        tierState: ((resolveStrategyByKey(state.settings.defaultStrategy, null, state.settings.strategies) || {}).addTiers || []).map(() => false),
        logicIntact: true
      };

      if (nav > 0) {
        // 市值 + 收益率 反推底仓：成本 = 市值 / (1 + r)；份额 = 市值 / 净值
        const shares = row.amount / nav;
        const cost = row.amount / (1 + row.returnPct / 100);
        const buyNav = cost / shares;
        fund.trades.push({
          id: store.uid(),
          type: 'BUY',
          date: today,
          nav: buyNav,
          amount: cost,
          shares,
          fee: 0,
          source: 'BASE',
          tierIndex: null,
          note: '批量导入底仓',
          closed: false,
          createdAt: Date.now()
        });
      } else {
        noNavCodes.push(row.code);
      }
      newFunds.push(fund);
    }

    if (newFunds.length) {
      state.funds.push(...newFunds);
      store.save(state);
      // 异步拉取 F10 基金类型：FTYPE 原值 + 自动归类三资产
      Promise.all(
        newFunds.map(async (fund) => {
          try {
            return applyFundClassification(fund, await fetchFundBasicInfo(fund.code));
          } catch {
            return false;
          }
        })
      ).then((results) => {
        if (results.some(Boolean)) {
          store.save(state);
          render();
        }
      });
    }
    batchParsed = null;
    hideSheet();
    render();

    const okCount = newFunds.length - noNavCodes.length;
    const parts = [];
    if (okCount) parts.push(`${okCount} 只新基金已登记底仓`);
    if (patchedBaseCount) parts.push(`${patchedBaseCount} 只已有基金补登记底仓`);
    let msg = parts.length ? `导入完成：${parts.join('，')}` : '导入完成：无新增（基金均已存在且有底仓）';
    if (noNavCodes.length) msg += `，${noNavCodes.length} 只（${noNavCodes.join('、')}）未查到净值`;
    toast(msg, okCount || patchedBaseCount ? 'success' : 'warn');
  } catch (error) {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确认导入';
    }
    toast(`导入失败：${error.message}`, 'error');
  }
}

function openTrade(fundId, preset = {}) {
  const fund = getFund(fundId);
  if (!fund) return;
  const metrics = metricsFor(fund);
  const isEmpty = !(metrics.position.shares > 0) && !(fund.trades || []).length;
  showSheet({
    title: isEmpty ? '登记底仓' : preset.type === 'SELL' ? '登记卖出' : '登记买入',
    subtitle: `${fund.name || fund.code} · 补仓后规则线会自动重算`,
    body: views.tradeSheetBody(fund, metrics, preset),
    tall: true
  });
}

/** 编辑已有交易记录：预填原值，保存时更新该笔 */
function openEditTrade(fundId, tradeId) {
  const fund = getFund(fundId);
  if (!fund) return;
  const trade = (fund.trades || []).find((item) => item.id === tradeId);
  if (!trade) return;
  showSheet({
    title: '编辑交易',
    subtitle: `${fund.name || fund.code} · 修改日期后净值将按当日重新匹配`,
    body: views.tradeSheetBody(fund, metricsFor(fund), {
      type: trade.type,
      source: trade.source,
      date: trade.date,
      fee: trade.fee,
      amount: trade.type === 'BUY' ? trade.amount : '',
      shares: trade.type === 'SELL' ? trade.shares : '',
      note: trade.note,
      tierIndex: Number.isInteger(trade.tierIndex) ? trade.tierIndex : undefined,
      nav: trade.nav,
      editTradeId: trade.id
    }),
    tall: true
  });
}

function handleAddFund(form) {
  const code = String(form.elements.code.value || '').trim();
  if (!isFundCode(code)) {
    toast('请输入 6 位基金代码', 'error');
    return;
  }
  if (state.funds.some((fund) => fund.code === code)) {
    toast('该基金已在监控列表中', 'warn');
    return;
  }

  const name = String(form.elements.name.value || '').trim() || `基金 ${code}`;
  const category = String(form.elements.category?.value || '').trim();
  const enteredNav = num(form.elements.nav.value);
  const navDateInput = form.elements.navDate.value || todayISO();
  const buyDate = form.elements.buyDate.value || navDateInput;
  const fee = num(form.elements.fee.value);

  // 底仓：只用「市值 + 收益率」反推（不再支持成交金额+净值模式）
  let amount = 0;     // 历史投入本金（成本）
  let buyNav = 0;     // 反推的成本净值
  let shares = 0;     // 份额
  let nav = enteredNav;
  let navDate = enteredNav > 0 ? navDateInput : '';

  const holdingAmount = num(form.elements.holdingAmount.value);
  const returnPct = num(form.elements.returnPct.value);
  const currentNav = enteredNav;

  if (holdingAmount > 0 && currentNav > 0) {
    // 成本 = 市值 / (1 + 收益率)
    const cost = holdingAmount / (1 + returnPct / 100);
    shares = holdingAmount / currentNav;
    amount = cost;
    buyNav = cost / shares;
  } else if (holdingAmount > 0 && currentNav <= 0) {
    toast('请先查询或填写最新净值', 'error');
    return;
  }

  // 如果没填净值但有底仓，用反推的成本净值兜底最新净值
  if (nav <= 0 && amount > 0 && buyNav > 0) {
    nav = buyNav;
    navDate = buyDate;
  }

  const fund = {
    id: store.uid(),
    code,
    name,
    category,
    assetClass: 'EQUITY', // 添加后由 F10 FTYPE 自动归类（异步）
    nav,
    navDate: nav > 0 ? navDate : '',
    navUpdatedAt: nav > 0 ? Date.now() : 0,
    navHistory: nav > 0 ? [{ date: navDate || buyDate, nav }] : [],
    strategyOverride: null,
    trades: [],
    tierState: ((resolveStrategyByKey(state.settings.defaultStrategy, null) || {}).addTiers || []).map(() => false),
    logicIntact: true
  };

  if (amount > 0 && buyNav > 0 && shares > 0) {
    fund.trades.push({
      id: store.uid(),
      type: 'BUY',
      date: buyDate,
      nav: buyNav,
      amount,
      shares,
      fee,
      source: 'BASE',
      tierIndex: null,
      note: '初始底仓（市值+收益率反推）',
      closed: false,
      createdAt: Date.now()
    });
  }

  state.funds.push(fund);
  store.save(state);
  hideSheet();
  render();
  toast('已加入监控', 'success');
  if (parseRoute().name !== 'holdings') location.hash = '#/holdings';

  // 异步拉取 F10 基金类型：FTYPE 原值 + 自动归类三资产
  fetchFundBasicInfo(fund.code)
    .then((info) => {
      if (!applyFundClassification(fund, info)) return;
      store.save(state);
      render();
    })
    .catch(() => {});
}

function handleStrategy(form) {
  const key = String(form.elements.defaultStrategy?.value || '');
  if (!STRATEGY_KEYS.includes(key)) {
    toast('请选择一个策略方案', 'error');
    return;
  }

  state.settings.defaultStrategy = key;

  // 解析两个方案的自定义参数
  for (const presetKey of STRATEGY_KEYS) {
    const parsed = parsePresetForm(form, presetKey);
    if (parsed) state.settings.strategies[presetKey] = parsed;
  }

  state.funds.forEach(normalizeTierState);
  commit();
  toast(`策略已保存，默认「${key === 'AGGRESSIVE' ? '激进' : '普通'}」`, 'success');
}

/** 从 strategy form 中解析单个 preset 的全部字段 */
function parsePresetForm(form, key) {
  const nameOf = (suffix) => `${key}__${suffix}`;
  const numField = (suffix, fallback) => {
    const raw = form.elements[nameOf(suffix)]?.value;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const base = {
    stopLossPct: numField('stopLossPct', 12),
    takeProfitPct: numField('takeProfitPct', 20),
    takeProfitSellRatio: numField('takeProfitSellRatio', 40),
    trailingStopPct: numField('trailingStopPct', 8),
    reserveAmount: numField('reserveAmount', 2400),
    reserveTriggerPct: numField('reserveTriggerPct', 20),
    addPositionSellPct: numField('addPositionSellPct', 6),
    addTiers: []
  };
  // 3 档补仓
  for (let i = 0; i < 3; i++) {
    const dropRaw = form.elements[nameOf(`tier${i}_drop`)]?.value;
    const amountRaw = form.elements[nameOf(`tier${i}_amount`)]?.value;
    const drop = parseFloat(dropRaw);
    const amount = parseFloat(amountRaw);
    if (Number.isFinite(drop) && drop > 0 && Number.isFinite(amount) && amount >= 0) {
      base.addTiers.push({ dropPct: drop, amount });
    }
  }
  return base;
}

function handleOverride(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;

  const raw = String(form.elements.strategyOverride?.value ?? '');
  // ''（跟随全局）| 'NORMAL' | 'AGGRESSIVE' | 'NONE'
  fund.strategyOverride = ['NORMAL', 'AGGRESSIVE', 'NONE'].includes(raw) ? raw : null;
  normalizeTierState(fund);
  store.save(state);
  hideSheet();
  render();
  toast('该基金的策略方案已保存', 'success');
}

function handleTrade(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;

  const fee = num(form.elements.fee.value);

  // 空基金底仓登记：市值 + 收益率 反推（nav 用最新净值）
  if (form.dataset.mode === 'base') {
    const date = form.elements.date.value || todayISO();
    const holdingAmount = num(form.elements.holdingAmount.value);
    const returnPct = num(form.elements.returnPct.value);
    if (holdingAmount <= 0) {
      toast('请填写有效的持仓市值', 'error');
      return;
    }
    if (fund.nav <= 0) {
      toast('暂无可用净值数据，请先刷新或查询基金净值', 'error');
      return;
    }
    const cost = holdingAmount / (1 + returnPct / 100);
    const shares = holdingAmount / fund.nav;
    const buyNav = cost / shares;

    fund.trades.push({
      id: store.uid(),
      type: 'BUY',
      date,
      nav: buyNav,
      amount: cost,
      shares,
      fee,
      source: 'BASE',
      tierIndex: null,
      note: '初始底仓（市值+收益率反推）',
      closed: false,
      createdAt: Date.now()
    });

    store.save(state);
    hideSheet();
    render();
    toast('底仓已登记', 'success');
    return;
  }

  const type = form.elements.type.value === 'SELL' ? 'SELL' : 'BUY';
  const date = form.elements.date.value || todayISO();
  const source = form.elements.source?.value === 'ADD' ? 'ADD' : 'BASE';
  const editId = String(form.elements.editId?.value || '');
  const origDate = String(form.dataset.origDate || '');
  const origNav = num(form.dataset.origNav);

  // nav 解析：编辑且日期未改 → 沿用原记录净值；否则按 resolveTradeNav 统一口径。
  // 当日净值尚未公布 → 记录暂存（pending），净值更新后以当日净值自动确认
  let nav = 0;
  let pending = false;
  if (editId && date === origDate && origNav > 0) {
    nav = origNav;
  } else {
    const navInfo = resolveTradeNav(fund, date);
    if (navInfo.pending) {
      pending = true;
    } else {
      nav = navInfo.nav;
    }
  }

  let amount = 0;
  let shares = 0;

  if (type === 'BUY') {
    amount = num(form.elements.amount.value);
    if (amount <= 0) {
      toast('请填写有效的买入金额', 'error');
      return;
    }
    // 暂存：份额待净值更新后按当日净值计算
    shares = pending ? 0 : amount / nav;
  } else {
    shares = num(form.elements.shares.value);
    if (shares <= 0) {
      toast('请填写有效的卖出份额', 'error');
      return;
    }
    // 暂存：卖出金额待净值更新后按当日净值计算
    amount = pending ? 0 : shares * nav;
    // 卖出前校验份额（编辑时放宽：该笔本身已计入持仓，扣除自身后校验）
    if (!editId) {
      const metrics = metricsFor(fund);
      if (shares > metrics.position.shares + 1e-6) {
        toast('卖出份额超过当前持仓', 'error');
        return;
      }
    }
  }

  const tierIndexRaw = String(form.elements.tierIndex.value || '');
  const note = String(form.elements.note.value || '').trim();
  const tierIndex = tierIndexRaw === '' ? null : Number(tierIndexRaw);

  if (editId) {
    const trade = fund.trades.find((item) => item.id === editId);
    if (!trade) {
      toast('原交易记录不存在，可能已被删除', 'error');
      return;
    }
    trade.type = type;
    trade.date = date;
    trade.nav = nav;
    trade.amount = amount;
    trade.shares = shares;
    trade.fee = fee;
    trade.note = note;
    trade.pending = pending;
    if (!Number.isInteger(trade.tierIndex) && form.elements.source) trade.source = source;

    store.save(state);
    hideSheet();
    render();
    toast(pending ? '净值未更新，记录已暂存' : '交易已更新', 'success');
    return;
  }

  const trade = {
    id: store.uid(),
    type,
    date,
    nav,
    amount,
    shares,
    fee,
    source,
    tierIndex,
    note,
    closed: false,
    pending,
    createdAt: Date.now()
  };

  fund.trades.push(trade);

  if (type === 'BUY' && trade.source === 'ADD' && Number.isInteger(trade.tierIndex)) {
    while (fund.tierState.length <= trade.tierIndex) fund.tierState.push(false);
    fund.tierState[trade.tierIndex] = true;
  }

  const batchId = String(form.elements.batchId.value || '');
  if (batchId) {
    const batch = fund.trades.find((item) => item.id === batchId);
    if (batch) batch.closed = true;
  }

  store.save(state);
  hideSheet();
  render();
  toast(
    pending
      ? '当日净值未更新，记录已暂存（净值更新后自动确认）'
      : type === 'SELL' ? '卖出已登记' : '买入已登记',
    'success'
  );
}

function handleManualNav(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;
  const nav = num(form.elements.nav.value);
  const navDate = form.elements.navDate.value || todayISO();
  if (nav <= 0) {
    toast('请输入有效净值', 'error');
    return;
  }

  fund.nav = nav;
  fund.navDate = navDate;
  fund.navUpdatedAt = Date.now();
  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const index = history.findIndex((item) => item.date === navDate);
  if (index >= 0) history[index] = { date: navDate, nav };
  else history.push({ date: navDate, nav });
  history.sort((a, b) => a.date.localeCompare(b.date));
  fund.navHistory = history.slice(-365);
  // 手动补录净值同样会确认对应日期的暂存交易
  const settled = settleFundPending(fund);

  store.save(state);
  hideSheet();
  render();
  toast(settled > 0 ? `净值已更新，已确认 ${settled} 笔暂存交易` : '净值已更新', 'success');
}

async function lookupFund(button) {
  const form = button.closest('form');
  if (!form) return;
  const code = String(form.elements.code.value || '').trim();
  const status = form.querySelector('#lookup-status');
  if (!isFundCode(code)) {
    if (status) {
      status.textContent = '请输入 6 位基金代码';
      status.dataset.tone = 'error';
    }
    return;
  }

  button.disabled = true;
  if (status) {
    status.textContent = '查询中…';
    status.dataset.tone = '';
  }

  try {
    const quotes = await fetchQuotes([code]);
    const quote = quotes.get(code);
    if (!quote || !(quote.nav > 0)) throw new Error('未查到该基金');
    form.elements.name.value = quote.name || form.elements.name.value;
    form.elements.nav.value = quote.nav.toFixed(4);
    if (quote.navDate) form.elements.navDate.value = quote.navDate;
    if (status) {
      status.textContent = `${quote.name} · ${quote.navDate} · ${quote.nav.toFixed(4)}`;
      status.dataset.tone = 'ok';
    }
  } catch (error) {
    if (status) {
      status.textContent = `查询失败：${error.message}`;
      status.dataset.tone = 'error';
    }
  } finally {
    button.disabled = false;
  }
}

async function deleteFund(fundId) {
  const fund = getFund(fundId);
  if (!fund) return;
  const ok = await confirmDialog({
    title: '删除基金',
    message: `确定删除「${fund.name || fund.code}」及其全部交易记录吗？此操作不可恢复。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  state.funds = state.funds.filter((item) => item.id !== fundId);
  store.save(state);
  if (parseRoute().name === 'detail') location.hash = '#/holdings';
  else render();
  toast('已删除', 'success');
}

async function deleteTrade(fundId, tradeId) {
  const fund = getFund(fundId);
  const trade = fund && fund.trades.find((item) => item.id === tradeId);
  if (!fund || !trade) return;
  const ok = await confirmDialog({
    title: '删除交易记录',
    message: '删除后持仓成本与规则线会重新计算，确定继续吗？',
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  fund.trades = fund.trades.filter((item) => item.id !== tradeId);
  store.save(state);
  render();
  toast('记录已删除', 'success');
}

async function resetTiers(fundId) {
  const fund = getFund(fundId);
  if (!fund) return;
  const ok = await confirmDialog({
    title: '重置补仓档位',
    message: '所有档位将恢复为「未执行」，用于新一轮计划。',
    confirmText: '重置'
  });
  if (!ok) return;
  fund.tierState = ((metricsFor(fund).strategy || {}).addTiers || []).map(() => false);
  commit();
  toast('档位已重置', 'success');
}

function handleExport() {
  downloadText(`fundpilot-${todayISO()}.json`, store.exportPayload(state));
  toast('备份已导出', 'success');
}

async function handleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = store.importPayload(text);
    const ok = await confirmDialog({
      title: '导入备份',
      message: `将用备份中的 ${imported.funds.length} 只基金覆盖当前本地数据，确定继续吗？`,
      confirmText: '覆盖导入',
      danger: true
    });
    if (!ok) return;
    state = imported;
    store.save(state);
    render();
    toast('备份已导入', 'success');
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
  } finally {
    input.value = '';
  }
}

async function removeCategory(name) {
  const catName = String(name || '').trim();
  if (!catName) return;
  const ok = await confirmDialog({
    title: '删除类别',
    message: `删除「${catName}」类别后，该类基金将变为未分类状态。`,
    confirmText: '删除'
  });
  if (!ok) return;
  state.categories = state.categories.filter((c) => c.name !== catName);
  state.funds.forEach((fund) => {
    if (fund.category === catName) fund.category = '';
  });
  commit();
  toast('类别已删除', 'success');
}

async function clearAllData() {
  const ok = await confirmDialog({
    title: '清空全部数据',
    message: '所有基金、交易与策略设置都会被删除，且无法恢复。建议先导出备份。',
    confirmText: '清空',
    danger: true
  });
  if (!ok) return;
  store.clear();
  state = store.defaultState();
  store.save(state);
  location.hash = '#/holdings';
  render();
  toast('数据已清空', 'success');
}

/** 处理 sheet 内 chip-option 点击：hf-=筛选(多选) / hs-=排序(单选) */
function handleSheetChip(group, value) {
  if (!group) return;

  if (group.startsWith('hf-')) {
    const setMap = {
      'hf-status': holdingsFilterState.statuses,
      'hf-ft': holdingsFilterState.ftypes,
      'hf-ac': holdingsFilterState.assetClasses,
      'hf-strat': holdingsFilterState.strategies,
      'hf-cat': holdingsFilterState.categories
    };
    const set = setMap[group];
    if (!set) return;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    showSheet({ title: '筛选基金', body: views.holdingsFilterSheetBody(state, holdingsFilterState), tall: true });
    render();
  } else if (group.startsWith('hs-')) {
    if (group === 'hs-by') holdingsSortBy = value;
    else if (group === 'hs-dir') holdingsSortDir = value;
    render();
    showSheet({ title: '排序基金', body: views.holdingsSortSheetBody(holdingsSortBy, holdingsSortDir) });
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target.closest('[data-action="toggle-alloc"]');
  if (!el) return;
  event.preventDefault();
  el.click();
});

document.addEventListener('click', (event) => {
  // sheet 里的筛选/排序 chip 点击处理（chip-option label）。
  // 注意：定投周几等自带 data-action 的 chip-option 走下方统一委托，此处只拦纯筛选 chip。
  const chip = event.target.closest('.chip-option');
  if (chip && !chip.dataset.action) {
    const group = chip.dataset.group;
    const value = chip.dataset.value;
    event.preventDefault();
    event.stopPropagation();
    handleSheetChip(group, value);
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'close-sheet':
      hideSheet();
      break;
    case 'back': {
      // hash 路由不依赖浏览器历史（iOS Safari history.length 恒 ≥ 2，back 可能跳出应用）：
      // 二级页（详情/交易明细）固定回持仓页，其余回宏观首页
      const from = parseRoute().name;
      location.hash = from === 'detail' || from === 'trades' ? '#/holdings' : '#/macro';
      break;
    }
    case 'add-fund':
      openAddFund();
      break;
    case 'open-batch-import':
      openBatchImport(); // showSheet 会替换当前弹层（从添加基金弹层跳转亦可）
      break;
    case 'batch-parse':
      handleBatchParse();
      break;
    case 'batch-import-file': {
      // 文件选择框自身的 click 冒泡到此委托时不再触发，避免递归
      if (event.target.tagName === 'INPUT') break;
      const fileInput = document.querySelector('input[data-action="batch-import-file"]');
      if (fileInput) fileInput.click();
      break;
    }
    case 'batch-import-confirm':
      confirmBatchImport();
      break;
    case 'macro-refresh':
      loadMacro({ force: true })
        .catch((error) => toast(`宏观数据加载失败：${error.message}`, 'error'))
        .finally(() => {
          if (parseRoute().name === 'macro') render();
        });
      break;
    case 'alloc-tab':
      // 配置页标签切换（三资产 / 自定义分类），UI 临时状态不持久化
      views.setAllocTab(target.dataset.tab);
      render();
      break;
    case 'toggle-alloc': {
      const catName = target.closest('[data-category]')?.dataset.category;
      if (catName) {
        if (expandedAllocCats.has(catName)) expandedAllocCats.delete(catName);
        else expandedAllocCats.add(catName);
        render();
      }
      break;
    }
    case 'toggle-asset': {
      // 三资产行展开/折叠（基金明细 + 目标修改）
      const clsKey = target.dataset.class;
      if (clsKey) {
        if (expandedAssetClasses.has(clsKey)) expandedAssetClasses.delete(clsKey);
        else expandedAssetClasses.add(clsKey);
        render();
      }
      break;
    }
    case 'open-holdings-filter': {
      showSheet({
        title: '筛选基金',
        body: views.holdingsFilterSheetBody(state, holdingsFilterState),
        tall: true
      });
      break;
    }
    case 'open-holdings-sort': {
      showSheet({
        title: '排序基金',
        body: views.holdingsSortSheetBody(holdingsSortBy, holdingsSortDir)
      });
      break;
    }
    case 'reset-preset': {
      const key = target.dataset.key;
      if (!key || !STRATEGY_KEYS.includes(key)) break;
      state.settings.strategies[key] = cloneStrategyPreset(key);
      state.funds.forEach(normalizeTierState);
      commit();
      toast(`${key === 'AGGRESSIVE' ? '激进' : '普通'}方案已恢复默认`, 'success');
      render();
      break;
    }
    case 'reset-holdings-filter': {
      holdingsFilterState.statuses.clear();
      holdingsFilterState.ftypes.clear();
      holdingsFilterState.assetClasses.clear();
      holdingsFilterState.strategies.clear();
      holdingsFilterState.categories.clear();
      // 如果筛选 sheet 还开着，刷新 body
      const sheet = document.getElementById('sheet-root');
      if (sheet && !sheet.hidden) {
        showSheet({ title: '筛选基金', body: views.holdingsFilterSheetBody(state, holdingsFilterState), tall: true });
      }
      render();
      break;
    }
    case 'toggle-attention':
      views.toggleAttentionExpanded();
      render();
      break;
    case 'run-backtest': {
      const fundSelect = document.querySelector('select[name="backtestFund"]');
      const keySelect = document.querySelector('select[name="backtestKey"]');
      const fund = getFund(fundSelect && fundSelect.value);
      views.setBacktestResult(
        fund
          ? backtestStrategy(fund.navHistory, keySelect ? keySelect.value : null, 10000, state.settings.strategies)
          : { ok: false, reason: '未找到基金，请重新选择' }
      );
      render();
      break;
    }
    case 'lookup-fund':
      lookupFund(target);
      break;
    case 'refresh-all':
      refreshFunds();
      break;
    case 'refresh-fund':
      refreshFunds([target.dataset.fund]);
      break;
    case 'open-fund':
      location.hash = `#/fund/${target.dataset.id}`;
      break;
    case 'tier-trade': {
      openTrade(target.dataset.fund, {
        source: 'ADD',
        tierIndex: Number(target.dataset.tier),
        amount: Number(target.dataset.amount) || 0,
        note: `第 ${Number(target.dataset.tier) + 1} 档补仓`
      });
      break;
    }
    case 'add-trade':
      openTrade(target.dataset.fund, { source: 'BASE' });
      break;
    case 'close-batch': {
      const fundId = target.dataset.fund;
      const fund = getFund(fundId);
      if (!fund) break;
      const shares = num(target.dataset.shares);
      openTrade(fundId, {
        type: 'SELL',
        shares,
        amount: shares * (num(fund.nav) || 1),
        batchId: target.dataset.trade,
        note: '补仓批次独立了结'
      });
      break;
    }
    case 'manual-nav': {
      const fund = getFund(target.dataset.fund);
      if (fund) {
        showSheet({
          title: '手动录入净值',
          subtitle: fund.name || fund.code,
          body: views.manualNavSheetBody(fund)
        });
      }
      break;
    }
    case 'override': {
      const fund = getFund(target.dataset.fund);
      if (fund && fundAssetKind(fund) !== 'EQUITY') {
        // 债券/黄金/海外基金锁定宏观推荐，按钮已隐藏，此为防御
        toast('债券/黄金/海外基金不适用策略方案', 'warn');
        break;
      }
      if (fund) {
        showSheet({
          title: '策略方案',
          subtitle: '该基金单独生效，优先于全局默认',
          body: views.overrideSheetBody(fund, state.settings.defaultStrategy),
          tall: true
        });
      }
      break;
    }
    case 'reset-tiers':
      resetTiers(target.dataset.fund);
      break;
    case 'delete-fund':
      deleteFund(target.dataset.fund);
      break;
    case 'delete-trade':
      deleteTrade(target.dataset.fund, target.dataset.trade);
      break;
    case 'edit-trade':
      openEditTrade(target.dataset.fund, target.dataset.trade);
      break;
    case 'open-trades':
      location.hash = '#/trades';
      break;
    case 'open-sip':
      openSip(target.dataset.fund);
      break;
    case 'stop-sip':
      stopSip(target.dataset.fund);
      break;
    case 'pick-sip-weekday': {
      sipWeekdayDraft = Number(target.dataset.day) || 1;
      const group = target.closest('[data-action-group="sip-weekday"]');
      if (group) {
        group.querySelectorAll('.chip-option').forEach((el) => {
          el.classList.toggle('is-on', el === target);
        });
      }
      break;
    }
    case 'trades-filter':
      views.setTradesFilterType(target.dataset.type);
      render();
      break;
    case 'open-fund': {
      const fundId = target.dataset.id || target.closest('[data-id]')?.dataset.id;
      if (fundId) location.hash = `#/fund/${fundId}`;
      break;
    }
    case 'export':
      handleExport();
      break;
    case 'import': {
      const input = document.getElementById('import-file');
      if (input) input.click();
      break;
    }
    case 'remove-category':
      removeCategory(target.dataset.name);
      break;
    case 'move-category': {
      const idx = Number(target.dataset.index);
      const dir = Number(target.dataset.dir);
      const next = idx + dir;
      if (!Number.isInteger(idx) || !Number.isInteger(dir)) break;
      if (next < 0 || next >= state.categories.length) break;
      const cats = state.categories;
      [cats[idx], cats[next]] = [cats[next], cats[idx]];
      commit();
      break;
    }
    case 'unassign-category': {
      const fund = getFund(target.dataset.fund);
      if (!fund) break;
      fund.category = '';
      commit();
      break;
    }
    case 'clear-data':
      clearAllData();
      break;
    default:
      break;
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();

  switch (form.dataset.form) {
    case 'add-fund':
      handleAddFund(form);
      break;
    case 'strategy':
      handleStrategy(form);
      break;
    case 'override':
      handleOverride(form);
      break;
    case 'add-trade':
      handleTrade(form);
      break;
    case 'manual-nav':
      handleManualNav(form);
      break;
    case 'categories':
      handleCategories(form);
      break;
    case 'save-sip':
      handleSip(form);
      break;
    default:
      break;
  }
});

function handleCategories(form) {
  const rows = form.querySelectorAll('.cat-edit-row');
  const seen = new Set();
  const newCategories = [];
  let renameMap = {}; // oldName -> newName

  for (const row of rows) {
    const name = String(row.querySelector('[name="cat-name"]').value || '').trim();
    const targetPct = num(row.querySelector('[name="cat-target"]').value);
    const oldName = String(row.dataset.oldName || '').trim();
    if (!name) continue;
    if (seen.has(name)) {
      toast(`类别名「${name}」重复`, 'error');
      return;
    }
    seen.add(name);
    newCategories.push({ name, targetPct });
    if (oldName && oldName !== name) {
      renameMap[oldName] = name;
    }
  }

  // 新增行
  const newName = String(form.elements.newCatName?.value || '').trim();
  const newTarget = num(form.elements.newCatTarget?.value);
  if (newName) {
    if (seen.has(newName)) {
      toast(`类别名「${newName}」已存在`, 'error');
      return;
    }
    newCategories.push({ name: newName, targetPct: newTarget });
  }

  // 应用重命名
  Object.entries(renameMap).forEach(([oldName, newName]) => {
    state.funds.forEach((fund) => {
      if (fund.category === oldName) fund.category = newName;
    });
  });

  state.categories = newCategories;
  commit();
  toast('类别设置已保存', 'success');
}

document.addEventListener('input', (event) => {
  // 补仓模拟器预览
  if (event.target.matches('[data-sim]')) {
    if (!currentFundId) return;
    const fund = getFund(currentFundId);
    if (!fund) return;

    const metrics = metricsFor(fund);
    const amountInput = document.querySelector('[data-sim="amount"]');
    const priceInput = document.querySelector('[data-sim="price"]');
    if (!amountInput || !priceInput) return;

    const result = simulateAdd(
      metrics.position,
      num(amountInput.value),
      num(priceInput.value),
      metrics.strategy
    );
    const box = document.getElementById('sim-result');
    if (box) box.innerHTML = views.simResultHtml(result, metrics.strategy);
    return;
  }

  // 底仓市值+收益率 实时反推预览
  if (
    event.target.matches('[name="holdingAmount"], [name="returnPct"], [name="nav"]') &&
    document.querySelector('form[data-form="add-fund"]')
  ) {
    updateBaseDerivePreview();
  }

  // 交易 sheet 日期变化 → 实时更新 nav hint
  if (event.target.matches('[name="date"]') && document.querySelector('form[data-form="add-trade"]')) {
    updateTradeNavHint();
  }
});

document.addEventListener('change', (event) => {
  // 交易 sheet BUY/SELL segmented 切换 → 显示/隐藏对应 panel + 买入性质 + 按钮文案
  const toggle = event.target.closest('[data-toggle="trade-panel"]');
  if (toggle) {
    const form = document.querySelector('form[data-form="add-trade"]');
    if (!form) return;
    const type = form.elements.type.value;
    form.querySelectorAll('[data-trade-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.tradePanel !== type;
    });
    const sourceField = form.querySelector('[data-source-field]');
    if (sourceField) sourceField.hidden = type === 'SELL';
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.textContent = form.elements.editId?.value
        ? '保存修改'
        : type === 'SELL'
          ? '登记卖出'
          : '登记买入';
    }
    updateTradeNavHint();
    return;
  }
  // 定投 sheet 每日/每周 segmented 切换
  const sipToggle = event.target.closest('[data-toggle="sip-panel"]');
  if (sipToggle) {
    const form = document.querySelector('form[data-form="save-sip"]');
    if (!form) return;
    const freq = form.elements.freq.value;
    form.querySelectorAll('[data-sip-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.sipPanel !== freq;
    });
  }
});

function updateTradeNavHint() {
  const form = document.querySelector('form[data-form="add-trade"]');
  if (!form) return;
  const hint = document.getElementById('trade-nav-hint');
  if (!hint) return;
  const fund = getFund(form.dataset.fund);
  if (!fund) return;
  const date = form.elements.date.value || todayISO();

  let navInfo = null;
  // 编辑模式：日期未改时提示沿用原记录净值
  if (form.dataset.origDate && date === form.dataset.origDate && num(form.dataset.origNav) > 0) {
    navInfo = { nav: num(form.dataset.origNav), date, source: 'record' };
  }
  if (!navInfo) navInfo = resolveTradeNav(fund, date);

  if (navInfo.pending) {
    hint.innerHTML = '<b class="warn">⏳ 该日净值尚未公布：记录将暂存，净值更新后按当日净值自动确认</b>';
    return;
  }
  const sourceLabel = navInfo.source === 'record' ? '（原记录）' : navInfo.source === 'latest' ? '（最新）' : '';
  hint.innerHTML = `将使用 ${navInfo.date} 净值 <b>${navInfo.nav.toFixed(4)}</b>${sourceLabel}`;
}

function updateBaseDerivePreview() {
  const form = document.querySelector('form[data-form="add-fund"]');
  if (!form) return;
  const hint = document.getElementById('base-derive-hint');
  if (!hint) return;

  const holdingAmount = num(form.elements.holdingAmount?.value);
  const returnPct = num(form.elements.returnPct?.value);
  const currentNav = num(form.elements.nav?.value);

  if (holdingAmount <= 0 || currentNav <= 0) {
    hint.hidden = true;
    return;
  }

  const cost = holdingAmount / (1 + returnPct / 100);
  const shares = holdingAmount / currentNav;
  const costNav = cost / shares;

  document.getElementById('derived-cost').textContent = cost.toFixed(2);
  document.getElementById('derived-shares').textContent = shares.toFixed(2);
  document.getElementById('derived-nav').textContent = costNav.toFixed(4);
  hint.hidden = false;
}

document.addEventListener('change', (event) => {
  const toggle = event.target.closest('[data-action="toggle-logic"]');
  if (toggle) {
    const fund = getFund(toggle.dataset.fund);
    if (fund) {
      fund.logicIntact = Boolean(toggle.checked);
      store.save(state);
      render();
    }
    return;
  }

  // 未分类基金 → 分配类别
  const assignSelect = event.target.closest('[data-action="assign-category"]');
  if (assignSelect) {
    const fund = getFund(assignSelect.dataset.fund);
    if (fund) {
      fund.category = String(assignSelect.value || '').trim();
      commit();
    }
    return;
  }

  if (event.target.id === 'import-file') {
    handleImportFile(event.target);
    return;
  }

  // 批量导入底仓：加载本地 CSV/TXT 文件到文本框并自动解析
  if (event.target.dataset && event.target.dataset.action === 'batch-import-file') {
    handleBatchImportFile(event.target);
  }
});

function handleBatchImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = ''; // 清空以便重复选择同一文件
  if (file.size > 1024 * 1024) {
    toast('文件过大（超过 1MB），请拆分后导入', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const form = document.querySelector('form[data-form="batch-import"]');
    if (!form) return;
    // 去除 Excel 导出 CSV 常见的 UTF-8 BOM
    form.elements.payload.value = String(reader.result || '').replace(/^\uFEFF/, '').trim();
    handleBatchParse();
  };
  reader.onerror = () => toast('文件读取失败', 'error');
  reader.readAsText(file);
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.fund-card[data-action="open-fund"]');
  if (!card) return;
  event.preventDefault();
  location.hash = `#/fund/${card.dataset.id}`;
});

window.addEventListener('hashchange', render);

// 启动时结算暂存交易（净值早已更新但未确认的记录补确认），再执行定投补记
let settledAtBoot = 0;
state.funds.forEach((fund) => {
  settledAtBoot += settleFundPending(fund);
});
if (settledAtBoot > 0) {
  store.save(state);
  toast(`已按当日净值确认 ${settledAtBoot} 笔暂存交易`, 'success');
}

// 启动时执行定投补记（净值已出的交易日自动补投；缺净值待刷新后自动补）
applySip();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

render();
