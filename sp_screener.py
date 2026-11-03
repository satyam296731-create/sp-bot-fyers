import sys

try:
    from fyers_apiv3 import fyersModel
    from fyers_apiv3.FyersWebsocket import data_ws
except Exception:
    fyersModel = None
    data_ws = None

import numpy as np
import time, csv, os, json, pickle, threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor


def ensure_utf8_console():
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        cleaned = []
        for item in args:
            cleaned.append(str(item).encode("ascii", "replace").decode("ascii"))
        print(*cleaned, **kwargs)


ensure_utf8_console()

BOT_TIMEFRAME = 5
ATR_MULTIPLIER = 1.75
ATR_PERIOD = 2.0
TARGET_MULT = 2.0
HISTORY_DAYS = 60
ALERT_GAP = 5.50
APP_ID = "RMZGEPFSHB-100"
SETTINGS_FILE = "sp_settings.json"
USE_HEIKIN_ASHI_CANDLES = True

def load_live_settings():
    global ATR_MULTIPLIER, ATR_PERIOD, ALERT_GAP, USE_HEIKIN_ASHI_CANDLES
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            ATR_MULTIPLIER = float(cfg.get("atr_mult", ATR_MULTIPLIER))
            ATR_PERIOD = float(cfg.get("atr_period", ATR_PERIOD))
            ALERT_GAP = float(cfg.get("alert_gap", ALERT_GAP))
            if "use_ha_candles" in cfg:
                USE_HEIKIN_ASHI_CANDLES = bool(cfg.get("use_ha_candles"))
        except Exception:
            pass

load_live_settings()

def is_option_sym(sym):
    s = str(sym).upper().replace("_HOLD", "").split(":")[-1]
    return len(s) > 4 and (s.endswith("CE") or s.endswith("PE")) and s[-3].isdigit()

def clean_sym(sym):
    s = str(sym).upper().strip()
    return (s.split(":")[1] if ":" in s else s).replace("-EQ", "").replace("-INDEX", "")

def fmt_entry_time(ts_or_dt, is_opt=False):
    dt = datetime.fromtimestamp(int(ts_or_dt)) if isinstance(ts_or_dt, (int, float, np.integer)) else ts_or_dt
    if is_opt and dt.hour == 9 and dt.minute <= 20:
        dt = dt.replace(minute=20, second=0)
    return dt.strftime('%d %b, %I:%M:%S %p')

def step_tstop(pt, ps, cs, cl):
    if cs > pt and ps > pt:
        return max(pt, cs - cl)
    if cs < pt and ps < pt:
        return min(pt, cs + cl)
    return (cs - cl) if cs > pt else (cs + cl)

def calc_tgt(ep, sl, is_buy):
    diff = abs(ep - sl) * TARGET_MULT
    return (ep + diff) if is_buy else (ep - diff)

fyers_api, access_token = None, ""
try:
    with open("fyers_token.txt", "r") as f:
        raw_token = f.read().strip()
    access_token = f"{APP_ID}:{raw_token}" if ":" not in raw_token else raw_token
    pure_token = raw_token.split(":")[1] if ":" in raw_token else raw_token
    fyers_api = fyersModel.FyersModel(client_id=APP_ID, is_async=False, token=pure_token, log_path="")
except Exception:
    safe_print("❌ Fyers Token Error: Pehle fyers_login.py run karein.")

api_lock = threading.Lock()
req_timestamps = []

def throttle_api():
    global req_timestamps
    with api_lock:
        now = time.time()
        req_timestamps = [t for t in req_timestamps if now - t < 60.0]
        if len(req_timestamps) >= 190:
            wait = 60.05 - (now - req_timestamps[0])
            if wait > 0: time.sleep(wait)
            now = time.time()
            req_timestamps = [t for t in req_timestamps if now - t < 60.0]
        if req_timestamps and (now - req_timestamps[-1]) < 0.12:
            time.sleep(0.12 - (now - req_timestamps[-1]))
        req_timestamps.append(time.time())

