from fyers_apiv3 import fyersModel
from fyers_apiv3.FyersWebsocket import data_ws
import pandas as pd
import numpy as np
import time
from datetime import datetime, timedelta
import threading
import json
import websocket
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor
import os

# ====================================================================================================
# SECTION 1: SP BOT CORE SETTINGS
# ====================================================================================================
BOT_TIMEFRAME = 5           
ATR_MULTIPLIER = 1.75       
ATR_PERIOD = 2.0            
TARGET_MULT = 2.0           
HISTORY_DAYS = 2            
ALERT_GAP = 5.50            

APP_ID = "RMZGEPFSHB-100"

# ====================================================================================================
# SECTION 2: FYERS API CONNECTION
# ====================================================================================================
try:
    with open("fyers_token.txt", "r") as f: 
        raw_token = f.read().strip()
    access_token = f"{APP_ID}:{raw_token}" if ":" not in raw_token else raw_token
    fyers_api = fyersModel.FyersModel(client_id=APP_ID, is_async=False, token=raw_token, log_path="")
except Exception as e:
    print("❌ Fyers Token Error. Please generate token first.")

# ====================================================================================================
# SECTION 3: COMPLETE STOCK & INDEX SYMBOLS LIST
# ====================================================================================================
NIFTY_50_STOCKs = ["NSE:NIFTY50-INDEX", "NSE:ADANIENT-EQ", "NSE:ADANIPORTS-EQ", "NSE:APOLLOHOSP-EQ", "NSE:ASIANPAINT-EQ", "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", "NSE:BPCL-EQ", "NSE:BHARTIARTL-EQ", "NSE:BRITANNIA-EQ", "NSE:CIPLA-EQ", "NSE:COALINDIA-EQ", "NSE:DIVISLAB-EQ", "NSE:DRREDDY-EQ", "NSE:EICHERMOT-EQ", "NSE:GRASIM-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCBANK-EQ", "NSE:HDFCLIFE-EQ", "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ", "NSE:INDUSINDBK-EQ", "NSE:INFY-EQ", "NSE:ITC-EQ", "NSE:JSWSTEEL-EQ", "NSE:KOTAKBANK-EQ", "NSE:LT-EQ", "NSE:M&M-EQ", "NSE:MARUTI-EQ", "NSE:NTPC-EQ", "NSE:NESTLEIND-EQ", "NSE:ONGC-EQ", "NSE:POWERGRID-EQ", "NSE:RELIANCE-EQ", "NSE:SBILIFE-EQ", "NSE:SBIN-EQ", "NSE:SUNPHARMA-EQ", "NSE:TCS-EQ", "NSE:TATACONSUM-EQ", "NSE:TMPV-EQ", "NSE:TATASTEEL-EQ", "NSE:TECHM-EQ", "NSE:TITAN-EQ", "NSE:UPL-EQ", "NSE:ULTRACEMCO-EQ", "NSE:WIPRO-EQ"]
BANK_NIFTY_STOCKs = ["NSE:NIFTYBANK-INDEX", "NSE:AUBANK-EQ", "NSE:BANDHANBNK-EQ", "NSE:BANKBARODA-EQ", "NSE:FEDERALBNK-EQ", "NSE:IDFCFIRSTB-EQ", "NSE:PNB-EQ"]
fin_NIFTY_STOCKs = ["NSE:FINNIFTY-INDEX", "NSE:CHOLAFIN-EQ", "NSE:HDFCAMC-EQ", "NSE:ICICIGI-EQ", "NSE:ICICIPRULI-EQ", "NSE:MUTHOOTFIN-EQ", "NSE:RPEL-EQ", "NSE:KPEL-EQ", "NSE:PFC-EQ", "NSE:RECLTD-EQ", "NSE:SBICARD-EQ", "NSE:SHRIRAMFIN-EQ"]
MIDCAP_NIFTY_STOCKs = ["NSE:NIFTYMIDCAP50-INDEX", "NSE:ALKEM-EQ", "NSE:ASHOKLEY-EQ", "NSE:ASTRAL-EQ", "NSE:AUROPHARMA-EQ", "NSE:BALKRISIND-EQ", "NSE:BANKINDIA-EQ", "NSE:BHARATFORG-EQ", "NSE:BHEL-EQ", "NSE:BIOCON-EQ", "NSE:BOSCHLTD-EQ", "NSE:CANBK-EQ", "NSE:COFORGE-EQ", "NSE:CONCOR-EQ", "NSE:CUMMINSIND-EQ", "NSE:DIXON-EQ", "NSE:ESCORTS-EQ", "NSE:GODREJPROP-EQ", "NSE:IDEA-EQ", "NSE:IGL-EQ", "NSE:INDHOTEL-EQ", "NSE:INDUSTOWER-EQ", "NSE:JINDALSTEL-EQ", "NSE:JSWENERGY-EQ", "NSE:JUBLFOOD-EQ", "NSE:LICHSGFIN-EQ", "NSE:LUPIN-EQ", "NSE:M&MFIN-EQ", "NSE:MRF-EQ", "NSE:NMDC-EQ", "NSE:OBEROIRLTY-EQ", "NSE:PAGEIND-EQ", "NSE:PERSISTENT-EQ", "NSE:PETRONET-EQ", "NSE:PIIND-EQ", "NSE:POLYCAB-EQ", "NSE:SAIL-EQ", "NSE:SIEMENS-EQ", "NSE:SRF-EQ", "NSE:TATACOMM-EQ", "NSE:TRENT-EQ", "NSE:TVSMOTOR-EQ", "NSE:UBL-EQ", "NSE:VOLTAS-EQ"]
SENSEX_STOCKs = ["BSE:SENSEX-INDEX"]
GLOBAL_STOCKs = ["BITCOIN", "ETHEREUM", "GOLD", "SILVER", "USOIL"]

