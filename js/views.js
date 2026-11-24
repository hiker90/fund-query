import {
  esc,
  fmtDate,
  fmtMoney,
  fmtNav,
  fmtPct,
  fmtShares,
  num,
  todayISO,
  toneClass
} from './ui.js';
import { simulateAdd, computeAllocation, computeThreeAssetAllocation, ASSET_CLASSES, parseBatchText, recommendAssetScheme, STRATEGY_PRESETS, STRATEGY_KEYS, cloneStrategyPreset, computeMacroAdvice, sparklineData, summarizeAttention } from './strategy.js';

const STATUS_META = {
  normal: { label: '运行中', tone: 'ok', rank: 5 },
  nearStop: { label: '接近止损', tone: 'warn', rank: 4 },
  add: { label: '可补仓', tone: 'accent', rank: 3 },
  takeProfit: { label: '触发止盈', tone: 'accent', rank: 2 },
  trailing: { label: '移动止盈', tone: 'warn', rank: 1 },
  stop: { label: '触发止损', tone: 'danger', rank: 0 },
  none: { label: '无策略', tone: 'flat', rank: 6 }
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.normal;
}

/** 5 类基金状态分组（匹配用：groupKey → 底层 metrics.status[] + 展示 meta） */
const STATUS_GROUPS = [
  { key: 'active', label: '进行中', tone: 'ok', matches: ['normal'] },
  { key: 'add', label: '待补仓', tone: 'accent', matches: ['add'] },
  { key: 'take', label: '待止盈', tone: 'warn', matches: ['takeProfit', 'trailing'] },
  { key: 'stop', label: '待止损', tone: 'danger', matches: ['stop', 'nearStop'] },
  { key: 'other', label: '其他', tone: 'flat', matches: ['none'] }
];

function statusGroupOf(metricsStatus) {
  for (const g of STATUS_GROUPS) {
    if (g.matches.includes(metricsStatus)) return g.key;
  }
  return 'other';
}

/** 匹配复合筛选条件：空 Set 表示该维度不过滤 */
function matchFilterState(metrics, filterState) {
  const f = metrics.fund;
  if (filterState.statuses.size && !filterState.statuses.has(statusGroupOf(metrics.status))) return false;
  if (filterState.assetClasses.size && !filterState.assetClasses.has(f.assetClass || 'EQUITY')) return false;
  if (filterState.strategies.size) {
    const effectiveStrategyKey = metrics.strategy
      ? (f.strategyOverride && ['NORMAL', 'AGGRESSIVE', 'NONE'].includes(f.strategyOverride)
          ? f.strategyOverride
          : (f.assetClass === 'EQUITY' ? 'GLOBAL' : 'NONE'))
      : 'NONE';
    if (!filterState.strategies.has(effectiveStrategyKey)) return false;
  }
  if (filterState.categories.size) {
    const cat = f.category || '';
    if (!filterState.categories.has(cat)) return false;
  }
  if (filterState.ftypes.size && !filterState.ftypes.has(f.ftype || '')) return false;
  return true;
}

const SORT_LABELS = {
  status: '策略状态',
  marketValue: '持仓金额',
  holdingPnlPct: '当前收益率',
  assetClass: '三资产类型',
  category: '自定义分类'
};

const ASSET_CLASS_LABELS = { EQUITY: '权益', BOND: '债券', GOLD: '黄金' };
const STRATEGY_LABELS = { NORMAL: '普通', AGGRESSIVE: '激进', NONE: '不启用', GLOBAL: '跟随全局' };

/** 今日关注卡折叠态（模块态，不持久化） */
let attentionExpanded = false;

export function toggleAttentionExpanded() {
  attentionExpanded = !attentionExpanded;
}

const ATTENTION_CHIP_LABELS = {
  stop: '止损',
  trailing: '移动止盈',
  takeProfit: '止盈',
  add: '可补仓',
  nearStop: '接近止损'
};

/** 今日关注汇总卡：无条目整卡不渲染；>3 条默认前 3 + 展开折叠 */
function attentionCardHtml(metricsList) {
  const { counts, items } = summarizeAttention(metricsList);
  if (items.length === 0) return '';

  const chips = Object.entries(ATTENTION_CHIP_LABELS)
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => {
      const meta = STATUS_META[key];
      return `<span class="badge badge-${meta.tone} badge-mini">${label} ${counts[key]}</span>`;
    })
    .join('');

  const shown = attentionExpanded || items.length <= 3 ? items : items.slice(0, 3);
  const list = shown
    .map(
      (item) => `
        <li class="attention-item">
          <button class="attention-name" type="button" data-action="open-fund" data-id="${esc(item.fundId)}">${esc(item.name)}</button>
          <span class="attention-text">${esc(item.text)}</span>
        </li>`
    )
    .join('');

  return `
    <section class="card attention-card">
      <div class="attention-head">
        <h2>今日关注</h2>
        <div class="attention-chips">${chips}</div>
      </div>
      <ul class="attention-list">${list}</ul>
      ${
        items.length > 3
          ? `<button class="attention-toggle" type="button" data-action="toggle-attention">${
              attentionExpanded ? '收起' : `展开全部 ${items.length} 条`
            }</button>`
          : ''
      }
    </section>`;
}

/** 锁定类基金的 badge 标签（替代「无策略」） */
const ASSET_KIND_LABELS = { BOND: '债券', GOLD: '黄金', OVERSEAS: '海外' };

function badge(metrics) {
  // 债券/黄金/海外权益基金不适用分档策略 → 显示资产类型徽章而非「无策略」
  const kindLabel = ASSET_KIND_LABELS[metrics.assetKind];
  if (kindLabel) return `<span class="badge badge-accent">${kindLabel}</span>`;
  const meta = statusMeta(metrics.status);
  return `<span class="badge badge-${meta.tone}">${esc(meta.label)}</span>`;
}

/** 估值水平小胶囊：如「估值 78%·高估」；无数据显示则不出 */
function valuationBadge(valuation) {
  if (!valuation || !valuation.label) return '';
  const pct = Math.round(num(valuation.percentile));
  return `<span class="badge badge-${valuation.tone || 'flat'} badge-mini">估值 ${pct}%·${esc(valuation.label)}</span>`;
}

function navMarkerPosition(metrics) {
  if (!metrics.avgCost || !metrics.nav) return 50;
  const low = metrics.stopLossNav * 0.98;
  const high = metrics.takeProfitNav * 1.02;
  if (high <= low) return 50;
  return Math.min(100, Math.max(0, ((metrics.nav - low) / (high - low)) * 100));
}

function ruleTrack(metrics) {
  if (!metrics.avgCost || !metrics.strategy) return '';
  const position = navMarkerPosition(metrics);
  return `
    <div class="rule-track" aria-hidden="true">
      <span class="rule-zone"></span>
      <span class="rule-mark stop" style="left:0%"></span>
      <span class="rule-mark cost" style="left:50%"></span>
      <span class="rule-mark take" style="left:100%"></span>
      <span class="rule-nav" style="left:${position.toFixed(1)}%"></span>
    </div>
    <div class="rule-legend">
      <span>止损 ${fmtNav(metrics.stopLossNav)}</span>
      <span>成本 ${fmtNav(metrics.avgCost)}</span>
      <span>止盈 ${fmtNav(metrics.takeProfitNav)}</span>
    </div>`;
}

function nextTierHint(metrics) {
  if (!metrics.avgCost) return '尚未录入持仓，先在详情页登记一笔买入';
  if (!metrics.strategy) return '该基金未启用策略，仅记录持仓成本与收益';
  if (metrics.triggeredTiers.length > 0) {
    const indexes = metrics.triggeredTiers.map((tier) => `第 ${tier.index + 1} 档`).join('、');
    const total = metrics.triggeredTiers.reduce((sum, tier) => sum + tier.amount, 0);
    return `已触及 ${indexes}，计划补仓 ${fmtMoney(total, 0)} 元`;
  }
  if (metrics.nextTier) {
    return `下一档：跌至 ${fmtNav(metrics.nextTier.triggerNav)}（-${metrics.nextTier.dropPct}%）补 ${fmtMoney(metrics.nextTier.amount, 0)} 元`;
  }
  return '所有补仓档位均已执行，保留最终储备';
}

/** 净值走势 sparkline（68×24 SVG polyline）：sparklineData 为 null 时返回空串不占位 */
function sparklineSvg(history) {
  const data = sparklineData(history);
  if (!data) return '';
  return `<svg class="spark ${data.dir}" width="68" height="24" viewBox="0 0 68 24" aria-hidden="true"><polyline points="${data.points}"/></svg>`;
}

/** 宏观方向提示行（锁定类基金）：替代补仓 hint */
function macroAdviceHint(metrics, macro) {
  const advice = computeMacroAdvice(metrics.assetKind, macro);
  if (!advice) return '';
  const prefix = `${ASSET_KIND_LABELS[metrics.assetKind]}基金不适用分档策略`;
  return `<p class="fund-hint"><b class="t-${advice.tone}">◆</b> ${esc(prefix)} · ${esc(advice.text)}</p>`;
}

function fundCard(metrics, valuation = null, macro = null) {
  const { fund } = metrics;
  const hasPosition = metrics.avgCost > 0;
  const pnlPct = hasPosition ? metrics.holdingPnlPct : 0;
  return `
    <article class="fund-card" data-action="open-fund" data-id="${esc(fund.id)}" tabindex="0">
      <div class="fund-card-top">
        <div class="fund-title">
          <h3>${esc(fund.name || fund.code)}</h3>
          <span class="fund-code">${esc(fund.code)}</span>
          ${fund.ftype ? `<span class="fund-ftype">${esc(fund.ftype)}</span>` : ''}
          ${valuationBadge(valuation)}
        </div>
        ${badge(metrics)}
      </div>
      <div class="fund-nav">
        <strong class="num">${fmtNav(metrics.nav)}</strong>
        <span class="muted">净值 ${fmtDate(fund.navDate)}</span>
        ${hasPosition ? sparklineSvg(fund.navHistory) : ''}
      </div>
      <div class="fund-metrics">
        <div>
          <span>摊薄成本</span>
          <strong class="num">${hasPosition ? fmtNav(metrics.avgCost) : '—'}</strong>
        </div>
        <div>
          <span>持仓收益</span>
          <strong class="num ${hasPosition ? toneClass(metrics.holdingPnl) : ''}">${
            hasPosition ? fmtPct(pnlPct) : '—'
          }</strong>
        </div>
        <div>
          <span>市值</span>
          <strong class="num">${hasPosition ? fmtMoney(metrics.marketValue) : '—'}</strong>
        </div>
      </div>
      ${ruleTrack(metrics)}
      ${
        ASSET_KIND_LABELS[metrics.assetKind]
          ? macroAdviceHint(metrics, macro)
          : `<p class="fund-hint${metrics.triggeredTiers.length ? ' is-alert' : ''}">${esc(nextTierHint(metrics))}</p>`
      }
    </article>`;
}

function emptyState() {
  return `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
          <rect x="5" y="9" width="38" height="30" rx="8" stroke="currentColor" stroke-width="2"/>
          <path d="M13 31l7-8 6 5 9-11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h2>还没有监控的基金</h2>
      <p>输入 6 位基金代码即可开始，净值支持自动拉取或手动录入。</p>
      <button class="btn primary" type="button" data-action="add-fund">添加第一只基金</button>
    </div>`;
}

