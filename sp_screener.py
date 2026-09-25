from fyers_apiv3 import fyersModel
from fyers_apiv3.FyersWebsocket import data_ws
import pandas as pd
import numpy as np
import os
import time
from datetime import datetime, timedelta
import gspread
from oauth2client.service_account import ServiceAccountCredentials

#############################################################################################################################################
# 0. SP BOT SETTINGS (MASTER CONTROL)
#############################################################################################################################################
BOT_TIMEFRAME = 5           
ATR_MULTIPLIER = 1.75       
ATR_PERIOD = 2.0            
TARGET_MULT = 2.0           

# 🔥 SMART LOAD OPTIMIZATION 🔥
# 5-min chart ke liye 4 din ka data bahut hai. Fyers par load nahi padega.
HISTORY_DAYS = 4            
ALERT_GAP = 5.50            

# ⚠️ HAR WEEK CURRENT EXPIRY UPDATE KAREIN ⚠️
NIFTY_EXPIRY = "26OCT"      
BANKNIFTY_EXPIRY = "26OCT"  
SENSEX_EXPIRY = "26OCT"     

################################################################################################################################################
# 1. Google Sheets Setup (Master Sheet Approach)
################################################################################################################################################
print("ALL THING CONECT WITH GOOGLE SHEET")
scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
creds = ServiceAccountCredentials.from_json_keyfile_name("secret_key.json", scope)
client = gspread.authorize(creds)
spreadsheet = client.open("SP_BOT_LIVE")

def get_or_create_sheet(title):
    try: return spreadsheet.worksheet(title)
    except: return spreadsheet.add_worksheet(title=title, rows="100", cols="10")

ws_MASTER = get_or_create_sheet("MASTER_DATA")
print("SHEET CLEANING...")
ws_MASTER.batch_clear(["A1:K1000"])

################################################################################################################################################
# 2. Fyers Token
################################################################################################################################################
with open("fyers_token.txt", "r") as f: raw_token = f.read().strip()
app_id = "RMZGEPFSHB-100"
access_token = f"{app_id}:{raw_token}" if ":" not in raw_token else raw_token

################################################################################################################################################
# 3. STOCK LISTS (Pre-Cleaned, No Duplicates for Light Memory Load)
################################################################################################################################################
NIFTY_50_STOCKs = ["NSE:NIFTY50-INDEX", "NSE:ADANIENT-EQ", "NSE:ADANIPORTS-EQ", "NSE:APOLLOHOSP-EQ", "NSE:ASIANPAINT-EQ", 
    "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", "NSE:BPCL-EQ", 
    "NSE:BHARTIARTL-EQ", "NSE:BRITANNIA-EQ", "NSE:CIPLA-EQ", "NSE:COALINDIA-EQ", "NSE:DIVISLAB-EQ", 
    "NSE:DRREDDY-EQ", "NSE:EICHERMOT-EQ", "NSE:GRASIM-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCBANK-EQ", 
    "NSE:HDFCLIFE-EQ", "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ", 
    "NSE:INDUSINDBK-EQ", "NSE:INFY-EQ", "NSE:ITC-EQ", "NSE:JSWSTEEL-EQ", "NSE:KOTAKBANK-EQ", 
    "NSE:LT-EQ", "NSE:M&M-EQ", "NSE:MARUTI-EQ", "NSE:NTPC-EQ", "NSE:NESTLEIND-EQ", 
    "NSE:ONGC-EQ", "NSE:POWERGRID-EQ", "NSE:RELIANCE-EQ", "NSE:SBILIFE-EQ", "NSE:SBIN-EQ", 
    "NSE:SUNPHARMA-EQ", "NSE:TCS-EQ", "NSE:TATACONSUM-EQ", "NSE:TMCV-EQ", "NSE:TATASTEEL-EQ", 
    "NSE:TECHM-EQ", "NSE:TITAN-EQ", "NSE:UPL-EQ", "NSE:ULTRACEMCO-EQ", "NSE:WIPRO-EQ"]

