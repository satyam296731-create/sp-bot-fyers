import math
import os
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo


IST = ZoneInfo("Asia/Kolkata")
OPTION_SYMBOL_RE = re.compile(r"\d+(CE|PE)$")
SESSION_END = time(15, 30)


class PaperTradingEngine:
    """Persistent, options-only paper trading based on screener signal changes."""

    def __init__(self, database_path):
        self.database_path = database_path
        self._lock = threading.RLock()
        parent = os.path.dirname(os.path.abspath(database_path))
        os.makedirs(parent, exist_ok=True)
        self._initialize_database()

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize_database(self):
        with self._lock, closing(self._connect()) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS paper_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paper_signals (
                    symbol TEXT PRIMARY KEY,
                    signal TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paper_positions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    instrument_type TEXT NOT NULL,
                    side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
                    quantity INTEGER NOT NULL CHECK (quantity > 0),
                    entry_price REAL NOT NULL,
                    entry_time TEXT NOT NULL,
                    entry_signal TEXT NOT NULL,
                    mark_price REAL NOT NULL,
                    exit_price REAL,
                    exit_time TEXT,
                    exit_reason TEXT,
                    realized_pnl REAL,
                    status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED'))
                );
                CREATE INDEX IF NOT EXISTS paper_positions_status_idx
                    ON paper_positions(status, entry_time);
                CREATE INDEX IF NOT EXISTS paper_positions_exit_idx
                    ON paper_positions(exit_time);
                """
            )
            started_at = self._now().isoformat(timespec="seconds")
            connection.execute(
                "INSERT OR IGNORE INTO paper_meta(key, value) VALUES ('started_at', ?)",
                (started_at,),
            )
            connection.commit()

    @staticmethod
    def _now(value=None):
        result = value or datetime.now(IST)
        if result.tzinfo is None:
            return result.replace(tzinfo=IST)
        return result.astimezone(IST)

    @staticmethod
    def _signal(value):
        signal = str(value or "").upper()
        if "BUY" in signal:
            return "BUY"
        if "SELL" in signal:
            return "SELL"
        return "WAIT"

    @staticmethod
    def _price(value):
        try:
            price = float(value)
        except (TypeError, ValueError):
            return None
        return price if math.isfinite(price) and price > 0 else None

    @staticmethod
    def _is_option(row, symbol):
        stock = str(row.get("stock", "")).upper()
        category = str(row.get("category", "")).upper()
        return (
            not stock.endswith("_HOLD")
            and category.startswith("OPT_")
            and OPTION_SYMBOL_RE.search(symbol.split(":")[-1]) is not None
        )

    @staticmethod
    def _unrealized(position):
        direction = 1 if position["side"] == "LONG" else -1
        return (position["mark_price"] - position["entry_price"]) * position["quantity"] * direction

    def _close_position(self, connection, position, price, now, reason):
        direction = 1 if position["side"] == "LONG" else -1
        realized = (price - position["entry_price"]) * position["quantity"] * direction
        connection.execute(
            """
            UPDATE paper_positions
            SET mark_price = ?, exit_price = ?, exit_time = ?, exit_reason = ?,
                realized_pnl = ?, status = 'CLOSED'
            WHERE id = ? AND status = 'OPEN'
            """,
            (price, price, now.isoformat(timespec="seconds"), reason, realized, position["id"]),
        )

    def process_rows(self, rows, now=None):
        """Record current marks and open/flip positions on newly observed signals."""
        current_time = self._now(now)
        stamp = current_time.isoformat(timespec="seconds")

        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                for row in rows:
                    symbol = str(row.get("fyers_symbol") or row.get("stock") or "").strip().upper()
                    price = self._price(row.get("ltp"))
                    if not symbol or price is None or not self._is_option(row, symbol):
                        continue

                    signal = self._signal(row.get("signal"))
                    previous = connection.execute(
                        "SELECT signal FROM paper_signals WHERE symbol = ?", (symbol,)
                    ).fetchone()
                    if previous is None:
                        connection.execute(
                            "INSERT INTO paper_signals(symbol, signal, updated_at) VALUES (?, ?, ?)",
                            (symbol, signal, stamp),
                        )
                    else:
                        previous_signal = previous["signal"]
                        connection.execute(
                            "UPDATE paper_signals SET signal = ?, updated_at = ? WHERE symbol = ?",
                            (signal, stamp, symbol),
                        )
                        if signal in ("BUY", "SELL") and signal != previous_signal:
                            side = "LONG" if signal == "BUY" else "SHORT"
                            opened = connection.execute(
                                "SELECT * FROM paper_positions WHERE symbol = ? AND status = 'OPEN'",
                                (symbol,),
                            ).fetchone()
                            if opened and opened["side"] != side:
                                self._close_position(connection, opened, price, current_time, "opposite_signal")
                                opened = None
                            if opened is None:
                                connection.execute(
                                    """
                                    INSERT INTO paper_positions(
                                        symbol, instrument_type, side, quantity, entry_price, entry_time,
                                        entry_signal, mark_price, status
                                    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'OPEN')
                                    """,
                                    (
                                        symbol,
                                        str(row.get("type") or "OPTION"),
                                        side,
                                        price,
                                        stamp,
                                        signal,
                                        price,
                                    ),
                                )

                    connection.execute(
                        "UPDATE paper_positions SET mark_price = ? WHERE symbol = ? AND status = 'OPEN'",
                        (price, symbol),
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

        self.close_expired_positions(current_time)

    def close_expired_positions(self, now=None):
        """Close at the latest observed option price at session end or the next session."""
        current_time = self._now(now)
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                opened = connection.execute(
                    "SELECT * FROM paper_positions WHERE status = 'OPEN'"
                ).fetchall()
                session_time = current_time.time().replace(tzinfo=None)
                for position in opened:
                    entry_date = datetime.fromisoformat(position["entry_time"]).date()
                    if entry_date < current_time.date() or session_time >= SESSION_END:
                        self._close_position(
                            connection,
                            position,
                            position["mark_price"],
                            current_time,
                            "session_end",
                        )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def get_dashboard(self, now=None):
        current_time = self._now(now)
        month_start = current_time.date().replace(day=1).isoformat()
        today = current_time.date().isoformat()

        with self._lock, closing(self._connect()) as connection:
            started_at = connection.execute(
                "SELECT value FROM paper_meta WHERE key = 'started_at'"
            ).fetchone()["value"]
            open_rows = connection.execute(
                "SELECT * FROM paper_positions WHERE status = 'OPEN' ORDER BY entry_time DESC"
            ).fetchall()
            closed_rows = connection.execute(
                "SELECT * FROM paper_positions WHERE status = 'CLOSED' ORDER BY exit_time DESC"
            ).fetchall()

        open_positions = []
        for row in open_rows:
            item = dict(row)
            item["unrealized_pnl"] = round(self._unrealized(row), 2)
            open_positions.append(item)

        all_realized = sum(float(row["realized_pnl"] or 0) for row in closed_rows)
        all_unrealized = sum(item["unrealized_pnl"] for item in open_positions)
        month_closed = [row for row in closed_rows if row["exit_time"][:10] >= month_start]
        month_open = [row for row in open_positions if row["entry_time"][:10] >= month_start]
        today_closed = [row for row in closed_rows if row["exit_time"][:10] == today]
        today_open = [row for row in open_positions if row["entry_time"][:10] == today]

        daily = {}
        for row in month_closed:
            day = row["exit_time"][:10]
            summary = daily.setdefault(day, {"date": day, "realized_pnl": 0.0, "unrealized_pnl": 0.0, "trades": 0})
            summary["realized_pnl"] += float(row["realized_pnl"] or 0)
            summary["trades"] += 1
        for row in month_open:
            day = row["entry_time"][:10]
            summary = daily.setdefault(day, {"date": day, "realized_pnl": 0.0, "unrealized_pnl": 0.0, "trades": 0})
            summary["unrealized_pnl"] += row["unrealized_pnl"]

        weekly = {}
        for summary in daily.values():
            day = datetime.fromisoformat(summary["date"]).date()
            week_start = (day - timedelta(days=day.weekday())).isoformat()
            item = weekly.setdefault(
                week_start,
                {"week_start": week_start, "realized_pnl": 0.0, "unrealized_pnl": 0.0, "trades": 0},
            )
            item["realized_pnl"] += summary["realized_pnl"]
            item["unrealized_pnl"] += summary["unrealized_pnl"]
            item["trades"] += summary["trades"]

        for summary in daily.values():
            summary["realized_pnl"] = round(summary["realized_pnl"], 2)
            summary["unrealized_pnl"] = round(summary["unrealized_pnl"], 2)
            summary["net_pnl"] = round(summary["realized_pnl"] + summary["unrealized_pnl"], 2)
        for summary in weekly.values():
            summary["realized_pnl"] = round(summary["realized_pnl"], 2)
            summary["unrealized_pnl"] = round(summary["unrealized_pnl"], 2)
            summary["net_pnl"] = round(summary["realized_pnl"] + summary["unrealized_pnl"], 2)

        trades = [dict(row) for row in closed_rows[:100]]
        trades.extend(dict(row) for row in open_rows[:100])
        trades.sort(key=lambda item: item["exit_time"] or item["entry_time"], reverse=True)

        month_realized = sum(float(row["realized_pnl"] or 0) for row in month_closed)
        month_unrealized = sum(row["unrealized_pnl"] for row in month_open)
        today_realized = sum(float(row["realized_pnl"] or 0) for row in today_closed)
        today_unrealized = sum(row["unrealized_pnl"] for row in today_open)

        return {
            "started_at": started_at,
            "tracking_start_date": started_at[:10],
            "mode": "OPTIONS_ONLY_PAPER",
            "quantity": 1,
            "policy": "BUY opens long; SELL closes long and opens short; opposite signal/session end exits",
            "summary": {
                "realized_pnl": round(all_realized, 2),
                "unrealized_pnl": round(all_unrealized, 2),
                "net_pnl": round(all_realized + all_unrealized, 2),
                "month_realized_pnl": round(month_realized, 2),
                "month_unrealized_pnl": round(month_unrealized, 2),
                "month_net_pnl": round(month_realized + month_unrealized, 2),
                "today_realized_pnl": round(today_realized, 2),
                "today_unrealized_pnl": round(today_unrealized, 2),
                "today_net_pnl": round(today_realized + today_unrealized, 2),
                "open_positions": len(open_positions),
                "closed_trades": len(closed_rows),
                "wins": sum(1 for row in closed_rows if float(row["realized_pnl"] or 0) > 0),
                "losses": sum(1 for row in closed_rows if float(row["realized_pnl"] or 0) < 0),
            },
            "daily": sorted(daily.values(), key=lambda item: item["date"], reverse=True),
            "weekly": sorted(weekly.values(), key=lambda item: item["week_start"], reverse=True),
            "open_positions": open_positions,
            "trades": trades,
        }
