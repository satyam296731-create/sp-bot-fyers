from flask import Flask, send_file, request, jsonify
from flask_socketio import SocketIO
import pandas as pd
import numpy as np
import os, re, json, time, pickle, logging, threading
from datetime import datetime, timedelta
from fyers_apiv3 import fyersModel
from paper_trading import PaperTradingEngine

logging.getLogger('werkzeug').setLevel(logging.ERROR)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(BASE_DIR, "templates", "index.html")
FALLBACK_HTML_PATH = os.path.join(BASE_DIR, "index.html")
SETTINGS_FILE = os.path.join(BASE_DIR, "sp_settings.json")
LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
PAPER_ENGINE = PaperTradingEngine(os.path.join(BASE_DIR, "paper_trading.sqlite3"))

app = Flask(__name__, template_folder=os.path.join(BASE_DIR, "templates"))
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

APP_ID = "RMZGEPFSHB-100"
SYMBOL_ALIASES = {
    "BAJAJFIN": "NSE:BAJFINANCE-EQ", "BAJFIN": "NSE:BAJFINANCE-EQ", "BAJFINANCE": "NSE:BAJFINANCE-EQ",
    "NIFTY": "NSE:NIFTY50-INDEX", "NIFTY50": "NSE:NIFTY50-INDEX", "NIFTY 50": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX", "NIFTYBANK": "NSE:NIFTYBANK-INDEX",
    "SENSEX": "BSE:SENSEX-INDEX", "BSE:SENSEX": "BSE:SENSEX-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX", "MIDCAP": "NSE:NIFTYMIDCAP50-INDEX",
    "NIFTYMIDCAP50": "NSE:NIFTYMIDCAP50-INDEX", "BANKEX": "BSE:BANKEX-INDEX",
}
OPTION_RE = re.compile(r'\d+(CE|PE)$')

def load_sp_settings():
    # Pine Script exact default settings: Mult = 1.75, Period = 2.0
    cfg = {"atr_mult": 1.75, "atr_period": 2.0, "alert_gap": 5.50}
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    return cfg

def save_sp_settings(cfg):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass

def is_option_sym(sym):
    return bool(OPTION_RE.search(str(sym).upper().replace("_HOLD", "").split(":")[-1]))

def to_fyers_symbol(sym_str):
    raw = str(sym_str or "").upper().strip().replace("_HOLD", "")
    if not raw or raw == "NAN": return ""
    if raw in SYMBOL_ALIASES: return SYMBOL_ALIASES[raw]
    prefix, bare = (raw.split(":", 1)[0].strip(), raw.split(":", 1)[1].strip()) if ":" in raw else ("", raw)
    bc = bare.replace("-EQ", "").replace("-INDEX", "")
    if bc in SYMBOL_ALIASES: return SYMBOL_ALIASES[bc]
    if "SENSEX" in bc or "BANKEX" in bc:
        return f"BSE:{bc}" if (is_option_sym(bc) or bc.endswith("FUT")) else f"BSE:{bc}-INDEX"
    if prefix == "MCX" or any(k in bc for k in ("GOLD", "SILVER", "CRUDEOIL", "NATURALGAS", "COPPER", "ZINC")):
        return f"MCX:{bare}"
    if prefix == "BSE":
        return f"BSE:{bare}" if (is_option_sym(bc) or bc.endswith("FUT") or "-" in bare) else f"BSE:{bc}-A"
    if bc in ("NIFTY50", "NIFTYBANK", "FINNIFTY", "NIFTYMIDCAP50", "INDIAVIX"):
        return f"NSE:{bc}-INDEX"
    if is_option_sym(bc) or bc.endswith("FUT"): return f"NSE:{bc}"
    return f"NSE:{bc}-EQ"

_fyers_client, _token_mtime = None, 0.0
_fyers_api_lock, HISTORY_CACHE_LOCK = threading.Lock(), threading.Lock()
_req_timestamps, HISTORY_CACHE, SYMBOL_FETCH_LOCKS = [], {}, {}
CACHED_SCREENER = {"rows": [], "summary": {"total": 0, "buy": 0, "sell": 0, "alerts": 0}}
CACHED_SYMBOLS = []

@app.after_request
def add_no_cache_headers(r):
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return r