NIFTY_50_STOCKs = [
    "NSE:NIFTY50-INDEX", "NSE:ADANIENT-EQ", "NSE:ADANIPORTS-EQ", "NSE:APOLLOHOSP-EQ", "NSE:ASIANPAINT-EQ",
    "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", "NSE:BPCL-EQ",
    "NSE:BHARTIARTL-EQ", "NSE:BRITANNIA-EQ", "NSE:CIPLA-EQ", "NSE:COALINDIA-EQ", "NSE:DIVISLAB-EQ",
    "NSE:DRREDDY-EQ", "NSE:EICHERMOT-EQ", "NSE:GRASIM-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCBANK-EQ",
    "NSE:HDFCLIFE-EQ", "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ",
    "NSE:INDUSINDBK-EQ", "NSE:INFY-EQ", "NSE:ITC-EQ", "NSE:JSWSTEEL-EQ", "NSE:KOTAKBANK-EQ",
    "NSE:LT-EQ", "NSE:M&M-EQ", "NSE:MARUTI-EQ", "NSE:NTPC-EQ", "NSE:NESTLEIND-EQ",
    "NSE:ONGC-EQ", "NSE:POWERGRID-EQ", "NSE:RELIANCE-EQ", "NSE:SBILIFE-EQ", "NSE:SBIN-EQ",
    "NSE:SUNPHARMA-EQ", "NSE:TCS-EQ", "NSE:TATACONSUM-EQ", "NSE:TMPV-EQ", "NSE:TATASTEEL-EQ",
    "NSE:TECHM-EQ", "NSE:TITAN-EQ", "NSE:UPL-EQ", "NSE:ULTRACEMCO-EQ", "NSE:WIPRO-EQ"
]
BANK_NIFTY_STOCKs = [
    "NSE:NIFTYBANK-INDEX", "NSE:AUBANK-EQ", "NSE:BANDHANBNK-EQ", "NSE:BANKBARODA-EQ",
    "NSE:FEDERALBNK-EQ", "NSE:IDFCFIRSTB-EQ", "NSE:PNB-EQ"
]
SENSEX_STOCKs = ["BSE:SENSEX-INDEX"]
MIDCAP_NIFTY_STOCKs = [
    "NSE:NIFTYMIDCAP50-INDEX", "NSE:ALKEM-EQ", "NSE:ASHOKLEY-EQ", "NSE:ASTRAL-EQ", "NSE:AUROPHARMA-EQ",
    "NSE:BALKRISIND-EQ", "NSE:BANKINDIA-EQ", "NSE:BHARATFORG-EQ", "NSE:BHEL-EQ", "NSE:BIOCON-EQ",
    "NSE:BOSCHLTD-EQ", "NSE:CANBK-EQ", "NSE:COFORGE-EQ", "NSE:CONCOR-EQ", "NSE:CUMMINSIND-EQ",
    "NSE:DIXON-EQ", "NSE:ESCORTS-EQ", "NSE:GODREJPROP-EQ", "NSE:IDEA-EQ", "NSE:IGL-EQ",
    "NSE:INDHOTEL-EQ", "NSE:INDUSTOWER-EQ", "NSE:JINDALSTEL-EQ", "NSE:JSWENERGY-EQ", "NSE:JUBLFOOD-EQ",
    "NSE:LICHSGFIN-EQ", "NSE:LUPIN-EQ", "NSE:M&MFIN-EQ", "NSE:MRF-EQ", "NSE:NMDC-EQ",
    "NSE:OBEROIRLTY-EQ", "NSE:PAGEIND-EQ", "NSE:PERSISTENT-EQ", "NSE:PETRONET-EQ", "NSE:PIIND-EQ",
    "NSE:POLYCAB-EQ", "NSE:SAIL-EQ", "NSE:SIEMENS-EQ", "NSE:SRF-EQ", "NSE:TATACOMM-EQ",
    "NSE:TRENT-EQ", "NSE:TVSMOTOR-EQ", "NSE:UBL-EQ", "NSE:VOLTAS-EQ"
]
Fin_NIFTY_STOCKs = [
    "NSE:FINNIFTY-INDEX", "NSE:CHOLAFIN-EQ", "NSE:HDFCAMC-EQ", "NSE:ICICIGI-EQ",
    "NSE:MUTHOOTFIN-EQ", "NSE:RPEL-EQ", "NSE:KPEL-EQ", "NSE:PFC-EQ", "NSE:RECLTD-EQ",
    "NSE:SBICARD-EQ", "NSE:SHRIRAMFIN-EQ"
]

def get_auto_commodity_symbols():
    today = datetime.now()
    cm, cy = (1, today.year + 1) if (today.day >= 17 and today.month == 12) else ((today.month + 1, today.year) if today.day >= 17 else (today.month, today.year))
    gm, gy = next(((m, today.year) for m in [2, 4, 6, 8, 10, 12] if m > today.month or (m == today.month and today.day < 4)), (2, today.year + 1))
    sm, sy = next(((m, today.year) for m in [3, 5, 7, 9, 12] if m > today.month or (m == today.month and today.day < 4)), (3, today.year + 1))
    return [
        f"MCX:GOLD{datetime(gy, gm, 1).strftime('%y%b').upper()}FUT",
        f"MCX:SILVER{datetime(sy, sm, 1).strftime('%y%b').upper()}FUT",
        f"MCX:CRUDEOIL{datetime(cy, cm, 1).strftime('%y%b').upper()}FUT"
    ]

Commodity_STOCKs = get_auto_commodity_symbols()

def get_920_spot_price(index_sym, fallback_price):
    now = datetime.now()
    if now.hour < 9 or (now.hour == 9 and now.minute < 20):
        try:
            throttle_api()
            q = fyers_api.quotes({"symbols": index_sym})
            if q.get('s') == 'ok' and q.get('d'): return q['d'][0]['v']['lp']
        except Exception: pass
        return fallback_price
    try:
        throttle_api()
        res = fyers_api.history(data={
            "symbol": index_sym, "resolution": str(BOT_TIMEFRAME), "date_format": "1",
            "range_from": (now - timedelta(days=5)).strftime("%Y-%m-%d"),
            "range_to": now.strftime("%Y-%m-%d"), "cont_flag": "1"
        })
        if res.get('s') == 'ok' and res.get('candles'):
            for c in reversed(res['candles']):
                dt = datetime.fromtimestamp(c[0])
                if dt.hour == 9 and dt.minute == 15: return float(c[4])
            return float(res['candles'][-1][4])
    except Exception: pass
    return fallback_price

