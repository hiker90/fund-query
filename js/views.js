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
import { simulateAdd, computeAllocation, parseBatchText } from './strategy.js';

const STATUS_META = {
  normal: { label: '运行中', tone: 'ok', rank: 5 },
  nearStop: { label: '接近止损', tone: 'warn', rank: 4 },
  add: { label: '可补仓', tone: 'accent', rank: 3 },
  takeProfit: { label: '触发止盈', tone: 'accent', rank: 2 },
  trailing: { label: '移动止盈', tone: 'warn', rank: 1 },
  stop: { label: '触发止损', tone: 'danger', rank: 0 }
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.normal;
}

const HOLDINGS_FILTERS = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'add', label: '可补仓', match: (m) => m.status === 'add' },
  {
    key: 'take',
    label: '止盈',
    match: (m) => m.status === 'takeProfit' || m.status === 'trailing'
  },
  {
    key: 'stop',
    label: '止损',
    match: (m) => m.status === 'stop' || m.status === 'nearStop'
  },
  { key: 'normal', label: '运行中', match: (m) => m.status === 'normal' }
];

function badge(metrics) {
  const meta = statusMeta(metrics.status);
  return `<span class="badge badge-${meta.tone}">${esc(meta.label)}</span>`;
}

function navMarkerPosition(metrics) {
  if (!metrics.avgCost || !metrics.nav) return 50;
  const low = metrics.stopLossNav * 0.98;
  const high = metrics.takeProfitNav * 1.02;
  if (high <= low) return 50;
  return Math.min(100, Math.max(0, ((metrics.nav - low) / (high - low)) * 100));
}