def get_fyers_client():
    global _fyers_client, _token_mtime
    tf = os.path.join(BASE_DIR, "fyers_token.txt")
    if os.path.exists(tf):
        try:
            mtime = os.path.getmtime(tf)
            if _fyers_client is None or mtime != _token_mtime:
                raw = open(tf, "r", encoding="utf-8").read().strip()
                token = raw.split(":")[1] if ":" in raw else raw
                _fyers_client = fyersModel.FyersModel(client_id=APP_ID, is_async=False, token=token, log_path=LOG_DIR)
                _token_mtime = mtime
        except Exception:
            pass
    return _fyers_client

def fetch_fyers_history_safe(fyers, data):
    global _req_timestamps
    for _ in range(2):
        try:
            with _fyers_api_lock:
                now = time.time()
                _req_timestamps = [t for t in _req_timestamps if now - t < 60.0]
                if len(_req_timestamps) >= 140:
                    w = 60.05 - (now - _req_timestamps[0])
                    if w > 0: time.sleep(w)
                if _req_timestamps and (time.time() - _req_timestamps[-1]) < 0.22:
                    time.sleep(0.22 - (time.time() - _req_timestamps[-1]))
                _req_timestamps.append(time.time())
            res = fyers.history(data=data)
            if res.get("s") == "ok" and res.get("candles"): return res["candles"]
            msg = str(res.get("message", "")).lower()
            if "invalid" in msg or res.get("code") == -300: return []
            time.sleep(1.2 if (res.get("code") == -429 or "limit" in msg) else 0.3)
        except Exception:
            time.sleep(0.3)
    return []

def compute_sp_candles(candles, atr_mult=1.75, atr_period=2.0):
    arr = np.asarray(candles, dtype=np.float64)
    _, uidx = np.unique(arr[:, 0], return_index=True)
    arr = arr[np.sort(uidx)]
    times = arr[:, 0].astype(np.int64)
    opens, highs, lows, closes = arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    vols = arr[:, 5] if arr.shape[1] > 5 else np.zeros(len(times))
    n = len(times)

    # 1. Pehle Heikin-Ashi Candles بنائیں (Exact TradingView HA Formula)
    ha_close = (opens + highs + lows + closes) * 0.25
    ha_open = np.empty(n, dtype=np.float64)
    ha_open[0] = (opens[0] + closes[0]) * 0.5
    for i in range(1, n):
        ha_open[i] = (ha_open[i - 1] + ha_close[i - 1]) * 0.5
    ha_high = np.maximum(highs, np.maximum(ha_open, ha_close))
    ha_low = np.minimum(lows, np.minimum(ha_open, ha_close))

    # 2. Heikin-Ashi Chart par useHA=true ka matlab hai Heikin-Ashi ka ohlc4 (Double Smoothing)
    src = (ha_open + ha_high + ha_low + ha_close) * 0.25

    # 3. True Range (ta.tr(true)) bhi Heikin-Ashi High, Low aur Prev HA Close par nikalta hai
    prev_hac = np.empty(n, dtype=np.float64)
    prev_hac[0], prev_hac[1:] = ha_close[0], ha_close[:-1]
    tr = np.maximum(ha_high - ha_low, np.maximum(np.abs(ha_high - prev_hac), np.abs(ha_low - prev_hac)))
    tr[0] = ha_high[0] - ha_low[0]

    # 4. Custom Alpha ATR (botAtr)
    rma = np.empty(n, dtype=np.float64)
    rma[0] = tr[0]
    alpha = 1.0 / max(0.1, float(atr_period))
    one_minus = 1.0 - alpha
    for i in range(1, n):
        rma[i] = alpha * tr[i] + one_minus * rma[i - 1]
    loss = rma * float(atr_mult)

    # 5. Yellow Line (tStop) with 2-Candle Confirmation & Crossover Signals
    t_stop = np.empty(n, dtype=np.float64)
    t_stop[0] = src[0]
    signals = [None] * n
    for i in range(1, n):
        pt, ps, cs, cl = t_stop[i - 1], src[i - 1], src[i], loss[i]
        if cs > pt and ps > pt:
            curr_t = max(pt, cs - cl)
        elif cs < pt and ps < pt:
            curr_t = min(pt, cs + cl)
        elif cs > pt:
            curr_t = cs - cl
        else:
            curr_t = cs + cl
        t_stop[i] = curr_t

        # Exact Pine Script: ta.crossover(eF, tStop) and src > tStop
        if (cs > curr_t+0.02) and (ps <= pt):
            signals[i] = "BUY"
        elif (cs < curr_t-0.02) and (ps >= pt):
            signals[i] = "SELL"

    return [{
        "time": int(times[i]), "open": float(opens[i]), "high": float(highs[i]),
        "low": float(lows[i]), "close": float(closes[i]), "volume": float(vols[i]),
        "ha_open": float(ha_open[i]), "ha_high": float(ha_high[i]),
        "ha_low": float(ha_low[i]), "ha_close": float(ha_close[i]),
        "tstop": float(t_stop[i]), "signal": signals[i]
    } for i in range(n)]

