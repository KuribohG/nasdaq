import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_FILTERS, filterFunds, formatMoney, isStale, makeCsv, csvCell, escapeHtml, validateSnapshot } from '../assets/core.js';

const now = new Date().toISOString();
const amount = value => ({ kind: 'amount', value, raw: `${value}.00元` });
const base = { code: '000001', name: '示例纳斯达克100A', company: '示例基金', group: 'nasdaq100', group_label: '纳斯达克100', share_class: 'A', currency: 'CNY', quota_currency_verified: true, venue: 'otc', channel: '天天基金', sip_status: 'available', purchase_status: 'limited', purchase_limit: amount(10), sip_min: amount(1), sip_limit: { kind: 'unknown', value: null, raw: '未披露' }, health: 'ok', checked_at: now };
const rows = [base, { ...base, code: '000002', group: 'sp500', share_class: 'C', purchase_limit: amount(100) }, { ...base, code: '000003', group: 'sp500_equal' }, { ...base, code: '000004', currency: 'USD', quota_currency_verified: false }, { ...base, code: '000005', venue: 'exchange', sip_status: 'not_applicable', purchase_status: 'not_applicable' }, { ...base, code: '000006', health: 'stale' }];

test('default scope excludes USD, exchange ETFs and other indices', () => {
  assert.deepEqual(filterFunds(rows, DEFAULT_FILTERS).map(f => f.code), ['000001', '000002', '000006']);
});
test('code, company, class and index filters compose', () => {
  assert.equal(filterFunds(rows, { ...DEFAULT_FILTERS, query: '000002', company: '示例基金', share: 'C', group: 'sp500' }).length, 1);
  assert.equal(filterFunds(rows, { ...DEFAULT_FILTERS, query: 'no match' }).length, 0);
});
test('buyable and SIP filters exclude stale records', () => {
  assert.deepEqual(filterFunds(rows, { ...DEFAULT_FILTERS, status: 'sip' }).map(f => f.code), ['000001', '000002']);
  assert.equal(filterFunds([{ ...base, purchase_status: 'paused' }], { ...DEFAULT_FILTERS, status: 'buy' }).length, 0);
});
test('favorites view only returns explicitly selected funds', () => {
  assert.deepEqual(filterFunds(rows, DEFAULT_FILTERS, new Set(['000002']), 'favorites').map(f => f.code), ['000002']);
});
test('unknown money is not zero or unlimited', () => {
  assert.equal(formatMoney({ kind: 'unknown' }, base), '未披露');
  assert.equal(formatMoney(amount(0), base), '0 元');
  assert.equal(formatMoney({ kind: 'unlimited' }, base), '无限额');
});
test('USD with ambiguous source units retains raw text', () => {
  assert.equal(formatMoney(amount(10), { ...base, currency: 'USD', quota_currency_verified: false }), '10.00元');
  assert.equal(formatMoney(amount(10), { ...base, currency: 'USD', quota_currency_verified: true }), '10 美元');
});
test('OTC amounts do not get applied to exchange ETFs', () => {
  assert.equal(formatMoney(amount(10), { ...base, venue: 'exchange' }), '不适用');
});
test('unknown limits stay last and unverified currencies are not mixed', () => {
  const input = [{ ...base, code: '000009', purchase_limit: { kind: 'unknown' } }, rows[3], ...rows.slice(0, 2)];
  assert.deepEqual(filterFunds(input, { ...DEFAULT_FILTERS, currency: '', sort: 'limit_desc' }).map(f => f.code), ['000002', '000001', '000004', '000009']);
});
test('old or failed data is stale even if the site refresh succeeds', () => {
  assert.equal(isStale({ ...base, checked_at: '2020-01-01T00:00:00Z' }), true);
  assert.equal(isStale({ ...base, health: 'stale' }), true);
  assert.equal(isStale(base), false);
});
test('remote text is safely escaped for HTML and CSV formulas', () => {
  assert.equal(escapeHtml('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.equal(csvCell('normal, comma'), '"normal, comma"');
});
test('CSV exports source and separate SIP fields with no invented limit', () => {
  const csv = makeCsv([{ ...base, source_url: 'https://example.com/' }]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('非定投上限'));
  assert.ok(csv.includes('未披露'));
  assert.ok(csv.includes('"000001"'));
});
test('real bundled snapshot is coherent and contains no duplicate codes', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/funds.json', import.meta.url), 'utf8'));
  assert.equal(validateSnapshot(doc), doc);
  assert.equal(doc.funds.length, doc.coverage.matched + doc.coverage.retained_removed);
  assert.equal(doc.coverage.collected + doc.coverage.failed, doc.coverage.matched);
  for (const f of doc.funds) {
    assert.ok(f.source_url.includes(f.code));
    for (const key of ['purchase_limit', 'sip_min', 'sip_limit']) {
      assert.ok(['amount', 'unknown', 'unlimited'].includes(f[key].kind));
      if (f[key].kind === 'amount') assert.ok(Number.isFinite(f[key].value) && f[key].value >= 0);
    }
  }
});
test('invalid cached snapshots are rejected', () => {
  assert.throws(() => validateSnapshot({ schema_version: 9, funds: [] }));
  assert.throws(() => validateSnapshot({ schema_version: 1, generated_at: now, funds: [base, base] }));
});