function ruleTrack(metrics) {
  if (!metrics.avgCost) return '';
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

function fundCard(metrics) {
  const { fund } = metrics;
  const hasPosition = metrics.avgCost > 0;
  const pnlPct = hasPosition ? metrics.holdingPnlPct : 0;
  return `
    <article class="fund-card" data-action="open-fund" data-id="${esc(fund.id)}" tabindex="0">
      <div class="fund-card-top">
        <div class="fund-title">
          <h3>${esc(fund.name || fund.code)}</h3>
          <span class="fund-code">${esc(fund.code)}</span>
        </div>
        ${badge(metrics)}
      </div>
      <div class="fund-nav">
        <strong class="num">${fmtNav(metrics.nav)}</strong>
        <span class="muted">净值 ${fmtDate(fund.navDate)}</span>
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
      <p class="fund-hint${metrics.triggeredTiers.length ? ' is-alert' : ''}">${esc(nextTierHint(metrics))}</p>
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

export function holdingsPage(state, metricsMap, { refreshing = false, filter = 'all' } = {}) {
  const metricsList = state.funds
    .map((fund) => metricsMap.get(fund.id))
    .filter(Boolean)
    .sort((a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank);

  let cost = 0;
  let value = 0;
  let updatedAt = 0;
  metricsList.forEach((metrics) => {
    cost += metrics.position.cost;
    value += metrics.marketValue;
    updatedAt = Math.max(updatedAt, num(metrics.fund.navUpdatedAt));
  });
  const pnl = value - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '尚未刷新';

  const activeFilter = HOLDINGS_FILTERS.find((f) => f.key === filter) || HOLDINGS_FILTERS[0];
  const filteredList = metricsList.filter(activeFilter.match);
  const filterTabs = HOLDINGS_FILTERS.map((f) => {
    const count = metricsList.filter(f.match).length;
    return `
      <button class="filter-tab${f.key === activeFilter.key ? ' is-active' : ''}" type="button"
        data-action="filter-holdings" data-filter="${f.key}">
        ${esc(f.label)}${count ? ` <em>${count}</em>` : ''}
      </button>`;
  }).join('');

  const filterBar = metricsList.length
    ? `<div class="filter-tabs" role="tablist" aria-label="按状态筛选基金">${filterTabs}</div>`
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
        <p class="hero-note">${metricsList.length} 只基金 · 净值更新 ${esc(updatedLabel)}</p>
      </section>

      ${filterBar}
      ${
        filteredList.length
          ? `<section class="fund-list">${filteredList.map(fundCard).join('')}</section>`
          : metricsList.length
            ? `<div class="empty-state compact"><p>「${esc(activeFilter.label)}」状态下暂无基金</p></div>`
            : emptyState()
      }
      <p class="footnote">数据仅保存在本机浏览器，不构成投资建议。</p>
    </main>
    <button class="fab" type="button" data-action="add-fund" aria-label="添加基金">＋</button>`;
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
  if (!metrics.avgCost) return '';
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
  const defaultAmount = metrics.nextTier ? metrics.nextTier.amount : metrics.strategy.addTiers[0]?.amount || 1200;
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
  return `
    <div class="sim-grid">
      <div><span>补仓后成本</span><b class="num">${fmtNav(result.newAvgCost)}</b></div>
      <div><span>成本变化</span><b class="num ${toneClass(result.costChangePct)}">${fmtPct(result.costChangePct)}</b></div>
      <div><span>新止损线</span><b class="num">${fmtNav(result.newStopLossNav)}</b></div>
      <div><span>新止盈线</span><b class="num">${fmtNav(result.newTakeProfitNav)}</b></div>
    </div>
    <p class="sim-note">补仓后回本需 ${fmtPct(result.breakevenPct)}；止损止盈已按新成本重算（-${strategy.stopLossPct}% / +${strategy.takeProfitPct}%）。</p>`;
}

function addBatchesCard(metrics) {
  if (!metrics.addBatches.length) return '';
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
                : `<span class="muted small-text">目标 +${metrics.strategy.addPositionSellPct}%</span>`
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
        <button class="btn ghost" type="button" data-action="override" data-fund="${esc(fund.id)}">策略覆盖</button>
        <button class="btn ghost" type="button" data-action="reset-tiers" data-fund="${esc(fund.id)}">重置补仓档位</button>
        <button class="btn ghost danger-text" type="button" data-action="delete-fund" data-fund="${esc(fund.id)}">删除基金</button>
      </div>
    </section>`;
}

export function detailPage(metrics) {
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

      ${ruleLadder(metrics)}
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

export function tierRows(tiers) {
  return (tiers || [])
    .map(
      (tier) => `
      <div class="tier-row">
        <label class="field">
          <span>跌幅 %</span>
          <input type="text" name="tierDrop" inputmode="decimal" value="${esc(tier.dropPct)}" autocomplete="off">
        </label>
        <label class="field">
          <span>金额（元）</span>
          <input type="text" name="tierAmount" inputmode="decimal" value="${esc(tier.amount)}" autocomplete="off">
        </label>
        <button class="icon-btn small" type="button" data-action="remove-tier" aria-label="删除该档">✕</button>
      </div>`
    )
    .join('');
}

export function strategyPage(state) {
  const strategy = state.settings.defaultStrategy;
  return `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <p class="eyebrow">全局模板</p>
          <h1>交易策略</h1>
        </div>
      </div>
    </header>
    <main class="page">
      <form class="form" data-form="strategy">
        <section class="card">
          <h2 class="card-title">止盈止损</h2>
          <p class="card-sub">止损与止盈以平均成本为锚，分档补仓以底仓成本为锚</p>
          <div class="field-grid">
            ${field({ label: '止损比例（%）', name: 'stopLossPct', value: strategy.stopLossPct })}
            ${field({ label: '止盈比例（%）', name: 'takeProfitPct', value: strategy.takeProfitPct })}
            ${field({ label: '第一层止盈卖出（%）', name: 'takeProfitSellRatio', value: strategy.takeProfitSellRatio })}
            ${field({ label: '移动止盈回撤（%）', name: 'trailingStopPct', value: strategy.trailingStopPct })}
          </div>
          <p class="hint-line">达到止盈线先卖出 ${strategy.takeProfitSellRatio}%，剩余仓位按最高浮盈回撤 ${strategy.trailingStopPct}% 移动止盈。</p>
        </section>

        <section class="card">
          <h2 class="card-title">分档补仓</h2>
          <p class="card-sub">跌幅按档递增，金额逐档放大，保留最终储备</p>
          <div class="tier-editor" id="strategy-tiers">${tierRows(strategy.addTiers)}</div>
          <button class="btn ghost small" type="button" data-action="add-tier" data-target="#strategy-tiers">＋ 添加档位</button>
        </section>

        <section class="card">
          <h2 class="card-title">资金与了结</h2>
          <div class="field-grid">
            ${field({ label: '最终储备（元）', name: 'reserveAmount', value: strategy.reserveAmount })}
            ${field({ label: '储备启用跌幅（%）', name: 'reserveTriggerPct', value: strategy.reserveTriggerPct })}
            ${field({ label: '补仓独立了结收益（%）', name: 'addPositionSellPct', value: strategy.addPositionSellPct })}
          </div>
          <p class="hint-line">储备金不自动触发，仅在深度回撤时人工决定；补仓份额达到目标收益可优先单独卖出。</p>
        </section>

        <button class="btn primary block" type="submit">保存策略模板</button>
      </form>

      <section class="card notes">
        <h2 class="card-title">策略说明</h2>
        <ul class="notes-list">
          <li><b>先判断该不该补：</b>基金经理变更、策略漂移、规模接近清盘或指数规则重大调整时，不动用补仓资金。</li>
          <li><b>分档而不是频繁小补：</b>每 5% 一档，金额递增，避免资金堆在半山腰。</li>
          <li><b>补仓后必须换锚：</b>止损线与止盈线按新的平均成本重算，而不是继续套用首次买入价。</li>
          <li><b>移动止盈只跟最高点：</b>回撤阈值不随成本变化，但仓位变重后绝对盈亏会放大。</li>
          <li><b>补仓可独立了结：</b>低位筹码反弹达标后先卖出，回收资金回到储备池。</li>
        </ul>
      </section>
    </main>`;
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

  // 1. 美债与美元
  const us = chg(data.us10y, '%');
  const dx = chg(data.dxy, '%');
  const cardUs = `
    <section class="card macro-card grad-blue">
      <h2 class="card-title">美债与美元</h2>
      ${macroMetricRow('美国10年期国债收益率', data.us10y.price > 0 ? `${data.us10y.price.toFixed(2)}%` : '—', us.text, us.cls)}
      ${macroMetricRow('美元指数', data.dxy.price > 0 ? data.dxy.price.toFixed(2) : '—', dx.text, dx.cls)}
    </section>`;

  // 2. 中国国债与利差
  const cn = chg(data.cn10y, '%');
  let spreadText = '—';
  let spreadCls = '';
  if (Number.isFinite(data.cnUsSpreadBp)) {
    spreadText = `${data.cnUsSpreadBp > 0 ? '+' : ''}${Math.round(data.cnUsSpreadBp)} bp`;
    spreadCls = data.cnUsSpreadBp >= 0 ? 'up' : 'down';
  }
  const cardCn = `
    <section class="card macro-card grad-teal">
      <h2 class="card-title">中国国债与利差</h2>
      ${macroMetricRow('中国10年期国债收益率', data.cn10y.price > 0 ? `${data.cn10y.price.toFixed(2)}%` : '—', cn.text, cn.cls)}
      ${macroMetricRow('中美10年期利差（参考）', spreadText, '', spreadCls)}
      <p class="macro-note">中债企业债信用利差暂无免费公开数据源，以中美10年期国债利差作为跨境利差参考。</p>
    </section>`;

  // 3. 股债性价比
  const eb = data.equityBond;
  let cardEb;
  if (eb) {
    cardEb = `
    <section class="card macro-card grad-violet">
      <h2 class="card-title">股债性价比（沪深300）</h2>
      ${macroMetricRow('盈利收益率（1/PE）', `${eb.earningsYield.toFixed(2)}%`)}
      ${macroMetricRow('PE-TTM', data.csi300.pe > 0 ? data.csi300.pe.toFixed(1) : '—')}
      ${macroMetricRow('股债收益比', eb.ratio.toFixed(2))}
      ${macroMetricRow('风险溢价 ERP', `${eb.erp >= 0 ? '+' : ''}${eb.erp.toFixed(2)}%`)}
      ${percentileBarHtml(eb.ratioPercentile, '股债收益比 5 年分位')}
      <p class="macro-note">分位基于近 5 年日频数据（样本 ${eb.sampleSize} 个），盈利收益率采用当前盈利近似估算。</p>
    </section>`;
  } else {
    cardEb = `
    <section class="card macro-card grad-violet">
      <h2 class="card-title">股债性价比（沪深300）</h2>
      <p class="muted">历史序列暂不可用，请稍后刷新重试。</p>
    </section>`;
  }

  // 4. 大宗商品
  const gd = chg(data.gold, '%');
  const ol = chg(data.oil, '%');
  const cardCm = `
    <section class="card macro-card grad-gold">
      <h2 class="card-title">大宗商品</h2>
      ${macroMetricRow('COMEX 黄金', data.gold.price > 0 ? `$${data.gold.price.toFixed(1)}` : '—', gd.text, gd.cls)}
      ${macroMetricRow('NYMEX 原油', data.oil.price > 0 ? `$${data.oil.price.toFixed(2)}` : '—', ol.text, ol.cls)}
    </section>`;

  const updated = new Date(data.updatedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `
    ${macroPageHead(refreshing)}
    <main class="page">
      ${cardUs}
      ${cardCn}
      ${cardEb}
      ${cardCm}
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
      <div class="segmented" data-toggle="base-mode">
        <label><input type="radio" name="baseMode" value="trade"><span>成交金额 + 净值</span></label>
        <label><input type="radio" name="baseMode" value="pnl" checked><span>市值 + 收益率</span></label>
      </div>

      <div data-base-panel="trade" hidden>
        <div class="field-grid">
          ${field({ label: '买入金额（元）', name: 'amount', placeholder: '10000' })}
          ${field({ label: '成交净值', name: 'buyNav', placeholder: '1.0000' })}
        </div>
      </div>
      <div data-base-panel="pnl">
        <div class="field-grid">
          ${field({ label: '当前持仓市值（元）', name: 'holdingAmount', placeholder: '10500' })}
          ${field({ label: '持仓收益率（%）', name: 'returnPct', placeholder: '5', hint: '正数=盈利，负数=亏损' })}
        </div>
        <p class="hint-line" id="base-derive-hint" hidden>
          反推结果：成本 <b id="derived-cost">—</b> 元 · 份额 <b id="derived-shares">—</b> 份 · 成本净值 <b id="derived-nav">—</b>
        </p>
      </div>

      <div class="field-grid">
        ${field({ label: '买入日期', name: 'buyDate', value: today, type: 'date', inputmode: 'none' })}
        ${field({ label: '手续费（元）', name: 'fee', placeholder: '0' })}
      </div>

      <button class="btn primary block" type="submit">保存并开始监控</button>
    </form>`;
}

export function tradeSheetBody(fund, metrics, preset = {}) {
  const isSell = preset.type === 'SELL';
  const today = todayISO();
  const nav = preset.nav || metrics.nav || 0;
  const defaultAmount =
    preset.amount || (isSell ? Math.round(metrics.marketValue || 0) : '');
  const lockedSource = Number.isInteger(preset.tierIndex);

  return `
    <form class="form" data-form="add-trade" data-fund="${esc(fund.id)}">
      ${
        lockedSource || isSell
          ? `<input type="hidden" name="source" value="${esc(preset.source || 'BASE')}">`
          : `<label class="field">
              <span>买入性质</span>
              <select name="source">
                <option value="BASE" selected>底仓买入（计入档位锚）</option>
                <option value="ADD">补仓买入（可独立了结）</option>
              </select>
            </label>`
      }
      <input type="hidden" name="tierIndex" value="${Number.isInteger(preset.tierIndex) ? preset.tierIndex : ''}">
      <input type="hidden" name="batchId" value="${esc(preset.batchId || '')}">
      <div class="segmented">
        <label><input type="radio" name="type" value="BUY" ${isSell ? '' : 'checked'}><span>买入 / 补仓</span></label>
        <label><input type="radio" name="type" value="SELL" ${isSell ? 'checked' : ''}><span>卖出</span></label>
      </div>
      <div class="field-grid">
        ${field({ label: '成交日期', name: 'date', value: preset.date || today, type: 'date', inputmode: 'none' })}
        ${field({ label: '成交净值', name: 'nav', value: nav ? nav.toFixed(4) : '', placeholder: '0.0000' })}
      </div>
      <div class="field-grid">
        ${field({ label: '金额（元）', name: 'amount', value: defaultAmount, placeholder: '0.00' })}
        ${field({ label: '份额（可选）', name: 'shares', value: preset.shares || '', placeholder: '留空自动计算' })}
      </div>
      ${field({ label: '手续费（元）', name: 'fee', value: '', placeholder: '0' })}
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

export function overrideSheetBody(fund, effective) {
  const override = fund.strategyOverride || {};
  const overrideValue = (key) => (override[key] === undefined ? '' : override[key]);
  const placeholder = (key) => String(effective[key]);
  const tiers = Array.isArray(override.addTiers) ? override.addTiers : effective.addTiers;
  const tierOverrideEnabled = Array.isArray(override.addTiers);

  return `
    <form class="form" data-form="override" data-fund="${esc(fund.id)}">
      <p class="hint-line">留空表示继承全局模板。填写后将只覆盖该基金的对应参数。</p>
      <div class="field-grid">
        ${field({ label: '止损比例（%）', name: 'stopLossPct', value: overrideValue('stopLossPct'), placeholder: placeholder('stopLossPct') })}
        ${field({ label: '止盈比例（%）', name: 'takeProfitPct', value: overrideValue('takeProfitPct'), placeholder: placeholder('takeProfitPct') })}
        ${field({ label: '第一层止盈卖出（%）', name: 'takeProfitSellRatio', value: overrideValue('takeProfitSellRatio'), placeholder: placeholder('takeProfitSellRatio') })}
        ${field({ label: '移动止盈回撤（%）', name: 'trailingStopPct', value: overrideValue('trailingStopPct'), placeholder: placeholder('trailingStopPct') })}
        ${field({ label: '补仓独立了结收益（%）', name: 'addPositionSellPct', value: overrideValue('addPositionSellPct'), placeholder: placeholder('addPositionSellPct') })}
        ${field({ label: '最终储备（元）', name: 'reserveAmount', value: overrideValue('reserveAmount'), placeholder: placeholder('reserveAmount') })}
      </div>

      <label class="switch-row">
        <span>
          <b>独立补仓档位</b>
          <small>关闭时沿用全局模板的档位与金额</small>
        </span>
        <input type="checkbox" name="enableTiers" ${tierOverrideEnabled ? 'checked' : ''}>
      </label>
      <div class="tier-editor" id="override-tiers">${tierRows(tiers)}</div>
      <button class="btn ghost small" type="button" data-action="add-tier" data-target="#override-tiers">＋ 添加档位</button>

      <button class="btn primary block" type="submit">保存覆盖</button>
      <button class="btn ghost block danger-text" type="button" data-action="clear-override" data-fund="${esc(fund.id)}">恢复跟随全局模板</button>
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

export function allocationPage(state, metricsMap, expandedCats = new Set()) {
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
      <section class="hero-card">
        <p class="hero-label">总资产市值</p>
        <strong class="hero-value num">¥ ${fmtMoney(alloc.totalMarketValue)}</strong>
        <div class="hero-chips">
          <div>
            <span>已配置目标合计</span>
            <b class="num ${targetTone}">${fmtPct(alloc.configuredTargetTotal, { signed: false })}</b>
          </div>
          <div>
            <span>未分类</span>
            <b class="num">${fmtPct(alloc.uncategorizedPct, { signed: false })}</b>
          </div>
        </div>
        <p class="hero-note">${esc(heroStatus)}</p>
      </section>

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

      <p class="footnote">占比按当前市值计算；无持仓的基金不计入配置分母。</p>
    </main>`;
}