FYERS_NATIVE_RES = {"1", "2", "3", "5", "10", "15", "20", "30", "45", "60", "120", "180", "240", "D", "1D"}

def parse_tf(tf_raw):
    s = str(tf_raw or "5").strip().upper()
    if s in ("D", "1D", "DAY"): return "D", None
    if s in ("W", "1W", "WEEK"): return "W", None
    if s.endswith("H"):
        try:
            m = max(1, min(1440, int(s[:-1] or "1") * 60))
            return str(m), m
        except Exception: return "60", 60
    if s.endswith("M"): s = s[:-1]
    try:
        m = max(1, min(1440, int(s)))
        return str(m), m
    except Exception: return "5", 5

def resample_ohlc(candles, target_mins, is_mcx=False):
    if not candles or not target_mins or target_mins <= 1: return candles
    arr = np.asarray(candles, dtype=np.float64)
    _, uidx = np.unique(arr[:, 0], return_index=True)
    arr = arr[np.sort(uidx)]
    times = arr[:, 0].astype(np.int64)
    ist = times + 19800
    day_start = (ist // 86400) * 86400
    anchor = (9 * 3600) if is_mcx else (9 * 3600 + 15 * 60)
    b_sec = int(target_mins) * 60
    b_utc = day_start + anchor + np.floor_divide(ist - day_start - anchor, b_sec) * b_sec - 19800
    ub, f_idx = np.unique(b_utc, return_index=True)
    n = len(arr)
    return [[
        int(ub[i]), float(arr[f_idx[i], 1]),
        float(np.max(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(ub) else n), 2])),
        float(np.min(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(ub) else n), 3])),
        float(arr[(f_idx[i+1] if i+1 < len(ub) else n) - 1, 4]),
        float(np.sum(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(ub) else n), 5])) if arr.shape[1] > 5 else 0.0
    ] for i in range(len(ub))]

def resample_weekly(candles):
    if not candles: return candles
    arr = np.asarray(candles, dtype=np.float64)
    _, uidx = np.unique(arr[:, 0], return_index=True)
    arr = arr[np.sort(uidx)]
    wb = np.asarray([int((datetime.utcfromtimestamp(t + 19800) - timedelta(days=datetime.utcfromtimestamp(t + 19800).weekday())).replace(hour=0, minute=0, second=0).timestamp()) for t in arr[:, 0].astype(np.int64)])
    uw, f_idx = np.unique(wb, return_index=True)
    n = len(arr)
    return [[
        int(arr[f_idx[i], 0]), float(arr[f_idx[i], 1]),
        float(np.max(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(uw) else n), 2])),
        float(np.min(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(uw) else n), 3])),
        float(arr[(f_idx[i+1] if i+1 < len(uw) else n) - 1, 4]),
        float(np.sum(arr[f_idx[i]:(f_idx[i+1] if i+1 < len(uw) else n), 5])) if arr.shape[1] > 5 else 0.0
    ] for i in range(len(uw))]

@app.route("/")
def index():
    return send_file(TEMPLATE_PATH if os.path.exists(TEMPLATE_PATH) else FALLBACK_HTML_PATH)

@app.route("/api/symbols")
def get_symbols(): return jsonify(CACHED_SYMBOLS)

@app.route("/api/screener")
def get_screener(): return jsonify(CACHED_SCREENER)

@app.route("/api/paper-trading")
def get_paper_trading():
    return jsonify(PAPER_ENGINE.get_dashboard())

@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    cfg = load_sp_settings()
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        cfg["atr_mult"] = round(float(body.get("atr_mult", cfg["atr_mult"])), 3)
        cfg["atr_period"] = round(float(body.get("atr_period", cfg["atr_period"])), 2)
        cfg["alert_gap"] = round(float(body.get("alert_gap", cfg["alert_gap"])), 2)
        if "use_ha_candles" in body:
            cfg["use_ha_candles"] = bool(body["use_ha_candles"])
        save_sp_settings(cfg)
        with HISTORY_CACHE_LOCK:
            HISTORY_CACHE.clear()
        socketio.emit("strategy_updated", cfg)
    return jsonify(cfg)