BANK_NIFTY_STOCKs = ["NSE:NIFTYBANK-INDEX", "NSE:AUBANK-EQ", "NSE:BANDHANBNK-EQ", "NSE:BANKBARODA-EQ", 
    "NSE:FEDERALBNK-EQ", "NSE:IDFCFIRSTB-EQ", "NSE:PNB-EQ"]

fin_NIFTY_STOCKs = ["NSE:FINNIFTY-INDEX", "NSE:CHOLAFIN-EQ", "NSE:HDFCAMC-EQ", "NSE:ICICIGI-EQ", "NSE:ICICIPRULI-EQ",
     "NSE:MUTHOOTFIN-EQ", "NSE:RPEL-EQ", "NSE:KPEL-EQ", "NSE:PFC-EQ", "NSE:RECLTD-EQ", "NSE:SBICARD-EQ", "NSE:SHRIRAMFIN-EQ"]

MIDCAP_NIFTY_STOCKs = ["NSE:NIFTYMIDCAP50-INDEX", "NSE:ALKEM-EQ", "NSE:ASHOKLEY-EQ", "NSE:ASTRAL-EQ", "NSE:AUROPHARMA-EQ", "NSE:BALKRISIND-EQ",
    "NSE:BANKINDIA-EQ", "NSE:BHARATFORG-EQ", "NSE:BHEL-EQ", "NSE:BIOCON-EQ", "NSE:BOSCHLTD-EQ", "NSE:CANBK-EQ", "NSE:COFORGE-EQ", "NSE:CONCOR-EQ",
    "NSE:CUMMINSIND-EQ","NSE:DIXON-EQ", "NSE:ESCORTS-EQ", "NSE:GODREJPROP-EQ", "NSE:IDEA-EQ", "NSE:IGL-EQ","NSE:INDHOTEL-EQ", "NSE:INDUSTOWER-EQ", 
    "NSE:JINDALSTEL-EQ", "NSE:JSWENERGY-EQ", "NSE:JUBLFOOD-EQ","NSE:LICHSGFIN-EQ", "NSE:LUPIN-EQ", "NSE:M&MFIN-EQ", "NSE:MRF-EQ", "NSE:NMDC-EQ", 
    "NSE:OBEROIRLTY-EQ", "NSE:PAGEIND-EQ", "NSE:PERSISTENT-EQ", "NSE:PETRONET-EQ", "NSE:PIIND-EQ", "NSE:POLYCAB-EQ", "NSE:SAIL-EQ", "NSE:SIEMENS-EQ", 
    "NSE:SRF-EQ", "NSE:TATACOMM-EQ", "NSE:TRENT-EQ", "NSE:TVSMOTOR-EQ", "NSE:UBL-EQ", "NSE:VOLTAS-EQ"]

SENSEX_STOCKs = ["BSE:SENSEX-INDEX"]

commodity_STOCKs = ["MCX:GOLD26OCTFUT", "MCX:SILVER26DECFUT", "MCX:CRUDEOIL26OCTFUT"]

def create_category_df(sym_list, cat_name):
    df = pd.DataFrame(columns=["STOCK", "LTP", "Signal", "Entry_Time", "Entry_Price", "Current_PL", "Target_Price", "Signal_Gap", "Next BUY/SELL", "Category"])
    clean_names = [s.split(":")[1].replace("-EQ", "").replace("-INDEX", "") for s in sym_list]
    df["STOCK"] = clean_names
    df.set_index("STOCK", inplace=True)
    for col in ["LTP", "Entry_Price", "Current_PL", "Target_Price"]: df[col] = 0.0
    df["Signal_Gap"], df["Signal"], df["Entry_Time"], df["Next BUY/SELL"] = "-", "WAIT⚪", "-", "-"
    df["Category"] = cat_name
    return df

fyers_api = fyersModel.FyersModel(client_id=app_id, is_async=False, token=raw_token, log_path="")

