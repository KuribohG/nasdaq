export const GROUPS = {
  nasdaq100: '纳斯达克100', sp500: '标普500', sp500_equal: '标普500等权重',
  nasdaq_tech: '纳斯达克科技', nasdaq_bio: '纳斯达克生物科技', nasdaq_other: '其他纳斯达克相关',
};
export const PURCHASE = { open: '开放申购', limited: '限额申购', paused: '暂停申购', unknown: '待核验', not_applicable: '场内 ETF', not_sold: '未代销' };
export const SIP = { available: '支持定投', paused: '暂停定投', unsupported: '不支持定投', unknown: '待核验', not_applicable: '不适用', not_sold: '未代销' };
export const FIELD_NAMES = { purchase_status: '申购状态', purchase_limit: '日累计申购限额', purchase_min: '申购起点', sip_status: '定投状态', sip_min: '定投起点', sip_limit: '定投上限' };
export const DEFAULT_FILTERS = { query: '', group: 'core', company: '', currency: 'CNY', venue: 'otc', share: '', status: '', sort: 'default' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatMoney(money, fund = {}, withUnit = true) {
  if (fund.venue === 'exchange') return '不适用';
  if (!money || money.kind === 'unknown') return '未披露';
  if (money.kind === 'unlimited') return '无限额';
  if (fund.currency === 'USD' && !fund.quota_currency_verified) return money.raw || '币种待核验';
  const value = Number(money.value);
  const amount = value >= 100000000 ? `${(value / 100000000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}亿` : value >= 10000 ? `${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}万` : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return amount + (withUnit ? (fund.currency === 'USD' ? ' 美元' : ' 元') : '');
}

export function isStale(fund, now = Date.now(), hours = 12) {
  return fund.health !== 'ok' || !fund.checked_at || now - Date.parse(fund.checked_at) > hours * 3600000;
}

export function filterFunds(funds, filters, favorites = new Set(), view = 'funds') {
  const q = filters.query.trim().toLowerCase();
  const selected = funds.filter(fund => {
    if (view === 'favorites' && !favorites.has(fund.code)) return false;
    if (q && !`${fund.name} ${fund.code} ${fund.company}`.toLowerCase().includes(q)) return false;
    if (filters.group === 'core' && !['nasdaq100', 'sp500'].includes(fund.group)) return false;
    if (filters.group === 'other' && ['nasdaq100', 'sp500'].includes(fund.group)) return false;
    if (!['core', 'all', 'other'].includes(filters.group) && fund.group !== filters.group) return false;
    if (filters.company && fund.company !== filters.company) return false;
    if (filters.currency && fund.currency !== filters.currency) return false;
    if (filters.venue && fund.venue !== filters.venue) return false;
    if (filters.share && fund.share_class !== filters.share) return false;
    if (filters.status === 'sip' && (fund.sip_status !== 'available' || isStale(fund))) return false;
    if (filters.status === 'buy' && (!['open', 'limited'].includes(fund.purchase_status) || isStale(fund))) return false;
    if (filters.status === 'paused' && fund.purchase_status !== 'paused') return false;
    if (filters.status === 'stale' && !isStale(fund)) return false;
    if (filters.status === 'not_sold' && fund.purchase_status !== 'not_sold') return false;
    return true;
  });
  return selected.sort((a, b) => {
    if (filters.sort === 'company') return a.company.localeCompare(b.company, 'zh-CN') || a.code.localeCompare(b.code);
    if (filters.sort.startsWith('limit')) {
      // Unknowns and inapplicable values always come last; USD values are not mixed with RMB.
      const val = f => f.venue === 'exchange' || !f.quota_currency_verified || !['amount', 'unlimited'].includes(f.purchase_limit?.kind) ? null : f.purchase_limit.kind === 'unlimited' ? Number.MAX_VALUE : f.purchase_limit.value;
      const av = val(a), bv = val(b);
      if (av === null) return bv === null ? a.code.localeCompare(b.code) : 1;
      if (bv === null) return -1;
      return (filters.sort === 'limit_desc' ? bv - av : av - bv) || a.code.localeCompare(b.code);
    }
    const rank = f => isStale(f) ? 4 : f.sip_status === 'available' ? 0 : ['open', 'limited'].includes(f.purchase_status) ? 1 : f.purchase_status === 'paused' ? 2 : 3;
    return rank(a) - rank(b) || a.company.localeCompare(b.company, 'zh-CN') || a.code.localeCompare(b.code);
  });
}

export function csvCell(value) {
  const str = String(value ?? '');
  // Spreadsheet formula injection protection for scraped names and statuses.
  return `"${(/^[=+@\-\t\r]/.test(str) ? "'" + str : str).replace(/"/g, '""')}"`;
}

export function makeCsv(funds) {
  const rows = [['基金代码', '基金名称', '基金公司', '指数分类', '份额币种', '渠道', '申购状态', '日累计申购限额（非定投上限）', '定投状态', '定投起点', '单独披露的定投上限', '数据状态', '抓取时间', '来源']];
  funds.forEach(f => rows.push([f.code, f.name, f.company, f.group_label, f.currency, f.channel, PURCHASE[f.purchase_status], formatMoney(f.purchase_limit, f), SIP[f.sip_status], formatMoney(f.sip_min, f), formatMoney(f.sip_limit, f), isStale(f) ? '待更新' : '已抓取', f.checked_at, f.source_url]));
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function validateSnapshot(doc) {
  if (doc?.schema_version !== 1 || !Array.isArray(doc.funds) || !doc.funds.length || !Number.isFinite(Date.parse(doc.generated_at))) throw new Error('数据快照格式无效');
  const codes = new Set();
  for (const f of doc.funds) {
    if (!/^\d{6}$/.test(f.code) || codes.has(f.code) || typeof f.name !== 'string' || !GROUPS[f.group] || !(f.purchase_status in PURCHASE) || !(f.sip_status in SIP)) throw new Error('基金记录格式无效');
    codes.add(f.code);
  }
  return doc;
}
