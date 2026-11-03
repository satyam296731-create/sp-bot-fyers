import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from paper_trading import IST, PaperTradingEngine


class PaperTradingEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.engine = PaperTradingEngine(str(Path(self.temp_dir.name) / "paper.sqlite3"))
        self.row = {
            "stock": "NIFTY50-24500CE",
            "fyers_symbol": "NSE:NIFTY502024110724500CE",
            "type": "CALL ATM",
            "category": "OPT_NIFTY",
            "signal": "WAIT⚪",
            "ltp": 100.0,
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def at(hour, minute, day=3):
        return datetime(2026, 11, day, hour, minute, tzinfo=IST)

    def test_signal_flip_tracks_realized_and_open_pnl(self):
        self.engine.process_rows([self.row], self.at(9, 20))

        self.row.update(signal="BUY🟢", ltp=100.0)
        self.engine.process_rows([self.row], self.at(9, 25))
        self.row["ltp"] = 110.0
        self.engine.process_rows([self.row], self.at(9, 30))
        self.row.update(signal="SELL🔴", ltp=105.0)
        self.engine.process_rows([self.row], self.at(9, 35))

        result = self.engine.get_dashboard(self.at(10, 0))
        self.assertEqual(result["summary"]["closed_trades"], 1)
        self.assertEqual(result["summary"]["realized_pnl"], 5.0)
        self.assertEqual(result["open_positions"][0]["side"], "SHORT")

        self.row["ltp"] = 103.0
        self.engine.process_rows([self.row], self.at(10, 5))
        result = self.engine.get_dashboard(self.at(10, 5))
        self.assertEqual(result["summary"]["unrealized_pnl"], 2.0)
        self.assertEqual(result["summary"]["net_pnl"], 7.0)

        self.engine.close_expired_positions(self.at(15, 30))
        result = self.engine.get_dashboard(self.at(15, 31))
        self.assertEqual(result["summary"]["open_positions"], 0)
        self.assertEqual(result["summary"]["realized_pnl"], 7.0)
        self.assertEqual(result["summary"]["month_net_pnl"], 7.0)
        self.assertEqual(result["daily"][0]["net_pnl"], 7.0)
        self.assertEqual(result["weekly"][0]["net_pnl"], 7.0)

    def test_first_observed_signal_is_baseline_not_a_backfilled_trade(self):
        self.row.update(signal="BUY🟢", ltp=100.0)
        self.engine.process_rows([self.row], self.at(9, 20))
        self.engine.process_rows([self.row], self.at(9, 25))

        result = self.engine.get_dashboard(self.at(9, 30))
        self.assertEqual(result["summary"]["open_positions"], 0)
        self.assertEqual(result["summary"]["closed_trades"], 0)

    def test_positions_and_signal_state_survive_engine_restart(self):
        self.engine.process_rows([self.row], self.at(9, 20))
        self.row.update(signal="BUY🟢", ltp=100.0)
        self.engine.process_rows([self.row], self.at(9, 25))

        restarted = PaperTradingEngine(self.engine.database_path)
        self.row["ltp"] = 110.0
        restarted.process_rows([self.row], self.at(9, 30))
        result = restarted.get_dashboard(self.at(9, 30))

        self.assertEqual(result["summary"]["open_positions"], 1)
        self.assertEqual(result["summary"]["unrealized_pnl"], 10.0)

    def test_only_live_option_contract_rows_are_traded(self):
        self.engine.process_rows([self.row], self.at(9, 20))
        stock = dict(self.row, stock="RELIANCE", fyers_symbol="NSE:RELIANCE-EQ", category="NIFTY50")
        hold = dict(self.row, stock="NIFTY50-24500CE_HOLD", category="OPT_HOLD_POSITIONS")

        self.engine.process_rows([stock, hold], self.at(9, 25))
        self.assertEqual(self.engine.get_dashboard(self.at(9, 30))["summary"]["open_positions"], 0)


if __name__ == "__main__":
    unittest.main()