def get_option_symbols(spot_price, base_symbol, exchange, expiry_tag, strike_diff):
    atm_strike = int(round(spot_price / strike_diff) * strike_diff)
    opt_syms = []
    for i in range(-5, 6):
        strike = atm_strike + (i * strike_diff)
        opt_syms.extend([f"{exchange}:{base_symbol}{expiry_tag}{strike}CE", f"{exchange}:{base_symbol}{expiry_tag}{strike}PE"])
    return opt_syms

print("Fetching Spot Prices to Generate Option Chains...")
spot_nifty, spot_banknifty, spot_sensex = 24000, 50000, 80000 
try:
    res = fyers_api.quotes({"symbols": "NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,BSE:SENSEX-INDEX"})
    if res.get('s') == 'ok':
        for item in res['d']:
            if item['n'] == 'NSE:NIFTY50-INDEX': spot_nifty = item['v']['lp']
            elif item['n'] == 'NSE:NIFTYBANK-INDEX': spot_banknifty = item['v']['lp']
            elif item['n'] == 'BSE:SENSEX-INDEX': spot_sensex = item['v']['lp']
except: pass

opt_nifty_stocks = get_option_symbols(spot_nifty, "NIFTY", "NSE", NIFTY_EXPIRY, 50)
opt_banknifty_stocks = get_option_symbols(spot_banknifty, "BANKNIFTY", "NSE", BANKNIFTY_EXPIRY, 100)
opt_sensex_stocks = get_option_symbols(spot_sensex, "SENSEX", "BSE", SENSEX_EXPIRY, 100)

all_unique_symbols = list(set(NIFTY_50_STOCKs + BANK_NIFTY_STOCKs + fin_NIFTY_STOCKs + MIDCAP_NIFTY_STOCKs + commodity_STOCKs + SENSEX_STOCKs + opt_nifty_stocks + opt_banknifty_stocks + opt_sensex_stocks))

df_NIFTY50 = create_category_df(NIFTY_50_STOCKs, "NIFTY50")
df_BANKNIFTY = create_category_df(BANK_NIFTY_STOCKs, "BANKNIFTY")
df_finNIFTY = create_category_df(fin_NIFTY_STOCKs, "FINNIFTY")
df_MIDCAP = create_category_df(MIDCAP_NIFTY_STOCKs, "MIDCAP")
df_commodity = create_category_df(commodity_STOCKs, "COMMODITY")
df_SENSEX = create_category_df(SENSEX_STOCKs, "SENSEX")
df_opt_nifty = create_category_df(opt_nifty_stocks, "OPT_NIFTY")
df_opt_banknifty = create_category_df(opt_banknifty_stocks, "OPT_BANKNIFTY")
df_opt_sensex = create_category_df(opt_sensex_stocks, "OPT_SENSEX")

all_dataframes = [df_NIFTY50, df_BANKNIFTY, df_finNIFTY, df_MIDCAP, df_commodity, df_SENSEX, df_opt_nifty, df_opt_banknifty, df_opt_sensex]

################################################################################################################################################
# 4. Deep History (SAFE RATE LIMIT - OPTIMIZED PAYLOAD)
################################################################################################################################################
def get_deep_history(sym, total_days):
    end = datetime.now()
    start = end - timedelta(days=total_days)
    all_candles = []
    current_end = end
    while current_end > start:
        current_start = current_end - timedelta(days=90)
        if current_start < start: current_start = start
        data = {"symbol": sym, "resolution": str(BOT_TIMEFRAME), "date_format": "1", "range_from": current_start.strftime("%Y-%m-%d"), "range_to": current_end.strftime("%Y-%m-%d"), "cont_flag": "1"}
        res = fyers_api.history(data=data)
        if 'candles' in res and isinstance(res['candles'], list): all_candles = res['candles'] + all_candles
        current_end = current_start - timedelta(days=1)
        #  SMART SLEEP: Fyers par 0 load
        time.sleep(0.15) 
    return all_candles