# ====================================================================================================
# SECTION 4: OPTIONS LOGIC & AUTO-COMMODITY
# ====================================================================================================
def get_auto_commodity_symbols():
    today = datetime.now()
    crude_m, crude_y = today.month, today.year
    if today.day >= 18: 
        crude_m += 1
        if crude_m > 12: crude_m, crude_y = 1, crude_y + 1
    crude_dt = datetime(crude_y, crude_m, 1)
    
    gold_m, gold_y = None, today.year
    for m in [2, 4, 6, 8, 10, 12]:
        if m > today.month or (m == today.month and today.day < 24): 
            gold_m = m; break
    if gold_m is None: gold_m, gold_y = 2, gold_y + 1
    gold_dt = datetime(gold_y, gold_m, 1)

    silver_m, silver_y = None, today.year
    for m in [3, 5, 7, 9, 12]:
        if m > today.month or (m == today.month and today.day < 24): 
            silver_m = m; break
    if silver_m is None: silver_m, silver_y = 3, silver_y + 1
    silver_dt = datetime(silver_y, silver_m, 1)

    return [f"MCX:GOLD{gold_dt.strftime('%y')}{gold_dt.strftime('%b').upper()}FUT", 
            f"MCX:SILVER{silver_dt.strftime('%y')}{silver_dt.strftime('%b').upper()}FUT", 
            f"MCX:CRUDEOIL{crude_dt.strftime('%y')}{crude_dt.strftime('%b').upper()}FUT"]

Commodity_STOCKs = get_auto_commodity_symbols()

def get_920_spot_price(index_sym, fallback_price):
    now = datetime.now()
    if now < now.replace(hour=9, minute=20, second=0):
        try:
            q = fyers_api.quotes({"symbols": index_sym})
            if q.get('s') == 'ok' and 'd' in q: return q['d'][0]['v']['lp']
        except: pass
        return fallback_price
    
    today_str = now.strftime("%Y-%m-%d")
    data = {"symbol": index_sym, "resolution": str(BOT_TIMEFRAME), "date_format": "1", "range_from": today_str, "range_to": today_str, "cont_flag": "1"}
    try:
        res = fyers_api.history(data=data)
        if res.get('s') == 'ok' and 'candles' in res:
            for c in res['candles']:
                if datetime.fromtimestamp(c[0]).hour == 9 and datetime.fromtimestamp(c[0]).minute == 15: return c[4]
            return res['candles'][0][4]
    except: pass
    return fallback_price

