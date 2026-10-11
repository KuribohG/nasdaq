import { GROUPS, PURCHASE, SIP, FIELD_NAMES, DEFAULT_FILTERS, escapeHtml as esc, formatMoney, filterFunds, isStale, makeCsv, validateSnapshot } from './core.js';

const paths = {
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.55-1L20 9M4 15l2.35 3A7 7 0 0 0 17.9 17"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1M10 21v-3h4v3"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  star: '<path d="m12 3 2.8 5.7 6.3.9-4.55 4.45 1.07 6.28L12 17.36l-5.62 2.97 1.07-6.28L2.9 9.6l6.3-.9L12 3Z"/>',
  external: '<path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.replaceWith(document.createRange().createContextualFragment(icon(el.dataset.icon))));
const $ = id => document.getElementById(id);
const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } } };
const savedFavorites = storage.get('index-quota:favorites', []);
const state = { data: null, health: null, history: null, filters: { ...DEFAULT_FILTERS }, favorites: new Set(Array.isArray(savedFavorites) ? savedFavorites.filter(c => /^\d{6}$/.test(c)) : []), view: 'funds', page: 1, pageSize: 12, loading: false, offline: false, error: '', historyError: false };
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
function timeText(time, compact = false) {
  if (!time) return '尚未成功抓取';
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const options = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const s = new Intl.DateTimeFormat('zh-CN', options).format(date).replaceAll('/', '.');
  return compact ? s.slice(5) : s;
}
function safeUrl(value) { try { const u = new URL(value); return u.protocol === 'https:' ? esc(u.href) : '#'; } catch { return '#'; } }
const externalLink = (url, label) => `<a class="source-link" href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;

async function fetchJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`./data/${path}?v=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function refresh(manual = false) {
  if (state.loading) return;
  state.loading = true;
  $('refresh').disabled = true; $('refresh').classList.add('spinning');
  const oldTime = state.data?.generated_at;
  try {
    const [funds, history, health] = await Promise.allSettled([fetchJson('funds.json'), fetchJson('changes.json'), fetchJson('health.json')]);
    if (funds.status === 'rejected') throw funds.reason;
    const incoming = validateSnapshot(funds.value);
    if (state.data && Date.parse(incoming.generated_at) < Date.parse(state.data.generated_at)) throw new Error('服务器快照暂未同步');
    state.data = incoming;
    state.offline = false; state.error = '';
    if (history.status === 'fulfilled' && Array.isArray(history.value.changes)) { state.history = history.value; state.historyError = false; } else { state.historyError = true; }
    state.health = health.status === 'fulfilled' ? health.value : null;
    storage.set('index-quota:snapshot', { data: state.data, history: state.history, health: state.health });
    populateCompanies(); render();
    if (manual) toast(oldTime === state.data.generated_at ? '已检查，当前就是最新发布的快照' : '已载入最新数据快照');
  } catch (err) {
    state.offline = true; state.error = err.message;
    if (!state.data) {
      const saved = storage.get('index-quota:snapshot', null);
      try { if (saved) { state.data = validateSnapshot(saved.data); state.history = saved.history; state.health = saved.health; populateCompanies(); } } catch { /* Invalid local cache is ignored. */ }
    }
    render();
    if (manual) toast(state.data ? '刷新失败，已保留上次成功快照' : '暂时无法加载数据，请稍后重试');
  } finally { state.loading = false; $('refresh').disabled = false; $('refresh').classList.remove('spinning'); }
}

