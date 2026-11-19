/**
 * 宏观数据源：东方财富公开接口（与 quote.js 一致，支持 CORS，静态页面直连）。
 * 行情批量走 ulist 接口；历史序列走 K 线接口；股债性价比基于沪深300 PE-TTM
 * 与中国10年期国债收益率，分位窗口为近5年。
 *
 * 指标口径（界面均已标注）：
 * - 期限利差：东财全球债无 2Y 品种，用 10Y−5Y（美国 / 中国各一条）
 * - 美国实际利率：美国通胀预期无 CORS 接口，用 US10Y − WTI 同比 近似
 * - 信用利差：中债企业债收益率曲线无免费公开接口，以中美10年期国债利差作为跨境利差参考
 *
 * 数据源兜底链路（任一层失败自动降级到下一层）：
 * 1. 东财 push2 主域 → 镜像域名轮询（push2delay / 90.push2 等）
 * 2. 同接口 JSONP 桥接（push2 支持 cb 参数，绕过 fetch/CORS 拦截）
 * 3. 天天基金接口代理基金补日涨跌：fundmobapi 批量净值（CORS）→ fundgz 估值 JSONP 逐只补漏
 *    —— 仅黄金/原油/沪深300 有场外代理基金；收益率与 PE 无代理，降级显示「—」
 */

const TIMEOUT_MS = 10000;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟内存缓存
const HISTORY_YEARS = 5;
const OIL_HISTORY_DAYS = 400; // 取 1 年多一点的 WTI 日K，保证能找到 365 天前的锚点

const MACO_SECIDS = '171.US10Y,171.US05Y,100.UDI,171.CN10Y,171.CN05Y,101.GC00Y,102.CL00Y,1.000300';
const CSI300_SECID = '1.000300';

// 东财行情镜像域名（主域不可用时轮询）
const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://90.push2.eastmoney.com'
];
const KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://90.push2his.eastmoney.com',
  'https://25.push2his.eastmoney.com'
];

// 天天基金代理基金：宏观标的 → 可观测该标的的场外基金
const PROXY_FUNDS = {
  GC00Y: '000217',  // 华安黄金ETF联接C → COMEX 黄金
  CL00Y: '501018',  // 南方原油A → NYMEX 原油
  '000300': '000961' // 天弘沪深300ETF联接A → 沪深300
};

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

let jsonpSeq = 0;

/** JSONP 桥接：注入 <script> 读取 cb 回调数据，绕过 fetch/CORS 拦截 */
function fetchJsonp(url, timeout = TIMEOUT_MS) {
  const cbName = `cbMacro${Date.now().toString(36)}${jsonpSeq++}`;
  const src = `${url}${url.includes('?') ? '&' : '?'}cb=${cbName}`;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP 请求超时'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP 加载失败'));
    };
    script.src = src;
    document.head.appendChild(script);
  });
}

function buildUrl(host, path, params, extra = {}) {
  const query = new URLSearchParams({ ...params, ...extra });
  return `${host}${path}?${query.toString()}`;
}

/**
 * 兜底请求：依次尝试镜像域名 fetch，全部失败后用 JSONP 桥接重试一轮。
 */