export function holdingsPage(state, metricsMap, { refreshing = false, filterState, sortBy = 'status', sortDir = 'asc', valuations = null, macro = null } = {}) {
  // 完整 metrics 列表（先按 status rank 排，后面再按 sortBy 排）
  const fullList = state.funds
    .map((fund) => metricsMap.get(fund.id))
    .filter(Boolean);

  // 筛选
  const filteredList = filterState
    ? fullList.filter((m) => matchFilterState(m, filterState))
    : fullList.slice();

  // 排序
  filteredList.sort((a, b) => compareMetrics(a, b, sortBy, sortDir));

  let cost = 0;
  let value = 0;
  let updatedAt = 0;
  fullList.forEach((m) => {
    cost += m.position.cost;
    value += m.marketValue;
    updatedAt = Math.max(updatedAt, num(m.fund.navUpdatedAt));
  });
  const pnl = value - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '尚未刷新';

  // 工具栏：筛选按钮 + 排序按钮 + 基金计数
  const totalCount = fullList.length;
  const filteredCount = filteredList.length;
  const hasFilter = filterState && (
    filterState.statuses.size || filterState.assetClasses.size || filterState.strategies.size || filterState.categories.size || filterState.ftypes.size
  );
  const filterBadge = hasFilter ? `<em class="tb-badge on">${filteredCount}/${totalCount}</em>` : (totalCount ? `<em class="tb-badge">${totalCount}</em>` : '');
  const sortLabel = SORT_LABELS[sortBy] || '策略状态';
  const sortArrow = sortDir === 'asc' ? '↑' : '↓';

  const filterBar = totalCount
    ? `<div class="filter-bar">
        <button class="tb-btn" type="button" data-action="open-holdings-filter">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M6 12h12M10 18h4"/></svg>
          筛选${filterBadge}
        </button>
        <button class="tb-btn" type="button" data-action="open-holdings-sort">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>
          ${esc(sortLabel)} <em>${sortArrow}</em>
        </button>
      </div>`
    : '';

  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">FundPilot</p>
          <h1>持仓监控</h1>
        </div>
        <button class="icon-btn${refreshing ? ' is-busy' : ''}" type="button" data-action="refresh-all"
          ${refreshing ? 'disabled' : ''} aria-label="刷新全部净值">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M20 12a8 8 0 1 1-2.34-5.66"/>
            <path d="M20 4v5h-5"/>
          </svg>
        </button>
      </div>
    </header>
    <main class="page">
      <section class="hero-card">
        <p class="hero-label">持仓总市值</p>
        <strong class="hero-value num">¥ ${fmtMoney(value)}</strong>
        <div class="hero-chips">
          <div>
            <span>持仓盈亏</span>
            <b class="num ${toneClass(pnl)}">${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)} <em>${fmtPct(pnlPct)}</em></b>
          </div>
          <div>
            <span>持仓成本</span>
            <b class="num">¥ ${fmtMoney(cost)}</b>
          </div>
        </div>
        <p class="hero-note">${totalCount} 只基金 · 净值更新 ${esc(updatedLabel)}</p>
      </section>

      ${attentionCardHtml(fullList)}
      ${filterBar}
      ${
        filteredList.length
          ? `<section class="fund-list">${filteredList
              .map((m) => fundCard(m, valuations && valuations.get(m.fund.code), macro))
              .join('')}</section>`
          : totalCount
            ? `<div class="empty-state compact"><p>筛选结果为空，当前条件 ${esc(summarizeFilter(filterState))}</p>
                <button class="btn ghost" type="button" data-action="reset-holdings-filter">清除筛选</button>
              </div>`
            : emptyState()
      }
      <p class="footnote">数据仅保存在本机浏览器，不构成投资建议。</p>
    </main>
    <button class="fab" type="button" data-action="add-fund" aria-label="添加基金">＋</button>`;
}

/** 两个 metrics 的通用比较器 */
function compareMetrics(a, b, sortBy, sortDir) {
  const dir = sortDir === 'desc' ? -1 : 1;
  let cmp = 0;
  switch (sortBy) {
    case 'marketValue':
      cmp = a.marketValue - b.marketValue;
      break;
    case 'holdingPnlPct':
      cmp = a.holdingPnlPct - b.holdingPnlPct;
      break;
    case 'assetClass': {
      const order = { EQUITY: 0, BOND: 1, GOLD: 2 };
      cmp = (order[a.fund.assetClass] ?? 9) - (order[b.fund.assetClass] ?? 9);
      if (cmp === 0) cmp = a.marketValue - b.marketValue;
      break;
    }
    case 'category': {
      cmp = String(a.fund.category || '').localeCompare(String(b.fund.category || ''), 'zh-CN');
      if (cmp === 0) cmp = a.marketValue - b.marketValue;
      break;
    }
    case 'status':
    default:
      cmp = statusMeta(a.status).rank - statusMeta(b.status).rank;
      break;
  }
  // 同分时用市值兜底降序（让用户有稳定感）
  if (cmp === 0) cmp = b.marketValue - a.marketValue;
  return cmp * dir;
}

/** 空态下生成筛选摘要 */
function summarizeFilter(filterState) {
  if (!filterState) return '';
  const parts = [];
  if (filterState.statuses.size) parts.push(`状态=${[...filterState.statuses].map((k) => STATUS_GROUPS.find((g) => g.key === k)?.label || k).join('/')}`);
  if (filterState.ftypes.size) parts.push(`类型=${[...filterState.ftypes].join('/')}`);
  if (filterState.assetClasses.size) parts.push(`三资产=${[...filterState.assetClasses].map((k) => ASSET_CLASS_LABELS[k] || k).join('/')}`);
  if (filterState.strategies.size) parts.push(`策略=${[...filterState.strategies].map((k) => STRATEGY_LABELS[k] || k).join('/')}`);
  if (filterState.categories.size) parts.push(`分类=${[...filterState.categories].map((k) => k || '未分类').join('/')}`);
  return parts.join(' · ');
}

/** 持仓页筛选 sheet body：多选 */
export function holdingsFilterSheetBody(state, filterState) {
  const usedAssetClasses = new Set();
  const usedStrategies = new Set();
  const usedCategories = new Set(['']);
  const usedFtypes = new Set();

  state.funds.forEach((fund) => {
    usedAssetClasses.add(fund.assetClass || 'EQUITY');
    usedCategories.add(fund.category || '');
    if (fund.strategyOverride && ['NORMAL', 'AGGRESSIVE', 'NONE'].includes(fund.strategyOverride)) {
      usedStrategies.add(fund.strategyOverride);
    } else {
      usedStrategies.add('GLOBAL');
    }
    if (fund.ftype) usedFtypes.add(fund.ftype);
  });

  // 状态 5 大类（始终展示）
  const statusOptions = STATUS_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tone: g.tone
  }));

  return `
    <div class="sheet-filter-group">
      <h4>基金状态</h4>
      <div class="chip-row">
        ${statusOptions.map((opt) => chipOption('hf-status', opt.key, opt.label, filterState.statuses.has(opt.key), opt.tone)).join('')}
      </div>
    </div>
    ${usedFtypes.size > 0 ? `
    <div class="sheet-filter-group">
      <h4>基金类型（FTYPE）</h4>
      <div class="chip-row">
        ${[...usedFtypes].sort().map((k) => chipOption('hf-ft', k, k, filterState.ftypes.has(k))).join('')}
      </div>
    </div>` : ''}
    ${usedAssetClasses.size > 1 ? `
    <div class="sheet-filter-group">
      <h4>三资产类型</h4>
      <div class="chip-row">
        ${[...usedAssetClasses].map((k) => chipOption('hf-ac', k, ASSET_CLASS_LABELS[k] || k, filterState.assetClasses.has(k))).join('')}
      </div>
    </div>` : ''}
    ${usedStrategies.size > 1 ? `
    <div class="sheet-filter-group">
      <h4>策略</h4>
      <div class="chip-row">
        ${[...usedStrategies].map((k) => chipOption('hf-strat', k, STRATEGY_LABELS[k] || k, filterState.strategies.has(k))).join('')}
      </div>
    </div>` : ''}
    ${state.categories.length > 0 || (usedCategories.size > 1 && [...usedCategories].some((c) => c)) ? `
    <div class="sheet-filter-group">
      <h4>自定义分类</h4>
      <div class="chip-row">
        ${[...usedCategories].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((k) => chipOption('hf-cat', k, k || '未分类', filterState.categories.has(k))).join('')}
      </div>
    </div>` : ''}
    <div class="sheet-actions">
      <button class="btn ghost" type="button" data-action="reset-holdings-filter">清除筛选</button>
      <button class="btn primary" type="button" data-action="close-sheet">完成</button>
    </div>`;
}

/** 持仓页排序 sheet body：单选 + 升降序 */
export function holdingsSortSheetBody(sortBy, sortDir) {
  const options = ['status', 'marketValue', 'holdingPnlPct', 'assetClass', 'category'];
  return `
    <div class="sheet-filter-group">
      <h4>排序维度</h4>
      <div class="chip-row">
        ${options.map((k) => chipOption('hs-by', k, SORT_LABELS[k], sortBy === k, 'accent')).join('')}
      </div>
    </div>
    <div class="sheet-filter-group">
      <h4>方向</h4>
      <div class="chip-row">
        ${chipOption('hs-dir', 'asc', sortBy === 'holdingPnlPct' || sortBy === 'marketValue' ? '升序（低→高）' : '升序（前→后）', sortDir === 'asc')}
        ${chipOption('hs-dir', 'desc', sortBy === 'holdingPnlPct' || sortBy === 'marketValue' ? '降序（高→低）' : '降序（后→前）', sortDir === 'desc')}
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" data-action="close-sheet">取消</button>
    </div>`;
}

/** 筛选/排序 sheet 里的多选 chip */
function chipOption(group, value, label, checked, tone) {
  const v = String(value);
  const extras = tone ? ` tone-${tone}` : '';
  return `<label class="chip-option${checked ? ' is-on' : ''}${extras}" data-group="${group}" data-value="${esc(v)}">
    <input type="checkbox" data-group="${group}" data-value="${esc(v)}" ${checked ? 'checked' : ''} hidden>
    <span>${esc(label)}</span>
  </label>`;
}

function ladderRow(label, value, extra, kind) {
  return `
    <li class="ladder-row${kind ? ` is-${kind}` : ''}">
      <span class="ladder-label">${esc(label)}</span>
      <strong class="num">${value}</strong>
      <em>${extra}</em>
    </li>`;
}

function ruleLadder(metrics) {
  if (!metrics.avgCost || !metrics.strategy) return '';
  const nav = metrics.nav;
  const rows = [
    {
      label: `止盈线 +${metrics.strategy.takeProfitPct}%`,
      value: metrics.takeProfitNav,
      kind: 'take',
      extra: nav > 0 ? `需上涨 ${fmtPct((metrics.takeProfitNav / nav - 1) * 100, { signed: false })}` : '—'
    },
    {
      label: '持仓成本',
      value: metrics.avgCost,
      kind: 'cost',
      extra: nav > 0 ? `当前 ${fmtPct((nav / metrics.avgCost - 1) * 100)}` : '—'
    },
    {
      label: '当前净值',
      value: nav,
      kind: 'now',
      extra: fmtDate(metrics.fund.navDate)
    },
    {
      label: `止损线 -${metrics.strategy.stopLossPct}%`,
      value: metrics.stopLossNav,
      kind: 'stop',
      extra: nav > 0 ? `还可下跌 ${fmtPct((1 - metrics.stopLossNav / nav) * 100, { signed: false })}` : '—'
    }
  ].sort((a, b) => b.value - a.value);

  return `
    <section class="card">
      <h2 class="card-title">规则锚点</h2>
      <p class="card-sub">补仓后以新的平均成本重新计算</p>
      <ul class="ladder">${rows
        .map((row) =>
          ladderRow(
            row.label,
            fmtNav(row.value),
            row.extra,
            row.kind === 'now' ? 'now' : undefined
          )
        )
        .join('')}</ul>
    </section>`;
}

function tiersCard(metrics) {
  const { fund, strategy } = metrics;
  if (!strategy) return '';
  return `
    <section class="card">
      <h2 class="card-title">分档补仓</h2>
      <p class="card-sub">${
        metrics.tierAnchor
          ? `以底仓成本 ${fmtNav(metrics.tierAnchor)} 为锚，越跌越买但逐档谨慎`
          : '登记底仓后，按底仓成本计算各档触发价'
      }</p>
      <div class="tier-list">
        ${strategy.addTiers
          .map((tier, index) => {
            const executed = Boolean((fund.tierState || [])[index]);
            const triggerNav = metrics.tierAnchor
              ? metrics.tierAnchor * (1 - tier.dropPct / 100)
              : 0;
            const reached = triggerNav > 0 && metrics.nav > 0 && metrics.nav <= triggerNav;
            return `
              <div class="tier-item${executed ? ' is-done' : reached ? ' is-reached' : ''}">
                <div class="tier-main">
                  <b>第 ${index + 1} 档</b>
                  <span>下跌 ${tier.dropPct}%</span>
                </div>
                <div class="tier-num">
                  <b class="num">${triggerNav ? fmtNav(triggerNav) : '—'}</b>
                  <span>建议 ${fmtMoney(tier.amount, 0)} 元</span>
                </div>
                ${
                  executed
                    ? '<span class="tier-done">已执行</span>'
                    : `<button class="btn small${reached ? ' primary' : ' ghost'}" type="button"
                        data-action="tier-trade" data-fund="${esc(fund.id)}" data-tier="${index}"
                        data-amount="${tier.amount}" ${metrics.tierAnchor ? '' : 'disabled'}>登记补仓</button>`
                }
              </div>`;
          })
          .join('')}
      </div>
      <p class="tier-reserve">最终储备 <b class="num">${fmtMoney(strategy.reserveAmount, 0)} 元</b> · 跌超 ${strategy.reserveTriggerPct}% 后择机启用</p>
    </section>`;
}

function simulatorCard(metrics) {
  if (!metrics.strategy) return ''; // 锁定类基金无策略，不显示补仓模拟器
  const defaultAmount = metrics.nextTier
    ? metrics.nextTier.amount
    : (metrics.strategy && metrics.strategy.addTiers[0]?.amount) || 1200;
  const price = metrics.nav || metrics.avgCost;
  const result = simulateAdd(metrics.position, defaultAmount, price, metrics.strategy);
  return `
    <section class="card">
      <h2 class="card-title">补仓模拟器</h2>
      <p class="card-sub">提前看清补仓后的成本与规则线</p>
      <div class="sim-inputs">
        <label class="field">
          <span>补仓金额（元）</span>
          <input type="text" inputmode="decimal" data-sim="amount" value="${defaultAmount}" autocomplete="off">
        </label>
        <label class="field">
          <span>成交净值</span>
          <input type="text" inputmode="decimal" data-sim="price" value="${price ? price.toFixed(4) : ''}" autocomplete="off">
        </label>
      </div>
      <div id="sim-result" class="sim-result">${simResultHtml(result, metrics.strategy)}</div>
    </section>`;
}

export function simResultHtml(result, strategy) {
  if (!result || !result.valid) {
    return '<p class="sim-empty">输入补仓金额与净值后显示结果</p>';
  }
  const ratioNote = strategy
    ? `；止损止盈已按新成本重算（-${strategy.stopLossPct}% / +${strategy.takeProfitPct}%）`
    : '；该基金未启用策略，不计算规则线';
  return `
    <div class="sim-grid">
      <div><span>补仓后成本</span><b class="num">${fmtNav(result.newAvgCost)}</b></div>
      <div><span>成本变化</span><b class="num ${toneClass(result.costChangePct)}">${fmtPct(result.costChangePct)}</b></div>
      <div><span>新止损线</span><b class="num">${fmtNav(result.newStopLossNav)}</b></div>
      <div><span>新止盈线</span><b class="num">${fmtNav(result.newTakeProfitNav)}</b></div>
    </div>
    <p class="sim-note">补仓后回本需 ${fmtPct(result.breakevenPct)}${ratioNote}。</p>`;
}

function addBatchesCard(metrics) {
  if (!metrics.strategy || !metrics.addBatches.length) return ''; // 锁定类基金无补仓计划
  return `
    <section class="card">
      <h2 class="card-title">补仓批次</h2>
      <p class="card-sub">补仓份额可在反弹中独立了结，保持资金滚动</p>
      <div class="batch-list">
        ${metrics.addBatches
          .map(
            (batch) => `
          <div class="batch-item">
            <div>
              <b>${fmtDate(batch.date)} · ${fmtMoney(batch.amount, 0)} 元</b>
              <span>买入净值 ${fmtNav(batch.nav)} · ${fmtShares(batch.shares)} 份</span>
            </div>
            <strong class="num ${toneClass(batch.returnPct)}">${fmtPct(batch.returnPct)}</strong>
            ${
              batch.suggestClose
                ? `<button class="btn small primary" type="button" data-action="close-batch"
                    data-fund="${esc(metrics.fund.id)}" data-trade="${esc(batch.id)}"
                    data-shares="${batch.shares}" data-amount="${batch.amount}">了结</button>`
                : `<span class="muted small-text">${
                    metrics.strategy ? `目标 +${metrics.strategy.addPositionSellPct}%` : '未启用策略'
                  }</span>`
            }
          </div>`
          )
          .join('')}
      </div>
    </section>`;
}

function tradesCard(metrics) {
  const trades = [...(metrics.fund.trades || [])].sort((a, b) => {
    const diff = String(b.date || '').localeCompare(String(a.date || ''));
    return diff !== 0 ? diff : num(b.createdAt) - num(a.createdAt);
  });

  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">交易记录</h2>
          <p class="card-sub">共 ${trades.length} 笔</p>
        </div>
        <button class="btn small ghost" type="button" data-action="add-trade" data-fund="${esc(metrics.fund.id)}">＋ 记一笔</button>
      </div>
      ${
        trades.length
          ? `<ul class="trade-list">${trades
              .map((trade) => {
                const isSell = trade.type === 'SELL';
                const sourceLabel = isSell
                  ? '卖出'
                  : trade.source === 'ADD'
                    ? `补仓${Number.isInteger(trade.tierIndex) ? ` · 第 ${trade.tierIndex + 1} 档` : ''}`
                    : '买入 · 底仓';
                return `
                <li class="trade-item">
                  <div class="trade-left">
                    <span class="trade-dot ${isSell ? 'sell' : 'buy'}"></span>
                    <div>
                      <b>${esc(sourceLabel)}</b>
                      <small>${fmtDate(trade.date)} · 净值 ${fmtNav(trade.nav)}${trade.fee ? ` · 费 ${fmtMoney(trade.fee)}` : ''}</small>
                      ${trade.note ? `<small class="trade-note">${esc(trade.note)}</small>` : ''}
                    </div>
                  </div>
                  <div class="trade-right">
                    <b class="num ${isSell ? 'sell' : ''}">${isSell ? '-' : '+'}${fmtMoney(trade.amount)}</b>
                    <small class="num">${fmtShares(trade.shares)} 份</small>
                  </div>
                  <button class="link-btn" type="button" data-action="delete-trade"
                    data-fund="${esc(metrics.fund.id)}" data-trade="${esc(trade.id)}">删除</button>
                </li>`;
              })
              .join('')}</ul>`
          : '<p class="empty-inline">还没有交易记录，先登记底仓买入。</p>'
      }
    </section>`;
}

