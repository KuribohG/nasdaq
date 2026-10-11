#!/usr/bin/env python3
"""Refresh public Tiantian Fund disclosures. Python 3.9+, standard library only."""
import argparse
import concurrent.futures
import copy
import hashlib
import html
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.request
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parents[1]
CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
SOURCE = "天天基金"
GROUPS = {"nasdaq100": "纳斯达克100", "sp500": "标普500", "sp500_equal": "标普500等权重", "nasdaq_tech": "纳斯达克科技", "nasdaq_bio": "纳斯达克生物科技", "nasdaq_other": "其他纳斯达克相关"}
TRACKED = ("purchase_status", "purchase_limit", "purchase_min", "sip_status", "sip_min", "sip_limit")


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", value))).strip()


def table_fields(page):
    """Only read table cells; header navigation contains similarly named labels."""
    fields = {}
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, re.S | re.I):
        cells = [clean(c) for c in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, re.S | re.I)]
        for a, b in zip(cells[::2], cells[1::2]):
            fields[a] = b
    return fields


def money(raw):
    """Unknown is never converted to zero or unlimited; retain original units."""
    raw = raw.strip()
    if raw in ("无限额", "不限", "不限额", "无限制"):
        return {"kind": "unlimited", "value": None, "raw": raw}
    match = re.fullmatch(r"([\d,]+(?:\.\d+)?)\s*(万|亿)?\s*(?:元|美元|美金)?", raw)
    if match:
        value = float(match[1].replace(",", "")) * {None: 1, "万": 10000, "亿": 100000000}[match[2]]
        return {"kind": "amount", "value": value, "raw": raw}
    return {"kind": "unknown", "value": None, "raw": raw or "未披露"}


def classify(name, target=""):
    value = name + " " + target
    if "标普500" in value:
        return "sp500_equal" if "等权" in value else "sp500"
    if "生物科技" in value:
        return "nasdaq_bio"
    if "科技" in value and ("纳斯达克" in value or "纳指" in value):
        return "nasdaq_tech"
    if re.search(r"纳斯达克100|纳指100|纳指ETF|纳斯达克ETF", value):
        return "nasdaq100"
    return "nasdaq_other"


def parse_catalog(text):
    rows = json.loads(text[text.index("["):text.rindex("]") + 1])
    if len(rows) < 1000:
        raise ValueError("基金目录不完整，拒绝覆盖已有数据")
    selected = []
    for row in rows:
        code, _, name, fund_type = row[:4]
        if re.fullmatch(r"\d{6}", code) and re.search(r"纳斯达克|纳指|标普500", name):
            selected.append({"code": code, "name": name, "fund_type": fund_type})
    if len(selected) < 30 or len({r["code"] for r in selected}) != len(selected):
        raise ValueError("基金筛选结果异常，拒绝覆盖已有数据")
    return rows, selected