async function fetchJsonFallback(hosts, path, params) {
  let lastError = null;
  for (const host of hosts) {
    try {
      return await fetchJson(buildUrl(host, path, params));
    } catch (error) {
      lastError = error;
    }
  }
  for (const host of hosts) {
    try {
      return await fetchJsonp(buildUrl(host, path, params, { cb: 'cbMacro' }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('全部数据源不可用');
}

/** 批量行情：一次请求取全部宏观标的（价格 + 日涨跌幅） */
export async function fetchMacroQuotes() {
  const payload = await fetchJsonFallback(QUOTE_HOSTS, '/api/qt/ulist.np/get', {
    secids: MACO_SECIDS,
    fltt: '2',
    fields: 'f2,f3,f12,f14'
  });
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
  const payload = await fetchJsonFallback(QUOTE_HOSTS, '/api/qt/stock/get', {
    secid: CSI300_SECID,
    fltt: '2',
    fields: 'f43,f58,f115'
  });
  const data = (payload && payload.data) || {};
  const pe = Number(data.f115);
  return Number.isFinite(pe) && pe > 0 ? pe : 0;
}

/** 日K收盘序列：[{date:'YYYY-MM-DD', close:Number}] */
export async function fetchKlineClose(secid, begDate) {
  const payload = await fetchJsonFallback(KLINE_HOSTS, '/api/qt/stock/kline/get', {
    secid,
    klt: '101',
    fqt: '0',
    fields1: 'f1,f2',
    fields2: 'f51,f53',
    beg: begDate,
    end: '20500101'
  });
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

/** 天天基金估值 JSONP：回调名固定为 jsonpgz，需串行调用 */
function fetchFundGz(code, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('天天基金估值请求超时'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      delete window.jsonpgz;
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window.jsonpgz = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('天天基金估值加载失败'));
    };
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js`;
    document.head.appendChild(script);
  });
}

/** 兜底层：天天基金代理行情，返回 目标标的代码 → { name, changePct, proxyFund } */
export async function fetchTiantianProxies() {
  const result = new Map();
  const targets = Object.entries(PROXY_FUNDS);

  // 层 3a：fundmobapi 批量净值/涨跌（CORS 可用，一次请求，与 quote.js 同源）
  try {
    const codes = targets.map(([, code]) => code).join(',');
    const payload = await fetchJson(
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?Fcodes=${codes}&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8`
    );
    const byCode = new Map(((payload && payload.Datas) || []).map((row) => [String(row.FCODE), row]));
    for (const [target, fundCode] of targets) {
      const row = byCode.get(fundCode);
      const changePct = Number(row && (row.NAVCHGRT ?? row.GSZZL));
      if (Number.isFinite(changePct)) {
        result.set(target, {
          name: String((row && row.SHORTNAME) || '').trim() || target,
          changePct,
          proxyFund: fundCode
        });
      }
    }
  } catch {
    // 批量失败走层 3b 逐只补漏
  }

  // 层 3b：fundgz 估值 JSONP 逐只补漏（回调名固定 jsonpgz，需串行）
  for (const [target, fundCode] of targets) {
    if (result.has(target)) continue;
    try {
      const data = await fetchFundGz(fundCode);
      const changePct = Number(data && data.gszzl);
      if (Number.isFinite(changePct)) {
        result.set(target, {
          name: String((data && data.name) || '').trim() || target,
          changePct,
          proxyFund: fundCode
        });
      }
    } catch {
      // 单只代理失败不阻断其余代理
    }
  }
  return result;
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

/**
 * 期限利差（bp）：长端收益率% − 短端收益率%，转 bp。
 * 任一输入非有限数返回 null。
 */
export function computeSpreadBp(longPct, shortPct) {
  if (!Number.isFinite(longPct) || !Number.isFinite(shortPct)) return null;
  return (longPct - shortPct) * 100;
}

/**
 * WTI 同比（%）：以「最后交易日 − 365 天」为锚点，取日期最接近的收盘价计算。
 * 样本不足 300 条或序列非法时返回 null。
 */
export function computeOilYoy(series) {
  const list = (series || []).filter((p) => p && Number.isFinite(p.close) && p.close > 0);
  if (list.length < 300) return null;
  const last = list[list.length - 1];
  const lastMs = Date.parse(last.date);
  if (!Number.isFinite(lastMs)) return null;
  const target = lastMs - 365 * 24 * 60 * 60 * 1000;

  let anchor = null;
  let bestDiff = Infinity;
  for (const point of list) {
    const diff = Math.abs(Date.parse(point.date) - target);
    if (Number.isFinite(diff) && diff < bestDiff) {
      bestDiff = diff;
      anchor = point;
    }
  }
  if (!anchor || anchor.close <= 0) return null;
  return (last.close / anchor.close - 1) * 100;
}

/**
 * 美国实际利率（%）：US10Y − 通胀代理（WTI 同比）。
 * 任一输入非有限数返回 null。口径为近似值，界面已标注。
 */
export function computeRealRate(us10yPct, inflationProxyPct) {
  if (!Number.isFinite(us10yPct) || !Number.isFinite(inflationProxyPct)) return null;
  return us10yPct - inflationProxyPct;
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

  // 兜底链路逐层降级，任何一层失败不阻断页面展示
  let quotes = new Map();
  let quotesFailed = false;
  try {
    quotes = await fetchMacroQuotes();
    quotesFailed = quotes.size === 0;
  } catch {
    quotesFailed = true;
  }

  let peNow = 0;
  try {
    peNow = await fetchCsi300Pe();
  } catch {
    peNow = 0; // PE 失败 → 股债性价比卡降级
  }

  // 兜底层：天天基金估值代理，仅对缺失的 黄金/原油/沪深300 补日涨跌（价格为 0，界面显示涨跌）
  let proxyUsed = false;
  const proxyTargets = Object.keys(PROXY_FUNDS).filter((code) => !quotes.has(code) || !(quotes.get(code).price > 0));
  if (quotesFailed || proxyTargets.length > 0) {
    const proxies = await fetchTiantianProxies();
    for (const target of proxyTargets) {
      const proxy = proxies.get(target);
      if (proxy && !quotes.has(target)) {
        quotes.set(target, {
          code: target,
          name: `${proxy.name}（代理）`,
          price: 0,
          changePct: proxy.changePct
        });
        proxyUsed = true;
      }
    }
  }

  const pick = (code) => quotes.get(code) || { code, name: '', price: 0, changePct: 0 };
  const us10y = pick('US10Y');
  const us05y = pick('US05Y');
  const dxy = pick('UDI');
  const cn10y = pick('CN10Y');
  const cn05y = pick('CN05Y');
  const gold = pick('GC00Y');
  const oil = pick('CL00Y');
  const csi300 = pick('000300');

  const data = {
    us10y: { ...us10y, unit: '%' },
    us05y: { ...us05y, unit: '%' },
    dxy,
    cn10y: { ...cn10y, unit: '%' },
    cn05y: { ...cn05y, unit: '%' },
    // 美债期限利差（bp）：US10Y − US05Y
    usTermSpreadBp: computeSpreadBp(us10y.price, us05y.price),
    // 中国期限利差（bp）：CN10Y − CN05Y
    cnTermSpreadBp: computeSpreadBp(cn10y.price, cn05y.price),
    // 中美10年期国债利差（bp）：中国10Y − 美国10Y
    cnUsSpreadBp: us10y.price > 0 && cn10y.price > 0 ? (cn10y.price - us10y.price) * 100 : null,
    gold,
    oil,
    csi300: { ...csi300, pe: peNow },
    // WTI 同比（%）与美国实际利率（%）：history=false 时为 null
    oilYoyPct: null,
    usRealRate: null,
    equityBond: null,
    // 降级标志（界面据此显示降级提示）
    quotesFailed,
    peMissing: !(peNow > 0),
    proxyUsed,
    historyMissing: false,
    updatedAt: Date.now()
  };

  if (history) {
    try {
      const beg = dateOffset(HISTORY_YEARS * 365);
      const oilBeg = dateOffset(OIL_HISTORY_DAYS);
      const [priceSeries, yieldSeries, oilSeries] = await Promise.all([
        fetchKlineClose(CSI300_SECID, beg),
        fetchKlineClose('171.CN10Y', beg),
        fetchKlineClose('102.CL00Y', oilBeg)
      ]);
      const yieldByDate = new Map(yieldSeries.map((p) => [p.date, p.close]));
      data.equityBond = computeEquityBond(priceSeries, yieldByDate, peNow, csi300.price || 0);
      // WTI 同比 + 美国实际利率（近似口径：US10Y − WTI同比）
      const oilYoy = computeOilYoy(oilSeries);
      data.oilYoyPct = oilYoy;
      data.usRealRate = oilYoy != null && us10y.price > 0 ? computeRealRate(us10y.price, oilYoy) : null;
    } catch {
      data.historyMissing = true; // 历史序列失败不阻断现价展示
    }
  }

  cache = { data, ts: Date.now() };
  return data;
}

export function clearMacroCache() {
  cache = null;
}
