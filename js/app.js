import * as store from './store.js';
import {
  computeFundMetrics,
  mergeStrategy,
  normalizeTiers,
  num,
  parseBatchText,
  simulateAdd,
  validateStrategy
} from './strategy.js';
import { fetchQuotes, isFundCode } from './quote.js';
import { fetchMacroData } from './macro.js';
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
let holdingsFilter = 'all';

async function loadMacro({ force = false } = {}) {
  if (macroLoading) return;
  macroLoading = true;
  if (parseRoute().name === 'macro') render();
  try {
    const data = await fetchMacroData({ force });
    macroData = data;
    if (parseRoute().name === 'macro') render();
  } finally {
    macroLoading = false;
  }
}

const app = document.getElementById('app');

function parseRoute() {
  const hash = String(location.hash || '').replace(/^#/, '');
  if (hash.startsWith('/fund/')) return { name: 'detail', id: hash.slice('/fund/'.length) };
  if (hash === '/holdings') return { name: 'holdings' };
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
  return computeFundMetrics(fund, state.settings.defaultStrategy);
}

function buildMetricsMap() {
  return new Map(state.funds.map((fund) => [fund.id, metricsFor(fund)]));
}

function updateTabs(route) {
  document.querySelectorAll('.tabbar a').forEach((link) => {
    const tab = link.dataset.tab;
    const active =
      tab === route.name || (tab === 'holdings' && route.name === 'detail');
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
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
    app.innerHTML = views.detailPage(metricsFor(fund));
  } else if (route.name === 'strategy') {
    currentFundId = null;
    app.innerHTML = views.strategyPage(state);
  } else if (route.name === 'allocation') {
    currentFundId = null;
    app.innerHTML = views.allocationPage(state, buildMetricsMap(), expandedAllocCats);
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
    app.innerHTML = views.holdingsPage(state, buildMetricsMap(), { refreshing, filter: holdingsFilter });
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
  const tiers = (state.settings.defaultStrategy.addTiers || []).length;
  const current = Array.isArray(fund.tierState) ? fund.tierState : [];
  fund.tierState = Array.from({ length: tiers }, (_, index) => Boolean(current[index]));
}

function applyQuote(fund, quote) {
  if (quote.name) fund.name = quote.name;
  if (!(quote.nav > 0)) return;
  fund.nav = quote.nav;
  fund.navDate = quote.navDate || fund.navDate;
  fund.navUpdatedAt = Date.now();

  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const existing = history.findIndex((item) => item.date === fund.navDate);
  if (existing >= 0) history[existing] = { date: fund.navDate, nav: quote.nav };
  else history.push({ date: fund.navDate, nav: quote.nav });
  history.sort((a, b) => a.date.localeCompare(b.date));
  fund.navHistory = history.slice(-365);
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

    funds.forEach((fund) => {
      const quote = quotes.get(fund.code);
      if (!quote || !(quote.nav > 0)) {
        missing.push(fund.code);
        return;
      }
      applyQuote(fund, quote);
      updated += 1;
    });

    store.save(state);
    if (updated > 0) toast(`已更新 ${updated} 只基金的净值`, 'success');
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

    for (const row of rows) {
      // 跳过已有基金
      if (state.funds.some((f) => f.code === row.code)) continue;
      const quote = quotes.get(row.code);
      const nav = quote && quote.nav > 0 ? quote.nav : 0;
      const navDate = nav > 0 && quote.navDate ? quote.navDate : today;

      const fund = {
        id: store.uid(),
        code: row.code,
        name: (quote && quote.name) || `基金 ${row.code}`,
        category: '',
        nav,
        navDate: nav > 0 ? navDate : '',
        navUpdatedAt: nav > 0 ? Date.now() : 0,
        navHistory: nav > 0 ? [{ date: navDate, nav }] : [],
        strategyOverride: null,
        trades: [],
        tierState: (state.settings.defaultStrategy.addTiers || []).map(() => false),
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
    }
    batchParsed = null;
    hideSheet();
    render();

    const okCount = newFunds.length - noNavCodes.length;
    let msg = `导入完成：${okCount} 只已登记底仓`;
    if (noNavCodes.length) msg += `，${noNavCodes.length} 只（${noNavCodes.join('、')}）未查到净值，仅添加监控无底仓`;
    toast(msg, okCount ? 'success' : 'warn');
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
  showSheet({
    title: preset.type === 'SELL' ? '登记卖出' : '登记买入',
    subtitle: `${fund.name || fund.code} · 补仓后规则线会自动重算`,
    body: views.tradeSheetBody(fund, metricsFor(fund), preset),
    tall: true
  });
}

function readTiers(container) {
  if (!container) return [];
  return [...container.querySelectorAll('.tier-row')].map((row) => ({
    dropPct: num(row.querySelector('[name="tierDrop"]').value),
    amount: num(row.querySelector('[name="tierAmount"]').value)
  }));
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

  // 确定录入模式
  const baseMode = String(form.querySelector('[name="baseMode"]:checked')?.value || 'trade');

  let amount = 0;        // 成交金额（= 成本 + 手续费不含费？不，amount 是买入金额即本金投入）
  let buyNav = 0;        // 成交净值
  let shares = 0;        // 份额
  let nav = enteredNav;
  let navDate = enteredNav > 0 ? navDateInput : '';

  if (baseMode === 'pnl') {
    // 市值 + 收益率 反推
    const holdingAmount = num(form.elements.holdingAmount.value);
    const returnPct = num(form.elements.returnPct.value);
    const currentNav = enteredNav;

    if (holdingAmount > 0 && currentNav > 0) {
      // 成本 = 市值 / (1 + 收益率)
      const cost = holdingAmount / (1 + returnPct / 100);
      shares = holdingAmount / currentNav;
      amount = cost; // 历史投入本金
      buyNav = cost / shares; // 反推的成本净值
    }
  } else {
    // 成交方式（原有）
    amount = num(form.elements.amount.value);
    buyNav = num(form.elements.buyNav.value);
    if (amount > 0 && buyNav > 0) shares = amount / buyNav;
  }

  if (amount > 0 && buyNav <= 0) {
    toast(baseMode === 'pnl' ? '请填写最新净值以便反推' : '请填写底仓成交净值', 'error');
    return;
  }

  if (amount <= 0 && baseMode === 'pnl') {
    // 用户填了市值+收益率但没填净值，上面判断已经会拦截；或市值本身为 0
    const holdingAmount = num(form.elements.holdingAmount.value);
    if (holdingAmount > 0) {
      toast('请先查询或手动填写最新净值', 'error');
      return;
    }
  }

  // 如果没填净值但有底仓，用成交净值兜底
  if (nav <= 0 && amount > 0 && buyNav > 0) {
    nav = buyNav;
    navDate = buyDate;
  }

  const fund = {
    id: store.uid(),
    code,
    name,
    category,
    nav,
    navDate: nav > 0 ? navDate : '',
    navUpdatedAt: nav > 0 ? Date.now() : 0,
    navHistory: nav > 0 ? [{ date: navDate || buyDate, nav }] : [],
    strategyOverride: null,
    trades: [],
    tierState: (state.settings.defaultStrategy.addTiers || []).map(() => false),
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
      note: baseMode === 'pnl' ? '初始底仓（市值+收益率反推）' : '初始底仓',
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
}

function handleStrategy(form) {
  const draft = {
    stopLossPct: num(form.elements.stopLossPct.value),
    takeProfitPct: num(form.elements.takeProfitPct.value),
    takeProfitSellRatio: num(form.elements.takeProfitSellRatio.value),
    trailingStopPct: num(form.elements.trailingStopPct.value),
    reserveAmount: num(form.elements.reserveAmount.value),
    reserveTriggerPct: num(form.elements.reserveTriggerPct.value),
    addPositionSellPct: num(form.elements.addPositionSellPct.value),
    addTiers: readTiers(form.querySelector('#strategy-tiers'))
  };

  const errors = validateStrategy(draft);
  if (errors.length > 0) {
    toast(errors[0], 'error');
    return;
  }

  state.settings.defaultStrategy = { ...draft, addTiers: normalizeTiers(draft.addTiers) };
  state.funds.forEach(normalizeTierState);
  commit();
  toast('策略模板已保存', 'success');
}

function handleOverride(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;

  const override = {};
  ['stopLossPct', 'takeProfitPct', 'takeProfitSellRatio', 'trailingStopPct', 'addPositionSellPct', 'reserveAmount'].forEach(
    (key) => {
      const raw = String(form.elements[key].value || '').trim();
      if (raw !== '' && Number.isFinite(Number(raw))) override[key] = Number(raw);
    }
  );

  if (form.elements.enableTiers.checked) {
    const tiers = normalizeTiers(readTiers(form.querySelector('#override-tiers')));
    if (tiers.length === 0) {
      toast('至少保留一个补仓档位', 'error');
      return;
    }
    override.addTiers = tiers;
  }

  const effective = mergeStrategy(state.settings.defaultStrategy, override);
  const errors = validateStrategy(effective);
  if (errors.length > 0) {
    toast(errors[0], 'error');
    return;
  }

  fund.strategyOverride = Object.keys(override).length > 0 ? override : null;
  const tierCount = effective.addTiers.length;
  fund.tierState = Array.from({ length: tierCount }, (_, index) => Boolean((fund.tierState || [])[index]));
  store.save(state);
  hideSheet();
  render();
  toast('该基金的策略覆盖已保存', 'success');
}

function handleTrade(form) {
  const fund = getFund(form.dataset.fund);
  if (!fund) return;

  const type = form.elements.type.value === 'SELL' ? 'SELL' : 'BUY';
  const date = form.elements.date.value || todayISO();
  const nav = num(form.elements.nav.value);
  const amount = num(form.elements.amount.value);
  const fee = num(form.elements.fee.value);
  const sharesInput = num(form.elements.shares.value);
  const shares = sharesInput > 0 ? sharesInput : nav > 0 ? amount / nav : 0;

  if (nav <= 0) {
    toast('请填写有效的成交净值', 'error');
    return;
  }
  if (amount <= 0 && shares <= 0) {
    toast('请填写金额或份额', 'error');
    return;
  }

  const metrics = metricsFor(fund);
  if (type === 'SELL' && shares > metrics.position.shares + 1e-6) {
    toast('卖出份额超过当前持仓', 'error');
    return;
  }

  const tierIndexRaw = String(form.elements.tierIndex.value || '');
  const trade = {
    id: store.uid(),
    type,
    date,
    nav,
    amount: amount > 0 ? amount : shares * nav,
    shares,
    fee,
    source: form.elements.source.value === 'ADD' ? 'ADD' : 'BASE',
    tierIndex: tierIndexRaw === '' ? null : Number(tierIndexRaw),
    note: String(form.elements.note.value || '').trim(),
    closed: false,
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
  toast(type === 'SELL' ? '卖出已登记' : '买入已登记', 'success');
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

  store.save(state);
  hideSheet();
  render();
  toast('净值已更新', 'success');
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
    if (!num(form.elements.buyNav.value)) form.elements.buyNav.value = quote.nav.toFixed(4);
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
  fund.tierState = (metricsFor(fund).strategy.addTiers || []).map(() => false);
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

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target.closest('[data-action="toggle-alloc"]');
  if (!el) return;
  event.preventDefault();
  el.click();
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'close-sheet':
      hideSheet();
      break;
    case 'back':
      if (window.history.length > 1) window.history.back();
      else location.hash = '#/holdings';
      break;
    case 'add-fund':
      openAddFund();
      break;
    case 'open-batch-import':
      openBatchImport();
      break;
    case 'batch-parse':
      handleBatchParse();
      break;
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
    case 'toggle-alloc': {
      const catName = target.closest('[data-category]')?.dataset.category;
      if (catName) {
        if (expandedAllocCats.has(catName)) expandedAllocCats.delete(catName);
        else expandedAllocCats.add(catName);
        render();
      }
      break;
    }
    case 'filter-holdings':
      holdingsFilter = target.dataset.filter || 'all';
      render();
      break;
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
      if (fund) {
        showSheet({
          title: '策略覆盖',
          subtitle: '留空继承全局模板',
          body: views.overrideSheetBody(fund, metricsFor(fund).strategy),
          tall: true
        });
      }
      break;
    }
    case 'clear-override': {
      const fund = getFund(target.dataset.fund);
      if (!fund) break;
      fund.strategyOverride = null;
      normalizeTierState(fund);
      store.save(state);
      hideSheet();
      render();
      toast('已恢复跟随全局模板', 'success');
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
    case 'add-tier': {
      const container = document.querySelector(target.dataset.target || '');
      if (!container) break;
      const rows = container.querySelectorAll('.tier-row');
      const last = rows[rows.length - 1];
      const lastDrop = last ? num(last.querySelector('[name="tierDrop"]').value) : 0;
      const lastAmount = last ? num(last.querySelector('[name="tierAmount"]').value) : 0;
      container.insertAdjacentHTML(
        'beforeend',
        views.tierRows([
          { dropPct: lastDrop > 0 ? Math.min(lastDrop + 5, 95) : '', amount: lastAmount || '' }
        ])
      );
      break;
    }
    case 'remove-tier': {
      const row = target.closest('.tier-row');
      if (row) row.remove();
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
});

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

  // 底仓录入模式切换
  if (event.target.matches('[name="baseMode"]')) {
    const panelName = event.target.value;
    document.querySelectorAll('[data-base-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.basePanel !== panelName;
    });
    if (panelName === 'pnl') updateBaseDerivePreview();
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
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.fund-card[data-action="open-fund"]');
  if (!card) return;
  event.preventDefault();
  location.hash = `#/fund/${card.dataset.id}`;
});

window.addEventListener('hashchange', render);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

render();