def parse_fund(item, fee_page, profile_page, checked_at):
    code, name = item["code"], item["name"]
    fields, profile = table_fields(fee_page), table_fields(profile_page)
    # Verify we received the intended fund, not an HTTP-200 error or redirected page.
    if not re.search(rf"(?:jjfl_|jbgk_|fcode\s*=\s*['\"]){code}", fee_page):
        raise ValueError("返回页面无法确认基金代码")
    if not fields.get("申购状态") or not fields.get("定投状态"):
        raise ValueError("交易规则字段缺失，可能是来源页面改版")
    manager = re.search(r'管理人：\s*<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', fee_page, re.S)
    if not manager:
        raise ValueError("基金管理人字段缺失")
    company = clean(manager[2])
    is_etf = "ETF" in name and "联接" not in name
    currency = "USD" if re.search(r"美元|美钞|美汇", name) else "CNY"
    group = classify(name, profile.get("跟踪标的", ""))
    share = re.search(r"(?:\)|）|人民币|现汇|现钞|指数|联接|QDII)?([ACDEFIY])(?=人民币|美元|\(|（|$)", name)
    sip_raw = fields["定投状态"]
    sip_status = "unsupported" if "不支持" in sip_raw else "paused" if "暂停" in sip_raw else "available" if sip_raw in ("支持", "开放", "开放定投") else "unknown"
    purchase_raw = fields["申购状态"]
    purchase_status = "paused" if "暂停" in purchase_raw or "封闭" in purchase_raw else "limited" if re.search(r"限制|限大额|限额", purchase_raw) else "open" if "开放" in purchase_raw else "unknown"
    limit = money(fields.get("日累计申购限额", ""))
    not_sold = "该基金尚未开通天天基金代销" in fee_page
    if not is_etf and not not_sold and ("日累计申购限额" not in fields or "定投起点" not in fields):
        raise ValueError("额度字段缺失，保留上次有效记录")
    if not is_etf and purchase_status == "open" and limit["kind"] == "amount":
        purchase_status = "limited"
    sip_limit = money(fields.get("定投上限", fields.get("日累计定投限额", "")))
    # Page often says '元' even on USD classes. Do not silently assert RMB or USD.
    currency_verified = currency == "CNY"
    return {
        **item, "company": company, "company_url": manager[1].replace("http:", "https:"),
        "group": group, "group_label": GROUPS[group], "target_index": profile.get("跟踪标的", ""),
        "benchmark": profile.get("业绩比较基准", ""), "share_class": share[1] if share else "—",
        "currency": currency, "quota_currency_verified": currency_verified,
        "venue": "exchange" if is_etf else "otc", "channel": SOURCE, "sold_by_source": not not_sold,
        "purchase_status": "not_applicable" if is_etf else "not_sold" if not_sold else purchase_status,
        "purchase_status_raw": purchase_raw, "purchase_limit": limit,
        "purchase_min": money(fields.get("申购起点", "")),
        "sip_status": "not_applicable" if is_etf else "not_sold" if not_sold else sip_status, "sip_status_raw": sip_raw,
        "sip_min": money(fields.get("定投起点", "")), "sip_limit": sip_limit,
        "management_fee": profile.get("管理费率", ""), "custody_fee": profile.get("托管费率", ""),
        "sales_fee": profile.get("销售服务费率", ""),
        "source_url": f"https://fundf10.eastmoney.com/jjfl_{code}.html",
        "profile_url": f"https://fundf10.eastmoney.com/jbgk_{code}.html",
        "announcements_url": f"https://fundf10.eastmoney.com/jjgg_{code}.html",
        "checked_at": checked_at, "source_effective_at": None,
        "health": "ok", "error": None, "in_catalog": True,
        "evidence_hash": hashlib.sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16],
    }


def fetch(url):
    error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; IndexQuota/1.0; public-fund-disclosure)", "Referer": "https://fund.eastmoney.com/"})
            with urllib.request.urlopen(request, timeout=25) as response:
                return response.read().decode("utf-8-sig")
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(str(error))


def load_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")
        temporary = file.name
    os.replace(temporary, path)


def changes_between(previous, current, timestamp):
    events = []
    for row in current:
        old = previous.get(row["code"])
        if not old or row["health"] != "ok":
            continue
        diff = {key: {"before": old.get(key), "after": row.get(key)} for key in TRACKED if old.get(key) != row.get(key)}
        if diff:
            events.append({"code": row["code"], "name": row["name"], "company": row["company"], "at": timestamp, "changes": diff})
    return events


def fallback(item, old, error):
    if old:
        return {**copy.deepcopy(old), "health": "stale", "error": str(error)[:250], "in_catalog": True}
    name = item["name"]
    return {**item, "company": "待核验", "company_url": "", "group": classify(name), "group_label": GROUPS[classify(name)],
        "target_index": "", "benchmark": "", "share_class": "—", "currency": "USD" if re.search(r"美元|美钞|美汇", name) else "CNY",
        "quota_currency_verified": False, "venue": "exchange" if "ETF" in name and "联接" not in name else "otc", "channel": SOURCE,
        "purchase_status": "unknown", "purchase_status_raw": "待核验", "sip_status": "unknown", "sip_status_raw": "待核验",
        **{key: money("") for key in ("purchase_limit", "purchase_min", "sip_min", "sip_limit")},
        "source_url": f"https://fundf10.eastmoney.com/jjfl_{item['code']}.html", "profile_url": f"https://fundf10.eastmoney.com/jbgk_{item['code']}.html",
        "announcements_url": f"https://fundf10.eastmoney.com/jjgg_{item['code']}.html", "checked_at": None,
        "source_effective_at": None, "health": "error", "error": str(error)[:250], "in_catalog": True}