def fetch_fyers_option_chain(index_sym, base_symbol, exchange, strike_diff, default_spot):
    spot = get_920_spot_price(index_sym, default_spot)
    atm_strike = int(round(spot / strike_diff) * strike_diff)
    try:
        res = fyers_api.optionchain(data={"symbol": index_sym, "strikecount": 15, "timestamp": ""})
        if res.get('s') == 'ok' and 'optionsChain' in res['data']:
            chain = res['data']['optionsChain']
            ce_opts = sorted([x for x in chain if x.get('option_type') == 'CE'], key=lambda x: x['strike_price'])
            pe_opts = sorted([x for x in chain if x.get('option_type') == 'PE'], key=lambda x: x['strike_price'])
            
            call_list, put_list = [], []
            atm_ce = min(ce_opts, key=lambda x: abs(x['strike_price'] - atm_strike))
            atm_pe = min(pe_opts, key=lambda x: abs(x['strike_price'] - atm_strike))
            
            for idx, item in enumerate([x for x in ce_opts if x['strike_price'] < atm_strike][-5:], 1): call_list.append({'symbol': item['symbol'], 'clean_name': item['symbol'].split(":")[1], 'type_label': f"CALL ITM {6-idx}"})
            call_list.append({'symbol': atm_ce['symbol'], 'clean_name': atm_ce['symbol'].split(":")[1], 'type_label': "CALL ATM"})
            for idx, item in enumerate([x for x in ce_opts if x['strike_price'] > atm_strike][:5], 1): call_list.append({'symbol': item['symbol'], 'clean_name': item['symbol'].split(":")[1], 'type_label': f"CALL OTM {idx}"})
            
            for idx, item in enumerate(reversed([x for x in pe_opts if x['strike_price'] > atm_strike][:5]), 1): put_list.append({'symbol': item['symbol'], 'clean_name': item['symbol'].split(":")[1], 'type_label': f"PUT ITM {6-idx}"})
            put_list.append({'symbol': atm_pe['symbol'], 'clean_name': atm_pe['symbol'].split(":")[1], 'type_label': "PUT ATM"})
            for idx, item in enumerate(reversed([x for x in pe_opts if x['strike_price'] < atm_strike][-5:]), 1): put_list.append({'symbol': item['symbol'], 'clean_name': item['symbol'].split(":")[1], 'type_label': f"PUT OTM {idx}"})
            
            return call_list + put_list
    except: pass
    return []

# ====================================================================================================
# SECTION 5: PINE SCRIPT "SP BOT" ENGINE (STRICTLY NON-REPAINTING / NEXT CANDLE + HEIKIN ASHI)
# ====================================================================================================
# ====================================================================================================
# SECTION 5: PINE SCRIPT "SP BOT" ENGINE (STRICTLY NON-REPAINTING / NEXT CANDLE + HEIKIN ASHI)
# ====================================================================================================
def calculate_rma(series, length):
    alpha = 1.0 / length
    rma_vals = np.zeros(len(series))
    rma_vals[0] = series.iloc[0] 
    for i in range(1, len(series)): 
        rma_vals[i] = alpha * series.iloc[i] + (1 - alpha) * rma_vals[i-1]
    return rma_vals