@app.route("/api/history")
def history():
    cfg = load_sp_settings()
    symbol = to_fyers_symbol(request.args.get("symbol", "NSE:NIFTY50-INDEX"))
    tf_norm, tf_mins = parse_tf(request.args.get("timeframe", "5"))
    atr_mult = float(request.args.get("mult", cfg["atr_mult"]) or cfg["atr_mult"])
    atr_period = float(request.args.get("period", cfg["atr_period"]) or cfg["atr_period"])
    cache_key = (symbol, tf_norm, round(atr_mult, 3), round(atr_period, 2))

    with HISTORY_CACHE_LOCK:
        if cache_key in HISTORY_CACHE and time.time() - HISTORY_CACHE[cache_key][0] < 20.0 and HISTORY_CACHE[cache_key][1]:
            return jsonify(HISTORY_CACHE[cache_key][1])
        sym_lock = SYMBOL_FETCH_LOCKS.setdefault(cache_key, threading.Lock())

    with sym_lock:
        with HISTORY_CACHE_LOCK:
            if cache_key in HISTORY_CACHE and time.time() - HISTORY_CACHE[cache_key][0] < 20.0 and HISTORY_CACHE[cache_key][1]:
                return jsonify(HISTORY_CACHE[cache_key][1])
        fyers = get_fyers_client()
        if not fyers: return jsonify([])
        is_deriv, is_mcx = (is_option_sym(symbol) or symbol.endswith("FUT")), symbol.startswith("MCX:")

        if tf_norm in ("D", "W"):
            fyers_res, days, need_res = "D", (120 if is_deriv else 365), (tf_norm == "W")
        elif tf_norm in FYERS_NATIVE_RES:
            fyers_res, need_res = tf_norm, False
            days = 60
        else:
            base_int = next((d for d in (60, 30, 15, 10, 5, 3, 2, 1) if tf_mins % d == 0), 1)
            fyers_res, need_res = str(base_int), True
            days = 60

        # ---- YEH LINE ZAROORI HAI ----
        end_t = datetime.now() 
        # ------------------------------

        candles = fetch_fyers_history_safe(fyers, {
            "symbol": symbol, "resolution": fyers_res, "date_format": "1",
            "range_from": (end_t - timedelta(days=days)).strftime("%Y-%m-%d"),
            "range_to": end_t.strftime("%Y-%m-%d"), "cont_flag": "1"
        })
        
       # --- HISTORICAL CHART FILTER (Only 9:15 to 3:15 for INDEX) ---
        if candles and "-INDEX" in symbol:
            from datetime import timezone  # Ye nayi line add karni hai
            filtered_candles = []
            for c in candles:
                # Niche wali line update ki gayi hai warning hatane ke liye
                dt = datetime.fromtimestamp(c[0] + 19800, timezone.utc)
                t_val = dt.hour * 100 + dt.minute
                if 915 <= t_val <= 1515:
                    filtered_candles.append(c)
            candles = filtered_candles
        # -------------------------------------------------------------

        if not candles:
            with HISTORY_CACHE_LOCK:

                if cache_key in HISTORY_CACHE: return jsonify(HISTORY_CACHE[cache_key][1])
            return jsonify([])
        if need_res:
            candles = resample_weekly(candles) if tf_norm == "W" else resample_ohlc(candles, tf_mins, is_mcx=is_mcx)
        formatted = compute_sp_candles(candles, atr_mult=atr_mult, atr_period=atr_period)
        with HISTORY_CACHE_LOCK:
            HISTORY_CACHE[cache_key] = (time.time(), formatted)
        return jsonify(formatted)