def refresh(data_dir, workers=4):
    started = utcnow()
    previous_doc = load_json(data_dir / "funds.json", {})
    previous = {row["code"]: row for row in previous_doc.get("funds", [])}
    catalog, items = parse_catalog(fetch(CATALOG_URL))
    if previous and len(items) < len(previous) * 0.85:
        raise ValueError("目录收录数量骤降超过15%，拒绝覆盖快照")
    logging.info("Found %s matching share classes in %s catalog entries", len(items), len(catalog))
    def get_one(item):
        try:
            fee_page = fetch(f"https://fundf10.eastmoney.com/jjfl_{item['code']}.html")
            old = previous.get(item["code"], {})
            # Profile metadata is ancillary; a profile outage must not discard fresh quotas.
            try:
                profile = fetch(f"https://fundf10.eastmoney.com/jbgk_{item['code']}.html")
            except Exception:
                profile = ""
            result = parse_fund(item, fee_page, profile, utcnow())
            if not profile:
                for field in ("benchmark", "target_index", "management_fee", "custody_fee", "sales_fee"):
                    result[field] = old.get(field, "")
            time.sleep(0.2)
            return result
        except Exception as exc:
            logging.warning("%s: %s", item["code"], exc)
            return fallback(item, previous.get(item["code"]), exc)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        funds = list(pool.map(get_one, items))
    good = sum(row["health"] == "ok" for row in funds)
    if good < len(items) * 0.8:
        raise ValueError(f"仅 {good}/{len(items)} 条抓取成功，低于80%阈值；保留旧快照")
    # Catalog removals are visible for review; they are never silently presented as fresh.
    current_codes = {item["code"] for item in items}
    for code, old in previous.items():
        if code not in current_codes:
            funds.append({**old, "in_catalog": False, "health": "stale", "error": "本次基金目录中未发现，保留记录待核验"})
    funds.sort(key=lambda item: item["code"])
    history_doc = load_json(data_dir / "changes.json", {"changes": []})
    events = changes_between(previous, funds, started)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    history = (events + [e for e in history_doc["changes"] if e["at"] >= cutoff])[:5000]
    snapshot = {
        "schema_version": 1, "generated_at": utcnow(), "started_at": started,
        "source": SOURCE, "catalog_url": CATALOG_URL, "catalog_total": len(catalog),
        "schedule_hours": 4, "stale_after_hours": 12,
        "scope": "公开目录中名称含纳斯达克、纳指或标普500的境内公募基金；份额分别统计；其他纳斯达克及标普500等权产品单独分类。",
        "coverage": {"matched": len(items), "collected": good, "failed": len(items) - good, "retained_removed": len(funds) - len(items), "companies": len({row["company"] for row in funds if row["company"] != "待核验"})},
        "funds": funds,
    }
    atomic_json(data_dir / "changes.json", {"updated_at": snapshot["generated_at"], "baseline_at": history_doc.get("baseline_at", previous_doc.get("generated_at", started)), "changes": history})
    atomic_json(data_dir / "funds.json", snapshot)
    atomic_json(data_dir / "health.json", {"last_attempt_at": snapshot["generated_at"], "status": "ok" if good == len(items) else "partial", "collected": good, "matched": len(items), "error": None})
    logging.info("Saved %s funds, %s new changes", len(funds), len(events))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        refresh(args.data_dir, max(1, min(args.workers, 6)))
    except Exception as exc:
        atomic_json(args.data_dir / "health.json", {"last_attempt_at": utcnow(), "status": "error", "error": str(exc)[:500]})
        logging.exception("Update failed; existing valid funds.json remains untouched")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