def calculate_rma(series, length):
    alpha = 1.0 / length
    rma_vals = np.zeros(len(series))
    rma_vals[0] = series.iloc[0] 
    for i in range(1, len(series)): rma_vals[i] = alpha * series.iloc[i] + (1 - alpha) * rma_vals[i-1]
    return rma_vals

def process_historical_data(df):
    ha_open = np.zeros(len(df))
    ha_open[0] = (df['open'].iloc[0] + df['close'].iloc[0]) / 2
    df['ha_close'] = (df['open'] + df['high'] + df['low'] + df['close']) / 4
    for i in range(1, len(df)): ha_open[i] = (ha_open[i-1] + df['ha_close'].iloc[i-1]) / 2
    df['ha_open'] = ha_open
    df['ha_high'] = df[['high', 'ha_open', 'ha_close']].max(axis=1)
    df['ha_low'] = df[['low', 'ha_open', 'ha_close']].min(axis=1)
    df['ohlc4'] = (df['ha_open'] + df['ha_high'] + df['ha_low'] + df['ha_close']) / 4
    df['prev_ha_close'] = df['ha_close'].shift(1).fillna(df['ha_close'].iloc[0])
    df['TR'] = df[['ha_high', 'ha_low', 'prev_ha_close']].apply(lambda x: max(x['ha_high'] - x['ha_low'], abs(x['ha_high'] - x['prev_ha_close']), abs(x['ha_low'] - x['prev_ha_close'])), axis=1)
    df['ATR'] = calculate_rma(df['TR'], ATR_PERIOD)
    df['loss'] = df['ATR'] * ATR_MULTIPLIER
    src, loss, t_stop = df['ohlc4'].values, df['loss'].values, np.zeros(len(df))
    t_stop[0] = src[0]
    eprice, lsig, etime, cSL, cTGT, tp_mult = 0.0, "WAIT⚪", "-", 0.0, 0.0, TARGET_MULT
    
    for i in range(1, len(df)):
        pt, ps, cs, cl = t_stop[i-1], src[i-1], src[i], loss[i]
        if cs > pt and ps > pt: t_stop[i] = max(pt, cs - cl)
        elif cs < pt and ps < pt: t_stop[i] = min(pt, cs + cl)
        elif cs > pt: t_stop[i] = cs - cl
        else: t_stop[i] = cs + cl
        b_buy, b_sell = (ps <= pt) and (cs > t_stop[i]), (ps >= pt) and (cs < t_stop[i])
        if b_buy: eprice, lsig, etime, cSL = pt, "BUY🟢", datetime.fromtimestamp(df['time'].iloc[i]).strftime('%d %b, %I:%M %p'), t_stop[i]; cTGT = eprice + abs(eprice - cSL) * tp_mult
        elif b_sell: eprice, lsig, etime, cSL = pt, "SELL🔴", datetime.fromtimestamp(df['time'].iloc[i]).strftime('%d %b, %I:%M %p'), t_stop[i]; cTGT = eprice - abs(eprice - cSL) * tp_mult
            
    last_idx = len(df) - 1
    return {'open': df['open'].iloc[last_idx], 'high': df['high'].iloc[last_idx], 'low': df['low'].iloc[last_idx], 'ha_open': df['ha_open'].iloc[last_idx], 'prev_tstop': t_stop[last_idx-1] if last_idx > 0 else t_stop[0], 'prev_src': src[last_idx-1] if last_idx > 0 else src[0], 'prev_ha_close': df['ha_close'].iloc[last_idx-1] if last_idx > 0 else df['ha_close'].iloc[0], 'prev_atr': df['ATR'].iloc[last_idx-1] if last_idx > 0 else df['ATR'].iloc[0], 'ePrice': eprice, 'eTime': etime, 'Signal': lsig, 'cTGT': cTGT, 'cSL': cSL, 'current_candle_min': (datetime.fromtimestamp(df['time'].iloc[last_idx]).minute // BOT_TIMEFRAME) * BOT_TIMEFRAME, 'live_tstop': t_stop[last_idx], 'live_src': src[last_idx], 'live_ha_close': df['ha_close'].iloc[last_idx], 'live_atr': df['ATR'].iloc[last_idx]}

print(f"\n SP BOT: Smart Fetching {len(all_unique_symbols)} Symbols (Zero Load Mode)...")
master_state = {}

for sym in all_unique_symbols:
    try:
        clean_name = sym.split(":")[1].replace("-EQ", "").replace("-INDEX", "")
        #  SMART LOGIC: Options decay hoti hain, toh unka 2 din ka data, aur stocks ka 4 din ka data bahut hai!
        fetch_days = 2 if ("CE" in sym or "PE" in sym) else HISTORY_DAYS
        candles = get_deep_history(sym, fetch_days)
        
        if len(candles) > 0:
            df_hist = pd.DataFrame(candles, columns=['time', 'open', 'high', 'low', 'close', 'vol'])
            df_hist.drop_duplicates(subset=['time'], keep='last', inplace=True)
            df_hist.sort_values('time', inplace=True)
            df_hist.reset_index(drop=True, inplace=True)
            
            state = process_historical_data(df_hist)
            master_state[clean_name] = state
            
            for d in all_dataframes:
                if clean_name in d.index:
                    d.at[clean_name, "LTP"] = df_hist['close'].iloc[-1]
                    d.at[clean_name, "Signal"] = state['Signal']
                    d.at[clean_name, "Entry_Time"] = state['eTime']
                    d.at[clean_name, "Entry_Price"] = round(state['ePrice'], 2)
                    ep = state['ePrice']
                    pl = (state['live_ha_close'] - ep) if state['Signal'] == "BUY🟢" else (ep - state['live_ha_close'])
                    d.at[clean_name, "Current_PL"] = round(pl, 2) if ep > 0 else 0.0
                    d.at[clean_name, "Target_Price"] = round(state['cTGT'], 2)
                    gap_val = round(abs(state['live_src'] - state['live_tstop']), 2)
                    d.at[clean_name, "Signal_Gap"] = f"🚨{gap_val}🚨" if gap_val <= ALERT_GAP else str(gap_val)  
                    d.at[clean_name, "Next BUY/SELL"] = f"SELL : {round(state['live_tstop'], 2)}" if state['Signal'] == "BUY🟢" else f"BUY : {round(state['live_tstop'], 2)}"
    except Exception as e:
        pass

try:
    master_df = pd.concat([d.reset_index() for d in all_dataframes], ignore_index=True).fillna("")
    master_df.to_csv("LIVE_DATA.csv", index=False)
    print("\n Initial Data Saved to LIVE_DATA.csv. Dashboard should show data now!")
except Exception as e:
    pass

################################################################################################################################################
# 5. Live Handling (Web Dashboard Data Creator)
################################################################################################################################################
last_sheet_update = time.time()
last_csv_update = time.time()

def sync_data():
    global last_sheet_update, last_csv_update
    master_df = pd.concat([d.reset_index() for d in all_dataframes], ignore_index=True).fillna("")
    
    if time.time() - last_csv_update > 1:
        master_df.to_csv("LIVE_DATA.csv", index=False)
        last_csv_update = time.time()

    if time.time() - last_sheet_update > 3:
        ws_MASTER.update(range_name='A1', values=[master_df.columns.values.tolist()] + master_df.values.tolist())
        os.system('cls' if os.name == 'nt' else 'clear')
        print(f"=== SP BOT (Live: {datetime.now().strftime('%I:%M:%S %p')}) ===")
        print("Data streaming to Google Sheet & Web Dashboard...")
        last_sheet_update = time.time()

def custom_message(message):
    try:
        if 'symbol' in message and 'ltp' in message:
            sym = message['symbol'].split(":")[1].replace("-EQ", "").replace("-INDEX", "")
            ltp = message['ltp']
            ts = message.get('exchange_timestamp', time.time())
            if ts > 1e11: ts /= 1000 
            
            if sym not in master_state: return
            s = master_state[sym]
            dt = datetime.fromtimestamp(ts)
            candle_min = (dt.minute // BOT_TIMEFRAME) * BOT_TIMEFRAME
            if s['current_candle_min'] != candle_min:
                s['prev_tstop'], s['prev_src'], s['prev_ha_close'], s['prev_atr'] = s['live_tstop'], s['live_src'], s['live_ha_close'], s['live_atr']
                s['ha_open'] = (s['ha_open'] + s['live_ha_close']) / 2
                s['open'] = s['high'] = s['low'] = ltp
                s['current_candle_min'] = candle_min

            s['high'], s['low'] = max(s['high'], ltp), min(s['low'], ltp)
            live_ha_close = (s['open'] + s['high'] + s['low'] + ltp) / 4
            live_ha_high, live_ha_low = max(s['high'], s['ha_open'], live_ha_close), min(s['low'], s['ha_open'], live_ha_close)
            live_src = (s['ha_open'] + live_ha_high + live_ha_low + live_ha_close) / 4
            
            tr = max(live_ha_high - live_ha_low, abs(live_ha_high - s['prev_ha_close']), abs(live_ha_low - s['prev_ha_close']))
            live_atr = (1.0/ATR_PERIOD) * tr + (1 - 1.0/ATR_PERIOD) * s['prev_atr']
            live_loss = live_atr * ATR_MULTIPLIER
            pt, ps = s['prev_tstop'], s['prev_src']
            
            if live_src > pt and ps > pt: tstop = max(pt, live_src - live_loss)
            elif live_src < pt and ps < pt: tstop = min(pt, live_src + live_loss)
            elif live_src > pt: tstop = live_src - live_loss
            else: tstop = live_src + live_loss
                
            b_buy, b_sell = (ps <= pt) and (live_src > tstop), (ps >= pt) and (live_src < tstop)
            if b_buy and s['Signal'] != "BUY🟢":
                s['ePrice'], s['Signal'], s['eTime'], s['cSL'] = pt, "BUY🟢", datetime.now().strftime('%d %b, %I:%M %p'), tstop
                s['cTGT'] = s['ePrice'] + abs(s['ePrice'] - s['cSL']) * TARGET_MULT
            elif b_sell and s['Signal'] != "SELL🔴":
                s['ePrice'], s['Signal'], s['eTime'], s['cSL'] = pt, "SELL🔴", datetime.now().strftime('%d %b, %I:%M %p'), tstop
                s['cTGT'] = s['ePrice'] - abs(s['ePrice'] - s['cSL']) * TARGET_MULT
                
            s['live_tstop'], s['live_src'], s['live_ha_close'], s['live_atr'] = tstop, live_src, live_ha_close, live_atr
            pl = (live_ha_close - s['ePrice']) if s['Signal'] == "BUY🟢" else (s['ePrice'] - live_ha_close)
            gap = round(abs(live_src - tstop), 2)
            
            for df in all_dataframes:
                if sym in df.index:
                    df.at[sym, "LTP"], df.at[sym, "Signal"], df.at[sym, "Entry_Time"], df.at[sym, "Entry_Price"] = ltp, s['Signal'], s['eTime'], round(s['ePrice'], 2)
                    df.at[sym, "Current_PL"], df.at[sym, "Target_Price"] = round(pl, 2) if s['ePrice'] > 0 else 0.0, round(s['cTGT'], 2)
                    df.at[sym, "Signal_Gap"] = f"🚨{gap}🚨" if gap <= ALERT_GAP else str(gap)
                    df.at[sym, "Next BUY/SELL"] = f"SELL : {round(tstop, 2)}" if s['Signal'] == "BUY🟢" else f"BUY : {round(tstop, 2)}"
            
            sync_data()
    except Exception as e: pass

fyers = data_ws.FyersDataSocket(access_token=access_token, log_path="", litemode=True, write_to_file=False, reconnect=True,
    on_connect=lambda: fyers.subscribe(symbols=all_unique_symbols, data_type="SymbolUpdate"), on_close=lambda _: None, on_error=lambda _: None, on_message=custom_message)
fyers.connect()