def fetch_fyers_option_chain(index_sym, strike_diff, default_spot):
    spot_920 = get_920_spot_price(index_sym, default_spot)
    atm_strike = int(round(spot_920 / strike_diff) * strike_diff)
    try:
        throttle_api()
        res = fyers_api.optionchain(data={"symbol": index_sym, "strikecount": 40, "timestamp": ""})
        if res.get('s') == 'ok' and 'optionsChain' in res.get('data', {}):
            chain = res['data']['optionsChain']
            ce_opts = sorted([x for x in chain if x.get('option_type') == 'CE'], key=lambda x: x['strike_price'])
            pe_opts = sorted([x for x in chain if x.get('option_type') == 'PE'], key=lambda x: x['strike_price'])
            if not ce_opts or not pe_opts: return []

            atm_ce = min(ce_opts, key=lambda x: abs(x['strike_price'] - atm_strike))
            atm_pe = min(pe_opts, key=lambda x: abs(x['strike_price'] - atm_strike))
            mk = lambda it, lbl: {'symbol': it['symbol'], 'clean_name': clean_sym(it['symbol']), 'type_label': lbl}

            call_list = (
                [mk(x, f"CALL ITM {6-i}") for i, x in enumerate([x for x in ce_opts if x['strike_price'] < atm_strike][-5:], 1)] +
                [mk(atm_ce, "CALL ATM")] +
                [mk(x, f"CALL OTM {i}") for i, x in enumerate([x for x in ce_opts if x['strike_price'] > atm_strike][:5], 1)]
            )
            put_list = (
                [mk(x, f"PUT ITM {6-i}") for i, x in enumerate(reversed([x for x in pe_opts if x['strike_price'] > atm_strike][:5]), 1)] +
                [mk(atm_pe, "PUT ATM")] +
                [mk(x, f"PUT OTM {i}") for i, x in enumerate(reversed([x for x in pe_opts if x['strike_price'] < atm_strike][-5:]), 1)]
            )
            return call_list + put_list
    except Exception: pass
    return []

def calc_rma(tr_arr, period):
    n = len(tr_arr)
    rma = np.empty(n, dtype=np.float64)
    if n == 0:
        return rma
    rma[0] = tr_arr[0]
    alpha = 1.0 / max(0.1, float(period))
    one_minus = 1.0 - alpha
    for i in range(1, n):
        rma[i] = alpha * tr_arr[i] + one_minus * rma[i - 1]
    return rma

SHARED_CANDLE_CACHE = {}
SHARED_CACHE_LOCK = threading.Lock()
cache_dirty = False