function manageCard(metrics) {
  const { fund } = metrics;
  const lockedKind = Boolean(ASSET_KIND_LABELS[metrics.assetKind]); // 锁定类基金隐藏策略入口
  return `
    <section class="card">
      <h2 class="card-title">持仓管理</h2>
      <label class="switch-row">
        <span>
          <b>基金逻辑未恶化</b>
          <small>补仓前必须确认经理、策略、规模与指数规则无重大变化</small>
        </span>
        <input type="checkbox" data-action="toggle-logic" data-fund="${esc(fund.id)}" ${fund.logicIntact ? 'checked' : ''}>
      </label>
      <div class="button-grid">
        <button class="btn ghost" type="button" data-action="manual-nav" data-fund="${esc(fund.id)}">手动录入净值</button>
        ${lockedKind ? '' : `<button class="btn ghost" type="button" data-action="override" data-fund="${esc(fund.id)}">策略方案</button>
        <button class="btn ghost" type="button" data-action="reset-tiers" data-fund="${esc(fund.id)}">重置补仓档位</button>`}
        <button class="btn ghost danger-text" type="button" data-action="delete-fund" data-fund="${esc(fund.id)}">删除基金</button>
      </div>
    </section>`;
}

/** 宏观方向卡（详情页，锁定类基金专用）：替代策略规则卡组 */
function macroAdviceCard(metrics, macro) {
  const kindLabel = ASSET_KIND_LABELS[metrics.assetKind];
  const advice = computeMacroAdvice(metrics.assetKind, macro);
  if (!kindLabel || !advice) return '';
  return `
    <section class="card">
      <h2 class="card-title">宏观方向</h2>
      <p class="card-sub">${esc(kindLabel)}基金不适用分档策略，按宏观指标给出方向参考</p>
      <p class="fund-hint is-alert"><b class="t-${advice.tone}">◆</b> ${esc(advice.text)}</p>
      <p class="card-empty">方向依据：债券看中债期限利差，黄金/海外看美债实际利率与曲线形态；宏观数据缺失时维持现有配置。</p>
    </section>`;
}

export function detailPage(metrics, macro = null) {
  const { fund } = metrics;
  const hasPosition = metrics.avgCost > 0;
  const addCount = (fund.trades || []).filter((trade) => trade.type === 'BUY' && trade.source === 'ADD').length;

  return `
    <header class="topbar">
      <div class="topbar-row">
        <button class="icon-btn" type="button" data-action="back" aria-label="返回">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <div class="topbar-title">
          <h1>${esc(fund.name || fund.code)}</h1>
          <p>${esc(fund.code)} · ${fund.logicIntact ? '逻辑未变' : '需复核逻辑'}</p>
        </div>
        <button class="icon-btn" type="button" data-action="refresh-fund" data-fund="${esc(fund.id)}" aria-label="刷新净值">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M20 12a8 8 0 1 1-2.34-5.66"/>
            <path d="M20 4v5h-5"/>
          </svg>
        </button>
      </div>
    </header>
    <main class="page">
      <section class="detail-hero">
        <div class="detail-hero-top">
          <div>
            <p>${hasPosition ? '持仓收益' : '最新净值'}</p>
            <strong class="num ${hasPosition ? toneClass(metrics.holdingPnl) : ''}">${
              hasPosition ? `${metrics.holdingPnl >= 0 ? '+' : ''}${fmtMoney(metrics.holdingPnl)}` : fmtNav(metrics.nav)
            }</strong>
          </div>
          <div class="detail-nav">
            <span class="badge badge-accent">${fmtNav(metrics.nav)}</span>
            <small>${fmtDate(fund.navDate)}</small>
          </div>
        </div>
        <div class="detail-stats">
          <div><span>持仓收益率</span><b class="num ${hasPosition ? toneClass(metrics.holdingPnl) : ''}">${hasPosition ? fmtPct(metrics.holdingPnlPct) : '—'}</b></div>
          <div><span>摊薄成本</span><b class="num">${hasPosition ? fmtNav(metrics.avgCost) : '—'}</b></div>
          <div><span>持仓市值</span><b class="num">${hasPosition ? fmtMoney(metrics.marketValue) : '—'}</b></div>
          <div><span>剩余份额</span><b class="num">${hasPosition ? fmtShares(metrics.position.shares) : '—'}</b></div>
          <div><span>剩余本金</span><b class="num">${hasPosition ? fmtMoney(metrics.position.cost) : '—'}</b></div>
          <div><span>已实现收益</span><b class="num ${toneClass(metrics.position.realized)}">${fmtMoney(metrics.position.realized)}</b></div>
        </div>
        ${badge(metrics)}
        ${hasPosition ? `<p class="detail-foot">补仓 ${addCount} 次 · 记录 ${(fund.trades || []).length} 笔</p>` : '<p class="detail-foot">登记首笔买入后开始计算成本与规则线</p>'}
      </section>

      ${ASSET_KIND_LABELS[metrics.assetKind] ? macroAdviceCard(metrics, macro) : ruleLadder(metrics)}
      ${tiersCard(metrics)}
      ${simulatorCard(metrics)}
      ${addBatchesCard(metrics)}
      ${tradesCard(metrics)}
      ${manageCard(metrics)}

      <p class="footnote">规则提醒仅供参考，不构成投资建议。</p>
    </main>`;
}