def background_sync_worker():
    global CACHED_SCREENER, CACHED_SYMBOLS
    last_ltp, last_sig, last_csv_m, last_pkl_m, last_push = {}, {}, 0.0, 0.0, 0.0
    last_paper_close_check = 0.0
    pkl_path, csv_path = os.path.join(BASE_DIR, "CANDLE_CACHE.pkl"), os.path.join(BASE_DIR, "LIVE_DATA.csv")

    while True:
        if os.path.exists(pkl_path):
            try:
                pm = os.path.getmtime(pkl_path)
                if pm != last_pkl_m and os.path.getsize(pkl_path) > 0:
                    shared = pickle.load(open(pkl_path, "rb"))
                    last_pkl_m, now_t = pm, time.time()
                    cfg = load_sp_settings()
                    with HISTORY_CACHE_LOCK:
                        for k, val in shared.items():
                            if isinstance(val, tuple) and len(val) == 2 and val[1]:
                                ck = (k[0], k[1], round(cfg["atr_mult"], 3), round(cfg["atr_period"], 2)) if len(k) == 2 else k
                                cts = now_t if (now_t - val[1][-1].get("time", 0)) < 900 else 0.0
                                HISTORY_CACHE[ck] = (cts, val[1])
            except Exception:
                pass

        if os.path.exists(csv_path):
            try:
                cm = os.path.getmtime(csv_path)
                if cm != last_csv_m and os.path.getsize(csv_path) > 0:
                    df = pd.read_csv(csv_path).fillna("")
                    last_csv_m = cm
                    rows, syms, ticks, buy_c, sell_c, alt_c = [], set(), [], 0, 0, 0
                    for r in df.to_dict("records"):
                        st = str(r.get("STOCK", "")).strip()
                        if not st or st.upper() == "NAN": continue
                        fs = to_fyers_symbol(st)
                        if fs: syms.add(fs)
                        sig, gap, brk, nxt = str(r.get("Signal", "WAIT⚪")), str(r.get("Signal_Gap", "-")), str(r.get("Breakout", "-")), str(r.get("Next BUY/SELL", "-"))
                        if "BUY" in sig: buy_c += 1
                        elif "SELL" in sig: sell_c += 1
                        if "🚨" in gap or "BREAK" in brk: alt_c += 1
                        def flt(k):
                            try: return round(float(r.get(k, 0)), 2)
                            except Exception: return 0.0
                        ltp, ep, pl, tp = flt("LTP"), flt("Entry_Price"), flt("Current_PL"), flt("Target_Price")
                        ts_val = 0.0
                        if ":" in nxt:
                            try: ts_val = float(nxt.split(":")[1].strip())
                            except Exception: pass
                        rows.append({
                            "stock": st, "fyers_symbol": fs, "type": str(r.get("Type", "-")), "ltp": ltp,
                            "signal": sig, "entry_time": str(r.get("Entry_Time", "-")), "entry_price": ep,
                            "current_pl": pl, "target_price": tp, "signal_gap": gap, "breakout": brk,
                            "next_level": nxt, "category": str(r.get("Category", "OTHER"))
                        })
                        if "_HOLD" not in st and ltp > 0:
                            cs = st.upper().split(":")[-1].replace("-EQ", "").replace("-INDEX", "")
                            clean_sig = "BUY" if "BUY" in sig else ("SELL" if "SELL" in sig else None)
                            if last_ltp.get(cs) != ltp or last_sig.get(cs) != clean_sig:
                                last_ltp[cs] = ltp
                                last_sig[cs] = clean_sig
                                ticks.append({"symbol": cs, "price": ltp, "tstop": ts_val, "signal": clean_sig, "entry_time": str(r.get("Entry_Time", "-"))})
                    CACHED_SCREENER = {"rows": rows, "summary": {"total": len(rows), "buy": buy_c, "sell": sell_c, "alerts": alt_c}}
                    try:
                        PAPER_ENGINE.process_rows(rows)
                    except Exception:
                        logging.exception("Paper-trading signal processing failed")
                    if syms: CACHED_SYMBOLS = sorted(syms)
                    if ticks: socketio.emit("live_ticks_batch", ticks)
                    if time.time() - last_push >= 1.0:
                        last_push = time.time()
                        socketio.emit("screener_data", CACHED_SCREENER)
            except Exception:
                logging.exception("Dashboard CSV or paper-trading sync failed")
        if time.time() - last_paper_close_check >= 1.0:
            last_paper_close_check = time.time()
            try:
                PAPER_ENGINE.close_expired_positions()
            except Exception:
                logging.exception("Paper-trading session close failed")
        time.sleep(0.25)

if __name__ == "__main__":
    print("🚀 SP BOT PRO TURBO TERMINAL RUNNING: http://localhost:8000")
    threading.Thread(target=background_sync_worker, daemon=True).start()
    socketio.run(app, host="0.0.0.0", port=8000, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)