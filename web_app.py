import os
import sys
import time
import subprocess
import pandas as pd
import streamlit as st
from streamlit.runtime.scriptrunner import get_script_run_ctx

if not get_script_run_ctx():
    subprocess.run([sys.executable, "-m", "streamlit", "run", __file__])
    sys.exit()

st.set_page_config(page_title="SP BOT PRO", layout="wide", initial_sidebar_state="collapsed")

st.markdown("""
    <style>
    .stDataFrame {font-size: 14px;}
    </style>
""", unsafe_allow_html=True)

st.title("🚀 SP BOT Real-Time Dashboard")
st.write("---")

def style_dataframe(val, col_name):
    try:
        if col_name == 'Type':
            if 'ATM' in str(val): return 'background-color: #d4af37; color: #000000; font-weight: bold; border-radius: 4px;'
            elif 'ITM' in str(val): return 'color: #00ff88; font-weight: bold;'
            elif 'OTM' in str(val): return 'color: #00d4ff;'
        elif col_name == 'Current_PL':
            v = float(val)
            if v > 0: return 'color: #00ff00; font-weight: bold;' 
            elif v < 0: return 'color: #ff4b4b; font-weight: bold;' 
        elif col_name == 'Signal_Gap':
            if '🚨' in str(val): return 'color: #ff4b4b; font-weight: bold;' 
        elif col_name == 'Signal':
            if 'BUY' in str(val): return 'color: #00ff00; font-weight: bold;' 
            elif 'SELL' in str(val): return 'color: #ff4b4b; font-weight: bold;' 
    except: pass
    return ''

def render_table(df_subset):
    num_cols = ['LTP', 'Entry_Price', 'Current_PL', 'Target_Price']
    for col in num_cols:
        if col in df_subset.columns:
            df_subset[col] = pd.to_numeric(df_subset[col], errors='coerce')
            df_subset[col] = df_subset[col].apply(lambda x: f"{x:.2f}" if pd.notnull(x) else "0.00")

    styler = df_subset.style
    if 'Type' in df_subset.columns: styler = styler.map(lambda x: style_dataframe(x, 'Type'), subset=['Type'])
    if 'Current_PL' in df_subset.columns: styler = styler.map(lambda x: style_dataframe(x, 'Current_PL'), subset=['Current_PL'])
    if 'Signal_Gap' in df_subset.columns: styler = styler.map(lambda x: style_dataframe(x, 'Signal_Gap'), subset=['Signal_Gap'])
    if 'Signal' in df_subset.columns: styler = styler.map(lambda x: style_dataframe(x, 'Signal'), subset=['Signal'])
    
    st.dataframe(styler, use_container_width=True, hide_index=True)

@st.cache_data(ttl=1)
def load_data():
    if os.path.exists("LIVE_DATA.csv"):
        try: return pd.read_csv("LIVE_DATA.csv")
        except: return None
    return None

df = load_data()

if df is not None and not df.empty:
    for cat in df['Category'].unique():
        display_df = df[df['Category'] == cat].drop(columns=['Category'])
        if str(cat).startswith("OPT_"):
            clean_title = str(cat).replace("OPT_", "")
            st.subheader(f"📊 {clean_title} OPTIONS")
            call_df = display_df[display_df['Type'].astype(str).str.contains('CALL', na=False)]
            put_df = display_df[display_df['Type'].astype(str).str.contains('PUT', na=False)]
            if not call_df.empty:
                st.markdown(f"##### 🟢 {clean_title} — CALL OPTIONS")
                render_table(call_df)
            if not put_df.empty:
                st.markdown(f"##### 🔴 {clean_title} — PUT OPTIONS")
                render_table(put_df)
            st.write("---")
        else:
            st.subheader(f"📊 {cat}")
            render_table(display_df)
else:
    st.info("🔄 Live data loading...")

time.sleep(0.5)
st.rerun()