function field({
  label,
  name,
  value = '',
  hint = '',
  inputmode = 'decimal',
  type = 'text',
  placeholder = '',
  autocomplete = 'off',
  required = false
}) {
  return `
    <label class="field">
      <span>${esc(label)}</span>
      <input type="${type}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"
        inputmode="${inputmode}" autocomplete="${autocomplete}" ${required ? 'required' : ''}>
      ${hint ? `<small>${esc(hint)}</small>` : ''}
    </label>`;
}

/** 策略回测卡模块态（不持久化）：选中的基金 / 方案 / 最近一次结果 */
let backtestFundId = '';
let backtestResult = null;

export function setBacktestResult(result) {
  backtestResult = result;
}

function backtestResultHtml(result) {
  if (!result || !result.ok) {
    return `<p class="card-empty">${esc((result && result.reason) || '选择基金与方案后点击运行。')}</p>`;
  }
  const c = result.counts;
  const rows = [
    ['区间总收益', `${fmtPct(result.totalReturnPct)}<small>（买入持有 ${fmtPct(result.buyHoldReturnPct)}）</small>`],
    ['最大回撤', fmtPct(result.maxDrawdownPct)],
    ['投入 → 期末', `¥ ${fmtMoney(result.totalInvested, 0)} → ¥ ${fmtMoney(result.finalMarketValue + result.finalCash, 0)}`],
    ['触发次数', `止损 ${c.stopLoss} · 止盈 ${c.takeProfit} · 移动止盈 ${c.trailing} · 补仓 ${c.addBuys}（合计 ¥ ${fmtMoney(result.addTotalAmount, 0)}）`]
  ];
  return `
    <ul class="preset-list">
      ${rows
        .map(([label, value]) => `<li><span>${label}</span><b>${value}</b></li>`)
        .join('')}
    </ul>
    <p class="card-empty">样本 ${result.sampleSize} 天（${esc(result.startDate.slice(5))} ~ ${esc(result.endDate.slice(5))}），模拟按预设规则自动执行，仅供参考。</p>`;
}

/** 策略页「策略回测」卡：限有净值历史的基金 */
function backtestCardHtml(funds) {
  const eligible = (funds || []).filter((f) => Array.isArray(f.navHistory) && f.navHistory.length >= 5);
  if (eligible.length === 0) {
    return `
      <section class="card notes">
        <h2 class="card-title">策略回测</h2>
        <p class="card-empty">暂无基金有净值历史（进入持仓页刷新净值后积累，≥5 条可选）。</p>
      </section>`;
  }
  if (!backtestFundId || !eligible.some((f) => f.id === backtestFundId)) {
    backtestFundId = eligible[0].id;
  }
  const options = eligible
    .map(
      (f) =>
        `<option value="${esc(f.id)}" ${f.id === backtestFundId ? 'selected' : ''}>${esc(f.name || f.code)}</option>`
    )
    .join('');
  const keyOptions = ['NORMAL', 'AGGRESSIVE']
    .map(
      (key) =>
        `<option value="${key}" ${key === 'NORMAL' ? 'selected' : ''}>${key === 'AGGRESSIVE' ? '激进方案' : '普通方案'}</option>`
    )
    .join('');
  return `
    <section class="card notes">
      <h2 class="card-title">策略回测</h2>
      <div class="backtest-controls">
        <select name="backtestFund" aria-label="回测基金">${options}</select>
        <select name="backtestKey" aria-label="回测方案">${keyOptions}</select>
        <button class="btn secondary" type="button" data-action="run-backtest">运行回测</button>
      </div>
      <div id="backtest-result">${backtestResultHtml(backtestResult)}</div>
    </section>`;
}

export function strategyPage(state) {
  const currentKey = state.settings.defaultStrategy === 'AGGRESSIVE' ? 'AGGRESSIVE' : 'NORMAL';
  const customStrategies = state.settings.strategies || {
    NORMAL: STRATEGY_PRESETS.NORMAL,
    AGGRESSIVE: STRATEGY_PRESETS.AGGRESSIVE
  };
  const presetCards = STRATEGY_KEYS
    .map((key) => presetCardEditable(key, customStrategies[key], currentKey === key))
    .join('');
  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">策略方案</p>
          <h1>交易策略</h1>
        </div>
      </div>
    </header>
    <main class="page">
      <form class="form" data-form="strategy">
        <p class="page-desc">调整止损/止盈/分档补仓等参数，保存后新参数对所有跟随该方案的基金生效。</p>
        ${presetCards}
        <button class="btn primary block" type="submit">保存所有方案</button>
      </form>

      ${backtestCardHtml(state.funds || [])}

      <section class="card notes">
        <h2 class="card-title">策略说明</h2>
        <ul class="notes-list">
          <li><b>两方案独立：</b>普通 / 激进 两套参数均可自由调整；单只权益基金可在详情页选择「跟随全局 / 普通 / 激进 / 不启用」。</li>
          <li><b>策略不适用于三类基金：</b>债券 / 黄金 / 海外（QDII）权益基金不适用分档策略，系统按宏观指标给出方向参考（见宏观页），详情页不提供策略覆盖。</li>
          <li><b>不启用的含义：</b>选择「不启用」后该基金不再计算止损 / 止盈 / 分档提醒，仅记录成本与收益。</li>
          <li><b>先判断该不该补：</b>基金经理变更、策略漂移、规模接近清盘或指数规则重大调整时，不动用补仓资金。</li>
          <li><b>补仓后必须换锚：</b>止损线与止盈线按新的平均成本重算，而不是继续套用首次买入价。</li>
          <li><b>移动止盈只跟最高点：</b>回撤阈值不随成本变化，但仓位变重后绝对盈亏会放大。</li>
          <li><b>补仓可独立了结：</b>低位筹码反弹达标后先卖出，回收资金回到储备池。</li>
        </ul>
      </section>
    </main>`;
}

/** 可编辑策略卡：普通 / 激进，支持参数修改、恢复默认、选中全局默认 */
function presetCardEditable(key, preset, isCurrent) {
  if (!preset) return '';
  const label = key === 'AGGRESSIVE' ? '激进' : '普通';
  const desc = key === 'AGGRESSIVE' ? '止损更窄、止盈更高、补仓更早' : '节奏均衡，适合多数场景';
  const t = preset;
  // 档位编辑行（固定 3 行，不足空行、超过截断）
  const tierRows = [0, 1, 2].map((i) => {
    const tier = (t.addTiers && t.addTiers[i]) || {};
    return `
      <div class="tier-row">
        <label class="field inline">
          <span>跌</span>
          <input type="number" step="0.5" min="0" name="${key}__tier${i}_drop" value="${tier.dropPct ?? ''}" placeholder="5">
          <em>%</em>
        </label>
        <label class="field inline">
          <span>补</span>
          <input type="number" step="100" min="0" name="${key}__tier${i}_amount" value="${tier.amount ?? ''}" placeholder="1200">
          <em>元</em>
        </label>
      </div>`;
  }).join('');

  return `
    <section class="card preset-card preset-card-editable" data-preset="${key}">
      <header class="preset-head editable">
        <label class="radio-default">
          <input type="radio" name="defaultStrategy" value="${key}" ${isCurrent ? 'checked' : ''}>
          <b>${label}方案</b>
          ${isCurrent ? '<span class="badge badge-accent">当前默认</span>' : ''}
        </label>
        <button type="button" class="btn ghost tiny" data-action="reset-preset" data-key="${key}">恢复默认</button>
      </header>
      <small class="preset-desc">${esc(desc)}</small>

      <div class="preset-fields">
        <div class="field-grid">
          ${field({ label: '止损线', name: `${key}__stopLossPct`, placeholder: '12', value: String(t.stopLossPct), inputmode: 'decimal', hint: '跌超此比例触发止损' })}
          ${field({ label: '止盈线', name: `${key}__takeProfitPct`, placeholder: '20', value: String(t.takeProfitPct), inputmode: 'decimal', hint: '涨超此比例触发止盈' })}
        </div>
        <div class="field-grid">
          ${field({ label: '止盈卖出比例', name: `${key}__takeProfitSellRatio`, placeholder: '40', value: String(t.takeProfitSellRatio), inputmode: 'decimal', hint: '达止盈线时先卖出的仓位占比（%）' })}
          ${field({ label: '移动止盈回撤', name: `${key}__trailingStopPct`, placeholder: '8', value: String(t.trailingStopPct), inputmode: 'decimal', hint: '峰值回撤此比例时清剩余仓位（%）' })}
        </div>

        <h4 class="preset-sub-title">分档补仓</h4>
        <div class="tiers-block" data-key="${key}">
          ${tierRows}
        </div>

        <div class="field-grid">
          ${field({ label: '最终储备', name: `${key}__reserveAmount`, placeholder: '2400', value: String(t.reserveAmount), inputmode: 'decimal', hint: '前几档用完后，剩余储备金额（元）' })}
          ${field({ label: '储备触发跌幅', name: `${key}__reserveTriggerPct`, placeholder: '20', value: String(t.reserveTriggerPct), inputmode: 'decimal', hint: '需要启用储备时的跌幅阈值（%）' })}
        </div>
        ${field({ label: '补仓了结收益率', name: `${key}__addPositionSellPct`, placeholder: '6', value: String(t.addPositionSellPct), inputmode: 'decimal', hint: '补仓批次单独卖出的收益率阈值（%）' })}
      </div>
    </section>`;
}

export function dataPage(state) {
  const tradeCount = state.funds.reduce((sum, fund) => sum + (fund.trades || []).length, 0);
  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">本地优先</p>
          <h1>数据</h1>
        </div>
      </div>
    </header>
    <main class="page">
      <section class="card">
        <h2 class="card-title">数据概览</h2>
        <div class="stat-grid">
          <div><span>监控基金</span><b class="num">${state.funds.length}</b></div>
          <div><span>交易记录</span><b class="num">${tradeCount}</b></div>
          <div><span>存储位置</span><b>本机浏览器</b></div>
        </div>
        <p class="hint-line">清除浏览器缓存或更换设备会导致数据丢失，建议定期导出备份。</p>
      </section>

      <section class="card">
        <h2 class="card-title">备份与迁移</h2>
        <div class="button-grid">
          <button class="btn ghost" type="button" data-action="open-batch-import">批量导入底仓</button>
          <button class="btn ghost" type="button" data-action="export">导出 JSON 备份</button>
          <button class="btn ghost" type="button" data-action="import">导入 JSON 备份</button>
          <button class="btn ghost danger-text" type="button" data-action="clear-data">清空全部数据</button>
        </div>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </section>

      <section class="card notes">
        <h2 class="card-title">关于 FundPilot</h2>
        <p class="notes-text">
          基于「一次性建仓 + 闲置资金补仓」策略整理：先确认基金逻辑未坏；闲置资金留两三成作最终储备；可补部分按 5% / 10% / 15% 分三档递增投入；每次补仓后基于新的平均成本重算止损与止盈线；补仓份额可在反弹中优先独立了结。
        </p>
        <p class="notes-text muted">
          净值来源：东方财富公开接口（手动触发）。应用不自动下单、不上传数据、不提供投资建议。版本 v1.0。
        </p>
      </section>
    </main>`;
}

function macroMetricRow(label, valueText, changeText, toneCls) {
  const changeHtml = changeText
    ? `<span class="num ${toneCls}">${esc(changeText)}</span>`
    : '<span class="num muted">—</span>';
  return `
    <div class="macro-row">
      <span class="macro-label">${esc(label)}</span>
      <span class="macro-value num">${esc(valueText)}</span>
      ${changeHtml}
    </div>`;
}