def process_historical_data(df):
    # 1. 🚨 NORMAL OHLC TO HEIKIN ASHI CONVERSION 🚨
    ha_df = pd.DataFrame(index=df.index)
    ha_df['time'] = df['time']
    
    ha_close = (df['open'] + df['high'] + df['low'] + df['close']) / 4
    ha_open = np.zeros(len(df))
    ha_open[0] = (df['open'].iloc[0] + df['close'].iloc[0]) / 2 # Initial HA Open
    
    for i in range(1, len(df)):
        ha_open[i] = (ha_open[i-1] + ha_close.iloc[i-1]) / 2
        
    ha_df['HA_Open'] = ha_open
    ha_df['HA_Close'] = ha_close
    ha_df['HA_High'] = pd.concat([df['high'], ha_df['HA_Open'], ha_df['HA_Close']], axis=1).max(axis=1)
    ha_df['HA_Low'] = pd.concat([df['low'], ha_df['HA_Open'], ha_df['HA_Close']], axis=1).min(axis=1)

    # 2. 🚨 SP BOT LOGIC USING HEIKIN ASHI CANDLES 🚨
    ha_df['src'] = (ha_df['HA_Open'] + ha_df['HA_High'] + ha_df['HA_Low'] + ha_df['HA_Close']) / 4
    ha_df['prev_close'] = ha_df['HA_Close'].shift(1).fillna(ha_df['HA_Close'].iloc[0])
    
    # ATR Calculation
    ha_df['TR'] = pd.concat([
        ha_df['HA_High'] - ha_df['HA_Low'], 
        (ha_df['HA_High'] - ha_df['prev_close']).abs(), 
        (ha_df['HA_Low'] - ha_df['prev_close']).abs()
    ], axis=1).max(axis=1)
    
    ha_df['ATR'] = calculate_rma(ha_df['TR'], ATR_PERIOD)
    ha_df['loss'] = ha_df['ATR'] * ATR_MULTIPLIER
    
    src = ha_df['src'].values
    loss = ha_df['loss'].values
    t_stop = np.zeros(len(ha_df))
    t_stop[0] = src[0]
    
    eprice, lsig, etime, cSL, cTGT = 0.0, "WAIT⚪", "-", 0.0, 0.0
    
    # 'last_idx' current running (unclosed) candle hai
    last_idx = len(ha_df) - 1
    
    for i in range(1, len(ha_df)):
        pt = t_stop[i-1]
        ps = src[i-1]
        cs = src[i]
        cl = loss[i]
        
        # Trailing Stop Calculation
        if cs > pt and ps > pt: 
            t_stop[i] = max(pt, cs - cl)
        elif cs < pt and ps < pt: 
            t_stop[i] = min(pt, cs + cl)
        elif cs > pt: 
            t_stop[i] = cs - cl
        else: 
            t_stop[i] = cs + cl
        
        # 🚨 NEXT CANDLE LOGIC: SIGNAL SIRF CLOSED CANDLES PAR CHECK HOGA 🚨
        if i < last_idx:
            b_buy = (ps <= pt) and (cs > t_stop[i])
            b_sell = (ps >= pt) and (cs < t_stop[i])
            
            if b_buy: 
                eprice, lsig, etime = pt, "BUY🟢", datetime.fromtimestamp(ha_df['time'].iloc[i]).strftime('%d %b, %I:%M:%S %p')
                cSL, cTGT = t_stop[i], pt + abs(pt - t_stop[i]) * TARGET_MULT
            elif b_sell: 
                eprice, lsig, etime = pt, "SELL🔴", datetime.fromtimestamp(ha_df['time'].iloc[i]).strftime('%d %b, %I:%M:%S %p')
                cSL, cTGT = t_stop[i], pt - abs(pt - t_stop[i]) * TARGET_MULT
                
    return {
        'std_open': df['open'].iloc[last_idx], 'std_high': df['high'].iloc[last_idx], 'std_low': df['low'].iloc[last_idx], 'std_close': df['close'].iloc[last_idx], 
        'ha_open': ha_df['HA_Open'].iloc[last_idx], 'ha_high': ha_df['HA_High'].iloc[last_idx], 'ha_low': ha_df['HA_Low'].iloc[last_idx], 'ha_close': ha_df['HA_Close'].iloc[last_idx],
        'prev_ha_close': ha_df['HA_Close'].iloc[last_idx-1] if last_idx > 0 else ha_df['HA_Close'].iloc[0], 
        
        'prev_tstop': t_stop[last_idx-1] if last_idx > 0 else t_stop[0], 
        'prev_src': src[last_idx-1] if last_idx > 0 else src[0], 
        'prev_atr': ha_df['ATR'].iloc[last_idx-1] if last_idx > 0 else ha_df['ATR'].iloc[0], 
        
        'ePrice': eprice, 'eTime': etime, 'Signal': lsig, 'cTGT': cTGT, 'cSL': cSL, 
        'current_candle_min': (datetime.fromtimestamp(ha_df['time'].iloc[last_idx]).minute // BOT_TIMEFRAME) * BOT_TIMEFRAME, 
        
        'live_tstop': t_stop[last_idx], 'live_src': src[last_idx], 'live_atr': ha_df['ATR'].iloc[last_idx]
    }

def universal_live_tick_processor(sym, ltp, timestamp):
    if sym not in master_state:
        if sym in GLOBAL_STOCKs: 
            master_state[sym] = {'std_open': ltp, 'std_high': ltp, 'std_low': ltp, 'std_close': ltp, 'ha_open': ltp, 'ha_high': ltp, 'ha_low': ltp, 'ha_close': ltp, 'prev_ha_close': ltp, 'prev_tstop': ltp, 'prev_src': ltp, 'prev_atr': 1.0, 'ePrice': 0.0, 'eTime': '-', 'Signal': 'WAIT⚪', 'cTGT': 0.0, 'cSL': 0.0, 'current_candle_min': (datetime.fromtimestamp(timestamp).minute // BOT_TIMEFRAME) * BOT_TIMEFRAME, 'live_tstop': ltp, 'live_src': ltp, 'live_atr': 1.0}
        else: 
            return
            
    s = master_state[sym]
    dt = datetime.fromtimestamp(timestamp)
    
    # 🔥 FIXED: Candle close logic based on Fyers timestamp
    current_min = dt.minute
    expected_candle_start_min = (current_min // BOT_TIMEFRAME) * BOT_TIMEFRAME
    
    # -------------------------------------------------------------
    # 🚨 STRICT CANDLE CLOSE CONFIRMATION (ANTI-REPAINTING) 🚨
    # -------------------------------------------------------------
    if s['current_candle_min'] != expected_candle_start_min:
        
        older_tstop = s['prev_tstop']
        older_src = s['prev_src']
        closed_src = s['live_src']
        closed_tstop = s['live_tstop']
        
        b_buy = (older_src <= older_tstop) and (closed_src > closed_tstop)
        b_sell = (older_src >= older_tstop) and (closed_src < closed_tstop)
        
        if b_buy and s['Signal'] != "BUY🟢":
            s['ePrice'], s['Signal'], s['eTime'] = older_tstop, "BUY🟢", datetime.now().strftime('%d %b, %I:%M:%S %p')
            s['cSL'], s['cTGT'] = closed_tstop, older_tstop + abs(older_tstop - closed_tstop) * TARGET_MULT
        elif b_sell and s['Signal'] != "SELL🔴":
            s['ePrice'], s['Signal'], s['eTime'] = older_tstop, "SELL🔴", datetime.now().strftime('%d %b, %I:%M:%S %p')
            s['cSL'], s['cTGT'] = closed_tstop, older_tstop - abs(older_tstop - closed_tstop) * TARGET_MULT

        s['prev_tstop'] = closed_tstop
        s['prev_src'] = closed_src
        s['prev_atr'] = s['live_atr']
        s['prev_ha_close'] = s['ha_close']
        
        closed_ha_open = s['ha_open']
        closed_ha_close = s['ha_close']
        
        s['std_open'] = s['std_high'] = s['std_low'] = s['std_close'] = ltp
        
        s['ha_open'] = (closed_ha_open + closed_ha_close) / 2
        s['ha_close'] = (s['std_open'] + s['std_high'] + s['std_low'] + s['std_close']) / 4
        s['ha_high'] = max(s['std_high'], s['ha_open'], s['ha_close'])
        s['ha_low'] = min(s['std_low'], s['ha_open'], s['ha_close'])
        
        s['current_candle_min'] = expected_candle_start_min
        
    else:
        s['std_close'] = ltp
        s['std_high'] = max(s['std_high'], ltp)
        s['std_low'] = min(s['std_low'], ltp)
        
        s['ha_close'] = (s['std_open'] + s['std_high'] + s['std_low'] + s['std_close']) / 4
        s['ha_high'] = max(s['std_high'], s['ha_open'], s['ha_close'])
        s['ha_low'] = min(s['std_low'], s['ha_open'], s['ha_close'])

    # -------------------------------------------------------------
    # LIVE TSL CALCULATION (Heikin Ashi Math)
    # -------------------------------------------------------------
    live_src = (s['ha_open'] + s['ha_high'] + s['ha_low'] + s['ha_close']) / 4
    tr = max(s['ha_high'] - s['ha_low'], abs(s['ha_high'] - s['prev_ha_close']), abs(s['ha_low'] - s['prev_ha_close']))
    
    live_atr = (1.0/ATR_PERIOD) * tr + (1 - 1.0/ATR_PERIOD) * s['prev_atr']
    live_loss = live_atr * ATR_MULTIPLIER
    
    pt = s['prev_tstop']
    ps = s['prev_src']
    
    if live_src > pt and ps > pt: 
        tstop = max(pt, live_src - live_loss)
    elif live_src < pt and ps < pt: 
        tstop = min(pt, live_src + live_loss)
    elif live_src > pt: 
        tstop = live_src - live_loss
    else: 
        tstop = live_src + live_loss
            
    s['live_tstop'], s['live_src'], s['live_atr'] = tstop, live_src, live_atr
    
    breakout = "-"
    if live_src > tstop and s['Signal'] != "BUY🟢": 
        breakout = "BREAK UP 🚀 (Wait Close)"
    elif live_src < tstop and s['Signal'] != "SELL🔴": 
        breakout = "BREAK DOWN 🩸 (Wait Close)"
    
    pl = 0.0
    if s['Signal'] == "BUY🟢" and s['ePrice'] > 0: pl = ltp - s['ePrice']
    elif s['Signal'] == "SELL🔴" and s['ePrice'] > 0: pl = s['ePrice'] - ltp
    
    gap = round(abs(live_src - tstop), 2)
    
    for df in all_dataframes:
        if sym in df.index:
            df.at[sym, "LTP"] = ltp
            df.at[sym, "Signal"] = s['Signal']
            df.at[sym, "Entry_Time"] = s['eTime'] if s['Signal'] != "WAIT⚪" else "-"
            df.at[sym, "Entry_Price"] = round(s['ePrice'], 2) if s['Signal'] != "WAIT⚪" else 0.0
            df.at[sym, "Current_PL"] = round(pl, 2)
            df.at[sym, "Target_Price"] = round(s['cTGT'], 2) if s['Signal'] != "WAIT⚪" else 0.0
            df.at[sym, "Signal_Gap"] = f"🚨{gap}🚨" if gap <= ALERT_GAP else str(gap)
            df.at[sym, "Breakout"] = breakout 
            df.at[sym, "Next BUY/SELL"] = f"SELL : {round(tstop, 2)}" if s['Signal'] == "BUY🟢" else f"BUY : {round(tstop, 2)}"
            break
        
# ====================================================================================================
# SECTION 6: DATAFRAMES INITIALIZATION (ADDED BREAKOUT COLUMN)
# ====================================================================================================
opt_nifty_data = fetch_fyers_option_chain("NSE:NIFTY50-INDEX", "NIFTY", "NSE", 50, 24500)
opt_banknifty_data = fetch_fyers_option_chain("NSE:NIFTYBANK-INDEX", "BANKNIFTY", "NSE", 100, 51500)
opt_sensex_data = fetch_fyers_option_chain("BSE:SENSEX-INDEX", "SENSEX", "BSE", 100, 80000)

def create_category_df(items, cat_name):
    df = pd.DataFrame(columns=["STOCK", "Type", "LTP", "Signal", "Entry_Time", "Entry_Price", "Current_PL", "Target_Price", "Signal_Gap", "Breakout", "Next BUY/SELL", "Category"])
    clean_names, types = [], {}
    for it in items:
        if isinstance(it, dict):
            cname, types[it['clean_name']] = it['clean_name'], it.get('type_label', '-')
            clean_names.append(cname)
        else:
            cname = it.split(":")[1].replace("-EQ", "").replace("-INDEX", "") if ":" in it else it
            types[cname] = "INDEX" if "INDEX" in it else ("GLOBAL" if cname in GLOBAL_STOCKs else "EQUITY")
            clean_names.append(cname)
            
    df["STOCK"] = clean_names
    df.set_index("STOCK", inplace=True)
    for col in ["LTP", "Entry_Price", "Current_PL", "Target_Price"]: df[col] = 0.0
    df["Signal_Gap"], df["Signal"], df["Entry_Time"], df["Breakout"], df["Next BUY/SELL"] = "-", "WAIT⚪", "-", "-", "-"
    df["Category"] = cat_name
    for cname in clean_names: df.at[cname, "Type"] = types.get(cname, "-")
    return df

df_NIFTY50 = create_category_df(NIFTY_50_STOCKs, "NIFTY50")
df_BANKNIFTY = create_category_df(BANK_NIFTY_STOCKs, "BANKNIFTY")
df_finNIFTY = create_category_df(fin_NIFTY_STOCKs, "FINNIFTY")
df_MIDCAP = create_category_df(MIDCAP_NIFTY_STOCKs, "MIDCAP")
df_commodity = create_category_df(Commodity_STOCKs, "COMMODITY")
df_SENSEX = create_category_df(SENSEX_STOCKs, "SENSEX")
df_opt_nifty = create_category_df(opt_nifty_data, "OPT_NIFTY")
df_opt_banknifty = create_category_df(opt_banknifty_data, "OPT_BANKNIFTY")
df_opt_sensex = create_category_df(opt_sensex_data, "OPT_SENSEX")
df_GLOBAL = create_category_df(GLOBAL_STOCKs, "GLOBAL_MARKET (Crypto & Forex)")

all_dataframes = [df_NIFTY50, df_BANKNIFTY, df_finNIFTY, df_MIDCAP, df_commodity, df_SENSEX, df_opt_nifty, df_opt_banknifty, df_opt_sensex, df_GLOBAL]
fyers_symbols = list(set(NIFTY_50_STOCKs + BANK_NIFTY_STOCKs + fin_NIFTY_STOCKs + MIDCAP_NIFTY_STOCKs + Commodity_STOCKs + SENSEX_STOCKs + [x['symbol'] for x in opt_nifty_data] + [x['symbol'] for x in opt_banknifty_data] + [x['symbol'] for x in opt_sensex_data]))

pd.concat([d.reset_index() for d in all_dataframes], ignore_index=True).fillna("").to_csv("LIVE_DATA.csv", index=False)

# ====================================================================================================
# SECTION 7: ROBUST HISTORY FETCHER (ANTI-BLOCK SYSTEM)
# ====================================================================================================
master_state = {}

def get_deep_history_safe(sym, total_days):
    """Fyers ban se bachne ke liye safe retry system"""
    end = datetime.now()
    start = end - timedelta(days=total_days)
    data = {"symbol": sym, "resolution": str(BOT_TIMEFRAME), "date_format": "1", "range_from": start.strftime("%Y-%m-%d"), "range_to": end.strftime("%Y-%m-%d"), "cont_flag": "1"}
    for attempt in range(5):
        try:
            res = fyers_api.history(data=data)
            if res.get('s') == 'ok' and 'candles' in res:
                if len(res['candles']) > 0:
                    time.sleep(0.1) # Thoda aaram taaki block na ho
                    return res['candles']
                return []
            elif res.get('code') == -99: 
                time.sleep(2.0) # Agar jyada request ho gayi toh 2 sec ruko
            else: 
                time.sleep(0.5)
        except: time.sleep(1.0)
    return []

def fetch_worker(sym):
    try:
        clean_name = sym.split(":")[1].replace("-EQ", "").replace("-INDEX", "")
        fetch_days = 1 if ("CE" in sym or "PE" in sym) else HISTORY_DAYS
        candles = get_deep_history_safe(sym, fetch_days)
        if candles and len(candles) > 0:
            df_hist = pd.DataFrame(candles, columns=['time', 'open', 'high', 'low', 'close', 'vol']).drop_duplicates(subset=['time'], keep='last').sort_values('time').reset_index(drop=True)
            return (clean_name, process_historical_data(df_hist), df_hist['close'].iloc[-1])
    except: pass
    return None

print(f"\n⚡ Fetching Fyers History for {len(fyers_symbols)} symbols... (Thoda time lagega safe mode me)")
with ThreadPoolExecutor(max_workers=3) as executor:
    for res in executor.map(fetch_worker, fyers_symbols):
        if res: 
            clean_name, state, last_ltp = res
            master_state[clean_name] = state
            for df in all_dataframes:
                if clean_name in df.index:
                    df.at[clean_name, "LTP"] = last_ltp
                    df.at[clean_name, "Signal"] = state['Signal']
                    df.at[clean_name, "Entry_Time"] = state['eTime']
                    df.at[clean_name, "Entry_Price"] = round(state['ePrice'], 2)
                    df.at[clean_name, "Target_Price"] = round(state['cTGT'], 2)
                    df.at[clean_name, "Next BUY/SELL"] = f"SELL : {round(state['live_tstop'], 2)}" if state['Signal'] == "BUY🟢" else f"BUY : {round(state['live_tstop'], 2)}"

# ====================================================================================================
# SECTION 8: FOREX & CRYPTO GLOBAL MARKET (CONNECTED TO STRATEGY ENGINE)
# ====================================================================================================
def start_global_market():
    
    # 1. Crypto (Binance WebSocket - Ultra Fast 24/7)
    def on_binance(ws, message):
        try:
            data = json.loads(message)
            if 'data' in data:
                sym = "BITCOIN" if data['data']['s'] == "BTCUSDT" else ("ETHEREUM" if data['data']['s'] == "ETHUSDT" else None)
                if sym: 
                    ltp = round(float(data['data']['p']), 2)
                    ts = data['data'].get('E', time.time() * 1000) / 1000
                    universal_live_tick_processor(sym, ltp, ts)
        except: pass

    threading.Thread(target=lambda: websocket.WebSocketApp("wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade", on_message=on_binance).run_forever(), daemon=True).start()

    # 2. Forex & Commodities (Yahoo Direct Hidden API - 100% Anti-Block)
    def fetch_forex_safe():
        import requests
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

        symbols = {'GC=F': 'GOLD', 'SI=F': 'SILVER', 'CL=F': 'USOIL'}
        
        while True:
            try:
                for yf_sym, my_sym in symbols.items():
                    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf_sym}?interval=1m"
                    res = requests.get(url, headers=headers, timeout=5)
                    if res.status_code == 200:
                        data = res.json()
                        price = data['chart']['result'][0]['meta']['regularMarketPrice']
                        universal_live_tick_processor(my_sym, round(price, 2), time.time())
            except Exception as e:
                pass
            time.sleep(3)

    threading.Thread(target=fetch_forex_safe, daemon=True).start()
# ====================================================================================================
# SECTION 9: INDIAN MARKET LIVE DATA (FYERS)
# ====================================================================================================
def fyers_on_message(message):
    try:
        if 'symbol' in message and 'ltp' in message:
            sym = message['symbol'].split(":")[1].replace("-EQ", "").replace("-INDEX", "")
            ltp = message['ltp']
            ts = message.get('exchange_timestamp', time.time())
            if ts > 1e11: ts /= 1000 
            universal_live_tick_processor(sym, ltp, ts) # Seedha Engine me bhej diya!
    except: pass

fyers = data_ws.FyersDataSocket(access_token=access_token, log_path="", litemode=True, write_to_file=False, reconnect=True,
                                on_connect=lambda: fyers.subscribe(symbols=fyers_symbols, data_type="SymbolUpdate"), 
                                on_message=fyers_on_message)

# ====================================================================================================
# SECTION 10: RUN ALL SERVICES (BACKGROUND + LIVE)
# ====================================================================================================
threading.Thread(target=start_global_market, daemon=True).start()

def background_csv_sync():
    while True:
        try: pd.concat([d.reset_index() for d in all_dataframes], ignore_index=True).fillna("").to_csv("LIVE_DATA.csv", index=False)
        except: pass
        time.sleep(1)
threading.Thread(target=background_csv_sync, daemon=True).start()

print("🔴 Bot Connected! Listening to Fyers, Binance & Deriv Live Markets...")
fyers.connect()