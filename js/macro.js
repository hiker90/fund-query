/**
 * 宏观数据源：东方财富公开接口（与 quote.js 一致，支持 CORS，静态页面直连）。
 * 行情批量走 ulist 接口；历史序列走 K 线接口；股债性价比基于沪深300 PE-TTM
 * 与中国10年期国债收益率，分位窗口为近5年。
 *
 * 信用利差说明：中债企业债收益率曲线无免费公开接口，此处以
 * 「中美10年期国债利差」作为跨境利差参考指标，界面已标注。
 */

const TIMEOUT_MS = 10000;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟内存缓存
const HISTORY_YEARS = 5;

const MACO_SECIDS = '171.US10Y,100.UDI,171.CN10Y,101.GC00Y,102.CL00Y,1.000300';
const CSI300_SECID = '1.000300';

let cache = null; // { data, ts }

function beginAbort(timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return { controller, done: () => clearTimeout(timer) };
}

async function fetchJson(url, timeout = TIMEOUT_MS) {
  const { controller, done } = beginAbort(timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('请求超时，请检查网络');
    if (error instanceof TypeError) throw new Error('网络不可用或接口被拦截');
    throw error;
  } finally {
    done();
  }
}

/** 批量行情：一次请求取全部宏观标的（价格 + 日涨跌幅） */
export async function fetchMacroQuotes() {
  const query = new URLSearchParams({
    secids: MACO_SECIDS,
    fltt: '2',
    fields: 'f2,f3,f12,f14'
  });
  const payload = await fetchJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?${query.toString()}`);
  const diff = (payload && payload.data && payload.data.diff) || [];
  const map = new Map();
  for (const row of diff) {
    if (!row || !row.f12) continue;
    const price = Number(row.f2);
    map.set(String(row.f12), {
      code: String(row.f12),
      name: String(row.f14 || '').trim(),
      price: Number.isFinite(price) ? price : 0,
      changePct: Number(row.f3) || 0
    });
  }
  return map;
}

/** 沪深300 当前 PE-TTM（指数行情 f115 字段） */
async function fetchCsi300Pe() {
  const query = new URLSearchParams({
    secid: CSI300_SECID,
    fltt: '2',
    fields: 'f43,f58,f115'
  });
  const payload = await fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?${query.toString()}`);
  const data = (payload && payload.data) || {};
  const pe = Number(data.f115);
  return Number.isFinite(pe) && pe > 0 ? pe : 0;
}

/** 日K收盘序列：[{date:'YYYY-MM-DD', close:Number}] */
export async function fetchKlineClose(secid, begDate) {
  const query = new URLSearchParams({
    secid,
    klt: '101',
    fqt: '0',
    fields1: 'f1,f2',
    fields2: 'f51,f53',
    beg: begDate,
    end: '20500101'
  });
  const payload = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${query.toString()}`);
  const klines = (payload && payload.data && payload.data.klines) || [];
  const series = [];
  for (const line of klines) {
    const parts = String(line).split(',');
    if (parts.length < 2) continue;
    const close = Number(parts[1]);
    if (!Number.isFinite(close) || close <= 0) continue;
    series.push({ date: parts[0], close });
  }
  return series;
}

/**
 * 历史分位：当前值在序列中的分位（0-100）。
 * percent = 严格小于当前值的样本数 / (N-1) × 100
 */
export function computePercentile(values, current) {
  const list = (values || []).filter((v) => Number.isFinite(v));
  if (!Number.isFinite(current) || list.length < 2) return null;
  const below = list.filter((v) => v < current).length;
  return (below / (list.length - 1)) * 100;
}

/**
 * 股债性价比（股债收益比 + 风险溢价 ERP + 5年分位）。
 * 盈利收益率_t ≈ EPS_now / price_t（常数盈利近似，界面上已标注）；
 * 股债收益比 = 盈利收益率 / 国债收益率；ERP = 盈利收益率 − 国债收益率。
 *
 * @param {Array<{date:string, close:number}>} priceSeries 沪深300收盘序列
 * @param {Map<string, number>} yieldByDate 中国10Y收益率（%）按日期
 * @param {number} peNow 沪深300当前 PE-TTM
 * @param {number} priceNow 沪深300当前收盘
 */
export function computeEquityBond(priceSeries, yieldByDate, peNow, priceNow) {
  if (!(peNow > 0) || !(priceNow > 0) || !Array.isArray(priceSeries) || !(yieldByDate instanceof Map)) {
    return null;
  }
  const epsNow = priceNow / peNow;
  const history = [];
  for (const point of priceSeries) {
    const yieldPct = yieldByDate.get(point.date);
    if (!Number.isFinite(yieldPct) || yieldPct <= 0) continue;
    const earningsYield = epsNow / point.close;
    history.push({
      date: point.date,
      ratio: earningsYield / (yieldPct / 100),
      erp: earningsYield - yieldPct / 100
    });
  }
  if (history.length < 50) return null;

  const latest = history[history.length - 1];
  const ratioValues = history.map((h) => h.ratio);
  const erpValues = history.map((h) => h.erp);

  return {
    spanStart: history[0].date,
    spanEnd: latest.date,
    spanYears: HISTORY_YEARS,
    earningsYield: (epsNow / priceNow) * 100,
    ratio: latest.ratio,
    erp: latest.erp * 100,
    ratioPercentile: computePercentile(ratioValues, latest.ratio),
    erpPercentile: computePercentile(erpValues, latest.erp),
    sampleSize: history.length
  };
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}

/**
 * 拉取全部宏观观察数据（带 5 分钟内存缓存）。
 * @param {{force?: boolean, history?: boolean}} opts history=false 时跳过历史序列（仅刷新现价）
 */
export async function fetchMacroData({ force = false, history = true } = {}) {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  const [quotes, peNow] = await Promise.all([fetchMacroQuotes(), fetchCsi300Pe()]);

  const pick = (code) => quotes.get(code) || { code, name: '', price: 0, changePct: 0 };
  const us10y = pick('US10Y');
  const dxy = pick('UDI');
  const cn10y = pick('CN10Y');
  const gold = pick('GC00Y');
  const oil = pick('CL00Y');
  const csi300 = pick('000300');

  const data = {
    us10y: { ...us10y, unit: '%' },
    dxy,
    cn10y: { ...cn10y, unit: '%' },
    // 中美10年期国债利差（bp）：中国10Y − 美国10Y
    cnUsSpreadBp: us10y.price > 0 && cn10y.price > 0 ? (cn10y.price - us10y.price) * 100 : null,
    gold,
    oil,
    csi300: { ...csi300, pe: peNow },
    equityBond: null,
    updatedAt: Date.now()
  };

  if (history) {
    try {
      const beg = dateOffset(HISTORY_YEARS * 365);
      const [priceSeries, yieldSeries] = await Promise.all([
        fetchKlineClose(CSI300_SECID, beg),
        fetchKlineClose('171.CN10Y', beg)
      ]);
      const yieldByDate = new Map(yieldSeries.map((p) => [p.date, p.close]));
      data.equityBond = computeEquityBond(priceSeries, yieldByDate, peNow, csi300.price || 0);
    } catch {
      data.equityBond = null; // 历史序列失败不阻断现价展示
    }
  }

  cache = { data, ts: Date.now() };
  return data;
}

export function clearMacroCache() {
  cache = null;
}
