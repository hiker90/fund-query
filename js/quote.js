/**
 * 净值数据源：东方财富公开接口（支持 CORS，可静态页面直接请求）。
 * 接口不可用时由界面降级为手动录入。
 */
const ENDPOINT = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';
const BASIC_INFO_ENDPOINT = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation';
const TIMEOUT_MS = 10000;

export function isFundCode(code) {
  return /^\d{6}$/.test(String(code || '').trim());
}

export async function fetchQuotes(codes, { timeout = TIMEOUT_MS } = {}) {
  const list = [...new Set((codes || []).map((code) => String(code || '').trim()))].filter(isFundCode);
  if (list.length === 0) throw new Error('没有可查询的基金代码');

  const query = new URLSearchParams({
    pageIndex: '1',
    pageSize: String(list.length),
    plat: 'Android',
    appType: 'ttjj',
    product: 'EFund',
    Version: '1',
    deviceid: '1',
    Fcodes: list.join(',')
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);

    const payload = await response.json();
    if (!payload || payload.Success === false) {
      throw new Error((payload && (payload.ErrMsg || payload.ErrorMsg)) || '接口返回异常');
    }

    const map = new Map();
    for (const item of Array.isArray(payload.Datas) ? payload.Datas : []) {
      const code = String(item.FCODE || '').trim();
      if (!code) continue;
      const nav = Number(item.NAV);
      map.set(code, {
        code,
        name: String(item.SHORTNAME || '').trim(),
        nav: Number.isFinite(nav) && nav > 0 ? nav : 0,
        navDate: String(item.PDATE || ''),
        changePct: Number(item.NAVCHGRT) || 0
      });
    }
    return map;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('请求超时，请检查网络');
    if (error instanceof TypeError) throw new Error('网络不可用或接口被拦截');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F10 基本信息：基金类型（FTYPE）与跟踪指数（INDEXCODE / INDEXNAME / INDEXTEXCH）。
 * 用于估值标签分流：
 * - FTYPE 以「指数型-股票」开头且 INDEXCODE 为 6 位数字、INDEXTEXCH ∈ {0,1} → 跟踪指数 K 线分位
 * - FTYPE「指数型-其他」且 INDEXCODE=AU9999 → 黄金价格分位
 * - FTYPE 含「债券」→ 中债10Y收益率分位取反
 * - 主动/行业/QDII 基金 → 不展示估值标签
 * 失败返回 null（静默降级：不显示标签，缓存期内不重试）。
 */
export async function fetchFundBasicInfo(code, { timeout = TIMEOUT_MS } = {}) {
  if (!isFundCode(code)) return null;

  const query = new URLSearchParams({
    FCODE: String(code).trim(),
    deviceid: 'Wap',
    plat: 'Wap',
    product: 'EFund',
    version: '6.2.8'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${BASIC_INFO_ENDPOINT}?${query.toString()}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const data = payload && payload.Datas;
    if (!data) return null;
    return {
      ftype: String(data.FTYPE || ''),
      indexCode: String(data.INDEXCODE || ''),
      indexName: String(data.INDEXNAME || ''),
      indexExchange: String(data.INDEXTEXCH || '')
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
