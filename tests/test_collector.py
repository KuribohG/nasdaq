import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector", ROOT / "scripts/update_data.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
FIXTURES = ROOT / "tests/fixtures"


def fixture(name):
    return (FIXTURES / name).read_text()


def parsed():
    return c.parse_fund({"code": "019547", "name": "招商纳斯达克100ETF发起式联接(QDII)A", "fund_type": "指数型-海外股票"}, fixture("limited.html"), "", "2026-10-08T05:00:00+00:00")


class CollectorTests(unittest.TestCase):
    def test_real_limited_disclosure(self):
        f = parsed()
        self.assertEqual(f["purchase_status"], "limited")
        self.assertEqual(f["purchase_limit"]["value"], 10)
        self.assertEqual(f["sip_status"], "available")
        self.assertEqual(f["sip_min"]["value"], 10)
        self.assertEqual(f["sip_limit"]["kind"], "unknown")
        self.assertEqual(f["company"], "招商基金")

    def test_paused_retains_historical_limit_without_marking_buyable(self):
        f = c.parse_fund({"code": "270042", "name": "广发纳斯达克100ETF联接人民币(QDII)A"}, fixture("paused.html"), fixture("profile.html"), c.utcnow())
        self.assertEqual(f["purchase_status"], "paused")
        self.assertEqual(f["purchase_limit"]["value"], 2)
        self.assertEqual(f["sip_status"], "unsupported")
        self.assertEqual(f["target_index"], "纳斯达克100指数")

    def test_unsold_is_not_a_scrape_failure(self):
        f = c.parse_fund({"code": "000055", "name": "广发纳斯达克100ETF联接美元(QDII)A"}, fixture("not_sold.html"), "", c.utcnow())
        self.assertEqual(f["purchase_status"], "not_sold")
        self.assertEqual(f["sip_status"], "not_sold")
        self.assertFalse(f["quota_currency_verified"])
        self.assertEqual(f["health"], "ok")
        self.assertEqual(f["purchase_limit"]["kind"], "unknown")

    def test_exchange_etf_is_not_otc(self):
        f = c.parse_fund({"code": "513100", "name": "纳指ETF国泰"}, fixture("etf.html"), "", c.utcnow())
        self.assertEqual(f["venue"], "exchange")
        self.assertEqual(f["sip_status"], "not_applicable")
        self.assertEqual(f["group"], "nasdaq100")

    def test_semantic_parse_failure_is_rejected(self):
        for html in ("error page", fixture("limited.html").replace("定投状态", "changed-label"), fixture("limited.html").replace("日累计申购限额", "changed-label")):
            with self.assertRaises(ValueError):
                c.parse_fund({"code": "019547", "name": "招商纳斯达克100A"}, html, "", c.utcnow())

    def test_amount_units_and_unknowns(self):
        for value in ("---", "", "待确认", "每户100份"):
            self.assertEqual(c.money(value)["kind"], "unknown")
        self.assertEqual(c.money("0元")["value"], 0)
        self.assertEqual(c.money("1.5万元")["value"], 15000)
        self.assertEqual(c.money("1,000.00元")["value"], 1000)
        self.assertEqual(c.money("无限额")["kind"], "unlimited")

    def test_distinct_indices_not_mixed(self):
        self.assertEqual(c.classify("大成标普500等权重指数A"), "sp500_equal")
        self.assertEqual(c.classify("华宝纳斯达克精选股票A"), "nasdaq_other")
        self.assertEqual(c.classify("纳指科技ETF景顺"), "nasdaq_tech")
        self.assertEqual(c.classify("纳指生物科技ETF汇添富"), "nasdaq_bio")
        self.assertEqual(c.classify("博时标普500ETF联接A"), "sp500")

    def test_first_capture_and_failed_capture_do_not_create_changes(self):
        row = parsed()
        self.assertEqual(c.changes_between({}, [row], c.utcnow()), [])
        old = {row["code"]: copy.deepcopy(row)}
        row["checked_at"] = c.utcnow()
        self.assertEqual(c.changes_between(old, [row], c.utcnow()), [])
        row["purchase_limit"] = c.money("20元")
        events = c.changes_between(old, [row], c.utcnow())
        self.assertEqual(events[0]["changes"]["purchase_limit"]["before"]["value"], 10)
        self.assertEqual(events[0]["changes"]["purchase_limit"]["after"]["value"], 20)
        row["health"] = "stale"
        self.assertEqual(c.changes_between(old, [row], c.utcnow()), [])

    def test_failure_retains_original_timestamp(self):
        old = parsed()
        failed = c.fallback(old, old, "timeout")
        self.assertEqual(failed["health"], "stale")
        self.assertEqual(failed["checked_at"], old["checked_at"])
        self.assertEqual(failed["purchase_limit"], old["purchase_limit"])

    def test_incomplete_catalog_cannot_replace_snapshot(self):
        with self.assertRaises(ValueError):
            c.parse_catalog('var r=[["019547","","招商纳斯达克100A",""]];')

    def test_network_failure_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "funds.json"
            original = '{"funds": []}'
            path.write_text(original)
            with patch.object(c, "fetch", side_effect=RuntimeError("network timeout")):
                with self.assertRaises(RuntimeError):
                    c.refresh(Path(tmp))
            self.assertEqual(path.read_text(), original)

    def test_success_rate_guard_preserves_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "funds.json"
            old = parsed()
            original = json.dumps({"funds": [old]})
            path.write_text(original)
            items = [{"code": f"{i:06}", "name": "纳斯达克100A"} for i in range(35)]
            with patch.object(c, "parse_catalog", return_value=(list(range(1000)), items)), patch.object(c, "fetch", return_value="bad upstream page"):
                with self.assertRaisesRegex(ValueError, "80%"):
                    c.refresh(Path(tmp))
            self.assertEqual(path.read_text(), original)


if __name__ == "__main__":
    unittest.main()