def process_historical_data_fast(candles_list, full_sym, is_option=False):
    arr = np.asarray(candles_list, dtype=np.float64)
    _, unique_idx = np.unique(arr[:, 0], return_index=True)
    arr = arr[np.sort(unique_idx)]

    times = arr[:, 0].astype(np.int64)
    opens, highs, lows, closes = arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    n = len(times)

    # 1. Heikin-Ashi Candles Calculation
    ha_close = (opens + highs + lows + closes) * 0.25
    ha_open = np.empty(n, dtype=np.float64)
    ha_open[0] = (opens[0] + closes[0]) * 0.5
    for i in range(1, n):
        ha_open[i] = (ha_open[i - 1] + ha_close[i - 1]) * 0.5
    ha_high = np.maximum(highs, np.maximum(ha_open, ha_close))
    ha_low = np.minimum(lows, np.minimum(ha_open, ha_close))

    # =========================================================
    # EXACT TRADINGVIEW PINE SCRIPT ON HEIKIN-ASHI CHART
    # =========================================================
    # 1. Pine Script: src = useHA ? ohlc4 : close (On HA Chart, ohlc4 = HA_OHLC4)
    src = (ha_open + ha_high + ha_low + ha_close) * 0.25

    # 2. Pine Script: ta.tr(true) on Heikin-Ashi High, Low, Prev HA Close
    prev_ha_close = np.empty(n, dtype=np.float64)
    prev_ha_close[0], prev_ha_close[1:] = ha_close[0], ha_close[:-1]
    tr = np.maximum(ha_high - ha_low, np.maximum(np.abs(ha_high - prev_ha_close), np.abs(ha_low - prev_ha_close)))
    tr[0] = ha_high[0] - ha_low[0]

    atr = calc_rma(tr, ATR_PERIOD)
    loss = atr * ATR_MULTIPLIER

    # 3. Pine Script: Trailing Stop (tStop)
    t_stop = np.empty(n, dtype=np.float64)
    t_stop[0] = src[0]

    lsig = "BUY🟢" if src[0] > t_stop[0] else "SELL🔴"
    eprice, etime = float(t_stop[0]), fmt_entry_time(times[0], is_option)
    cSL, cTGT = float(t_stop[0]), 0.0
    last_idx = n - 1
    is_last_live = (time.time() - int(times[last_idx])) < (BOT_TIMEFRAME * 60)
    chart_signals = [None] * n

    for i in range(1, n):
        pt, ps, cs, cl = t_stop[i - 1], src[i - 1], src[i], loss[i]
        t_stop[i] = step_tstop(pt, ps, cs, cl)

        # 4. Pine Script: ta.crossover(eF, tStop) and src > tStop
        b_buy = (cs > t_stop[i]+0.02) and (ps <= pt)
        b_sell = (cs < t_stop[i]-0.02) and (ps >= pt)

        if b_buy: chart_signals[i] = "BUY"
        elif b_sell: chart_signals[i] = "SELL"

        if (i < last_idx or not is_last_live) and (b_buy or b_sell):
            eprice = float(pt)
            lsig = "BUY🟢" if b_buy else "SELL🔴"
            etime = fmt_entry_time(times[i], is_option)
            cSL = float(t_stop[i])
            cTGT = calc_tgt(eprice, cSL, b_buy)

    init_sig, init_eprice, init_etime, init_cSL, init_cTGT = lsig, eprice, etime, cSL, cTGT
    if is_last_live and last_idx > 0:
        b_buy_l = (src[last_idx] > t_stop[last_idx]) and (src[last_idx - 1] <= t_stop[last_idx - 1])
        b_sell_l = (src[last_idx] < t_stop[last_idx]) and (src[last_idx - 1] >= t_stop[last_idx - 1])
        if (b_buy_l and lsig != "BUY🟢") or (b_sell_l and lsig != "SELL🔴"):
            init_sig = "BUY🟢" if b_buy_l else "SELL🔴"
            init_eprice = float(t_stop[last_idx - 1])
            init_etime = fmt_entry_time(times[last_idx], is_option)
            init_cSL = float(t_stop[last_idx])
            init_cTGT = calc_tgt(init_eprice, init_cSL, b_buy_l)

    with SHARED_CACHE_LOCK:
        SHARED_CANDLE_CACHE[(full_sym, "5", round(ATR_MULTIPLIER, 3), round(ATR_PERIOD, 2))] = (time.time(), [
            {
                "time": int(times[i]), "open": float(opens[i]), "high": float(highs[i]),
                "low": float(lows[i]), "close": float(closes[i]),
                "ha_open": float(ha_open[i]), "ha_high": float(ha_high[i]),
                "ha_low": float(ha_low[i]), "ha_close": float(ha_close[i]),
                "tstop": float(t_stop[i]), "signal": chart_signals[i]
            } for i in range(n)
        ])

    eprice_920_hist = 0.0
    latest_session_date = datetime.fromtimestamp(int(times[last_idx])).date()
    for i in range(n):
        dt_hist = datetime.fromtimestamp(int(times[i]))
        if dt_hist.date() == latest_session_date and dt_hist.hour == 9 and dt_hist.minute == 15:
            eprice_920_hist = float(closes[i])

    last_dt = datetime.fromtimestamp(int(times[last_idx]))
    c_min = (last_dt.minute // BOT_TIMEFRAME) * BOT_TIMEFRAME
    c_bucket_dt = last_dt.replace(minute=c_min, second=0, microsecond=0)
    return {
        'full_sym': full_sym,
        'current_candle_ts': int(c_bucket_dt.timestamp()),
        'std_open': float(opens[last_idx]), 'std_high': float(highs[last_idx]),
        'std_low': float(lows[last_idx]), 'std_close': float(closes[last_idx]),
        'ha_open': float(ha_open[last_idx]), 'ha_high': float(ha_high[last_idx]),
        'ha_low': float(ha_low[last_idx]), 'ha_close': float(ha_close[last_idx]),
        'prev_ha_close': float(ha_close[last_idx - 1]) if last_idx > 0 else float(ha_close[0]),
        'prev_tstop': float(t_stop[last_idx - 1]) if last_idx > 0 else float(t_stop[0]),
        'prev_src': float(src[last_idx - 1]) if last_idx > 0 else float(src[0]),
        'prev_atr': float(atr[last_idx - 1]) if last_idx > 0 else float(atr[0]),
        'locked_Signal': lsig, 'locked_ePrice': eprice, 'locked_eTime': etime,
        'locked_cSL': cSL, 'locked_cTGT': cTGT,
        'Signal': init_sig, 'ePrice': init_eprice, 'eTime': init_etime,
        'cSL': init_cSL, 'cTGT': init_cTGT,
        'current_candle_min': c_min, 'current_candle_bucket': (last_dt.date(), last_dt.hour, c_min),
        'live_tstop': float(t_stop[last_idx]), 'live_src': float(src[last_idx]),
        'live_atr': float(atr[last_idx]), 'eprice_920': eprice_920_hist,
        'session_date_str': latest_session_date.strftime('%d %b')
    }

OPTION_INDICES = [
    ("NSE:NIFTY50-INDEX", 50, 24500, "OPT_NIFTY"),
    ("NSE:NIFTYBANK-INDEX", 100, 51500, "OPT_BANKNIFTY"),
    ("BSE:SENSEX-INDEX", 100, 80000, "OPT_SENSEX")
]
opt_chains = {cat: fetch_fyers_option_chain(sym, diff, spot) for sym, diff, spot, cat in OPTION_INDICES}

LIVE_ROWS, SYMBOL_ORDER, master_state, RAW_CANDLES_STORE = {}, [], {}, {}
ROWS_LOCK = threading.Lock()
INVALID_SYMBOLS = set()
rows_dirty = True

def register_items(items, cat_name):
    global rows_dirty
    for it in items:
        cname = it['clean_name'] if isinstance(it, dict) else clean_sym(it)
        t_label = it.get('type_label', '-') if isinstance(it, dict) else ("INDEX" if "INDEX" in it else ("FUT" if "FUT" in it else "EQUITY"))
        if cname not in LIVE_ROWS:
            SYMBOL_ORDER.append(cname)
        LIVE_ROWS[cname] = {
            "STOCK": cname, "Type": t_label, "LTP": 0.0, "Signal": "WAIT⚪",
            "Entry_Time": "-", "Entry_Price": 0.0, "Current_PL": 0.0,
            "Target_Price": 0.0, "Signal_Gap": "-", "Breakout": "-",
            "Next BUY/SELL": "-", "Category": cat_name
        }
    rows_dirty = True

for items, cat in [
    (NIFTY_50_STOCKs, "NIFTY50"), (BANK_NIFTY_STOCKs, "BANKNIFTY"), (SENSEX_STOCKs, "SENSEX"),
    (MIDCAP_NIFTY_STOCKs, "MIDCAP"), (Fin_NIFTY_STOCKs, "FINNIFTY"), (Commodity_STOCKs, "COMMODITY"),
    (opt_chains["OPT_NIFTY"], "OPT_NIFTY"), (opt_chains["OPT_BANKNIFTY"], "OPT_BANKNIFTY"), (opt_chains["OPT_SENSEX"], "OPT_SENSEX")
]:
    register_items(items, cat)

fyers_symbols = list(dict.fromkeys(
    NIFTY_50_STOCKs + BANK_NIFTY_STOCKs + SENSEX_STOCKs + MIDCAP_NIFTY_STOCKs +
    Fin_NIFTY_STOCKs + Commodity_STOCKs +
    [x['symbol'] for ch in opt_chains.values() for x in ch]
))
clean_to_full_map = {clean_sym(s): s for s in fyers_symbols if ":" in s}

def remove_invalid_symbol(sym):
    global rows_dirty
    INVALID_SYMBOLS.add(sym)
    cname = clean_sym(sym)
    with ROWS_LOCK:
        LIVE_ROWS.pop(cname, None)
        if cname in SYMBOL_ORDER:
            SYMBOL_ORDER.remove(cname)
        rows_dirty = True
    if sym in fyers_symbols:
        fyers_symbols.remove(sym)

def fetch_worker(sym):
    try:
        cname = clean_sym(sym)
        is_opt = is_option_sym(cname)
        days = 60
        end = datetime.now()
        data = {
            "symbol": sym, "resolution": str(BOT_TIMEFRAME), "date_format": "1",
            "range_from": (end - timedelta(days=days)).strftime("%Y-%m-%d"),
            "range_to": end.strftime("%Y-%m-%d"), "cont_flag": "1"
        }
        for _ in range(2):
            throttle_api()
            res = fyers_api.history(data=data)
            if res.get('s') == 'ok' and 'candles' in res:
                if res['candles']:
                    candles = res['candles']
                    
                    # --- HISTORICAL DATA FILTER (Only 9:15 to 3:15 for INDEX) ---
                    if "-INDEX" in sym:
                        filtered_candles = []
                        for c in candles:
                            dt = datetime.fromtimestamp(c[0])
                            t_val = dt.hour * 100 + dt.minute
                            if 915 <= t_val <= 1515:
                                filtered_candles.append(c)
                        candles = filtered_candles
                        if not candles:
                            return None
                    # ------------------------------------------------------------
                    
                    RAW_CANDLES_STORE[sym] = candles
                    return (cname, process_historical_data_fast(candles, sym, is_option=is_opt), float(candles[-1][4]))
                data["range_from"] = (end - timedelta(days=days + 5)).strftime("%Y-%m-%d")

            else:
                if 'invalid' in str(res.get('message', '')).lower() or res.get('code') == -300:
                    remove_invalid_symbol(sym)
                    break
                time.sleep(0.3)
    except Exception:
        pass
    return None

def sync_row(cname, s, ltp, breakout="-"):
    global rows_dirty
    is_opt = is_option_sym(cname)
    session_str = s.get('session_date_str') or datetime.now().strftime('%d %b')
    is_hold = ("⚪" not in s['Signal'] and s['eTime'] != "-" and not s['eTime'].startswith(session_str))

    eprice_main = (s.get('eprice_920') or s['ePrice']) if (is_hold and is_opt) else s['ePrice']
    pl_main = (ltp - eprice_main) if s['Signal'] == "BUY🟢" else ((eprice_main - ltp) if s['Signal'] == "SELL🔴" else 0.0)
    pl_hold = (ltp - s['ePrice']) if s['Signal'] == "BUY🟢" else ((s['ePrice'] - ltp) if s['Signal'] == "SELL🔴" else 0.0)

    gap = round(abs(s['live_src'] - s['live_tstop']), 2)
    gap_str = f"🚨{gap}🚨" if gap <= ALERT_GAP else str(gap)
    next_str = f"SELL : {round(s['live_tstop'], 2)}" if s['Signal'] == "BUY🟢" else f"BUY : {round(s['live_tstop'], 2)}"

    with ROWS_LOCK:
        if cname in LIVE_ROWS:
            r = LIVE_ROWS[cname]
            r.update({
                "LTP": ltp, "Signal": s['Signal'],
                "Entry_Time": f"{session_str}, 09:20:00 AM" if (is_hold and is_opt) else (s['eTime'] if s['Signal'] != "WAIT⚪" else "-"),
                "Entry_Price": round(eprice_main, 2) if s['Signal'] != "WAIT⚪" else 0.0,
                "Current_PL": round(pl_main, 2),
                "Target_Price": round(s['cTGT'], 2) if s['Signal'] != "WAIT⚪" else 0.0,
                "Signal_Gap": gap_str, "Breakout": breakout, "Next BUY/SELL": next_str
            })
            hold_sym = cname + "_HOLD"
            if is_hold and is_opt:
                if hold_sym not in LIVE_ROWS:
                    SYMBOL_ORDER.append(hold_sym)
                LIVE_ROWS[hold_sym] = {
                    "STOCK": hold_sym, "Type": r.get("Type", "-"), "LTP": ltp,
                    "Signal": "HOLD " + s['Signal'], "Entry_Time": s['eTime'],
                    "Entry_Price": round(s['ePrice'], 2), "Current_PL": round(pl_hold, 2),
                    "Target_Price": round(s['cTGT'], 2), "Signal_Gap": gap_str,
                    "Breakout": breakout, "Next BUY/SELL": next_str, "Category": "OPT_HOLD_POSITIONS"
                }
            elif hold_sym in LIVE_ROWS:
                del LIVE_ROWS[hold_sym]
            rows_dirty = True

def populate_initial_row(cname, state, last_ltp):
    master_state[cname] = state
    sync_row(cname, state, last_ltp)

def update_chart_cache_entry(s, chart_sig, is_new_bar):
    global cache_dirty
    full_sym = s.get('full_sym')
    if not full_sym or not s.get('current_candle_ts'):
        return
    key = (full_sym, "5", round(ATR_MULTIPLIER, 3), round(ATR_PERIOD, 2))

    with SHARED_CACHE_LOCK:
        if key in SHARED_CANDLE_CACHE:
            _, clist = SHARED_CANDLE_CACHE[key]
            bar_dict = {
                "time": int(s['current_candle_ts']),
                "open": float(s['std_open']), "high": float(s['std_high']),
                "low": float(s['std_low']), "close": float(s['std_close']),
                "ha_open": float(s['ha_open']), "ha_high": float(s['ha_high']),
                "ha_low": float(s['ha_low']), "ha_close": float(s['ha_close']),
                "tstop": float(s['live_tstop']), "signal": chart_sig
            }
            if clist and clist[-1]["time"] == bar_dict["time"]:
                clist[-1] = bar_dict
            elif is_new_bar:
                clist.append(bar_dict)
            SHARED_CANDLE_CACHE[key] = (time.time(), clist)
            cache_dirty = True

def universal_live_tick_processor(sym, ltp, timestamp):
    global rows_dirty
    is_option = is_option_sym(sym)
    s = master_state.get(sym)
    if not s or s['std_open'] == 0.0:
        with ROWS_LOCK:
            if sym in LIVE_ROWS:
                LIVE_ROWS[sym]["LTP"] = ltp
                rows_dirty = True
        return

    dt = datetime.fromtimestamp(timestamp)
    s['session_date_str'] = dt.strftime('%d %b')
    expected_min = (dt.minute // BOT_TIMEFRAME) * BOT_TIMEFRAME
    expected_bucket = (dt.date(), dt.hour, expected_min)

    is_new_bar = (s.get('current_candle_bucket') != expected_bucket)
    if is_new_bar:
        if s['current_candle_min'] == 15 and dt.hour == 9:
            s['eprice_920'] = s['std_close']

        # Exact Heikin-Ashi ohlc4 on candle close
        final_src = (s['ha_open'] + s['ha_high'] + s['ha_low'] + s['ha_close']) * 0.25
        final_tstop = s['live_tstop']
        b_buy_f = (final_src > final_tstop) and (s['prev_src'] <= s['prev_tstop'])
        b_sell_f = (final_src < final_tstop) and (s['prev_src'] >= s['prev_tstop'])
        closed_chart_sig = "BUY" if b_buy_f else ("SELL" if b_sell_f else None)
        update_chart_cache_entry(s, closed_chart_sig, False)

        if (b_buy_f and s['locked_Signal'] != "BUY🟢") or (b_sell_f and s['locked_Signal'] != "SELL🔴"):
            new_sig = "BUY🟢" if b_buy_f else "SELL🔴"
            s['locked_Signal'] = new_sig
            if s['Signal'] == new_sig and s['ePrice'] != 0.0 and not (is_option and s['current_candle_min'] == 15 and dt.hour == 9):
                s['locked_ePrice'], s['locked_eTime'], s['locked_cSL'], s['locked_cTGT'] = s['ePrice'], s['eTime'], s['cSL'], s['cTGT']
            else:
                s['locked_ePrice'] = s['prev_tstop']
                s['locked_eTime'] = fmt_entry_time(dt, is_option and s['current_candle_min'] == 15)
                s['locked_cSL'] = final_tstop
                s['locked_cTGT'] = calc_tgt(s['locked_ePrice'], final_tstop, b_buy_f)

        s['Signal'], s['ePrice'], s['eTime'], s['cSL'], s['cTGT'] = s['locked_Signal'], s['locked_ePrice'], s['locked_eTime'], s['locked_cSL'], s['locked_cTGT']
        # Store previous Heikin-Ashi close in prev_ha_close for HA True Range calculation
        s['prev_tstop'], s['prev_src'], s['prev_atr'], s['prev_ha_close'] = final_tstop, final_src, s['live_atr'], s['ha_close']
        s['ha_open'] = (s['ha_open'] + s['ha_close']) * 0.5
        s['std_open'] = s['std_high'] = s['std_low'] = s['std_close'] = s['ha_close'] = ltp
        s['ha_high'], s['ha_low'] = max(ltp, s['ha_open']), min(ltp, s['ha_open'])
        s['current_candle_min'], s['current_candle_bucket'] = expected_min, expected_bucket
        s['current_candle_ts'] = int(dt.replace(minute=expected_min, second=0, microsecond=0).timestamp())
    else:
        s['std_close'] = ltp
        if ltp > s['std_high']: s['std_high'] = ltp
        if ltp < s['std_low']: s['std_low'] = ltp
        s['ha_close'] = (s['std_open'] + s['std_high'] + s['std_low'] + ltp) * 0.25
        s['ha_high'] = max(s['std_high'], s['ha_open'], s['ha_close'])
        s['ha_low'] = min(s['std_low'], s['ha_open'], s['ha_close'])

    # Live tick calculation using Heikin-Ashi OHLC4 & Heikin-Ashi TR
    live_src = (s['ha_open'] + s['ha_high'] + s['ha_low'] + s['ha_close']) * 0.25
    tr = max(s['ha_high'] - s['ha_low'], abs(s['ha_high'] - s['prev_ha_close']), abs(s['ha_low'] - s['prev_ha_close']))
    alpha = 1.0 / max(0.1, float(ATR_PERIOD))
    live_atr = alpha * tr + (1.0 - alpha) * s['prev_atr']
    tstop = step_tstop(s['prev_tstop'], s['prev_src'], live_src, live_atr * ATR_MULTIPLIER)
    s['live_tstop'], s['live_src'], s['live_atr'] = tstop, live_src, live_atr

    temp_sig, temp_ep, temp_et, temp_sl, temp_tgt = s['locked_Signal'], s['locked_ePrice'], s['locked_eTime'], s['locked_cSL'], s['locked_cTGT']
    b_buy_l = (live_src > tstop + 0.02) and (s['prev_src'] <= s['prev_tstop'])
    b_sell_l = (live_src < tstop - 0.02) and (s['prev_src'] >= s['prev_tstop'])
    chart_sig = "BUY" if b_buy_l else ("SELL" if b_sell_l else None)

    if (b_buy_l and temp_sig != "BUY🟢") or (b_sell_l and temp_sig != "SELL🔴"):
        temp_sig = "BUY🟢" if b_buy_l else "SELL🔴"
        temp_ep = s['prev_tstop']
        temp_et, temp_sl = fmt_entry_time(datetime.now(), is_option), tstop
        temp_tgt = calc_tgt(temp_ep, tstop, b_buy_l)

    s['Signal'], s['ePrice'], s['eTime'], s['cSL'], s['cTGT'] = temp_sig, temp_ep, temp_et, temp_sl, temp_tgt
    breakout = "BREAK UP 🚀" if (s['locked_Signal'] != "BUY🟢" and live_src >= (tstop - ALERT_GAP)) else ("BREAK DOWN 🩸" if (s['locked_Signal'] != "SELL🔴" and live_src <= (tstop + ALERT_GAP)) else "-")
    update_chart_cache_entry(s, chart_sig, is_new_bar)
    sync_row(sym, s, ltp, breakout)

def flush_shared_candle_cache():
    global cache_dirty
    try:
        with SHARED_CACHE_LOCK:
            data_copy = dict(SHARED_CANDLE_CACHE)
            cache_dirty = False
        with open("CANDLE_CACHE.tmp", "wb") as f:
            pickle.dump(data_copy, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace("CANDLE_CACHE.tmp", "CANDLE_CACHE.pkl")
    except Exception:
        pass

def initialize_market_state():
    global _last_cfg_mtime
    safe_print(f"\n🚀 Fetching Fyers History for {len(fyers_symbols)} symbols (Mult={ATR_MULTIPLIER}, Period={ATR_PERIOD}, HA_Mode={USE_HEIKIN_ASHI_CANDLES})...")
    with ThreadPoolExecutor(max_workers=6) as executor:
        for res in executor.map(fetch_worker, list(fyers_symbols)):
            if res:
                populate_initial_row(*res)

    for sym in [s for s in list(fyers_symbols) if clean_sym(s) not in master_state and s not in INVALID_SYMBOLS]:
        res = fetch_worker(sym)
        if res:
            populate_initial_row(*res)
        elif sym not in INVALID_SYMBOLS:
            master_state[clean_sym(sym)] = {
                'full_sym': sym,
                'std_open': 0.0, 'std_high': 0.0, 'std_low': 0.0, 'std_close': 0.0,
                'ha_open': 0.0, 'ha_high': 0.0, 'ha_low': 0.0, 'ha_close': 0.0,
                'prev_c_close': 0.0, 'prev_ha_open': 0.0, 'prev_ha_close': 0.0,
                'prev_tstop': 0.0, 'prev_src': 0.0,
                'locked_Signal': 'WAIT⚪', 'locked_ePrice': 0.0, 'locked_eTime': '-',
                'locked_cSL': 0.0, 'locked_cTGT': 0.0, 'Signal': 'WAIT⚪', 'ePrice': 0.0,
                'eTime': '-', 'cSL': 0.0, 'cTGT': 0.0, 'current_candle_ts': 0,
                'current_candle_min': 0, 'current_candle_bucket': None,
                'is_candle_closed_in_hist': False, 'live_tstop': 0.0, 'live_src': 0.0,
                'eprice_920': 0.0, 'session_date_str': datetime.now().strftime('%d %b'),
                'recent_closes': []
            }

    flush_shared_candle_cache()
    safe_print(f"✅ Loaded {len(master_state)}/{len(fyers_symbols)} valid symbols & synced CANDLE_CACHE.pkl!")
    _last_cfg_mtime = os.path.getmtime(SETTINGS_FILE) if os.path.exists(SETTINGS_FILE) else 0.0
    return _last_cfg_mtime

def background_settings_watcher():
    global ATR_MULTIPLIER, ATR_PERIOD, ALERT_GAP, USE_HEIKIN_ASHI_CANDLES, _last_cfg_mtime
    while True:
        try:
            if os.path.exists(SETTINGS_FILE):
                m = os.path.getmtime(SETTINGS_FILE)
                if m != _last_cfg_mtime:
                    _last_cfg_mtime = m
                    old_m, old_p, old_g, old_ha = ATR_MULTIPLIER, ATR_PERIOD, ALERT_GAP, USE_HEIKIN_ASHI_CANDLES
                    load_live_settings()
                    if (ATR_MULTIPLIER, ATR_PERIOD, ALERT_GAP, USE_HEIKIN_ASHI_CANDLES) != (old_m, old_p, old_g, old_ha):
                        safe_print(f"⚙️ Live Strategy Updated -> Mult: {ATR_MULTIPLIER}, Period: {ATR_PERIOD}, Alert Gap: {ALERT_GAP}, HA: {USE_HEIKIN_ASHI_CANDLES}")
                        with SHARED_CACHE_LOCK:
                            SHARED_CANDLE_CACHE.clear()
                        for full_sym, candles in list(RAW_CANDLES_STORE.items()):
                            cname = clean_sym(full_sym)
                            cur_ltp = LIVE_ROWS.get(cname, {}).get("LTP") or float(candles[-1][4])
                            st = process_historical_data_fast(candles, full_sym, is_option=is_option_sym(cname))
                            populate_initial_row(cname, st, float(cur_ltp))
                        flush_shared_candle_cache()
        except Exception:
            pass
        time.sleep(1.0)

last_refresh_date = None

def background_option_updater():
    global last_refresh_date
    while True:
        now = datetime.now()
        if now.hour == 9 and now.minute == 19 and now.second >= 50 and last_refresh_date != now.date():
            last_refresh_date = now.date()
            try:
                fresh_items = {it['clean_name']: (it, cat) for sym, diff, spot, cat in OPTION_INDICES for it in fetch_fyers_option_chain(sym, diff, spot)}
                to_fetch = [it['symbol'] for cname, (it, _) in fresh_items.items() if cname not in master_state]
                if to_fetch:
                    new_subs = []
                    with ThreadPoolExecutor(max_workers=5) as ex:
                        for res in ex.map(fetch_worker, to_fetch):
                            if res:
                                cname, state, last_ltp = res
                                it, cat = fresh_items[cname]
                                clean_to_full_map[cname] = it['symbol']
                                register_items([it], cat)
                                populate_initial_row(cname, state, last_ltp)
                                new_subs.append(it['symbol'])
                    flush_shared_candle_cache()
                    if new_subs:
                        fyers_symbols.extend(new_subs)
                        fyers.subscribe(symbols=new_subs, data_type="SymbolUpdate")
            except Exception as e:
                safe_print(f"Auto-Updater Error: {e}")
        time.sleep(1)

def fyers_on_message(message):
    try:
        if 'symbol' in message and 'ltp' in message:
            raw_sym = message['symbol']
            ts = message.get('exchange_timestamp', time.time())
            if ts > 1e11:
                ts /= 1000.0
            dt = datetime.fromtimestamp(ts)
            t_val = dt.hour * 100 + dt.minute
            
            # --- LIVE TICK FILTER (Stop at 3:15 PM for INDEX) ---
            if raw_sym.endswith("-INDEX") and (t_val < 915 or t_val > 1515):
                return
            # ----------------------------------------------------

            if ("MCX:" in raw_sym and (t_val < 900 or t_val > 2355)) or ("MCX:" not in raw_sym and (t_val < 915 or t_val > 1530)):
                return
            universal_live_tick_processor(clean_sym(raw_sym), float(message['ltp']), ts)
    except Exception:
        pass

def fyers_on_error(msg):
    if isinstance(msg, dict) and msg.get('code') == -300 and msg.get('invalid_symbols'):
        for bad_sym in msg['invalid_symbols']:
            remove_invalid_symbol(bad_sym)
        valid_subs = [s for s in fyers_symbols if s not in INVALID_SYMBOLS]
        if valid_subs:
            fyers.subscribe(symbols=valid_subs, data_type="SymbolUpdate")

fyers = None

CSV_COLUMNS = ["STOCK", "Type", "LTP", "Signal", "Entry_Time", "Entry_Price", "Current_PL", "Target_Price", "Signal_Gap", "Breakout", "Next BUY/SELL", "Category"]

def background_csv_sync():
    global rows_dirty, cache_dirty
    last_cache_flush = time.time()
    while True:
        if rows_dirty:
            try:
                with ROWS_LOCK:
                    records = [LIVE_ROWS[k].copy() for k in SYMBOL_ORDER if k in LIVE_ROWS]
                    rows_dirty = False
                with open("LIVE_DATA.tmp", "w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
                    writer.writeheader()
                    writer.writerows(records)
                os.replace("LIVE_DATA.tmp", "LIVE_DATA.csv")
            except Exception:
                pass
        if cache_dirty and (time.time() - last_cache_flush) >= 2.0:
            flush_shared_candle_cache()
            last_cache_flush = time.time()
        time.sleep(0.25)


def main():
    global fyers
    if data_ws is None:
        raise RuntimeError("fyers_apiv3 is not available; cannot start the screener.")
    initialize_market_state()
    fyers = data_ws.FyersDataSocket(
        access_token=access_token, log_path="", litemode=True, write_to_file=False, reconnect=True,
        on_connect=lambda: fyers.subscribe(symbols=[s for s in fyers_symbols if s not in INVALID_SYMBOLS], data_type="SymbolUpdate"),
        on_message=fyers_on_message,
        on_error=fyers_on_error
    )
    threading.Thread(target=background_csv_sync, daemon=True).start()
    threading.Thread(target=background_option_updater, daemon=True).start()
    threading.Thread(target=background_settings_watcher, daemon=True).start()
    safe_print("🔴 SP BOT LIVE! Listening to Fyers WebSocket...")
    fyers.connect()


if __name__ == "__main__":
    main()