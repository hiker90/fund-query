/**
 * 净值数据源：东方财富公开接口（支持 CORS，可静态页面直接请求）。
 * 接口不可用时由界面降级为手动录入。
 */
const ENDPOINT = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';
const HIS_NET_ENDPOINT = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList';
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
 * 拉取单只基金近一年（约 260 条）单位净值历史，用于估值水平分位。
 * 返回 [{ date: 'YYYY-MM-DD', nav: Number }]（按日期倒序，接口原始顺序），失败返回 null。
 * 历史仅存内存缓存（app.js 层），禁止写入 localStorage。
 */
export async function fetchValuationHistory(code, { timeout = TIMEOUT_MS, pageSize = 260 } = {}) {
  if (!isFundCode(code)) return null;

  const query = new URLSearchParams({
    FCODE: String(code).trim(),
    PLEVEL: '1',
    pageIndex: '1',
    pageSize: String(pageSize),
    deviceid: 'Wap',
    plat: 'Wap',
    product: 'EFund',
    version: '6.2.8'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${HIS_NET_ENDPOINT}?${query.toString()}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const rows = Array.isArray(payload && payload.Datas) ? payload.Datas : [];
    const list = rows
      .map((row) => ({ date: String((row && row.FSRQ) || ''), nav: Number(row && row.DWJZ) }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isFinite(item.nav) && item.nav > 0);
    return list.length > 0 ? list : null;
  } catch {
    return null; // 失败静默降级：不显示估值标签，也不重试
  } finally {
    clearTimeout(timer);
  }
}