function populateCompanies() {
  const companies = [...new Set(state.data.funds.map(f => f.company))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  $('company').innerHTML = '<option value="">全部基金公司</option>' + companies.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (state.filters.company && !companies.includes(state.filters.company)) state.filters.company = '';
  syncFilters();
}

function renderStatus() {
  const data = state.data;
  const messages = [];
  if (!data) {
    $('snapshot-status').innerHTML = `${icon('info')}<span>暂时无法加载</span>`;
    $('snapshot-time').textContent = '请检查网络后重试';
    $('health-banner').textContent = '没有可用数据。请通过 HTTP 服务或 GitHub Pages 打开本网站，然后点击“刷新数据”重试。';
    $('health-banner').hidden = false;
    return;
  }
  const ageHours = (Date.now() - Date.parse(data.generated_at)) / 3600000;
  const stale = ageHours > data.stale_after_hours;
  const bad = data.funds.filter(f => isStale(f)).length;
  if (state.offline) messages.push('网络读取失败，正在显示本地保存的快照。刷新失败不会改变原始抓取时间。');
  if (state.health?.status === 'error') messages.push(`最近一次采集失败（${timeText(state.health.last_attempt_at)}），已保留此前数据。`);
  if (stale) messages.push(`快照距今已超过 ${data.stale_after_hours} 小时，请核验来源。`);
  else if (bad) messages.push(`${bad} 个份额的数据待更新，旧额度仅供核验。`);
  if (state.historyError) messages.push('变动记录读取失败；基金快照可正常查看。');
  if (!state.health) messages.push('采集任务状态暂不可用；请以每只基金的抓取时间为准。');
  $('health-banner').textContent = messages.join(' '); $('health-banner').hidden = !messages.length;
  const healthy = !stale && !state.offline && state.health?.status === 'ok' && !bad;
  $('snapshot-status').innerHTML = `<span class="live-dot" style="background:${healthy ? '#6d9b78' : '#b89b69'}"></span><span>${state.offline ? '本地快照' : stale ? '数据待更新' : state.health?.status === 'error' ? '采集异常' : bad ? '部分数据待更新' : '公开数据快照'}</span>`;
  $('snapshot-time').textContent = `抓取于 ${timeText(data.generated_at)} · 北京时间`;
  $('stat-funds').textContent = data.funds.length;
  $('stat-companies').textContent = data.coverage.companies;
  $('stat-sip').innerHTML = `${data.funds.filter(f => f.currency === 'CNY' && f.venue === 'otc' && f.sip_status === 'available' && !isStale(f)).length}<small>只</small>`;
  const recent = state.history?.changes?.filter(e => Date.now() - Date.parse(e.at) <= 86400000) || [];
  $('stat-changes').innerHTML = `${state.historyError || !state.history ? '—' : recent.length}<small>条</small>`;
  $('stat-change-note').textContent = state.history?.changes.length ? '申购、定投规则变化' : '已建立快照，开始记录变化';
  $('count-core').textContent = data.funds.filter(f => ['nasdaq100', 'sp500'].includes(f.group)).length;
}

function amountHtml(money, fund) {
  const unknown = !money || money.kind !== 'amount' || fund.venue === 'exchange' || (fund.currency === 'USD' && !fund.quota_currency_verified);
  if (unknown) return `<span class="quota-amount quota-muted">${esc(formatMoney(money, fund))}</span>`;
  return `<span class="quota-amount">${esc(formatMoney(money, fund, false))}<small>${fund.currency === 'USD' ? '美元' : '元'}</small></span>`;
}
function rowHtml(fund) {
  const favorite = state.favorites.has(fund.code);
  const stale = isStale(fund);
  const badge = fund.group === 'nasdaq100' ? '' : fund.group === 'sp500' ? 'sp500' : 'other';
  return `<tr>
    <td class="star-cell"><button class="star-button ${favorite ? 'selected' : ''}" data-favorite="${fund.code}" aria-label="${favorite ? '取消关注' : '关注'} ${esc(fund.name)}" aria-pressed="${favorite}">${icon('star')}</button></td>
    <td><button class="fund-title" data-detail="${fund.code}">${esc(fund.name)}</button><div class="fund-meta"><span class="fund-code">${fund.code}</span><span class="meta-dot">·</span><span>${esc(fund.company)}</span><span class="share-badge">${esc(fund.share_class === '—' ? fund.venue === 'exchange' ? 'ETF' : fund.currency : fund.share_class + ' 类')}</span>${stale ? '<span class="stale-tag">待更新</span>' : ''}</div></td>
    <td><span class="index-badge ${badge}">${esc(fund.group_label)}</span></td>
    <td>${amountHtml(fund.purchase_limit, fund)}<div class="status-line status-${fund.purchase_status}">${stale ? '上次：' : ''}${esc(PURCHASE[fund.purchase_status])}</div></td>
    <td><div class="sip-status ${!stale && fund.sip_status === 'available' ? 'available' : ''}">${icon(fund.sip_status === 'available' && !stale ? 'check' : 'minus')}${stale ? '上次：' : ''}${esc(SIP[fund.sip_status])}</div><div class="sip-min">${fund.venue === 'exchange' ? '券商交易规则另计' : fund.sip_min.kind === 'amount' ? esc(formatMoney(fund.sip_min, fund)) + ' 起投' : fund.purchase_status === 'not_sold' ? '该渠道未开放代销' : '起点未披露'}</div></td>
    <td><div class="sip-limit">${esc(formatMoney(fund.sip_limit, fund))}</div><div class="sip-limit-note">${fund.venue === 'exchange' ? '不适用场外定投' : fund.sip_limit.kind === 'unknown' ? '需查公告核验' : '来源单独披露'}</div></td>
    <td><button class="source-button" data-detail="${fund.code}" aria-label="查看 ${esc(fund.name)} 的来源和详情">${icon('external')}</button></td>
  </tr>`;
}
function selectedFunds() { return state.data ? filterFunds(state.data.funds, state.filters, state.favorites, state.view) : []; }
function renderTable() {
  if (!state.data) {
    $('fund-rows').innerHTML = `<tr><td colspan="7"><div class="empty-state">${icon('info')}<h3>暂时没有可用数据</h3><p>网络可能暂时不可用，也可能数据快照尚未部署。</p><button class="button button-primary" data-retry>重新加载</button></div></td></tr>`;
    $('page-label').textContent = '等待加载'; return;
  }
  const funds = selectedFunds();
  const pages = Math.max(1, Math.ceil(funds.length / state.pageSize)); state.page = Math.min(state.page, pages);
  const offset = (state.page - 1) * state.pageSize;
  $('result-count').textContent = funds.length;
  const descriptions = [state.filters.currency === 'CNY' ? '人民币' : state.filters.currency === 'USD' ? '美元' : '全部币种', state.filters.venue === 'otc' ? '场外' : state.filters.venue === 'exchange' ? '场内 ETF' : '全部方式', state.filters.group === 'core' ? '核心指数' : state.filters.group === 'all' ? '全部分类' : state.filters.group === 'other' ? '其他相关' : GROUPS[state.filters.group]];
  $('filter-description').textContent = ' · ' + descriptions.join(' · ');
  $('list-title').textContent = state.view === 'favorites' ? '留意你关心的每一份额度' : '发现适合你的定投';
  $('list-subtitle').textContent = state.view === 'favorites' ? '关注保存在当前浏览器，方便下次回来查看。' : '先看状态，再看额度。每一条信息都可以回到来源核验。';
  if (funds.length) $('fund-rows').innerHTML = funds.slice(offset, offset + state.pageSize).map(rowHtml).join('');
  else {
    const emptyFavorites = state.view === 'favorites' && !state.favorites.size;
    $('fund-rows').innerHTML = `<tr><td colspan="7"><div class="empty-state">${icon(emptyFavorites ? 'star' : 'search')}<h3>${emptyFavorites ? '把关心的基金放在这里' : '没有找到匹配的基金'}</h3><p>${emptyFavorites ? '点击基金左侧的星标，下次查额度就更方便。' : '试试调整筛选条件，或使用基金代码精确搜索。'}</p>${emptyFavorites ? '<a href="#funds" class="button button-primary">浏览基金额度</a>' : '<button class="button button-quiet" data-clear-all>清除全部筛选</button>'}</div></td></tr>`;
  }
  $('page-label').textContent = funds.length ? `显示 ${offset + 1}–${Math.min(offset + state.pageSize, funds.length)} / ${funds.length} 只基金` : '共 0 只基金';
  $('page-number').textContent = `${state.page} / ${pages}`;
  $('prev-page').disabled = state.page <= 1; $('next-page').disabled = state.page >= pages;
  $('export').disabled = !funds.length;
}

function eventValue(field, value, fund) { if (field === 'purchase_status') return PURCHASE[value] || value; if (field === 'sip_status') return SIP[value] || value; return formatMoney(value, fund); }
function renderChanges() {
  const events = state.history?.changes || [];
  $('history-baseline').textContent = state.history ? `记录起点：${timeText(state.history.baseline_at)}（北京时间）。保留近 90 天，最多 5,000 条；显示最近 100 条。` : '变动记录暂不可用。';
  if (!events.length) { $('change-list').innerHTML = `<div class="empty-state">${icon('activity')}<h3>${state.history ? '等待下一次真实变化' : '暂时无法读取记录'}</h3><p>${state.history ? '已建立初始快照。后续额度或状态发生变化时，会在这里留下记录。' : '请刷新数据后重试。'}</p></div>`; return; }
  $('change-list').innerHTML = events.slice(0, 100).map(event => {
    const fund = state.data?.funds.find(f => f.code === event.code) || {};
    return `<article class="change-item"><div class="change-time">${timeText(event.at)}<br>北京时间</div><div><h3><button class="fund-title" data-detail="${esc(event.code)}">${esc(event.name)} <span class="fund-code">${esc(event.code)}</span></button></h3>${Object.entries(event.changes).map(([key, value]) => `<p>${esc(FIELD_NAMES[key] || key)}<span class="change-values"><del>${esc(eventValue(key, value.before, fund))}</del>→<ins>${esc(eventValue(key, value.after, fund))}</ins></span></p>`).join('')}</div></article>`;
  }).join('');
}
function renderAbout() {
  const d = state.data;
  $('coverage-details').innerHTML = d ? `<p>本轮扫描 ${d.catalog_total.toLocaleString('zh-CN')} 条目录记录，匹配 ${d.coverage.matched} 个相关份额，成功采集 ${d.coverage.collected} 个，抓取失败 ${d.coverage.failed} 个。${d.coverage.retained_removed ? `另保留 ${d.coverage.retained_removed} 个本次目录未发现的旧份额。` : ''}<br>本轮快照：${timeText(d.generated_at)}（北京时间）<br>渠道：天天基金 · 计划采集周期：${d.schedule_hours} 小时 · 数据待更新阈值：${d.stale_after_hours} 小时</p>` : '<p>尚无可用快照。</p>';
}
function render() { $('favorite-count').textContent = state.favorites.size; renderStatus(); renderTable(); renderChanges(); renderAbout(); }
function syncFilters() {
  ['company', 'status', 'currency', 'venue', 'share', 'sort'].forEach(key => { $(key).value = state.filters[key]; });
  $('search').value = state.filters.query;
  document.querySelectorAll('[data-group]').forEach(button => { const active = button.dataset.group === state.filters.group; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
}
function updateFilters() { state.page = 1; renderTable(); }
function reset(all = false) { state.filters = { ...DEFAULT_FILTERS, ...(all ? { group: 'all', currency: '', venue: '' } : {}) }; state.page = 1; syncFilters(); renderTable(); }
function navigate() {
  const view = location.hash.slice(1);
  const next = ['funds', 'favorites', 'changes', 'about'].includes(view) ? view : 'funds';
  if (next !== state.view && next === 'favorites') reset(true);
  if (next !== state.view && next === 'funds') reset();
  state.view = next; state.page = 1;
  $('funds-view').hidden = !['funds', 'favorites'].includes(state.view); $('changes-view').hidden = state.view !== 'changes'; $('about-view').hidden = state.view !== 'about';
  document.querySelectorAll('[data-view]').forEach(a => { a.classList.toggle('active', a.dataset.view === state.view); if (a.dataset.view === state.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (state.data) renderTable();
}

function openDetail(code) {
  const f = state.data?.funds.find(fund => fund.code === code); if (!f) return;
  const stale = isStale(f);
  const messages = ['日累计申购限额未必适用于定投。请核验公告是否包含定期定额、A/C 合并计算以及适用渠道。'];
  if (stale) messages.unshift('该记录待更新，下列数值为上次成功抓取结果。');
  if (f.purchase_status === 'paused') messages.push('当前来源显示暂停申购，历史限额不代表可买入金额。');
  if (f.purchase_status === 'not_sold') messages.push('该基金尚未开通天天基金代销，不能由此推断其他渠道的交易状态。');
  if (f.venue === 'exchange') messages.push('这是场内 ETF，券商交易和定投规则需单独查询。');
  if (f.currency === 'USD' && !f.quota_currency_verified) messages.push('该份额为美元份额，额度币种未核验，数值按来源原文展示，不参与跨币种限额排序。');
  $('dialog-content').innerHTML = `<h2 id="dialog-title">${esc(f.name)}</h2><div class="dialog-meta"><span class="fund-code">${f.code}</span><span>${esc(f.company)}</span><span class="index-badge">${esc(f.group_label)}</span><span>${f.currency === 'USD' ? '美元份额' : '人民币份额'} · ${f.venue === 'exchange' ? '场内 ETF' : '场外基金'}</span></div>
    <div class="detail-grid"><div class="detail-box"><span>日累计申购限额</span><b>${esc(formatMoney(f.purchase_limit, f))}</b><p>${esc(PURCHASE[f.purchase_status])}</p></div><div class="detail-box"><span>定投起点</span><b>${esc(formatMoney(f.sip_min, f))}</b><p>${esc(SIP[f.sip_status])}</p></div><div class="detail-box"><span>单独定投上限</span><b>${esc(formatMoney(f.sip_limit, f))}</b><p>${f.sip_limit.kind === 'unknown' ? '待核验，不作推算' : '来源独立披露'}</p></div></div>
    <div class="dialog-notice">${messages.map(esc).join('<br>')}</div>
    <dl class="detail-list"><dt>数据渠道</dt><dd>天天基金</dd><dt>抓取时间</dt><dd>${timeText(f.checked_at)}（北京时间）${stale ? ' · 待更新' : ''}</dd><dt>规则生效时间</dt><dd>来源页面未披露，请查公告</dd><dt>申购起点</dt><dd>${esc(formatMoney(f.purchase_min, f))}</dd><dt>跟踪标的</dt><dd>${esc(f.target_index || '未披露')}</dd><dt>业绩比较基准</dt><dd>${esc(f.benchmark || '未披露')}</dd><dt>管理费 / 托管费</dt><dd>${esc(f.management_fee || '未披露')} / ${esc(f.custody_fee || '未披露')}</dd><dt>销售服务费</dt><dd>${esc(f.sales_fee || '未披露')}</dd></dl>
    <div class="dialog-links">${externalLink(f.source_url, '交易规则原文')}${externalLink(f.announcements_url, '基金公告（天天基金收录）')}${externalLink(f.profile_url, '基金档案')}</div>
    <details class="dialog-raw"><summary>查看抓取原始字段</summary><pre>${esc(`申购状态：${f.purchase_status_raw}\n日累计申购限额：${f.purchase_limit.raw}\n定投状态：${f.sip_status_raw}\n定投起点：${f.sip_min.raw}\n单独定投上限：${f.sip_limit.raw}\n${f.error ? '采集异常：' + f.error + '\n' : ''}字段指纹：${f.evidence_hash || '无'}`)}</pre></details>
    <div class="dialog-foot"><button class="button button-quiet" data-copy="${f.code}">${icon('copy')}复制基金代码</button><button class="button button-primary" data-favorite="${f.code}">${icon('star')}${state.favorites.has(f.code) ? '取消关注' : '加入我的关注'}</button></div>`;
  if (!$('fund-dialog').open) $('fund-dialog').showModal();
  $('fund-dialog').dataset.code = code;
}
function toggleFavorite(code) {
  if (state.favorites.has(code)) state.favorites.delete(code); else state.favorites.add(code);
  const saved = storage.set('index-quota:favorites', [...state.favorites]);
  $('favorite-count').textContent = state.favorites.size; renderTable();
  if ($('fund-dialog').open) openDetail(code);
  if (!saved) toast('浏览器无法保存关注，本次会话仍可使用');
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.favorite) toggleFavorite(button.dataset.favorite);
  if (button.dataset.detail) openDetail(button.dataset.detail);
  if (button.dataset.group) { state.filters.group = button.dataset.group; syncFilters(); updateFilters(); }
  if (button.hasAttribute('data-clear-all')) reset(true);
  if (button.hasAttribute('data-retry')) refresh(true);
  if (button.dataset.copy) {
    try { await navigator.clipboard.writeText(button.dataset.copy); toast('基金代码已复制'); }
    catch { toast(`基金代码：${button.dataset.copy}`); }
  }
});
$('search').addEventListener('input', event => { state.filters.query = event.target.value; updateFilters(); });
['company', 'status', 'currency', 'venue', 'share', 'sort'].forEach(key => $(key).addEventListener('change', event => { state.filters[key] = event.target.value; updateFilters(); }));
$('refresh').addEventListener('click', () => refresh(true));
$('reset-filters').addEventListener('click', () => reset(state.view === 'favorites'));
function changePage(delta) { state.page += delta; renderTable(); $('funds-view').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('prev-page').addEventListener('click', () => changePage(-1)); $('next-page').addEventListener('click', () => changePage(1));
$('close-dialog').addEventListener('click', () => $('fund-dialog').close());
$('fund-dialog').addEventListener('click', event => { if (event.target === $('fund-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('export').addEventListener('click', () => { const funds = selectedFunds(); if (!funds.length) return; const url = URL.createObjectURL(new Blob([makeCsv(funds)], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `指投-基金额度-${new Date().toISOString().slice(0, 10)}.csv`; a.hidden = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast(`已生成 ${funds.length} 条筛选结果的 CSV`); });
window.addEventListener('hashchange', navigate);
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('fund-dialog').open) { event.preventDefault(); if (!['funds', 'favorites'].includes(state.view)) location.hash = 'funds'; $('search').focus(); } });
window.addEventListener('storage', event => { if (event.key === 'index-quota:favorites') { const list = storage.get('index-quota:favorites', []); state.favorites = new Set(Array.isArray(list) ? list.filter(c => /^\d{6}$/.test(c)) : []); render(); } });
let interval;
function setAutoRefresh() { clearInterval(interval); if ($('auto-refresh').checked) interval = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 300000); storage.set('index-quota:auto-refresh', $('auto-refresh').checked); }
$('auto-refresh').checked = storage.get('index-quota:auto-refresh', true) !== false;
$('auto-refresh').addEventListener('change', setAutoRefresh);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('auto-refresh').checked) refresh(); });
setInterval(() => { if (state.data && document.visibilityState === 'visible') { renderStatus(); renderTable(); } }, 60000);
syncFilters(); navigate(); setAutoRefresh(); await refresh();