function percentileBarHtml(pct, label) {
  if (pct == null || !Number.isFinite(pct)) {
    return '<p class="muted">历史分位数据不可用。</p>';
  }
  const pos = Math.min(100, Math.max(0, pct));
  return `
    <div class="pct-block">
      <div class="pct-head">
        <span>${esc(label)}</span>
        <b class="num">${fmtPct(pct, { signed: false })}</b>
      </div>
      <div class="pct-track">
        <div class="pct-fill" style="width:${pos.toFixed(1)}%"></div>
      </div>
      <div class="pct-scale"><span>0%</span><span>50%</span><span>100%</span></div>
    </div>`;
}

function macroPageHead(refreshing) {
  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">FundPilot</p>
          <h1>宏观观察</h1>
        </div>
        <button class="icon-btn${refreshing ? ' is-busy' : ''}" type="button" data-action="macro-refresh"
          ${refreshing ? 'disabled' : ''} aria-label="刷新宏观数据">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M20 12a8 8 0 1 1-2.34-5.66"/>
            <path d="M20 4v5h-5"/>
          </svg>
        </button>
      </div>
    </header>`;
}

// —— 资产方向速览推导（宏观页顶部 + 配置页三资产标签共用）——
export function computeQuickDirections(data) {
  const dirs = [];
  if (!data) return dirs;
  // 权益：股债性价比分位为主，美债曲线倒挂为防守信号
  const eb = data.equityBond;
  const usBp = data.usTermSpreadBp;
  if (!eb || !Number.isFinite(eb.ratioPercentile)) {
    dirs.push({ label: '权益', tone: 'accent', text: '估值数据暂缺，建议按现有仓位观望。' });
  } else if (eb.ratioPercentile >= 70 && !(Number.isFinite(usBp) && usBp < 0)) {
    dirs.push({ label: '权益', tone: 'ok', text: `股债性价比分位高位（${Math.round(eb.ratioPercentile)}%），权益相对吸引力强，宜维持或增配。` });
  } else if (eb.ratioPercentile <= 30) {
    dirs.push({ label: '权益', tone: 'warn', text: `股债性价比分位低位（${Math.round(eb.ratioPercentile)}%），债券相对更优，宜控制权益仓位。` });
  } else if (Number.isFinite(usBp) && usBp < 0) {
    dirs.push({ label: '权益', tone: 'warn', text: '美债收益率曲线倒挂，衰退风险上升，权益宜防守为主。' });
  } else {
    dirs.push({ label: '权益', tone: 'accent', text: '股债性价比中性，权益维持现有配置。' });
  }
  // 债券：国债期限利差（宽松预期 vs 修复预期）
  const cnBp = data.cnTermSpreadBp;
  if (!Number.isFinite(cnBp)) {
    dirs.push({ label: '债券', tone: 'accent', text: '国债数据暂缺，建议维持现有久期。' });
  } else if (cnBp <= 30) {
    dirs.push({ label: '债券', tone: 'ok', text: '国债曲线平坦，宽松预期主导，债市偏友好，宜增配。' });
  } else if (cnBp >= 60) {
    dirs.push({ label: '债券', tone: 'warn', text: '国债曲线陡峭化，经济修复预期升温，宜控制债券久期。' });
  } else {
    dirs.push({ label: '债券', tone: 'accent', text: '国债期限利差常规区间，债券维持现有配置。' });
  }
  // 黄金：美国实际利率（近似口径）
  const rate = data.usRealRate;
  if (!Number.isFinite(rate)) {
    dirs.push({ label: '黄金', tone: 'accent', text: '实际利率数据暂缺，建议按现有比例持有。' });
  } else if (rate <= 0) {
    dirs.push({ label: '黄金', tone: 'ok', text: '实际利率为负，持有黄金机会成本低，宜增配。' });
  } else if (rate >= 2) {
    dirs.push({ label: '黄金', tone: 'warn', text: '实际利率偏高，黄金机会成本大，宜减配。' });
  } else {
    dirs.push({ label: '黄金', tone: 'accent', text: '实际利率中性，黄金维持现有配置。' });
  }
  // 石油：WTI 同比位置
  const yoy = data.oilYoyPct;
  if (!Number.isFinite(yoy)) {
    dirs.push({ label: '石油', tone: 'accent', text: '油价同比数据暂缺，建议观望。' });
  } else if (yoy >= 30) {
    dirs.push({ label: '石油', tone: 'warn', text: '油价同比处于高位，注意回落风险，不宜追高。' });
  } else if (yoy <= -20) {
    dirs.push({ label: '石油', tone: 'ok', text: '油价同比处于低位，若供应端企稳存在修复机会，可少量关注。' });
  } else {
    dirs.push({ label: '石油', tone: 'accent', text: '油价处于常规区间，对配置方向无新增信号。' });
  }
  return dirs;
}

export function macroPage(data, { refreshing = false } = {}) {
  if (!data) {
    return `
    ${macroPageHead(refreshing)}
    <main class="page">
      <section class="card macro-loading">
        <div class="spinner"></div>
        <p class="muted">正在加载宏观数据…</p>
      </section>
    </main>`;
  }

  const chg = (item, unit = '') => {
    if (!item || !Number.isFinite(item.changePct) || item.changePct === 0) return { text: '', cls: '' };
    const cls = item.changePct > 0 ? 'up' : 'down';
    return { text: `${item.changePct > 0 ? '+' : ''}${item.changePct.toFixed(2)}${unit}`, cls };
  };
  const fmtBp = (bp) => (Number.isFinite(bp) ? `${bp > 0 ? '+' : ''}${Math.round(bp)} bp` : '—');
  const bpCls = (bp) => (Number.isFinite(bp) ? (bp >= 0 ? 'up' : 'down') : '');
  const fmtPctVal = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');

  // —— 每张卡片一句话资产平衡方向（verdict）——
  const equityBondVerdict = (eb) => {
    if (!eb || !Number.isFinite(eb.ratioPercentile)) return null;
    const p = eb.ratioPercentile;
    if (p >= 70) return { tone: 'ok', text: '权益相对债券吸引力处于历史高位，宜增配权益、适当减配债券。' };
    if (p <= 30) return { tone: 'warn', text: '股债性价比处于历史低位，债券更占优，宜增配债券、控制权益仓位。' };
    return { tone: 'accent', text: '股债性价比处于中性区间，维持现有股债比例即可。' };
  };
  const realRateVerdict = (rate) => {
    if (!Number.isFinite(rate)) return null;
    if (rate >= 2) return { tone: 'warn', text: '实际利率偏高，持有黄金的机会成本大，宜减配黄金、增配债券。' };
    if (rate <= 0) return { tone: 'ok', text: '实际利率为负，黄金配置价值上升，宜增配黄金、适当减配债券。' };
    return { tone: 'accent', text: '实际利率处于中性区间，黄金与债券维持现有比例即可。' };
  };
  const usSpreadVerdict = (bp) => {
    if (!Number.isFinite(bp)) return null;
    if (bp < 0) return { tone: 'danger', text: '美债收益率曲线倒挂，衰退风险上升，宜降低权益敞口、增配债券与黄金。' };
    if (bp < 20) return { tone: 'warn', text: '美债曲线明显走平，警惕经济放缓，宜逐步控制权益仓位。' };
    return { tone: 'ok', text: '美债曲线形态正常，权益环境尚可，维持现有配置。' };
  };
  const cnSpreadVerdict = (bp) => {
    if (!Number.isFinite(bp)) return null;
    if (bp >= 60) return { tone: 'warn', text: '国债曲线陡峭化，经济修复预期强，宜控制债券久期、增配权益。' };
    if (bp <= 30) return { tone: 'ok', text: '国债曲线平坦，宽松预期占主导，债券偏友好，宜增配债券。' };
    return { tone: 'accent', text: '国债期限利差处于常规区间，股债维持现有比例即可。' };
  };
  const economyVerdict = (eco) => {
    if (!eco || !Number.isFinite(eco.pmi)) return null;
    if (eco.pmi >= 51) return { tone: 'ok', text: `制造业景气扩张（PMI ${eco.pmi.toFixed(1)}），经济动能强，权益环境友好，宜维持或增配权益。` };
    if (eco.pmi >= 50) return { tone: 'accent', text: `制造业处于扩张区间（PMI ${eco.pmi.toFixed(1)}），经济平稳，股债维持现有比例即可。` };
    if (eco.pmi >= 49) return { tone: 'warn', text: `制造业回落至荣枯线下（PMI ${eco.pmi.toFixed(1)}），经济动能减弱，关注后续能否回升，暂不加仓。` };
    return { tone: 'ok', text: `制造业景气收缩（PMI ${eco.pmi.toFixed(1)}），经济下行压力较大，债券偏友好，宜增配债券、控制权益仓位。` };
  };

  const quickDirCard = `
    <section class="card">
      <h2 class="card-title">资产方向速览</h2>
      <p class="card-sub">基于下方宏观指标自动推导，仅供参考</p>
      <div class="quick-dir-list">
        ${computeQuickDirections(data).map((d) => `<div class="quick-dir-row"><b class="t-${d.tone}">${esc(d.label)}</b><span>${esc(d.text)}</span></div>`).join('')}
      </div>
    </section>`;

  const card = ({ grad, title, sub, rows, extra = '', v = null, note = '' }) => `
    <section class="card macro-card ${grad}">
      <h2 class="card-title">${esc(title)}</h2>
      ${sub ? `<p class="card-sub">${esc(sub)}</p>` : ''}
      ${rows.map((r) => macroMetricRow(r.label, r.value, r.change || '', r.cls || '')).join('')}
      ${extra}
      ${v ? `<p class="macro-verdict"><b class="t-${v.tone}">◆</b> ${esc(v.text)}</p>` : ''}
      ${note ? `<p class="macro-note">${esc(note)}</p>` : ''}
    </section>`;

  // 1. 股债性价比（权益 vs 债券）
  const eb = data.equityBond;
  const cardEb = card({
    grad: 'grad-violet',
    title: '股债性价比 · 权益 vs 债券',
    rows: eb
      ? [
          { label: 'PE-TTM（近似·计算因子）', value: data.csi300.pe > 0 ? data.csi300.pe.toFixed(1) : '—' },
          { label: '盈利收益率 = 1 ÷ PE-TTM', value: fmtPctVal(eb.earningsYield) },
          { label: '股债收益比', value: eb.ratio.toFixed(2) },
          { label: '风险溢价 ERP', value: `${eb.erp >= 0 ? '+' : ''}${eb.erp.toFixed(2)}%` }
        ]
      : [{ label: 'PE-TTM（近似·计算因子）', value: data.csi300.pe > 0 ? data.csi300.pe.toFixed(1) : '—' }],
    extra: eb ? percentileBarHtml(eb.ratioPercentile, '股债收益比 5 年分位') : '',
    v: equityBondVerdict(eb),
    note: eb
      ? `盈利收益率 = 1 ÷ PE-TTM，PE 取行情近似口径、盈利采用当前值近似估算；分位基于近 5 年日频数据（样本 ${eb.sampleSize} 个）。`
      : '历史序列暂不可用，请稍后刷新重试。'
  });

  // 2. 美国实际利率（黄金 vs 债券）
  const cardReal = card({
    grad: 'grad-blue',
    title: '美国实际利率 · 黄金 vs 债券',
    rows: [
      { label: '美国10年期国债收益率', value: fmtPctVal(data.us10y.price), change: chg(data.us10y, '%').text, cls: chg(data.us10y, '%').cls },
      { label: 'WTI 同比（通胀近似）', value: fmtPctVal(data.oilYoyPct) },
      { label: '实际利率（近似）', value: fmtPctVal(data.usRealRate) }
    ],
    v: realRateVerdict(data.usRealRate),
    note: '实际利率 = US10Y − WTI同比。美国通胀预期无免费公开接口，以 WTI 同比近似，仅供参考。'
  });

  // 3. 美债期限利差（权益风险总敞口）
  const cardUsSpread = card({
    grad: 'grad-blue',
    title: '美债期限利差 · 权益风险总敞口',
    rows: [
      { label: '美国10Y', value: fmtPctVal(data.us10y.price) },
      { label: '美国2Y', value: fmtPctVal(data.us2y.price) },
      { label: '10Y − 2Y 利差', value: fmtBp(data.usTermSpreadBp), cls: bpCls(data.usTermSpreadBp) }
    ],
    v: usSpreadVerdict(data.usTermSpreadBp),
    note: '美债期限利差采用 10Y−2Y 口径，短端对货币政策更敏感。'
  });

  // 4. 中国国债期限利差（债券友好度）
  const cardCnSpread = card({
    grad: 'grad-teal',
    title: '中国期限利差 · 债券友好度',
    rows: [
      { label: '中国10Y', value: fmtPctVal(data.cn10y.price), change: chg(data.cn10y, '%').text, cls: chg(data.cn10y, '%').cls },
      { label: '中国2Y', value: fmtPctVal(data.cn2y.price) },
      { label: '10Y − 2Y 利差', value: fmtBp(data.cnTermSpreadBp), cls: bpCls(data.cnTermSpreadBp) }
    ],
    v: cnSpreadVerdict(data.cnTermSpreadBp),
    note: '中债期限利差采用 10Y−2Y 口径，短端对资金面更敏感。'
  });

  // 5. 通胀与景气（经济周期锚：CPI/PPI/PMI）
  const eco = data.economy;
  const scissors = eco && Number.isFinite(eco.cpiYoy) && Number.isFinite(eco.ppiYoy) ? eco.ppiYoy - eco.cpiYoy : NaN;
  const cardEconomy = card({
    grad: 'grad-teal',
    title: '通胀与景气 · 经济周期锚',
    rows: [
      { label: 'CPI 同比', value: fmtPctVal(eco ? eco.cpiYoy : NaN) },
      { label: 'PPI 同比', value: fmtPctVal(eco ? eco.ppiYoy : NaN) },
      { label: 'PPI−CPI 剪刀差', value: fmtPctVal(scissors), cls: Number.isFinite(scissors) ? (scissors >= 0 ? 'up' : 'down') : '' },
      { label: '制造业 PMI', value: eco && Number.isFinite(eco.pmi) ? eco.pmi.toFixed(1) : '—' },
      { label: '非制造业 PMI', value: eco && Number.isFinite(eco.pmiNonMfg) ? eco.pmiNonMfg.toFixed(1) : '—' }
    ],
    v: economyVerdict(eco),
    note: eco
      ? `${eco.time}月度数据，每月 9 日前后更新；PMI 以 50 为荣枯线，剪刀差为正代表上游成本压力偏大。`
      : '经济数据暂不可用，请稍后刷新重试。'
  });

  // 6. 黄金价格（方向沿用实际利率锚；美元指数并入本卡展示）
  const gd = chg(data.gold, '%');
  const cardGold = card({
    grad: 'grad-gold',
    title: 'COMEX 黄金 · 避险与实际利率锚',
    rows: [
      { label: 'COMEX 黄金', value: data.gold.price > 0 ? `$${data.gold.price.toFixed(1)}` : '—', change: gd.text, cls: gd.cls },
      { label: '美元指数', value: data.dxy.price > 0 ? data.dxy.price.toFixed(2) : '—' },
      { label: '美国实际利率（近似）', value: fmtPctVal(data.usRealRate) }
    ],
    v: realRateVerdict(data.usRealRate),
    note: '黄金与实际利率负相关、与美元大体反向；方向判断采用实际利率近似口径（详见实际利率卡）。'
  });

  // 7. 石油价格（WTI 同比位置）
  const ol = chg(data.oil, '%');
  const oilYoy = data.oilYoyPct;
  const oilVerdict = !Number.isFinite(oilYoy)
    ? { tone: 'accent', text: '油价同比数据暂缺，建议观望。' }
    : oilYoy >= 30
      ? { tone: 'warn', text: `油价同比 +${oilYoy.toFixed(0)}% 处于高位，注意回落风险，不宜追高。` }
      : oilYoy <= -20
        ? { tone: 'ok', text: `油价同比 ${oilYoy.toFixed(0)}% 处于低位，若供应端企稳存在修复机会，可少量关注。` }
        : { tone: 'accent', text: '油价处于常规区间，对配置方向无新增信号。' };
  const cardOil = card({
    grad: 'grad-gold',
    title: 'NYMEX 原油 · 通胀与周期锚',
    rows: [
      { label: 'NYMEX 原油', value: data.oil.price > 0 ? `$${data.oil.price.toFixed(2)}` : '—', change: ol.text, cls: ol.cls },
      { label: 'WTI 同比（365 天）', value: fmtPctVal(oilYoy) }
    ],
    v: oilVerdict,
    note: 'WTI 同比是通胀预期的近似代理，同时用于实际利率的计算因子（详见实际利率卡）。'
  });

  const updated = new Date(data.updatedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  // 降级提示：数据源兜底生效时明确告知口径
  const degradedNotes = [];
  if (data.quotesFailed) degradedNotes.push('东财行情不可用，国债收益率与美元指数暂缺');
  if (data.proxyUsed) degradedNotes.push('黄金/原油/沪深300 为天天基金估值代理，仅日涨跌可用');
  if (data.peMissing) degradedNotes.push('沪深300 PE 暂不可用，股债性价比降级');
  if (data.historyMissing) degradedNotes.push('历史序列暂不可用，分位/同比/实际利率降级');
  if (data.economyMissing) degradedNotes.push('CPI/PPI/PMI 经济数据暂不可用');
  const degradedHtml = degradedNotes.length
    ? `<p class="macro-note t-warn">⚠ 降级模式：${esc(degradedNotes.join('；'))}。</p>`
    : '';

  return `
    ${macroPageHead(refreshing)}
    <main class="page">
      ${quickDirCard}
      ${cardEb}
      ${cardReal}
      ${cardUsSpread}
      ${cardCnSpread}
      ${cardEconomy}
      ${cardGold}
      ${cardOil}
      ${degradedHtml}
      <p class="footnote">数据来源：东方财富公开接口 · 更新于 ${esc(updated)} · 仅供参考，不构成投资建议。</p>
    </main>`;
}

export function batchImportSheetBody() {
  return `
    <form class="form" data-form="batch-import">
      <label class="field">
        <span>持仓数据（每行：代码, 持仓金额, 持仓收益率）</span>
        <textarea name="payload" rows="7"
          placeholder="# 示例（收益率可省略，支持负数）&#10;110022,10500,5.2&#10;161725,8200,-3.1&#10;005827,12000"
          autocomplete="off" spellcheck="false"></textarea>
        <small>支持从 Excel 直接复制粘贴（逗号 / Tab 分隔）。名称与净值导入时自动联网查询。</small>
      </label>
      <div class="lookup-row">
        <button class="btn ghost small" type="button" data-action="batch-parse">解析预览</button>
        <button class="btn ghost small" type="button" data-action="batch-import-file">加载本地文件</button>
        <input type="file" accept=".csv,.txt,text/csv,text/plain" data-action="batch-import-file" hidden />
        <span class="lookup-status" id="batch-parse-status"></span>
      </div>
      <div id="batch-preview"></div>
      <button class="btn primary block" type="button" id="batch-import-btn" data-action="batch-import-confirm" hidden>确认导入</button>
    </form>`;
}

export function batchPreviewHtml(result, state) {
  const existing = new Set(state.funds.map((f) => f.code));
  const items = [
    ...result.rows.map((row) => ({
      ...row,
      status: existing.has(row.code) ? 'dup' : 'ok'
    })),
    ...result.errors.map((err) => ({ ...err, status: 'error' }))
  ].sort((a, b) => a.lineNo - b.lineNo);

  if (!items.length) return '<p class="empty-inline">没有解析到有效数据行。</p>';

  const rows = items
    .map((item) => {
      if (item.status === 'error') {
        return `
        <div class="batch-row is-error">
          <span class="batch-line">L${item.lineNo}</span>
          <span class="batch-code">${esc(item.code || '—')}</span>
          <span class="batch-reason">${esc(item.reason)}</span>
        </div>`;
      }
      if (item.status === 'dup') {
        return `
        <div class="batch-row is-dup">
          <span class="batch-line">L${item.lineNo}</span>
          <span class="batch-code">${esc(item.code)}</span>
          <span class="batch-reason">已在监控列表，将跳过</span>
        </div>`;
      }
      return `
        <div class="batch-row is-ok">
          <span class="batch-line">L${item.lineNo}</span>
          <span class="batch-code">${esc(item.code)}</span>
          <span class="batch-detail num">¥${fmtMoney(item.amount)} · ${fmtPct(item.returnPct)}</span>
        </div>`;
    })
    .join('');

  const okCount = result.rows.filter((r) => !existing.has(r.code)).length;
  const dupCount = result.rows.length - okCount;
  const summary = `可导入 ${okCount} 只${dupCount ? `，重复跳过 ${dupCount} 只` : ''}${
    result.errors.length ? `，错误 ${result.errors.length} 行` : ''
  }`;

  return `
    <div class="batch-summary">${summary}</div>
    <div class="batch-list">${rows}</div>`;
}

export function addFundSheetBody(categories = []) {
  const today = todayISO();
  const catOptions = categories.length
    ? categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')
    : '';
  const catSelect = catOptions
    ? `<label class="field">
        <span>资产类别</span>
        <select name="category">
          <option value="">未分类</option>
          ${catOptions}
        </select>
        <small>可在底部「配置」页面管理类别和目标比例</small>
      </label>`
    : `<label class="field">
        <span>资产类别</span>
        <input type="text" name="category" placeholder="可留空，稍后在配置页面归类">
        <small>暂无预设类别。可在此自由填写，或先去底部「配置」页面添加分类。</small>
      </label>`;
  return `
    <form class="form" data-form="add-fund">
      <label class="field">
        <span>基金代码</span>
        <input type="text" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
          placeholder="如 110022" autocomplete="off" required>
        <small>6 位数字。可先查询名称与净值，也可直接手动录入。</small>
      </label>
      <div class="lookup-row">
        <button class="btn ghost small" type="button" data-action="lookup-fund">查询名称与净值</button>
        <span class="lookup-status" id="lookup-status"></span>
      </div>
      ${field({ label: '基金名称', name: 'name', placeholder: '留空则自动获取' })}
      <div class="field-grid">
        ${field({ label: '最新净值', name: 'nav', placeholder: '0.0000' })}
        ${field({ label: '净值日期', name: 'navDate', value: today, type: 'date', inputmode: 'none' })}
      </div>
      ${catSelect}

      <h3 class="form-section">初始底仓（可跳过）</h3>
      <p class="hint">填写持仓市值和收益率，系统自动反推成本、份额和成本净值。</p>
      <div class="field-grid">
        ${field({ label: '持仓日期', name: 'buyDate', value: today, type: 'date', inputmode: 'none' })}
        ${field({ label: '手续费（元）', name: 'fee', placeholder: '0' })}
      </div>
      <div class="field-grid">
        ${field({ label: '持仓市值（元）', name: 'holdingAmount', placeholder: '10500' })}
        ${field({ label: '持仓收益率（%）', name: 'returnPct', placeholder: '5', inputmode: 'text', hint: '正数=盈利，负数=亏损' })}
      </div>
      <p class="hint-line" id="base-derive-hint" hidden>
        反推结果：成本 <b id="derived-cost">—</b> 元 · 份额 <b id="derived-shares">—</b> 份 · 成本净值 <b id="derived-nav">—</b>
      </p>
      <button class="btn ghost block" type="button" data-action="open-batch-import">多只基金？批量导入底仓（代码, 金额, 收益率）</button>

      <button class="btn primary block" type="submit">保存并开始监控</button>
    </form>`;
}

/** 在 fund 的 navHistory 里查找指定日期净值，找不到用最新净值兜底 */
function resolveNavForDate(fund, dateStr) {
  if (!fund) return null;
  if (Array.isArray(fund.navHistory)) {
    const hit = fund.navHistory.find((h) => h.date === dateStr);
    if (hit) return { nav: hit.nav, date: hit.date, source: 'history' };
    // 找该日期之前最近的一条（工作日净值）
    const before = fund.navHistory
      .filter((h) => h.date <= dateStr)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (before) return { nav: before.nav, date: before.date, source: 'history' };
  }
  if (fund.nav > 0) {
    return { nav: fund.nav, date: fund.navDate || dateStr, source: 'latest' };
  }
  return null;
}

export function tradeSheetBody(fund, metrics, preset = {}) {
  const isSell = preset.type === 'SELL';
  const isBase = (preset.source || 'BASE') === 'BASE';
  const lockedSource = Number.isInteger(preset.tierIndex);
  const today = todayISO();
  const defaultDate = preset.date || today;
  const navInfo = resolveNavForDate(fund, defaultDate);
  const navHint = navInfo
    ? `将使用 ${navInfo.date} 净值 <b>${navInfo.nav.toFixed(4)}</b>${navInfo.source === 'latest' ? '（最新）' : ''}`
    : '<b class="warn">⚠ 暂无净值数据，请先刷新或查询</b>';

  // 空基金（无份额且无交易记录）→ 只显示底仓登记（市值 + 收益率）
  const hasPosition = !!(metrics && metrics.position && metrics.position.shares > 0);
  const hasTrades = Array.isArray(fund.trades) && fund.trades.length > 0;
  if (!hasPosition && !hasTrades) {
    return `
      <form class="form" data-form="add-trade" data-mode="base" data-fund="${esc(fund.id)}">
        <p class="hint">该基金还没有持仓。填写当前市值和收益率，系统自动反推成本、份额和底仓成本净值。</p>
        <div class="field-grid">
          ${field({ label: '持仓日期', name: 'date', value: defaultDate, type: 'date', inputmode: 'none' })}
          ${field({ label: '手续费（元）', name: 'fee', value: preset.fee || '', placeholder: '0' })}
        </div>
        <div class="field-grid">
          ${field({ label: '持仓市值（元）', name: 'holdingAmount', placeholder: '10500' })}
          ${field({ label: '持仓收益率（%）', name: 'returnPct', placeholder: '5', inputmode: 'text', hint: '正数=盈利，负数=亏损' })}
        </div>
        <p class="hint-line" id="trade-nav-hint">${navHint}</p>
        <button class="btn primary block" type="submit">登记底仓</button>
      </form>`;
  }

  return `
    <form class="form" data-form="add-trade" data-fund="${esc(fund.id)}">
      ${
        lockedSource
          ? `<input type="hidden" name="source" value="${esc(preset.source || 'BASE')}">`
          : `<div data-source-field ${isSell ? 'hidden' : ''}>
              <label class="field">
                <span>买入性质</span>
                <select name="source">
                  <option value="BASE" ${isBase ? 'selected' : ''}>底仓买入（计入档位锚）</option>
                  <option value="ADD">补仓买入（可独立了结）</option>
                </select>
              </label>
            </div>`
      }
      <input type="hidden" name="tierIndex" value="${Number.isInteger(preset.tierIndex) ? preset.tierIndex : ''}">
      <input type="hidden" name="batchId" value="${esc(preset.batchId || '')}">

      <div class="segmented">
        <label><input type="radio" name="type" value="BUY" ${isSell ? '' : 'checked'} data-toggle="trade-panel"><span>买入 / 补仓</span></label>
        <label><input type="radio" name="type" value="SELL" ${isSell ? 'checked' : ''} data-toggle="trade-panel"><span>卖出</span></label>
      </div>

      <div class="field-grid">
        ${field({ label: '成交日期', name: 'date', value: defaultDate, type: 'date', inputmode: 'none' })}
        ${field({ label: '手续费（元）', name: 'fee', value: preset.fee || '', placeholder: '0' })}
      </div>

      <p class="hint-line" id="trade-nav-hint">${navHint}</p>

      <div data-trade-panel="BUY" ${isSell ? 'hidden' : ''}>
        ${field({ label: '买入金额（元）', name: 'amount', value: preset.amount || '', placeholder: '0.00', hint: '份额 = 金额 ÷ 当日净值' })}
      </div>
      <div data-trade-panel="SELL" ${isSell ? '' : 'hidden'}>
        ${field({ label: '卖出份额（份）', name: 'shares', value: preset.shares || '', placeholder: '0.000', hint: '卖出金额 = 份额 × 当日净值' })}
      </div>

      ${field({ label: '备注', name: 'note', value: preset.note || '', placeholder: '可选', inputmode: 'text' })}
      <button class="btn primary block" type="submit">${isSell ? '登记卖出' : '登记买入'}</button>
    </form>`;
}

export function manualNavSheetBody(fund) {
  return `
    <form class="form" data-form="manual-nav" data-fund="${esc(fund.id)}">
      <div class="field-grid">
        ${field({ label: '最新净值', name: 'nav', value: fund.nav ? fund.nav.toFixed(4) : '', placeholder: '0.0000', required: true })}
        ${field({ label: '净值日期', name: 'navDate', value: fund.navDate || todayISO(), type: 'date', inputmode: 'none' })}
      </div>
      <p class="hint-line">接口不可用时使用。手动净值会累加到本地净值历史。</p>
      <button class="btn primary block" type="submit">保存净值</button>
    </form>`;
}

export function overrideSheetBody(fund, defaultKey) {
  const current = typeof fund.strategyOverride === 'string' ? fund.strategyOverride : '';
  const globalLabel = defaultKey === 'AGGRESSIVE' ? '激进' : '普通';
  // 当前生效方案：覆盖为 NORMAL/AGGRESSIVE 时取覆盖值，NONE 不启用，其余跟随全局
  const effKey = fund.strategyOverride === 'NORMAL' || fund.strategyOverride === 'AGGRESSIVE'
    ? fund.strategyOverride
    : defaultKey === 'AGGRESSIVE' ? 'AGGRESSIVE' : 'NORMAL';
  const effectiveLabel = fund.strategyOverride === 'NONE' ? '不启用' : effKey === 'AGGRESSIVE' ? '激进' : '普通';

  return `
    <form class="form" data-form="override" data-fund="${esc(fund.id)}">
      <section class="card">
        <h2 class="card-title">策略方案</h2>
        <p class="card-sub">当前生效：${esc(effectiveLabel)}${current ? '' : '（跟随全局）'}</p>
        <label class="field">
          <span>选择方案</span>
          <select name="strategyOverride">
            <option value="" ${current === '' ? 'selected' : ''}>跟随全局（${esc(globalLabel)}）</option>
            <option value="NORMAL" ${current === 'NORMAL' ? 'selected' : ''}>普通</option>
            <option value="AGGRESSIVE" ${current === 'AGGRESSIVE' ? 'selected' : ''}>激进</option>
            <option value="NONE" ${current === 'NONE' ? 'selected' : ''}>不启用（仅记录成本）</option>
          </select>
        </label>
        <p class="hint-line">「不启用」后该基金不再计算止损 / 止盈 / 分档提醒，也不参与预警排序。</p>
      </section>
      <button class="btn primary block" type="submit">保存</button>
    </form>`;
}

function fmtFundName(fund) {
  return `${fund.name || '—'} · ${fund.code}`;
}

const PIE_COLORS = ['#0a6cff', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa', '#ffd60a', '#8e8e93'];

function rebalanceHtml(cat) {
  if (cat.unconfigured) return '';
  const amt = Math.abs(cat.adjustAmount);
  if (!Number.isFinite(amt) || amt < 1) return '<span class="rebal ok">已达标</span>';
  const isBuy = cat.adjustAmount > 0;
  const cls = isBuy ? 'buy' : 'sell';
  const label = isBuy ? '需买入' : '需卖出';
  return `<span class="rebal ${cls}">${label} ¥${fmtMoney(amt)}</span>`;
}

function allocPieHtml(alloc) {
  const segments = alloc.categories
    .filter((c) => c.actualValue > 0)
    .map((c) => ({
      name: c.name,
      value: c.actualValue,
      pct: c.actualPct,
      targetPct: c.targetPct,
      deviation: c.deviation
    }));
  if (alloc.uncategorizedValue > 0) {
    segments.push({
      name: '未分类',
      value: alloc.uncategorizedValue,
      pct: alloc.uncategorizedPct,
      targetPct: 0,
      deviation: null
    });
  }
  if (!segments.length) return '';

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const R = 56;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const circles = segments
    .map((seg, i) => {
      const frac = seg.value / total;
      const color = PIE_COLORS[i % PIE_COLORS.length];
      const el = `<circle r="${R}" cx="75" cy="75" fill="none" stroke="${color}" stroke-width="26"
        stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset * C).toFixed(2)}"
        transform="rotate(-90 75 75)"></circle>`;
      offset += frac;
      return el;
    })
    .join('');

  const legend = segments
    .map((seg, i) => {
      const color = PIE_COLORS[i % PIE_COLORS.length];
      // 偏差条：中线=目标，向左延伸=低配（绿），向右延伸=超配（红）
      let devBar = '';
      if (seg.targetPct > 0 && Number.isFinite(seg.deviation) && Math.abs(seg.deviation) >= 0.05) {
        const span = Math.max(seg.targetPct, seg.pct);
        const width = Math.min(50, (Math.abs(seg.deviation) / span) * 50);
        const dir = seg.deviation > 0 ? 'over' : 'under';
        const tip = `目标 ${seg.targetPct.toFixed(1)}% · 实际 ${seg.pct.toFixed(1)}%（${dir === 'over' ? '超配' : '低配'} ${Math.abs(seg.deviation).toFixed(1)}%）`;
        devBar = `
        <div class="pie-dev-track" title="${tip}">
          <div class="pie-dev-center"></div>
          <div class="pie-dev-fill ${dir}" style="width:${width.toFixed(1)}%"></div>
        </div>`;
      }
      return `
      <div class="pie-legend-item">
        <i style="background:${color}"></i>
        <span class="pie-legend-name">${esc(seg.name)}</span>
        <b class="num">${fmtPct(seg.pct, { signed: false })}</b>
        ${devBar}
      </div>`;
    })
    .join('');

  return `
    <section class="card">
      <h2 class="card-title">持仓占比总览</h2>
      <p class="card-sub">按当前市值统计各类别资金分布。</p>
      <div class="pie-wrap">
        <div class="pie-chart-box">
          <svg viewBox="0 0 150 150" class="alloc-pie" role="img" aria-label="资产类别占比饼图">${circles}</svg>
        </div>
        <div class="pie-legend">${legend}</div>
      </div>
      <p class="macro-note">图例进度条以中线为目标基准：<span class="dev-under">向左绿色</span>=低配，<span class="dev-over">向右红色</span>=超配。</p>
    </section>`;
}

// 配置页 UI 临时状态：当前标签（三资产 / 自定义分类），不持久化
let allocTab = 'asset';

export function setAllocTab(tab) {
  allocTab = tab === 'category' ? 'category' : 'asset';
}

export function allocationPage(state, metricsMap, expandedCats = new Set(), macroData = null, expandedAssets = new Set()) {
  const alloc = computeAllocation(state, metricsMap);
  const targetTotalDeviation = Math.abs(alloc.configuredTargetTotal - 100);
  const targetTone =
    alloc.configuredTargetTotal === 0 ? '' : targetTotalDeviation < 2 ? 'badge-ok' : targetTotalDeviation < 10 ? 'badge-accent' : 'badge-danger';

  const hasData = alloc.totalMarketValue > 0;
  const hasConfig = state.categories.length > 0;

  // 每个类别的可视化行
  const categoryRows = alloc.categories.length
    ? alloc.categories
        .map((cat) => {
          // 条形图：渐变轨道同持仓页 rule-track，竖线=目标，圆点=实际占比
          const barTargetLeft = cat.targetPct; // 目标线位置 0~100
          const barActualWidth = Math.min(cat.actualPct, 100);
          const sign = cat.deviation > 0 ? '+' : '';
          const isOpen = expandedCats.has(cat.name);
          return `
          <section class="alloc-row${cat.unconfigured ? ' is-unconfigured' : ''}${isOpen ? ' is-open' : ''}"
            data-category="${esc(cat.name)}">
            <div class="alloc-head" data-action="toggle-alloc" data-category="${esc(cat.name)}"
              role="button" tabindex="0" aria-expanded="${isOpen}">
              <div class="alloc-head-left">
                <b>${esc(cat.name)}</b>
                ${cat.unconfigured ? '<span class="alloc-tag">未设目标</span>' : ''}
                <span class="muted">${cat.fundCount} 只</span>
              </div>
              <div class="alloc-head-right">
                <span class="num">${fmtMoney(cat.actualValue)}</span>
                <span class="num ${toneClass(cat.deviation)}">${sign}${fmtPct(cat.deviation)}</span>
                <svg class="alloc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </div>
            </div>
            ${rebalanceHtml(cat)}
            <div class="alloc-bar-wrap">
              <div class="alloc-bar-track">
                <span class="alloc-bar-target" style="left:${barTargetLeft}%"></span>
                <span class="alloc-bar-nav" style="left:${barActualWidth}%"></span>
              </div>
              <div class="alloc-bar-labels">
                <span>实际 ${fmtPct(cat.actualPct, { signed: false })}</span>
                <span class="target-label">目标 ${fmtPct(cat.targetPct, { signed: false })}</span>
              </div>
            </div>
            ${
              cat.funds.length > 0
                ? `<div class="alloc-funds"${isOpen ? '' : ' hidden'}>
                    ${cat.funds
                      .map(
                        (f) => `
                    <div class="alloc-fund-item">
                      <span>${esc(fmtFundName(f.fund))}</span>
                      <b class="num">${fmtMoney(f.marketValue)}</b>
                      <button class="link-btn" type="button" data-action="unassign-category" data-fund="${esc(f.fund.id)}">移除</button>
                    </div>`
                      )
                      .join('')}
                   </div>`
                : ''
            }
          </section>`;
        })
        .join('')
    : '';

  // 未分类基金
  const uncategorizedBlock =
    alloc.uncategorizedFunds.length > 0
      ? `
      <section class="card">
        <h2 class="card-title">未分类资产</h2>
        <p class="card-sub">${fmtPct(alloc.uncategorizedPct, { signed: false })} · ${alloc.uncategorizedFunds.length} 只</p>
        <div class="uncat-list">
          ${alloc.uncategorizedFunds
            .map(
              (item) => `
            <div class="uncat-item">
              <span>${esc(fmtFundName(item.fund))}</span>
              <b class="num">${fmtMoney(item.marketValue)}</b>
              <select data-action="assign-category" data-fund="${esc(item.fund.id)}">
                <option value="">分配到…</option>
                ${state.categories
                  .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`)
                  .join('')}
              </select>
            </div>`
            )
            .join('')}
        </div>
      </section>`
      : '';

  // 顶部 hero
  const heroStatus = !hasData
    ? '先添加基金并登记底仓，配置页面才会显示占比'
    : !hasConfig
      ? '添加分类并设置目标比例，开始跟踪资产配置'
      : targetTotalDeviation >= 20
        ? '⚠️ 目标合计远离 100%，建议调整'
        : '✓ 目标配置正常';

  // 类别编辑表单行
  const categoryEditorRows = state.categories
    .map(
      (cat) => `
      <div class="cat-edit-row">
        <input type="text" name="cat-name" value="${esc(cat.name)}" placeholder="类别名，如 指数型"
          data-old-name="${esc(cat.name)}">
        <input type="text" name="cat-target" value="${esc(String(cat.targetPct))}"
          inputmode="decimal" placeholder="目标 %">
        <button class="icon-btn small" type="button" data-action="remove-category"
          data-name="${esc(cat.name)}" aria-label="删除该类别">✕</button>
      </div>`
    )
    .join('');

  // 三资产再平衡（权益 / 债券 / 黄金）+ 宏观方向建议 + 推荐方案自动切换
  const macroHints = macroData
    ? Object.fromEntries(
        computeQuickDirections(macroData)
          .filter((d) => ['权益', '债券', '黄金'].includes(d.label))
          .map((d) => [d.label, d])
      )
    : null;
  const rec = recommendAssetScheme(macroData);
  // 三资产目标比例仅由预置推荐方案决定（宏观数据缺失时按「平衡」方案兜底），不支持手动自定义
  const effectiveState = { ...state, settings: { ...state.settings, assetTargets: { ...rec.targets } } };
  const three = computeThreeAssetAllocation(effectiveState, metricsMap);
  const assetRows = three.classes
    .map((cls) => {
      const sign = cls.deviation > 0 ? '+' : '';
      const isOpen = expandedAssets.has(cls.key);
      const barTargetLeft = cls.targetPct; // 目标线位置 0~100
      const barActualWidth = Math.min(cls.actualPct, 100);
      const hint = macroHints && macroHints[cls.label]
        ? `<p class="macro-note">宏观：<b class="t-${macroHints[cls.label].tone}">◆</b> ${esc(macroHints[cls.label].text)}</p>`
        : '';
      const fundsItems = cls.funds
        .map(
          (f) => `
        <div class="asset-fund-item">
          <span>${esc(fmtFundName(f.fund))}</span>
          <b class="num">${fmtMoney(f.marketValue)}</b>
        </div>`
        )
        .join('');
      return `
      <section class="alloc-row${isOpen ? ' is-open' : ''}" data-class="${esc(cls.key)}">
        <div class="alloc-head" data-action="toggle-asset" data-class="${esc(cls.key)}"
          role="button" tabindex="0" aria-expanded="${isOpen}">
          <div class="alloc-head-left">
            <b>${esc(cls.label)}</b>
            <span class="muted">${cls.fundCount} 只</span>
          </div>
          <div class="alloc-head-right">
            <span class="num">${fmtMoney(cls.actualValue)}</span>
            <span class="num ${toneClass(cls.deviation)}">${sign}${fmtPct(cls.deviation)}</span>
            <svg class="alloc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </div>
        </div>
        ${rebalanceHtml(cls)}
        <div class="alloc-bar-wrap">
          <div class="alloc-bar-track">
            <span class="alloc-bar-target" style="left:${barTargetLeft}%"></span>
            <span class="alloc-bar-nav" style="left:${barActualWidth}%"></span>
          </div>
          <div class="alloc-bar-labels">
            <span>实际 ${fmtPct(cls.actualPct, { signed: false })}</span>
            <span class="target-label">目标 ${fmtPct(cls.targetPct, { signed: false })}</span>
          </div>
        </div>
        <div class="alloc-funds"${isOpen ? '' : ' hidden'}>
          ${fundsItems}
        </div>
        ${hint}
      </section>`;
    })
    .join('');

  const schemeBlock = `
      <section class="card">
        <h2 class="card-title">宏观推荐方案</h2>
        <p class="card-sub">当前方案：<b class="t-accent">${esc(rec.label)}</b>（权益 ${rec.targets.equity}% / 债券 ${rec.targets.bond}% / 黄金 ${rec.targets.gold}%）</p>
        ${
          macroData
            ? `<p class="macro-note"><b class="t-accent">◆</b> ${esc(rec.reason)}</p>
      <p class="macro-note">三资产目标比例由推荐方案自动决定，宏观变化时自动切换；基金大类由基金类型自动归类。</p>`
            : '<p class="macro-note">宏观数据暂缺，当前按「平衡」方案兜底；进入「宏观」页加载数据后自动切换。</p>'
        }
      </section>`;

  const threeAssetBlock = `
      ${schemeBlock}
      <section class="card">
        <h2 class="card-title">三资产再平衡</h2>
        <p class="card-sub">按权益 / 债券 / 黄金三个大类统计偏差与调仓金额；点击行展开基金明细。</p>
        <div class="alloc-list">${assetRows}</div>
        <p class="macro-note">目标合计 <b class="num ${three.targetTotalOk ? 'ok' : 'warn'}">${fmtPct(three.targetTotal, { signed: false })}</b>。大类由基金类型自动归类，无需手动维护。</p>
      </section>`;

  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">资产配置</p>
          <h1>配置</h1>
        </div>
      </div>
    </header>
    <main class="page">
      <div class="filter-tabs" role="tablist" aria-label="配置页标签">
        <button class="filter-tab${allocTab === 'asset' ? ' is-active' : ''}" type="button" data-action="alloc-tab" data-tab="asset">三资产</button>
        <button class="filter-tab${allocTab === 'category' ? ' is-active' : ''}" type="button" data-action="alloc-tab" data-tab="category">自定义分类</button>
      </div>

      <section class="hero-card">
        <p class="hero-label">总资产市值</p>
        <strong class="hero-value num">¥ ${fmtMoney(alloc.totalMarketValue)}</strong>
        ${
          allocTab === 'asset'
            ? `<p class="hero-note">${esc(!hasData ? '先添加基金并登记底仓，配置页才会显示占比' : '✓ 底仓数据就绪')}</p>`
            : `<div class="hero-chips">
          <div>
            <span>已配置目标合计</span>
            <b class="num ${targetTone}">${fmtPct(alloc.configuredTargetTotal, { signed: false })}</b>
          </div>
          <div>
            <span>未分类</span>
            <b class="num">${fmtPct(alloc.uncategorizedPct, { signed: false })}</b>
          </div>
        </div>
        <p class="hero-note">${esc(heroStatus)}</p>`
        }
      </section>

      ${
        allocTab === 'asset'
          ? hasData
            ? `${threeAssetBlock}
      <p class="footnote">宏观方向建议来自「宏观」页指标推导，仅供参考；占比按当前市值计算，无持仓的基金不计入分母。</p>`
            : '<p class="empty-inline">登记底仓后才能计算三资产再平衡。</p>'
          : `
      ${hasData ? allocPieHtml(alloc) : ''}

      ${
        hasData && !hasConfig
          ? '<section class="empty-inline"><p>还没有配置分类，先添加一个类别和目标比例。</p></section>'
          : hasData
            ? `<section class="card">
                <h2 class="card-title">类别占比与偏差</h2>
                <p class="card-sub">灰色竖线=目标位置，彩色填充=实际占比。正偏差=超配，负偏差=低配。</p>
                <div class="alloc-list">${categoryRows || '<p class="empty-inline">暂无分类资产。</p>'}</div>
              </section>`
            : '<p class="empty-inline">登记底仓后才能计算资产配置。</p>'
      }

      ${uncategorizedBlock}

      <section class="card">
        <h2 class="card-title">类别管理</h2>
        <p class="card-sub">添加、重命名、删除分类并设定目标比例。目标合计不必恰好 100%。</p>
        <form class="form" data-form="categories">
          <div class="cat-edit-list">${categoryEditorRows || '<p class="empty-inline">还没有类别，加一个吧。</p>'}</div>
          <div class="cat-edit-add">
            <label class="field-label">新类别</label>
            <input type="text" name="newCatName" placeholder="类别名，如 指数型 / 行业主题 / 债券" autocomplete="off">
            <input type="text" name="newCatTarget" placeholder="目标%" inputmode="decimal" autocomplete="off" title="目标占比 %">
            <button class="btn ghost small" type="submit" title="添加类别" aria-label="添加类别">＋</button>
          </div>
          <button class="btn primary block" type="submit">保存类别设置</button>
        </form>
      </section>

      <p class="footnote">占比按当前市值计算；无持仓的基金不计入配置分母。</p>`
      }
    </main>`;
}
