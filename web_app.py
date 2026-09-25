import streamlit as st
import pandas as pd
import time
import os

st.set_page_config(page_title="SP BOT PRO", layout="wide", initial_sidebar_state="collapsed")

st.markdown("""
    <style>
    .stDataFrame {font-size: 14px;}
    </style>
""", unsafe_allow_html=True)

st.title("🚀 SP BOT Real-Time Pro Dashboard")

def style_dataframe(val, col_name):
    try:
        if col_name == 'Current_PL':
            val_float = float(val)
            if val_float > 0:
                return 'color: #00ff00; font-weight: bold;' 
            elif val_float < 0:
                return 'color: #ff4b4b; font-weight: bold;' 
        
        elif col_name == 'Signal_Gap':
            if '🚨' in str(val):
                return 'color: #ff4b4b; font-weight: bold;' 
        
        elif col_name == 'Signal':
            if 'BUY' in str(val):
                return 'color: #00ff00; font-weight: bold;'
            elif 'SELL' in str(val):
                return 'color: #ff4b4b; font-weight: bold;'
    except:
        pass
    return ''

@st.cache_data(ttl=1) 
def load_data():
    if os.path.exists("LIVE_DATA.csv"):
        # YAHAN FIX KIYA HAI: try-except block add kar diya taaki crash na ho
        try:
            df = pd.read_csv("LIVE_DATA.csv")
            num_cols = ['LTP', 'Entry_Price', 'Current_PL', 'Target_Price']
            for col in num_cols:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce').round(2)
            return df
        except pd.errors.EmptyDataError:
            # Agar file overwrite ho rahi ho aur khali mile, toh crash hone ki jagah chup-chap wapas aa jao
            return None
        except Exception:
            return None
    return None

# ==========================================
# Main Display Loop
# ==========================================
df = load_data()

if df is not None and not df.empty:
    categories = df['Category'].unique()
    for cat in categories:
        st.subheader(f"📊 {cat}")
        display_df = df[df['Category'] == cat].drop(columns=['Category'])
        
        styler = display_df.style
        
        if 'Current_PL' in display_df.columns:
            styler = styler.map(lambda x: style_dataframe(x, 'Current_PL'), subset=['Current_PL'])
        if 'Signal_Gap' in display_df.columns:
            styler = styler.map(lambda x: style_dataframe(x, 'Signal_Gap'), subset=['Signal_Gap'])
        if 'Signal' in display_df.columns:
            styler = styler.map(lambda x: style_dataframe(x, 'Signal'), subset=['Signal'])
        
        format_dict = {col: "{:.2f}" for col in ['LTP', 'Entry_Price', 'Current_PL', 'Target_Price'] if col in display_df.columns}
        styler = styler.format(format_dict)
        
        st.dataframe(styler, width='stretch', hide_index=True)
else:
    # Error ki jagah ab ek smooth message dikhega
    st.info("🔄 Data update ho raha hai... (Microsecond sync)")

time.sleep(1)
st.rerun()