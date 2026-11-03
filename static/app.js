// SP BOT PRO — Complete Application, 60FPS Drawing Engine, Strategy & Notifications (100% Full Features Restored)
const socket = io({ transports: ['websocket', 'polling'] });
const chartGrid = document.getElementById('chart-grid'), gridSelector = document.getElementById('grid-selector');
let panes = {}, paneCounter = 0, activePaneId = null, screenerRows = [], selectedScreenerCat = 'ALL';
let starredSymbols = JSON.parse(localStorage.getItem('sp_starred_symbols') || '["NIFTY50", "NIFTYBANK", "SENSEX", "RELIANCE", "HDFCBANK"]');
let lastSidebarDomKey = '', lastScreenerDomKey = '', lastWatchlistStarKey = '', lastWatchlistRadarKey = '';
let syncCrosshairEnabled = JSON.parse(localStorage.getItem('sp_sync_xhair') ?? 'true');
let syncedCrosshairTime = null;

const setTxt = (root, sel, val, cls) => {
    const el = typeof sel === 'string' ? root.querySelector(sel) : sel;
    if (!el) return;
    if (val !== undefined && el.textContent !== String(val)) el.textContent = val;
    if (cls && el.className !== cls) el.className = cls;
};
const toggleFlexModal = (id, show) => {
    const el = document.getElementById(id);
    if (el) { el.classList.toggle('hidden', !show); el.classList.toggle('flex', show); }
};

const ALIAS_MAP = {
    "BAJAJFIN": "NSE:BAJFINANCE-EQ", "BAJFIN": "NSE:BAJFINANCE-EQ", "BAJFINANCE": "NSE:BAJFINANCE-EQ",
    "RELIANCE": "NSE:RELIANCE-EQ", "ULTRACEMCO": "NSE:ULTRACEMCO-EQ", "NIFTY": "NSE:NIFTY50-INDEX", "NIFTY50": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX", "NIFTYBANK": "NSE:NIFTYBANK-INDEX", "SENSEX": "BSE:SENSEX-INDEX", "BANKEX": "BSE:BANKEX-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX", "MIDCAP": "NSE:NIFTYMIDCAP50-INDEX", "NIFTYMIDCAP50": "NSE:NIFTYMIDCAP50-INDEX"
};
const isOptionSym = s => /\d+(CE|PE)$/.test(String(s || '').replace('_HOLD', '').split(':').pop());

function normalizeSymbol(raw) {
    let s = String(raw || '').trim().toUpperCase().replace('_HOLD', '');
    if (!s) return "NSE:NIFTY50-INDEX";
    if (ALIAS_MAP[s]) return ALIAS_MAP[s];
    const [pref, bare = s] = s.includes(':') ? s.split(':').map(x => x.trim()) : ['', s];
    const clean = bare.replace(/-(EQ|INDEX)$/, '');
    if (ALIAS_MAP[clean]) return ALIAS_MAP[clean];
    const isDeriv = isOptionSym(clean) || clean.endsWith('FUT');
    if (clean.includes('SENSEX') || clean.includes('BANKEX')) return `BSE:${clean}${isDeriv ? '' : '-INDEX'}`;
    if (pref === 'MCX' || /(GOLD|SILVER|CRUDEOIL|NATURALGAS)/.test(clean)) return `MCX:${bare}`;
    if (pref === 'BSE') return (isDeriv || bare.includes('-')) ? `BSE:${bare}` : `BSE:${clean}-A`;
    if (["NIFTY50", "NIFTYBANK", "FINNIFTY", "NIFTYMIDCAP50", "INDIAVIX"].includes(clean)) return `NSE:${clean}-INDEX`;
    return isDeriv ? `NSE:${clean}` : `NSE:${clean}-EQ`;
}

function calcGroupStats(rows) {
    let buy = 0, sell = 0, alerts = 0;
    for (let i = 0; i < rows.length; i++) {
        const sig = rows[i].signal || '', gap = rows[i].signal_gap || '', brk = rows[i].breakout || '';
        if (sig.includes('BUY')) buy++; else if (sig.includes('SELL')) sell++;
        if (gap.includes('🚨') || brk.includes('BREAK')) alerts++;
    }
    return { total: rows.length, buy, sell, alerts };
}

function buildSectionPills(prefix, rows, compact = false) {
    const st = calcGroupStats(rows), pad = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
    return `<div class="flex flex-wrap items-center gap-2">
        <div class="${pad} rounded-md bg-[#0b0f19] border border-gray-800 flex items-center gap-1.5"><span class="text-gray-400">Tracked:</span><span id="pill-tot-${prefix}" class="text-white font-bold">${st.total}</span></div>
        <div class="${pad} rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-1.5"><span class="text-emerald-400">BUY🟢:</span><span id="pill-buy-${prefix}" class="text-emerald-300 font-bold">${st.buy}</span></div>
        <div class="${pad} rounded-md bg-red-500/10 border border-red-500/20 flex items-center gap-1.5"><span class="text-red-400">SELL🔴:</span><span id="pill-sell-${prefix}" class="text-red-300 font-bold">${st.sell}</span></div>
        <div class="${pad} rounded-md bg-yellow-500/10 border border-yellow-500/20 flex items-center gap-1.5"><span class="text-yellow-400">Alerts🚨:</span><span id="pill-alt-${prefix}" class="text-yellow-300 font-bold">${st.alerts}</span></div>
    </div>`;
}

function updateSectionPillsInPlace(prefix, rows) {
    const st = calcGroupStats(rows);
    [['tot', st.total], ['buy', st.buy], ['sell', st.sell], ['alt', st.alerts]].forEach(([k, v]) => setTxt(document, `#pill-${k}-${prefix}`, v));
}

const pendingHistoryMap = new Map();
async function fetchHistoryDeduplicated(symbol, timeframe) {
    const key = `${symbol}_${timeframe}`;
    if (pendingHistoryMap.has(key)) return pendingHistoryMap.get(key);
    const promise = fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`)
        .then(r => { if (!r.ok) throw new Error("API Fetch Failed"); return r.json(); })
        .finally(() => pendingHistoryMap.delete(key));
    pendingHistoryMap.set(key, promise);
    return promise;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatIstTime12h(t) {
    if (typeof t === 'object' && t !== null) return `${t.day} ${MONTHS_SHORT[(t.month || 1) - 1]}`;
    const date = new Date(t * 1000), minutes = date.getUTCMinutes(), ampm = date.getUTCHours() >= 12 ? 'PM' : 'AM';
    return `${date.getUTCHours() % 12 || 12}:${minutes < 10 ? '0' + minutes : minutes} ${ampm}`;
}
function formatIstCrosshair12h(t) {
    if (typeof t === 'object' && t !== null) return `${t.day} ${MONTHS_SHORT[(t.month || 1) - 1]} '${String(t.year).slice(-2)}`;
    const date = new Date(t * 1000);
    return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]} '${String(date.getUTCFullYear()).slice(-2)}  ${formatIstTime12h(t)}`;
}

const DESIRED_ORDER = ["NIFTY50", "BANKNIFTY", "SENSEX", "MIDCAP", "FINNIFTY", "COMMODITY", "OPT_NIFTY", "OPT_BANKNIFTY", "OPT_SENSEX", "OPT_HOLD_POSITIONS"];
const timeframes = [
    {val: "1", text: "1M"}, {val: "2", text: "2M"}, {val: "3", text: "3M"}, {val: "5", text: "5M"},
    {val: "10", text: "10M"}, {val: "15", text: "15M"}, {val: "30", text: "30M"}, {val: "60", text: "1H"},
    {val: "120", text: "2H"}, {val: "180", text: "3H"}, {val: "240", text: "4H"}, {val: "D", text: "1D"}, {val: "W", text: "1W"}
];

function formatTimeframeShortLabel(val) {
    const s = String(val || "5").trim().toUpperCase();
    if (s === "D" || s === "1D") return "1D";
    if (s === "W" || s === "1W") return "1W";
    const mins = parseInt(s, 10);
    return (!isNaN(mins) && mins > 0) ? (mins % 60 === 0 ? `${mins / 60}H` : `${mins}M`) : s;
}

function parseCustomIntervalInput(rawStr) {
    const s = String(rawStr || "").trim().toUpperCase();
    if (!s) return null;
    if (s === "D" || s === "1D") return { val: "D", shortLabel: "1D", longLabel: "1 day" };
    if (s === "W" || s === "1W") return { val: "W", shortLabel: "1W", longLabel: "1 week" };
    const hMatch = s.match(/^(\d+)\s*H$/);
    if (hMatch) {
        const hrs = parseInt(hMatch[1], 10);
        return (hrs >= 1 && hrs <= 24) ? { val: String(hrs * 60), shortLabel: `${hrs}H`, longLabel: hrs === 1 ? "1 hour" : `${hrs} hours` } : null;
    }
    const mMatch = s.match(/^(\d+)\s*M?$/);
    if (mMatch) {
        const mins = parseInt(mMatch[1], 10);
        if (mins >= 1 && mins <= 1440) {
            const shortLabel = (mins % 60 === 0 && (s.endsWith("H") || [60, 120, 180, 240].includes(mins))) ? `${mins / 60}H` : `${mins}M`;
            return { val: String(mins), shortLabel, longLabel: mins === 1 ? "1 minute" : `${mins} minutes` };
        }
    }
    return null;
}

let KNOWN_SYMBOLS_SET = new Set();
function refreshSymbolsDatalist() {
    fetch('/api/symbols').then(res => res.json()).then(symbols => {
        if (!symbols?.length) return;
        KNOWN_SYMBOLS_SET = new Set(symbols.map(s => String(s).toUpperCase()));
        document.getElementById('symbol-suggestions').innerHTML = symbols.map(s => `<option value="${s}"></option>`).join('');
    }).catch(() => {});
}

function switchView(viewName) {
    ['charts', 'screener', 'watchlist', 'paper'].forEach(v => {
        document.getElementById(`view-${v}`).classList.toggle('hidden', v !== viewName);
        const btn = document.getElementById(`nav-${v}`);
        if (btn) btn.className = v === viewName ? "px-3 py-1.5 rounded-md text-xs font-semibold bg-yellow-500 text-gray-950 flex items-center gap-1" : "px-3 py-1.5 rounded-md text-xs font-semibold text-gray-300 hover:text-white flex items-center gap-1";});

    if (viewName !== 'charts') {
        selectDrawing(null, null);
        closeAllPopMenus();}

    if (viewName === 'charts') setTimeout(() => Object.values(panes).forEach(p => p.resizeChart()), 40);
    else if (viewName === 'screener') renderScreenerTables(true);
    else if (viewName === 'watchlist') renderWatchlistView(true);
    else if (viewName === 'paper') fetchPaperTradingData();}

function toggleSidebar() {
    document.getElementById('right-sidebar').classList.toggle('hidden');
    setTimeout(() => Object.values(panes).forEach(p => p.resizeChart()), 50);
}

function toggleCrosshairSync() {
    syncCrosshairEnabled = !syncCrosshairEnabled;
    localStorage.setItem('sp_sync_xhair', JSON.stringify(syncCrosshairEnabled));
    const btn = document.getElementById('sync-xhair-btn');
    if (btn) {
        btn.className = syncCrosshairEnabled
            ? "px-2.5 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-xs text-blue-400 font-semibold"
            : "px-2.5 py-1.5 rounded-lg bg-[#0b0f19] border border-gray-800 text-xs text-gray-400 font-semibold";
    }
    if (!syncCrosshairEnabled) {
        syncedCrosshairTime = null;
        Object.values(panes).forEach(p => p.requestDraw?.());
    }
}

function setActivePane(paneId) {
    activePaneId = paneId;
    Object.values(panes).forEach(p => {
        const isAct = p.id === paneId;
        p.wrapper.classList.toggle('active-pane', isAct);
        if (isAct) { setTxt(document, '#active-pane-indicator', `Target: Pane #${p.index + 1}`); setTxt(document, '#cmd-target-pane', `Pane #${p.index + 1}`); }
    });
}

function loadSymbolIntoActivePane(fyersSymbol) {
    if (!fyersSymbol) return;
    switchView('charts');
    (panes[activePaneId] || Object.values(panes)[0])?.setSymbol(fyersSymbol);
}

function toggleStarSymbol(cleanStock, event) {
    if (event) event.stopPropagation();
    const idx = starredSymbols.indexOf(cleanStock);
    idx > -1 ? starredSymbols.splice(idx, 1) : starredSymbols.push(cleanStock);
    localStorage.setItem('sp_starred_symbols', JSON.stringify(starredSymbols));
    renderSidebarList(true); renderSearchModalResults(); renderWatchlistView(true);
}

class ChartPane {
    constructor(id, index) {
        this.id = id; this.index = index;
        this.symbol = normalizeSymbol(localStorage.getItem(`pane_symbol_${index}`) || "NSE:NIFTY50-INDEX");
        localStorage.setItem(`pane_symbol_${index}`, this.symbol);
        this.timeframe = localStorage.getItem(`pane_tf_${index}`) || "5";
        this.chartType = localStorage.getItem(`pane_type_${index}`) || "HA";
        this.updateCleanSymbol();
        this.isLoaded = false; this.lastClosePrice = null; this.rawData = []; this.candleMap = new Map();
        this.lastCandleTime = 0; this.lastTimeStr = "--:--";
        this.currentTrend = null;
        this.createDOM(); this.initChart();
        this.candleSeries = this.chart.addCandlestickSeries({ upColor: '#089981', downColor: '#f23645', borderVisible: false, wickUpColor: '#089981', wickDownColor: '#f23645' });
        this.tslSeries = this.chart.addLineSeries({ color: 'rgba(255, 235, 59, 0.72)', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        setTimeout(() => this.loadData(), index * 180);
    }

    updateCleanSymbol() {
        this.cleanSymbol = (this.symbol.includes(':') ? this.symbol.split(":")[1] : this.symbol).replace(/-(EQ|INDEX)$/, "");
    }

    autoFitChart() {
        if (!this.chart) return;
        try {
            this.chart.priceScale('right').applyOptions({ autoScale: true });
            this.candleSeries?.priceScale().applyOptions({ autoScale: true });
            this.tslSeries?.priceScale().applyOptions({ autoScale: true });
            this.chart.timeScale().resetTimeScale();
            this.chart.timeScale().fitContent();
            this.requestDraw?.();
        } catch (err) {}
    }

    resetAndLoad() {
        this.isLoaded = false; this.rawData = []; this.candleMap.clear(); this.lastCandleTime = 0; this.lastReloadMs = 0;
        this.priceDisplay.textContent = "Loading...";
        this.autoFitChart(); this.loadData();
    }

    setSymbol(newSym) {
        this.symbol = normalizeSymbol(newSym);
        this.symInput.value = this.symbol;
        this.updateCleanSymbol();
        localStorage.setItem(`pane_symbol_${this.index}`, this.symbol);
        this.resetAndLoad();
        this.loadDrawings?.();
    }

    setTimeframe(newTfVal) {
        const tfStr = String(newTfVal || "5").trim().toUpperCase();
        this.timeframe = tfStr;
        localStorage.setItem(`pane_tf_${this.index}`, this.timeframe);
        if (this.tfSelect) {
            const idx = Array.from(this.tfSelect.options).findIndex(o => o.value === tfStr);
            if (idx > -1) this.tfSelect.selectedIndex = idx;
            else this.tfSelect.appendChild(new Option(formatTimeframeShortLabel(tfStr), tfStr, true, true));
        }
        this.resetAndLoad();
    }

    createDOM() {
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'pane';
        this.wrapper.onclick = () => setActivePane(this.id);
        const tfOpts = timeframes.map(tf => `<option value="${tf.val}" ${tf.val === this.timeframe ? 'selected' : ''}>${tf.text}</option>`).join('');
        const customTfOpt = (!timeframes.some(tf => tf.val === this.timeframe) && this.timeframe) ? `<option value="${this.timeframe}" selected>${formatTimeframeShortLabel(this.timeframe)}</option>` : '';

        this.wrapper.innerHTML = `
            <div class="pane-header">
                <span class="pane-badge text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-yellow-400">#${this.index + 1}</span>
                <input value="${this.symbol}" list="symbol-suggestions" spellcheck="false" autocomplete="off" placeholder="Type Symbol...">
                <select class="pane-tf-sel">${tfOpts}${customTfOpt}</select>
                <select class="pane-type-sel"><option value="HA" ${this.chartType === 'HA' ? 'selected' : ''}>HA</option><option value="STD" ${this.chartType === 'STD' ? 'selected' : ''}>STD</option></select>
                <button class="pane-fit-btn px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-[10px]" title="Auto-Fit Price & Time Scale">⟳</button>
                <button class="pane-max-btn px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-[10px]" title="Maximize / Restore Chart">⛶</button>
                <div class="price-time-box"><div class="live-price">Loading...</div><div class="live-time"><span class="live-t-txt">--:--</span><span>|</span><span class="candle-countdown">⏳ --:--</span></div></div>
            </div>
            <div class="chart-container"></div>`;

        this.header = this.wrapper.querySelector('.pane-header');
        this.symInput = this.header.querySelector('input');
        this.tfSelect = this.header.querySelector('.pane-tf-sel');
        this.priceDisplay = this.header.querySelector('.live-price');
        this.timeTxtEl = this.header.querySelector('.live-t-txt');
        this.countdownEl = this.header.querySelector('.candle-countdown');
        this.container = this.wrapper.querySelector('.chart-container');

        this.symInput.onfocus = () => setTimeout(() => { try { this.symInput.select(); } catch(e) {} }, 10);
        this.symInput.oninput = (e) => {
            const val = String(e.target.value || '').trim().toUpperCase();
            if (KNOWN_SYMBOLS_SET.has(val) && val !== this.symbol) { this.setSymbol(val); this.symInput.blur(); }
        };
        this.symInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.setSymbol(this.symInput.value); this.symInput.blur(); } };
        this.symInput.onchange = (e) => this.setSymbol(e.target.value);
        this.tfSelect.onchange = (e) => this.setTimeframe(e.target.value);
        this.header.querySelector('.pane-type-sel').onchange = (e) => {
            this.chartType = e.target.value;
            localStorage.setItem(`pane_type_${this.index}`, this.chartType);
            this.isLoaded = false; this.renderChartData();
        };
        this.header.querySelector('.pane-fit-btn').onclick = (e) => { e.stopPropagation(); this.autoFitChart(); };
        this.header.querySelector('.pane-max-btn').onclick = (e) => {
            e.stopPropagation(); this.wrapper.classList.toggle('maximized-pane');
            setTimeout(() => this.resizeChart(), 40);
        };
        chartGrid.appendChild(this.wrapper);
    }

    resizeChart() {
        if (!this.chart || !this.container) return;
        const rect = this.container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            this.chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
            this.requestDraw?.();
        }
    }
   initChart() {
        const rect = this.container.getBoundingClientRect();
        this.chart = LightweightCharts.createChart(this.container, {
            width: Math.floor(rect.width) || 400, height: Math.floor(rect.height) || 300,
            layout: { background: { type: 'solid', color: '#000000' }, textColor: '#d1d4dc', fontSize: 11, fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif' },
            grid: { vertLines: { color: '#1f2229', style: 0 }, horzLines: { color: '#1f2229', style: 0 } },
            localization: { timeFormatter: (time) => formatIstCrosshair12h(time) },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { labelVisible: true, color: '#787b86', style: 2 }, horzLine: { labelVisible: true, color: '#787b86', style: 2 } },
            timeScale: {
                timeVisible: true, secondsVisible: false, borderColor: '#2a2e39', rightOffset: 10,
                tickMarkFormatter: (time, tickMarkType) => {
                    if (this.timeframe === 'D' || this.timeframe === 'W' || tickMarkType === 0 || tickMarkType === 1) {
                        const d = new Date((typeof time === 'number' ? time : 0) * 1000);
                        return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
                    }
                    return formatIstTime12h(time);
                }
            },
            rightPriceScale: { borderColor: '#2a2e39', alignLabels: true, autoScale: true, minimumWidth: 65 }
        });
        // Exact TradingView Heikin-Ashi Colors & 1px Semi-Transparent Yellow Line
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#089981', downColor: '#f23645',
            borderVisible: false, wickUpColor: '#089981', wickDownColor: '#f23645'
        });
        this.tslSeries = this.chart.addLineSeries({
            color: 'rgba(255, 235, 59, 0.65)', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false
        });
        initPaneDrawingEngine(this);
    }

    async loadData() {
        const reqSym = this.symbol, reqTf = this.timeframe;
        try {
            const data = await fetchHistoryDeduplicated(reqSym, reqTf);
            if (this.symbol !== reqSym || this.timeframe !== reqTf) return;
            if (!Array.isArray(data) || !data.length) {
                this.priceDisplay.textContent = "No Data";
                return;
            }
            this.rawData = data;
            this.renderChartData();
        } catch (err) {
            if (this.symbol === reqSym) this.priceDisplay.textContent = "Error";
        }
    }

    renderChartData() {
        if (!this.rawData?.length) return;
        let validData = [], tslData = [], markers = [], lastValidTime = 0;
        const isHA = (this.chartType === "HA");
        this.candleMap.clear();
        for (let i = 0; i < this.rawData.length; i++) {
            const d = this.rawData[i];
            if (d.time > lastValidTime) {
                if (d.signal) this.currentTrend = d.signal;
                const t = d.time + 19800;
                const cObj = { time: t, open: isHA ? d.ha_open : d.open, high: isHA ? d.ha_high : d.high, low: isHA ? d.ha_low : d.low, close: isHA ? d.ha_close : d.close };
                validData.push(cObj);
                this.candleMap.set(t, cObj);
                if (d.tstop && d.tstop > 0) {
                    tslData.push({ time: t, value: d.tstop });
                }
                if (d.signal === 'BUY') markers.push({ time: t, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'BUY' });
                else if (d.signal === 'SELL') markers.push({ time: t, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'SELL' });
                lastValidTime = d.time;
            }
        }
        if (validData.length > 0) {
            this.markersList = markers;
            this.candleSeries.setData(validData);
            this.tslSeries?.setData(tslData);
            this.candleSeries.setMarkers(this.markersList);
            this.lastCandleTime = validData[validData.length - 1].time;
            const currentClose = validData[validData.length - 1].close;
            this.lastTimeStr = formatIstTime12h(this.lastCandleTime);
            this.updatePrice(currentClose); this.tickCountdown();
            this.lastClosePrice = currentClose;
            if (!this.isLoaded) {
                this.isLoaded = true;
                this.autoFitChart();
                requestAnimationFrame(() => this.autoFitChart());
            }
            this.requestDraw?.();
        }
    }

    getIntradayBucketAndRemaining() {
        if (this.timeframe === 'D' || this.timeframe === 'W') return { expectedBucketTime: this.lastCandleTime, secondsRemaining: 0 };
        const candleSec = Math.max(1, parseInt(this.timeframe, 10) || 5) * 60;
        const nowEpochIst = Math.floor(Date.now() / 1000) + 19800;
        const sessionStartIst = Math.floor(nowEpochIst / 86400) * 86400 + (this.symbol.startsWith('MCX:') ? 9 * 3600 : 9 * 3600 + 15 * 60);
        const secSinceOpen = Math.max(0, nowEpochIst - sessionStartIst);
        return { expectedBucketTime: sessionStartIst + Math.floor(secSinceOpen / candleSec) * candleSec, secondsRemaining: Math.max(0, candleSec - (secSinceOpen % candleSec)) };
    }

    updateLiveTick(price, tstop, backendSignal) {
        if (!this.isLoaded || !this.candleSeries || !this.rawData.length) return;
        const { expectedBucketTime } = this.getIntradayBucketAndRemaining();
        const isHA = (this.chartType === "HA");
        let lastRaw = this.rawData[this.rawData.length - 1];

        if (this.timeframe !== 'D' && this.timeframe !== 'W' && expectedBucketTime > this.lastCandleTime) {
            if (backendSignal) this.currentTrend = backendSignal; // Lock signal on candle close
            const prevTstop = lastRaw.tstop;
            const newHaOpen = (lastRaw.ha_open + lastRaw.ha_close) * 0.5;
            lastRaw = {
                time: expectedBucketTime - 19800, open: price, high: price, low: price, close: price,
                ha_open: newHaOpen, ha_high: Math.max(price, newHaOpen), ha_low: Math.min(price, newHaOpen), ha_close: price,
                tstop: tstop || prevTstop, signal: null
            };
            this.rawData.push(lastRaw);
            this.lastCandleTime = expectedBucketTime;
            const nowMs = Date.now();
            if (!this.lastReloadMs || (nowMs - this.lastReloadMs > 15000)) { this.lastReloadMs = nowMs; setTimeout(() => this.loadData(), 1500); }
        } else {
            lastRaw.close = price;
            if (price > lastRaw.high) lastRaw.high = price;
            if (price < lastRaw.low) lastRaw.low = price;
        }

        const newHaClose = (lastRaw.open + lastRaw.high + lastRaw.low + price) * 0.25;
        lastRaw.ha_close = newHaClose;
        lastRaw.ha_high = Math.max(lastRaw.high, lastRaw.ha_open, newHaClose);
        lastRaw.ha_low = Math.min(lastRaw.low, lastRaw.ha_open, newHaClose);

        const cObj = isHA
            ? { time: this.lastCandleTime, open: lastRaw.ha_open, high: lastRaw.ha_high, low: lastRaw.ha_low, close: lastRaw.ha_close }
            : { time: this.lastCandleTime, open: lastRaw.open, high: lastRaw.high, low: lastRaw.low, close: price };

        const activeTstop = (this.timeframe === '5' && tstop && tstop > 0) ? tstop : lastRaw.tstop;
        if (activeTstop && activeTstop > 0) {
            lastRaw.tstop = activeTstop;
            this.tslSeries?.update({ time: this.lastCandleTime, value: activeTstop });

            if (this.rawData.length >= 2) {
                let liveSig = null;
                // JS calc ko ignore karke strictly Python ke backend signal par draw karega
                if (backendSignal && backendSignal !== this.currentTrend) {
                    liveSig = backendSignal;
                }

                const baseMarkers = (this.markersList || []).filter(m => m.time !== this.lastCandleTime);
                if (liveSig === 'BUY') {
                    baseMarkers.push({ time: this.lastCandleTime, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'BUY' });
                } else if (liveSig === 'SELL') {
                    baseMarkers.push({ time: this.lastCandleTime, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'SELL' });
                }
                this.markersList = baseMarkers;
                this.candleSeries.setMarkers(this.markersList);
            }
        }

        this.candleSeries.update(cObj);
        this.candleMap.set(this.lastCandleTime, cObj);
        this.lastTimeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        this.updatePrice(price);
        this.lastClosePrice = price;
        this.requestDraw?.();
    }
    
    updatePrice(newPrice) {
        setTxt(this.priceDisplay, this.priceDisplay, newPrice.toFixed(2));
        setTxt(this.timeTxtEl, this.timeTxtEl, this.lastTimeStr);
    }

    tickCountdown() {
        if (document.hidden) return;
        let countdownStr = "⏳ 1D";
        if (this.timeframe === 'W') countdownStr = "⏳ 1W";
        else if (this.timeframe !== 'D') {
            const { secondsRemaining: s } = this.getIntradayBucketAndRemaining();
            countdownStr = s >= 3600 ? `⏳ ${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `⏳ ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        }
        setTxt(this.timeTxtEl, this.timeTxtEl, this.lastTimeStr);
        setTxt(this.countdownEl, this.countdownEl, countdownStr);
    }

    destroy() {
        if (this.ro) this.ro.disconnect();
        if (this.onWinMouseUp) window.removeEventListener('mouseup', this.onWinMouseUp);
        if (this.onWinMouseMove) window.removeEventListener('mousemove', this.onWinMouseMove);
        if (this.chart) { try { this.chart.remove(); } catch(e) {} }
        this.wrapper.remove();
    }
}

setInterval(() => { if (!document.hidden) Object.values(panes).forEach(p => { if (p.isLoaded) p.tickCountdown(); }); }, 1000);

function changeLayout(count) {
    count = parseInt(count, 10);
    localStorage.setItem('chartLayoutCount', count);
    chartGrid.className = `layout-${count}`;
    let currentPanes = Object.keys(panes).length;
    while (currentPanes < count) {
        const id = 'pane_' + paneCounter++;
        panes[id] = new ChartPane(id, currentPanes);
        if (currentPanes === 0) setActivePane(id);
        currentPanes++;
    }
    while (currentPanes > count) {
        const keys = Object.keys(panes), idToRemove = keys[keys.length - 1];
        panes[idToRemove].destroy(); delete panes[idToRemove]; currentPanes--;
    }
    if (!panes[activePaneId] && Object.keys(panes).length > 0) setActivePane(Object.keys(panes)[0]);
}

function getSignalBadge(sig) {
    if (sig.includes('BUY')) return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">${sig}</span>`;
    if (sig.includes('SELL')) return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">${sig}</span>`;
    return `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-800 text-gray-400">${sig}</span>`;
}

function renderSidebarList(forceRebuild = false) {
    const catFilter = document.getElementById('sidebar-cat-filter').value, sigFilter = document.getElementById('sidebar-sig-filter').value;
    const container = document.getElementById('sidebar-list');
    const catRows = screenerRows.filter(r => catFilter === 'STARRED' ? starredSymbols.includes(r.stock) : (catFilter === 'ALL' || r.category === catFilter));
    const catSt = calcGroupStats(catRows);
    setTxt(document, '#sb-sum-total', catSt.total); setTxt(document, '#sb-sum-buy', catSt.buy); setTxt(document, '#sb-sum-sell', catSt.sell);

    const filtered = catRows.filter(r => {
        if (sigFilter === 'BUY') return r.signal.includes('BUY');
        if (sigFilter === 'SELL') return r.signal.includes('SELL');
        if (sigFilter === 'ALERT') return r.signal_gap.includes('🚨') || r.breakout.includes('BREAK');
        return true;
    }).slice(0, 80);

    if (!filtered.length) {
        if (lastSidebarDomKey !== 'EMPTY') { lastSidebarDomKey = 'EMPTY'; container.innerHTML = `<div class="p-6 text-center text-xs text-gray-500">No matching symbols in LIVE_DATA.csv</div>`; }
        return;
    }

    const newKey = filtered.map(r => r.stock).join('|');
    if (forceRebuild || newKey !== lastSidebarDomKey) {
        lastSidebarDomKey = newKey;
        container.innerHTML = filtered.map(r => {
            const isStar = starredSymbols.includes(r.stock), plColor = r.current_pl > 0 ? 'text-emerald-400' : (r.current_pl < 0 ? 'text-red-400' : 'text-gray-400');
            return `<div data-sb-stock="${r.stock}" onclick="loadSymbolIntoActivePane('${r.fyers_symbol}')" class="p-2 rounded-lg bg-[#0b0f19]/80 hover:bg-gray-800 border border-gray-800/80 hover:border-yellow-500/50 cursor-pointer flex items-center justify-between gap-2">
                <div class="min-w-0">
                    <div class="flex items-center gap-1.5"><button onclick="toggleStarSymbol('${r.stock}', event)" class="sb-star text-xs ${isStar ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-400'}">★</button><span class="text-xs font-bold text-white truncate">${r.stock}</span><span class="text-[10px] px-1.5 py-0.2 rounded bg-gray-800 text-gray-300">${r.type}</span></div>
                    <div class="text-[10px] text-gray-400 mt-0.5 flex items-center gap-2"><span class="sb-ep">Entry: ₹${r.entry_price.toFixed(2)}</span><span>•</span><span class="sb-pl ${plColor} font-semibold">P&L: ${r.current_pl >= 0 ? '+' : ''}${r.current_pl.toFixed(2)}</span></div>
                </div>
                <div class="text-right flex-shrink-0"><div class="sb-ltp text-xs font-bold text-white">₹${r.ltp.toFixed(2)}</div><div class="sb-sig mt-0.5" data-sig="${r.signal}">${getSignalBadge(r.signal)}</div></div>
            </div>`;
        }).join('');
    } else {
        const rowMap = new Map(filtered.map(r => [r.stock, r]));
        container.querySelectorAll('[data-sb-stock]').forEach(el => {
            const r = rowMap.get(el.getAttribute('data-sb-stock'));
            if (!r) return;
            setTxt(el, '.sb-ltp', `₹${r.ltp.toFixed(2)}`);
            setTxt(el, '.sb-ep', `Entry: ₹${r.entry_price.toFixed(2)}`);
            setTxt(el, '.sb-pl', `P&L: ${r.current_pl >= 0 ? '+' : ''}${r.current_pl.toFixed(2)}`, `sb-pl ${r.current_pl > 0 ? 'text-emerald-400' : (r.current_pl < 0 ? 'text-red-400' : 'text-gray-400')} font-semibold`);
            const sigEl = el.querySelector('.sb-sig');
            if (sigEl && sigEl.getAttribute('data-sig') !== r.signal) { sigEl.setAttribute('data-sig', r.signal); sigEl.innerHTML = getSignalBadge(r.signal); }
        });
    }
}

function setScreenerCat(cat) {
    selectedScreenerCat = cat;
    document.querySelectorAll('.scr-cat-btn').forEach(btn => {
        btn.className = btn.dataset.cat === cat ? "scr-cat-btn px-3 py-1 rounded-lg text-xs font-semibold bg-yellow-500 text-gray-950" : `scr-cat-btn px-3 py-1 rounded-lg text-xs font-semibold bg-gray-900 text-gray-300 hover:text-white ${btn.dataset.extra || ''}`;
    });
    renderScreenerTables(true);
}

function buildHtmlTable(rows) {
    return `<div class="overflow-x-auto rounded-lg border border-gray-800"><table class="w-full text-left border-collapse text-xs">
        <thead><tr class="bg-[#161f30] text-gray-300 border-b border-gray-800 uppercase text-[10px]"><th class="py-2.5 px-3">★</th><th class="py-2.5 px-3">Stock / Strike</th><th class="py-2.5 px-3">Type</th><th class="py-2.5 px-3 text-right">LTP</th><th class="py-2.5 px-3">Signal</th><th class="py-2.5 px-3">Entry Time</th><th class="py-2.5 px-3 text-right">Entry Price</th><th class="py-2.5 px-3 text-right">Current P&L</th><th class="py-2.5 px-3 text-right">Target Price</th><th class="py-2.5 px-3">Signal Gap</th><th class="py-2.5 px-3">Breakout</th><th class="py-2.5 px-3">Next BUY/SELL</th></tr></thead>
        <tbody class="divide-y divide-gray-800/70 bg-[#111827]">${rows.map(r => {
            const isStar = starredSymbols.includes(r.stock), plClass = r.current_pl > 0 ? 'text-emerald-400 font-bold' : (r.current_pl < 0 ? 'text-red-400 font-bold' : 'text-gray-400');
            const typeBadge = r.type.includes('ATM') ? 'bg-yellow-500 text-gray-950 font-bold px-1.5 py-0.5 rounded' : (r.type.includes('ITM') ? 'text-emerald-400 font-bold' : (r.type.includes('OTM') ? 'text-sky-400' : 'text-gray-300'));
            return `<tr data-tbl-stock="${r.stock}" onclick="loadSymbolIntoActivePane('${r.fyers_symbol}')" class="hover:bg-gray-800/70 cursor-pointer">
                <td class="py-2 px-3"><button onclick="toggleStarSymbol('${r.stock}', event)" class="${isStar ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-300'}">★</button></td>
                <td class="py-2 px-3 font-bold text-white">${r.stock}</td><td class="py-2 px-3"><span class="text-[11px] ${typeBadge}">${r.type}</span></td>
                <td class="tbl-ltp py-2 px-3 text-right font-bold text-white">₹${r.ltp.toFixed(2)}</td><td class="tbl-sig py-2 px-3" data-sig="${r.signal}">${getSignalBadge(r.signal)}</td>
                <td class="tbl-et py-2 px-3 text-gray-300">${r.entry_time}</td><td class="tbl-ep py-2 px-3 text-right text-gray-200">₹${r.entry_price.toFixed(2)}</td>
                <td class="tbl-pl py-2 px-3 text-right ${plClass}">${r.current_pl >= 0 ? '+' : ''}${r.current_pl.toFixed(2)}</td><td class="tbl-tp py-2 px-3 text-right text-yellow-400">₹${r.target_price.toFixed(2)}</td>
                <td class="tbl-gap py-2 px-3 ${r.signal_gap.includes('🚨') ? 'text-red-400 font-bold' : 'text-gray-300'}">${r.signal_gap}</td>
                <td class="tbl-brk py-2 px-3 ${r.breakout.includes('UP') ? 'text-emerald-400 font-bold' : (r.breakout.includes('DOWN') ? 'text-red-400 font-bold' : 'text-gray-500')}">${r.breakout}</td>
                <td class="tbl-next py-2 px-3 text-gray-300 font-mono text-[11px]">${r.next_level}</td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
}

function updateTableRowsInPlace(rootContainer) {
    const rowMap = new Map(screenerRows.map(r => [r.stock, r]));
    rootContainer.querySelectorAll('tr[data-tbl-stock]').forEach(tr => {
        const r = rowMap.get(tr.getAttribute('data-tbl-stock'));
        if (!r) return;
        setTxt(tr, '.tbl-ltp', `₹${r.ltp.toFixed(2)}`);
        setTxt(tr, '.tbl-et', r.entry_time);
        setTxt(tr, '.tbl-ep', `₹${r.entry_price.toFixed(2)}`);
        setTxt(tr, '.tbl-pl', `${r.current_pl >= 0 ? '+' : ''}${r.current_pl.toFixed(2)}`, `tbl-pl py-2 px-3 text-right ${r.current_pl > 0 ? 'text-emerald-400 font-bold' : (r.current_pl < 0 ? 'text-red-400 font-bold' : 'text-gray-400')}`);
        setTxt(tr, '.tbl-tp', `₹${r.target_price.toFixed(2)}`);
        setTxt(tr, '.tbl-gap', r.signal_gap, `tbl-gap py-2 px-3 ${r.signal_gap.includes('🚨') ? 'text-red-400 font-bold' : 'text-gray-300'}`);
        setTxt(tr, '.tbl-brk', r.breakout, `tbl-brk py-2 px-3 ${r.breakout.includes('UP') ? 'text-emerald-400 font-bold' : (r.breakout.includes('DOWN') ? 'text-red-400 font-bold' : 'text-gray-500')}`);
        setTxt(tr, '.tbl-next', r.next_level);
        const sigEl = tr.querySelector('.tbl-sig');
        if (sigEl && sigEl.getAttribute('data-sig') !== r.signal) { sigEl.setAttribute('data-sig', r.signal); sigEl.innerHTML = getSignalBadge(r.signal); }
    });
}

const renderOptSub = (cat, sfx, title, col, rows) => rows.length ? `<div class="space-y-2"><div class="flex flex-wrap items-center justify-between gap-2"><h4 class="text-xs font-bold ${col}">${title}</h4>${buildSectionPills(`${cat}_${sfx}`, rows, true)}</div>${buildHtmlTable(rows)}</div>` : '';

function renderScreenerTables(forceRebuild = false) {
    const container = document.getElementById('screener-tables-container');
    const catsToRender = selectedScreenerCat === 'ALL' ? DESIRED_ORDER : [selectedScreenerCat];
    const newKey = selectedScreenerCat + ':' + screenerRows.map(r => r.stock).join('|');
    const byCat = {};
    for (const r of screenerRows) (byCat[r.category] || (byCat[r.category] = [])).push(r);

    if (!forceRebuild && newKey === lastScreenerDomKey && screenerRows.length > 0) {
        updateTableRowsInPlace(container);
        catsToRender.forEach(cat => {
            const catRows = byCat[cat];
            if (!catRows?.length) return;
            updateSectionPillsInPlace(cat, catRows);
            if (cat.startsWith('OPT_') && cat !== 'OPT_HOLD_POSITIONS') {
                updateSectionPillsInPlace(`${cat}_CE`, catRows.filter(r => r.type.includes('CALL')));
                updateSectionPillsInPlace(`${cat}_PE`, catRows.filter(r => r.type.includes('PUT')));
            }
        });
        return;
    }
    lastScreenerDomKey = newKey;

    container.innerHTML = catsToRender.map(cat => {
        const catRows = byCat[cat];
        if (!catRows?.length) return '';
        const isOptChain = cat.startsWith('OPT_') && cat !== 'OPT_HOLD_POSITIONS';
        return `<div class="bg-[#111827] border border-gray-800 rounded-xl p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-gray-800/80"><h3 class="text-base font-bold ${isOptChain ? 'text-yellow-400' : 'text-white'} flex items-center gap-2">📊 ${isOptChain ? cat.replace('OPT_', '').replace('_', ' ') + ' OPTIONS CHAIN' : cat}</h3>${buildSectionPills(cat, catRows, false)}</div>
            ${isOptChain ? renderOptSub(cat, 'CE', '🟢 CALL OPTIONS (CE)', 'text-emerald-400', catRows.filter(r => r.type.includes('CALL'))) + renderOptSub(cat, 'PE', '🔴 PUT OPTIONS (PE)', 'text-red-400', catRows.filter(r => r.type.includes('PUT'))) : buildHtmlTable(catRows)}
        </div>`;
    }).join('') || `<div class="p-12 text-center text-gray-500">Waiting for LIVE_DATA.csv from sp_screener.py...</div>`;
}

function renderWatchlistView(forceRebuild = false) {
    const starredRows = screenerRows.filter(r => starredSymbols.includes(r.stock));
    const radarRows = screenerRows.filter(r => r.signal_gap.includes('🚨') || r.breakout.includes('BREAK'));
    const starEl = document.getElementById('watchlist-starred-table'), radarEl = document.getElementById('watchlist-radar-table');
    const newStarKey = starredRows.map(r => r.stock).join('|'), newRadarKey = radarRows.map(r => r.stock).join('|');

    if (forceRebuild || newStarKey !== lastWatchlistStarKey) {
        lastWatchlistStarKey = newStarKey;
        document.getElementById('wl-star-pills').innerHTML = buildSectionPills('WL_STAR', starredRows, true);
        starEl.innerHTML = starredRows.length ? buildHtmlTable(starredRows) : `<div class="p-6 text-center text-xs text-gray-500">No starred symbols yet. Press Ctrl+K to star stocks.</div>`;
    } else { updateSectionPillsInPlace('WL_STAR', starredRows); updateTableRowsInPlace(starEl); }

    if (forceRebuild || newRadarKey !== lastWatchlistRadarKey) {
        lastWatchlistRadarKey = newRadarKey;
        document.getElementById('wl-radar-pills').innerHTML = buildSectionPills('WL_RADAR', radarRows, true);
        radarEl.innerHTML = radarRows.length ? buildHtmlTable(radarRows) : `<div class="p-6 text-center text-xs text-gray-500">No active tight signal gaps or breakouts right now.</div>`;
    } else { updateSectionPillsInPlace('WL_RADAR', radarRows); updateTableRowsInPlace(radarEl); }
}

function applyScreenerPayload(data) {
    if (!data || document.hidden) return;
    screenerRows = data.rows || [];
    if (data.summary) {
        setTxt(document, '#sum-total', data.summary.total); setTxt(document, '#sum-buy', data.summary.buy);
        setTxt(document, '#sum-sell', data.summary.sell); setTxt(document, '#alert-count-badge', data.summary.alerts);
    }
    if (!document.getElementById('right-sidebar').classList.contains('hidden')) renderSidebarList(false);
    if (!document.getElementById('view-screener').classList.contains('hidden')) renderScreenerTables(false);
    if (!document.getElementById('view-watchlist').classList.contains('hidden')) renderWatchlistView(false);
}

async function fetchScreenerDataOnce() { try { applyScreenerPayload(await (await fetch('/api/screener')).json()); } catch (e) {} }

function paperEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function paperMoney(value) {
    const number = Number(value || 0);
    return `${number > 0 ? '+' : ''}${new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(number)}`;
}

function paperPnlClass(value) {
    return Number(value) > 0 ? 'text-emerald-400' : (Number(value) < 0 ? 'text-red-400' : 'text-gray-300');
}

function renderPaperTable(targetId, headers, rows, emptyMessage) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!rows.length) {
        target.innerHTML = `<div class="p-5 text-center text-xs text-gray-500">${paperEscape(emptyMessage)}</div>`;
        return;
    }
    target.innerHTML = `<table class="w-full min-w-[560px] text-left text-xs">
        <thead><tr class="border-b border-gray-800 text-[10px] uppercase text-gray-400">${headers.map(h => `<th class="px-3 py-2">${h}</th>`).join('')}</tr></thead>
        <tbody class="divide-y divide-gray-800/70">${rows.join('')}</tbody></table>`;
}

function renderPaperTrading(data) {
    const summary = data.summary || {};
    const setPnl = (id, value) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = paperMoney(value);
            el.className = `mt-2 text-xl font-bold ${paperPnlClass(value)}`;
        }
    };
    setPnl('paper-total-net', summary.net_pnl);
    setPnl('paper-month-net', summary.month_net_pnl);
    setPnl('paper-month-realized', summary.month_realized_pnl);
    setPnl('paper-open-pnl', summary.unrealized_pnl);
    setPnl('paper-today-net', summary.today_net_pnl);
    const counts = document.getElementById('paper-trade-count');
    if (counts) counts.textContent = `${summary.open_positions || 0} / ${summary.closed_trades || 0}`;
    const status = document.getElementById('paper-status');
    if (status) status.textContent = `Tracking since ${data.tracking_start_date || 'today'} · Saved locally · ${summary.wins || 0} wins / ${summary.losses || 0} losses`;

    const dailyRows = (data.daily || []).map(day => `<tr>
        <td class="px-3 py-2 text-gray-200">${paperEscape(day.date)}</td>
        <td class="px-3 py-2 text-right ${paperPnlClass(day.realized_pnl)}">${paperMoney(day.realized_pnl)}</td>
        <td class="px-3 py-2 text-right ${paperPnlClass(day.unrealized_pnl)}">${paperMoney(day.unrealized_pnl)}</td>
        <td class="px-3 py-2 text-right font-semibold ${paperPnlClass(day.net_pnl)}">${paperMoney(day.net_pnl)}</td>
        <td class="px-3 py-2 text-right text-gray-300">${day.trades || 0}</td></tr>`);
    renderPaperTable('paper-daily-table', ['Date', 'Realized', 'Open P&L', 'Net P&L', 'Closed'], dailyRows, 'No paper trades this month yet.');

    const weeklyRows = (data.weekly || []).map(week => `<tr>
        <td class="px-3 py-2 text-gray-200">${paperEscape(week.week_start)}</td>
        <td class="px-3 py-2 text-right ${paperPnlClass(week.realized_pnl)}">${paperMoney(week.realized_pnl)}</td>
        <td class="px-3 py-2 text-right ${paperPnlClass(week.unrealized_pnl)}">${paperMoney(week.unrealized_pnl)}</td>
        <td class="px-3 py-2 text-right font-semibold ${paperPnlClass(week.net_pnl)}">${paperMoney(week.net_pnl)}</td>
        <td class="px-3 py-2 text-right text-gray-300">${week.trades || 0}</td></tr>`);
    renderPaperTable('paper-weekly-table', ['Week of', 'Realized', 'Open P&L', 'Net P&L', 'Closed'], weeklyRows, 'No paper trades this month yet.');

    const openRows = (data.open_positions || []).map(position => `<tr>
        <td class="px-3 py-2 font-semibold text-white">${paperEscape(position.symbol)}</td>
        <td class="px-3 py-2 ${position.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}">${paperEscape(position.side)}</td>
        <td class="px-3 py-2 text-right text-gray-300">${position.quantity}</td>
        <td class="px-3 py-2 text-right text-gray-300">₹${Number(position.entry_price).toFixed(2)}</td>
        <td class="px-3 py-2 text-right text-gray-300">₹${Number(position.mark_price).toFixed(2)}</td>
        <td class="px-3 py-2 text-right font-semibold ${paperPnlClass(position.unrealized_pnl)}">${paperMoney(position.unrealized_pnl)}</td>
        <td class="px-3 py-2 text-gray-400">${paperEscape(position.entry_time)}</td></tr>`);
    renderPaperTable('paper-open-table', ['Option', 'Side', 'Qty', 'Entry', 'LTP', 'Open P&L', 'Opened'], openRows, 'No open paper positions.');

    const tradeRows = (data.trades || []).map(trade => {
        const isOpen = trade.status === 'OPEN';
        const pnl = isOpen ? trade.unrealized_pnl : trade.realized_pnl;
        return `<tr>
            <td class="px-3 py-2 font-semibold text-white">${paperEscape(trade.symbol)}</td>
            <td class="px-3 py-2 ${trade.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}">${paperEscape(trade.side)}</td>
            <td class="px-3 py-2 text-gray-300">${paperEscape(trade.entry_time)}</td>
            <td class="px-3 py-2 text-right text-gray-300">₹${Number(trade.entry_price).toFixed(2)}</td>
            <td class="px-3 py-2 text-gray-300">${isOpen ? 'OPEN' : paperEscape(trade.exit_reason || 'closed')}</td>
            <td class="px-3 py-2 text-right ${paperPnlClass(pnl)}">${paperMoney(pnl)}</td></tr>`;
    });
    renderPaperTable('paper-trades-table', ['Option', 'Side', 'Entry time', 'Entry', 'Status / Exit', 'P&L'], tradeRows, 'Paper trade history will appear here.');
}

async function fetchPaperTradingData() {
    try {
        const response = await fetch('/api/paper-trading');
        if (!response.ok) throw new Error(`Paper trading API returned ${response.status}`);
        renderPaperTrading(await response.json());
    } catch (error) {
        const status = document.getElementById('paper-status');
        if (status) status.textContent = 'Could not load paper trading data. Check the dashboard server logs.';
        console.error('Paper trading dashboard refresh failed:', error);
    }
}

function openSearchModal() {
    toggleFlexModal('search-modal', true);
    const input = document.getElementById('cmd-search-input');
    input.value = ''; renderSearchModalResults(); input.focus();
}
function closeSearchModal() { toggleFlexModal('search-modal', false); }

function renderSearchModalResults() {
    const q = document.getElementById('cmd-search-input').value.trim().toUpperCase();
    const listEl = document.getElementById('cmd-search-list'), countEl = document.getElementById('cmd-result-count');
    const matches = q ? screenerRows.filter(r => r.stock.toUpperCase().includes(q) || r.category.toUpperCase().includes(q) || r.type.toUpperCase().includes(q)) : screenerRows.slice(0, 25);
    countEl.textContent = q ? `Search results (${matches.length})` : `Popular / Top Active Symbols (${matches.length})`;
    if (!matches.length && q) {
        listEl.innerHTML = `<li onclick="loadSymbolIntoActivePane('${q}'); closeSearchModal();" class="p-3.5 hover:bg-gray-800 cursor-pointer flex items-center justify-between text-xs"><span class="text-white">Load custom symbol: <strong class="text-yellow-400">${q}</strong></span><span class="text-gray-400">Press Enter ↵</span></li>`;
        return;
    }
    listEl.innerHTML = matches.slice(0, 45).map(r => `<li onclick="loadSymbolIntoActivePane('${r.fyers_symbol}'); closeSearchModal();" class="px-4 py-2.5 hover:bg-gray-800/80 cursor-pointer flex items-center justify-between">
        <div class="flex items-center gap-3"><button onclick="toggleStarSymbol('${r.stock}', event)" class="text-sm ${starredSymbols.includes(r.stock) ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-300'}">★</button><div><div class="text-xs font-bold text-white flex items-center gap-2">${r.stock}<span class="text-[10px] px-1.5 py-0.2 bg-gray-800 text-gray-300 rounded">${r.category}</span><span class="text-[10px] text-yellow-400">${r.type}</span></div><div class="text-[10px] text-gray-400">Fyers: ${r.fyers_symbol} • Next: ${r.next_level}</div></div></div>
        <div class="text-right"><div class="text-xs font-bold text-white">₹${r.ltp.toFixed(2)}</div><div>${getSignalBadge(r.signal)}</div></div>
    </li>`).join('');
}

function openIntervalModal(initialChar = '') {
    toggleFlexModal('interval-modal', true);
    const input = document.getElementById('interval-input');
    input.value = initialChar; onIntervalInputChange(); input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch(err) {}
}
function closeIntervalModal() { toggleFlexModal('interval-modal', false); document.getElementById('interval-input')?.blur(); }
function onIntervalInputChange() {
    const input = document.getElementById('interval-input'), preview = document.getElementById('interval-preview'), parsed = parseCustomIntervalInput(input.value);
    input.className = `w-36 h-9 bg-[#131722] border-2 ${parsed ? 'border-[#2962ff]' : 'border-[#ef4444]'} rounded text-center text-white font-semibold text-sm focus:outline-none`;
    preview.textContent = parsed ? parsed.longLabel : "Not applicable";
    preview.className = `mt-2.5 text-[11px] ${parsed ? 'text-gray-300' : 'text-gray-400'} font-medium h-4`;
}
function submitIntervalModal() {
    const parsed = parseCustomIntervalInput(document.getElementById('interval-input').value);
    if (!parsed) return;
    closeIntervalModal();
    (panes[activePaneId] || Object.values(panes)[0])?.setTimeframe(parsed.val);
}
socket.on('live_ticks_batch', function(ticks) {
    if (!ticks?.length || document.hidden) return;
    const paneList = Object.values(panes);
    for (let i = 0; i < ticks.length; i++) {
        const t = ticks[i];
        for (let j = 0; j < paneList.length; j++) {
            // Yahan t.signal add kiya gaya hai
            if (paneList[j].cleanSymbol === t.symbol) paneList[j].updateLiveTick(t.price, t.tstop, t.signal); 
        }
    }
});
socket.on('screener_data', applyScreenerPayload);

const SCREENER_CAT_BTNS = [
    ['ALL', 'ALL', ''], ['NIFTY50', 'NIFTY 50', ''], ['BANKNIFTY', 'BANKNIFTY', ''], ['SENSEX', 'SENSEX', ''],
    ['MIDCAP', 'MIDCAP', ''], ['FINNIFTY', 'FINNIFTY', ''], ['COMMODITY', 'COMMODITY', ''],
    ['OPT_NIFTY', 'OPT NIFTY', 'text-yellow-400 border border-yellow-500/30'],
    ['OPT_BANKNIFTY', 'OPT BANKNIFTY', 'text-yellow-400 border border-yellow-500/30'],
    ['OPT_SENSEX', 'OPT SENSEX', 'text-yellow-400 border border-yellow-500/30'],
    ['OPT_HOLD_POSITIONS', 'HOLD POSITIONS', 'text-emerald-400 border border-emerald-500/30']
];

function initStaticUI() {
    const bar = document.getElementById('screener-cat-bar');
    if (bar) bar.innerHTML = `<span class="text-xs font-bold text-gray-400 uppercase mr-1">Category:</span>` + SCREENER_CAT_BTNS.map(([cat, lbl, extra], i) => `<button onclick="setScreenerCat('${cat}')" data-cat="${cat}" data-extra="${extra}" class="scr-cat-btn px-3 py-1 rounded-lg text-xs font-semibold ${i === 0 ? 'bg-yellow-500 text-gray-950' : 'bg-gray-900 text-gray-300 hover:text-white ' + extra}">${lbl}</button>`).join('');
    const regChecks = document.getElementById('dsm-reg-checks');
    if (regChecks) regChecks.innerHTML = [['dsm-ext-l','Extend left line'],['dsm-ext-r','Extend right line'],['dsm-mid','Middle point'],['dsm-plbl','Price labels'],['dsm-prng','Price range'],['dsm-pct','Percent change'],['dsm-brng','Bars range'],['dsm-dist','Distance']].map(([id, lbl]) => `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="${id}"> ${lbl}</label>`).join('');
    const coordBox = document.getElementById('dsm-body-coord');
    if (coordBox) coordBox.innerHTML = [1, 2, 3].map(n => `<div ${n === 3 ? 'id="dsm-coord-p3-wrap" class="hidden items-center justify-between"' : 'class="flex items-center justify-between"'}><span>#${n} (price, bar)</span><div class="flex gap-2"><input type="number" step="0.05" id="dsm-p${n}" class="w-28 bg-[#131722] border ${n===1?'border-[#2962ff]':'border-gray-700'} rounded px-2 py-1 text-right"><input type="number" id="dsm-b${n}" class="w-16 bg-[#131722] border border-gray-700 rounded px-2 py-1 text-right" readonly></div></div>`).join('');
    const visBox = document.getElementById('dsm-body-vis');
    if (visBox) visBox.innerHTML = [['Seconds',59],['Minutes',59,'dsm-vis-m'],['Hours',24,'dsm-vis-h'],['Days',366,'dsm-vis-d'],['Weeks',52],['Months',12]].map(([lbl, max, id]) => `<div class="flex items-center justify-between"><label class="flex items-center gap-2"><input type="checkbox" ${id ? `id="${id}"` : ''} checked> ${lbl}</label><div class="flex items-center gap-2"><span class="px-2 py-0.5 bg-[#131722] border border-gray-700 rounded">1</span><div class="w-20 h-1 bg-white rounded"></div><span class="px-2 py-0.5 bg-[#131722] border border-gray-700 rounded">${max}</span></div></div>`).join('');

    document.getElementById('tv-width-pop').innerHTML = [1,2,3,4].map(w => `<div class="tv-pop-item" onclick="updateSelectedDrawingProp('width', ${w})"><span>━━━</span><span>${w}px</span></div>`).join('');
    document.getElementById('tv-style-pop').innerHTML = [['solid','───────','Solid'],['dashed','- - - - -','Dashed'],['dotted','··········','Dotted']].map(([k,s,l]) => `<div class="tv-pop-item" onclick="updateSelectedDrawingProp('dash', '${k}')"><span>${s}</span><span>${l}</span></div>`).join('');
    document.getElementById('tv-tpl-pop').innerHTML = `<div class="tv-pop-item" onclick="saveCurrentAsDefaultTemplate()">Save Drawing Template As...</div><div class="tv-pop-item" onclick="applyDefaultTemplate()">Apply Default Drawing Template</div>`;
    document.getElementById('tv-del-pop').innerHTML = `<div class="px-2.5 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Delete Options</div><div class="tv-pop-item" onclick="deleteSelectedDrawing()"><span>Remove Selected Drawing</span><span class="text-gray-500">Del</span></div><div class="tv-pop-item" onclick="clearActivePaneDrawings()"><span>Remove All Drawings on Active Chart</span></div><div class="border-t border-gray-800 my-1"></div><div class="tv-pop-item text-red-400" onclick="clearAllSymbolsDrawings()"><span>Clear All Saved Drawings (All Symbols)</span></div>`;
}

window.onload = () => {
    initStaticUI();
    const savedCount = localStorage.getItem('chartLayoutCount') || "4";
    gridSelector.value = savedCount;
    changeLayout(savedCount);
    fetchScreenerDataOnce();
    fetchPaperTradingData();
    setInterval(() => {
        if (!document.hidden && !document.getElementById('view-paper').classList.contains('hidden')) {
            fetchPaperTradingData();
        }
    }, 3000);
    refreshSymbolsDatalist();
    setInterval(refreshSymbolsDatalist, 45000);
    if (!syncCrosshairEnabled) { syncCrosshairEnabled = true; toggleCrosshairSync(); }
};

// =========================================================================
// ZERO-LAG SYNCHRONOUS 60FPS DRAWING ENGINE + MAGNET OHLC SNAP + XHAIR SYNC
// =========================================================================
let currentDrawTool = 'cursor', lastLineTool = 'trendline', lastFibTool = 'fib', lastShapeTool = 'rect', lastPatternTool = 'xabcd', lastProjTool = 'long_pos';
let magnetEnabled = JSON.parse(localStorage.getItem('sp_magnet_mode') || 'false');
let stayInDrawingMode = false, lockAllDrawings = false, hideAllDrawings = false, selectedDrawingRef = null;
let starredLineTools = JSON.parse(localStorage.getItem('sp_starred_line_tools') || '["trendline","ray","parallel_channel","regression_trend"]');
let starredFibTools = JSON.parse(localStorage.getItem('sp_starred_fib_tools') || '["fib"]');
let starredShapeTools = JSON.parse(localStorage.getItem('sp_starred_shape_tools') || '["rect","path","circle","ellipse"]');
let starredPatternTools = JSON.parse(localStorage.getItem('sp_starred_pattern_tools') || '["xabcd","head_shoulders","abcd","triangle_pattern"]');
let starredProjTools = JSON.parse(localStorage.getItem('sp_starred_proj_tools') || '["long_pos","short_pos","forecast","frvp","price_range","date_range","date_price_range"]');

function toggleMagnetMode() {
    magnetEnabled = !magnetEnabled;
    localStorage.setItem('sp_magnet_mode', JSON.stringify(magnetEnabled));
    const btn = document.getElementById('btn-magnet-mode');
    if (btn) btn.classList.toggle('active', magnetEnabled);
}
window.addEventListener('DOMContentLoaded', () => document.getElementById('btn-magnet-mode')?.classList.toggle('active', magnetEnabled));

const DEFAULT_FIB_LEVELS = [
    [1,0,'#787b86'],[1,0.236,'#f23645'],[1,0.382,'#ff9800'],[1,0.5,'#4caf50'],[1,0.618,'#089981'],[1,0.786,'#00bcd4'],
    [1,1,'#787b86'],[1,1.618,'#2962ff'],[0,2.618,'#f23645'],[0,3.618,'#9c27b0'],[0,4.236,'#e91e63'],[0,-0.236,'#f23645'],
    [0,-0.382,'#ff9800'],[0,1.272,'#ff9800'],[0,1.414,'#f23645'],[0,-0.618,'#089981'],[0,2,'#089981'],[0,2.272,'#ff9800'],
    [0,2.414,'#4caf50'],[0,3,'#00bcd4'],[0,3.272,'#787b86'],[0,3.414,'#2962ff'],[0,4,'#f23645'],[0,4.414,'#ff9800']
].map(([e, val, color]) => ({ enabled: !!e, val, color }));

const FIB_TOOLS_MENU = [
    { section: 'FIBONACCI' },
    { id: 'fib', label: 'Fib Retracement', shortcut: 'Alt + F', svg: '<line x1="3" y1="4" x2="21" y2="4"/><line x1="3" y1="9" x2="18" y2="9"/><circle cx="19.5" cy="9" r="2.2" fill="#131722"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="6" y1="19" x2="21" y2="19"/><circle cx="4.5" cy="19" r="2.2" fill="#131722"/>' },
    { id: 'fib_ext', label: 'Trend-Based Fib Extension', shortcut: '', svg: '<line x1="4" y1="9" x2="11" y2="4"/><line x1="4" y1="9" x2="4" y2="16"/><circle cx="4" cy="9" r="2" fill="#131722"/><circle cx="11" cy="4" r="2" fill="#131722"/><circle cx="4" cy="16" r="2" fill="#131722"/><line x1="4" y1="16" x2="20" y2="16"/><line x1="4" y1="20" x2="20" y2="20"/>' }
];
const SHAPE_TOOLS_MENU = [
    { section: 'SHAPES' },
    { id: 'rect', label: 'Rectangle', shortcut: 'Alt + Shift + R', svg: '<rect x="4" y="6" width="16" height="12" rx="0.5"/><circle cx="4" cy="6" r="2" fill="#131722"/><circle cx="20" cy="6" r="2" fill="#131722"/><circle cx="4" cy="18" r="2" fill="#131722"/><circle cx="20" cy="18" r="2" fill="#131722"/>' },
    { id: 'rotated_rect', label: 'Rotated Rectangle', shortcut: '', svg: '<polygon points="12,3 21,10 12,21 3,14"/><circle cx="12" cy="3" r="2" fill="#131722"/><circle cx="21" cy="10" r="2" fill="#131722"/><circle cx="12" cy="21" r="2" fill="#131722"/><circle cx="3" cy="14" r="2" fill="#131722"/>' },
    { id: 'path', label: 'Path', shortcut: '', svg: '<polyline points="3,17 9,10 14,15 21,7"/><polyline points="16,7 21,7 21,12"/><circle cx="3" cy="17" r="2" fill="#131722"/><circle cx="9" cy="10" r="2" fill="#131722"/><circle cx="14" cy="15" r="2" fill="#131722"/>' },
    { id: 'circle', label: 'Circle', shortcut: '', svg: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="#131722"/><circle cx="20" cy="12" r="2" fill="#131722"/>' },
    { id: 'ellipse', label: 'Ellipse', shortcut: '', svg: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><circle cx="12" cy="6.5" r="2" fill="#131722"/><circle cx="12" cy="17.5" r="2" fill="#131722"/><circle cx="3" cy="12" r="2" fill="#131722"/><circle cx="21" cy="12" r="2" fill="#131722"/>' },
    { id: 'polyline', label: 'Polyline', shortcut: '', svg: '<polygon points="5,18 5,11 10,7 17,9 17,14 12,14 12,18"/><circle cx="5" cy="18" r="1.8" fill="#131722"/><circle cx="10" cy="7" r="1.8" fill="#131722"/><circle cx="17" cy="9" r="1.8" fill="#131722"/><circle cx="12" cy="18" r="1.8" fill="#131722"/>' },
    { section: 'ARROWS' },
    { id: 'arrow_marker', label: 'Arrow Marker', shortcut: '', svg: '<polygon points="4,19 14,9 11,6 20,4 18,13 15,10 5,20"/>' },
    { id: 'arrow', label: 'Arrow', shortcut: '', svg: '<line x1="4" y1="20" x2="19" y2="5"/><polygon points="19,5 12,7 17,12" fill="currentColor"/><circle cx="4" cy="20" r="2.2" fill="#131722"/><circle cx="19" cy="5" r="2.2" fill="#131722"/>' }
];
const PATTERN_TOOLS_MENU = [
    { section: 'PATTERNS' },
    { id: 'xabcd', label: 'XABCD Pattern', pts: 5, labels: ['X','A','B','C','D'], svg: '<polyline points="4,19 8,5 12,12 17,6 20,16"/><line x1="4" y1="19" x2="12" y2="12"/><line x1="12" y1="12" x2="20" y2="16"/><circle cx="4" cy="19" r="2" fill="#131722"/><circle cx="8" cy="5" r="2" fill="#131722"/><circle cx="12" cy="12" r="2" fill="#131722"/><circle cx="17" cy="6" r="2" fill="#131722"/><circle cx="20" cy="16" r="2" fill="#131722"/>' },
    { id: 'cypher', label: 'Cypher Pattern', pts: 5, labels: ['X','A','B','C','D'], svg: '<polyline points="4,19 8,5 12,12 17,6 20,16"/><line x1="4" y1="19" x2="12" y2="12"/><line x1="12" y1="12" x2="20" y2="16"/><circle cx="4" cy="19" r="2" fill="#131722"/><circle cx="8" cy="5" r="2" fill="#131722"/><circle cx="12" cy="12" r="2" fill="#131722"/><circle cx="17" cy="6" r="2" fill="#131722"/><circle cx="20" cy="16" r="2" fill="#131722"/><text x="12" y="21" font-size="6.5" fill="currentColor" text-anchor="middle" stroke="none" font-weight="bold">C</text>' },
    { id: 'head_shoulders', label: 'Head and Shoulders', pts: 7, labels: ['','L','N1','H','N2','R',''], svg: '<polyline points="2,18 5,11 8,16 12,5 16,16 19,11 22,18"/><line x1="2" y1="16" x2="22" y2="16" stroke-dasharray="2 2"/><circle cx="5" cy="11" r="1.8" fill="#131722"/><circle cx="12" cy="5" r="1.8" fill="#131722"/><circle cx="19" cy="11" r="1.8" fill="#131722"/>' },
    { id: 'abcd', label: 'ABCD Pattern', pts: 4, labels: ['A','B','C','D'], svg: '<polyline points="4,18 8,6 15,16 19,5"/><line x1="8" y1="6" x2="19" y2="5" stroke-dasharray="2 2"/><line x1="4" y1="18" x2="15" y2="16" stroke-dasharray="2 2"/><circle cx="4" cy="18" r="2" fill="#131722"/><circle cx="8" cy="6" r="2" fill="#131722"/><circle cx="15" cy="16" r="2" fill="#131722"/><circle cx="19" cy="5" r="2" fill="#131722"/>' },
    { id: 'triangle_pattern', label: 'Triangle Pattern', pts: 4, labels: ['A','B','C','D'], svg: '<polyline points="4,19 7,6 11,15 15,9"/><line x1="4" y1="19" x2="21" y2="12"/><line x1="7" y1="6" x2="21" y2="12"/><circle cx="4" cy="19" r="2" fill="#131722"/><circle cx="7" cy="6" r="2" fill="#131722"/><circle cx="11" cy="15" r="2" fill="#131722"/><circle cx="15" cy="9" r="2" fill="#131722"/>' },
    { id: 'three_drives', label: 'Three Drives Pattern', pts: 7, labels: ['0','1','A','2','B','3','C'], svg: '<polyline points="3,18 6,11 9,16 12,8 15,14 18,5 21,12"/><circle cx="6" cy="11" r="1.7" fill="#131722"/><circle cx="12" cy="8" r="1.7" fill="#131722"/><circle cx="18" cy="5" r="1.7" fill="#131722"/><circle cx="21" cy="12" r="1.7" fill="#131722"/>' }
];
const PROJ_TOOLS_MENU = [
    { section: 'PROJECTION' },
    { id: 'long_pos', label: 'Long Position', svg: '<rect x="4" y="4" width="16" height="8" fill="#089981" fill-opacity="0.35"/><rect x="4" y="12" width="16" height="7" fill="#f23645" fill-opacity="0.35"/><line x1="3" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="2" fill="#131722"/>' },
    { id: 'short_pos', label: 'Short Position', svg: '<rect x="4" y="4" width="16" height="7" fill="#f23645" fill-opacity="0.35"/><rect x="4" y="11" width="16" height="8" fill="#089981" fill-opacity="0.35"/><line x1="3" y1="11" x2="21" y2="11"/><circle cx="12" cy="11" r="2" fill="#131722"/>' },
    { id: 'forecast', label: 'Forecast', svg: '<line x1="5" y1="6" x2="5" y2="18"/><rect x="3.5" y="9" width="3" height="6" fill="#131722"/><line x1="11" y1="5" x2="11" y2="17"/><rect x="9.5" y="8" width="3" height="6" fill="#131722"/><line x1="17" y1="5" x2="17" y2="13"/><polyline points="14.5,11 17,14 19.5,11"/><circle cx="17" cy="17.5" r="1.5" fill="currentColor"/>' },
    { id: 'bars_pattern', label: 'Bars Pattern', svg: '<line x1="4" y1="6" x2="4" y2="18"/><rect x="2.5" y="9" width="3" height="6" fill="#131722"/><line x1="9" y1="8" x2="9" y2="20"/><rect x="7.5" y="11" width="3" height="5" fill="#131722"/><line x1="14" y1="4" x2="14" y2="17"/><rect x="12.5" y="7" width="3" height="6" fill="#131722"/><line x1="19" y1="6" x2="19" y2="16"/><rect x="17.5" y="8" width="3" height="5" fill="#131722"/>' },
    { id: 'ghost_feed', label: 'Ghost Feed', svg: '<line x1="4" y1="16" x2="20" y2="9"/><circle cx="4" cy="16" r="2" fill="#131722"/><circle cx="20" cy="9" r="2" fill="#131722"/><rect x="8" y="10" width="3" height="7" fill="#131722"/><line x1="9.5" y1="7" x2="9.5" y2="19"/><rect x="13" y="8" width="3" height="7" fill="#131722"/><line x1="14.5" y1="5" x2="14.5" y2="17"/>' },
    { section: 'VOLUME-BASED' },
    { id: 'avwap', label: 'Anchored VWAP', svg: '<path d="M3 16 Q 9 14, 14 10 T 21 7"/><line x1="8" y1="5" x2="8" y2="19"/><rect x="6.5" y="8" width="3" height="7" fill="#131722"/><line x1="14" y1="4" x2="14" y2="18"/><rect x="12.5" y="7" width="3" height="7" fill="#131722"/><circle cx="4" cy="16" r="2" fill="#131722"/>' },
    { id: 'frvp', label: 'Fixed Range Volume Profile', svg: '<line x1="4" y1="4" x2="4" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/><circle cx="4" cy="19" r="2" fill="#131722"/><circle cx="18" cy="5" r="2" fill="#131722"/><rect x="4" y="7" width="6" height="3"/><rect x="4" y="10" width="10" height="3"/><rect x="4" y="13" width="5" height="3"/>' },
    { section: 'MEASURER' },
    { id: 'price_range', label: 'Price Range', svg: '<line x1="4" y1="5" x2="18" y2="5"/><line x1="4" y1="19" x2="18" y2="19"/><circle cx="16" cy="5" r="2" fill="#131722"/><circle cx="6" cy="19" r="2" fill="#131722"/><line x1="11" y1="18" x2="11" y2="7"/><polyline points="8.5,10 11,7 13.5,10"/>' },
    { id: 'date_range', label: 'Date Range', svg: '<line x1="5" y1="4" x2="5" y2="20"/><line x1="19" y1="4" x2="19" y2="20"/><circle cx="5" cy="18" r="2" fill="#131722"/><circle cx="19" cy="6" r="2" fill="#131722"/><line x1="6" y1="12" x2="17" y2="12"/><polyline points="14,9.5 17,12 14,14.5"/>' },
    { id: 'date_price_range', label: 'Date and Price Range', svg: '<rect x="4" y="5" width="15" height="14"/><circle cx="4" cy="19" r="2" fill="#131722"/><circle cx="19" cy="5" r="2" fill="#131722"/><line x1="11" y1="17" x2="11" y2="7"/><polyline points="8.5,9.5 11,7 13.5,9.5"/><line x1="6" y1="12" x2="17" y2="12"/><polyline points="14.5,9.5 17,12 14.5,14.5"/>' }
];
const LINE_TOOLS_MENU = [
    { section: 'LINES' },
    { id: 'trendline', label: 'Trend Line', shortcut: 'Alt + T', svg: '<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2.5" fill="#131722"/><circle cx="20" cy="4" r="2.5" fill="#131722"/>' },
    { id: 'ray', label: 'Ray', shortcut: '', svg: '<line x1="4" y1="20" x2="21" y2="3"/><circle cx="4" cy="20" r="2.5" fill="#131722"/><circle cx="13" cy="11" r="2.2" fill="#131722"/>' },
    { id: 'infoline', label: 'Info Line', shortcut: '', svg: '<line x1="4" y1="20" x2="19" y2="5"/><circle cx="4" cy="20" r="2.2" fill="#131722"/><circle cx="19" cy="5" r="2.2" fill="#131722"/><rect x="13" y="14" width="7" height="5" rx="1"/>' },
    { id: 'extended', label: 'Extended Line', shortcut: '', svg: '<line x1="2" y1="22" x2="22" y2="2"/><circle cx="8" cy="16" r="2.2" fill="#131722"/><circle cx="16" cy="8" r="2.2" fill="#131722"/>' },
    { id: 'trendangle', label: 'Trend Angle', shortcut: '', svg: '<line x1="4" y1="19" x2="18" y2="5"/><line x1="4" y1="19" x2="20" y2="19"/><path d="M12 19 A8 8 0 0 0 9.6 13.4"/><circle cx="4" cy="19" r="2.2" fill="#131722"/><circle cx="18" cy="5" r="2.2" fill="#131722"/>' },
    { id: 'hline', label: 'Horizontal Line', shortcut: 'Alt + H', svg: '<line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.5" fill="#131722"/>' },
    { id: 'hray', label: 'Horizontal Ray', shortcut: 'Alt + J', svg: '<line x1="4" y1="12" x2="22" y2="12"/><circle cx="4" cy="12" r="2.5" fill="#131722"/>' },
    { id: 'vline', label: 'Vertical Line', shortcut: 'Alt + V', svg: '<line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="12" r="2.5" fill="#131722"/>' },
    { id: 'crossline', label: 'Cross Line', shortcut: 'Alt + C', svg: '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.5" fill="#131722"/>' },
    { section: 'CHANNELS' },
    { id: 'parallel_channel', label: 'Parallel Channel', shortcut: '', svg: '<line x1="4" y1="17" x2="17" y2="4"/><line x1="7" y1="20" x2="20" y2="7"/><circle cx="4" cy="17" r="2.2" fill="#131722"/><circle cx="17" cy="4" r="2.2" fill="#131722"/><circle cx="13.5" cy="13.5" r="2.2" fill="#131722"/>' },
    { id: 'regression_trend', label: 'Regression Trend', shortcut: '', svg: '<line x1="4" y1="15" x2="20" y2="5"/><line x1="4" y1="20" x2="20" y2="10"/><line x1="4" y1="17.5" x2="20" y2="7.5" stroke-dasharray="2 2"/><circle cx="4" cy="17.5" r="2.2" fill="#131722"/><circle cx="20" cy="7.5" r="2.2" fill="#131722"/>' },
    { id: 'flat_channel', label: 'Flat Top/Bottom', shortcut: '', svg: '<line x1="4" y1="15" x2="20" y2="6"/><line x1="4" y1="19" x2="20" y2="19"/><circle cx="4" cy="15" r="2.2" fill="#131722"/><circle cx="20" cy="6" r="2.2" fill="#131722"/><circle cx="4" cy="19" r="2.2" fill="#131722"/>' },
    { id: 'disjoint_channel', label: 'Disjoint Channel', shortcut: '', svg: '<line x1="4" y1="14" x2="20" y2="5"/><line x1="4" y1="16" x2="20" y2="20"/><circle cx="4" cy="14" r="2.2" fill="#131722"/><circle cx="20" cy="5" r="2.2" fill="#131722"/><circle cx="20" cy="20" r="2.2" fill="#131722"/>' }
];

const FIB_TOOL_IDS = new Set(['fib', 'fib_ext']);
const SHAPE_TOOL_IDS = new Set(SHAPE_TOOLS_MENU.filter(x => x.id).map(x => x.id));
const PATTERN_TOOL_MAP = Object.fromEntries(PATTERN_TOOLS_MENU.filter(x => x.id).map(x => [x.id, x]));
const PATTERN_TOOL_IDS = new Set(Object.keys(PATTERN_TOOL_MAP));
const PROJ_TOOL_MAP = Object.fromEntries(PROJ_TOOLS_MENU.filter(x => x.id).map(x => [x.id, x]));
const PROJ_TOOL_IDS = new Set(Object.keys(PROJ_TOOL_MAP));
const LINE_TOOL_IDS = new Set(LINE_TOOLS_MENU.filter(x => x.id).map(x => x.id));
const CHANNEL_TYPES = new Set(['parallel_channel', 'flat_channel', 'disjoint_channel']);
const THREE_POINT_TYPES = new Set(['parallel_channel', 'flat_channel', 'disjoint_channel', 'fib_ext', 'rotated_rect']);
const MULTI_POINT_TYPES = new Set(['path', 'polyline']);
const FILLED_SHAPE_TYPES = new Set(['rect', 'rotated_rect', 'circle', 'ellipse', 'polyline', 'arrow_marker', ...PATTERN_TOOL_IDS]);
const BOX_TOOLS = new Set(['rect', 'ellipse', 'measure', 'price_range', 'date_range', 'date_price_range', 'frvp', 'forecast', 'bars_pattern', 'ghost_feed']);

const TOOL_GROUPS = {
    line:    { pop: 'tv-lines-pop',    btn: 'btn-lines-group',    svg: 'btn-lines-svg',    menu: LINE_TOOLS_MENU,    stars: () => starredLineTools,    key: 'sp_starred_line_tools',    last: () => lastLineTool,    setLast: v => lastLineTool = v },
    fib:     { pop: 'tv-fib-pop',      btn: 'btn-fib-group',      svg: 'btn-fib-svg',      menu: FIB_TOOLS_MENU,     stars: () => starredFibTools,     key: 'sp_starred_fib_tools',     last: () => lastFibTool,     setLast: v => lastFibTool = v },
    shape:   { pop: 'tv-shapes-pop',   btn: 'btn-shapes-group',   svg: 'btn-shapes-svg',   menu: SHAPE_TOOLS_MENU,   stars: () => starredShapeTools,   key: 'sp_starred_shape_tools',   last: () => lastShapeTool,   setLast: v => lastShapeTool = v },
    pattern: { pop: 'tv-patterns-pop', btn: 'btn-patterns-group', svg: 'btn-patterns-svg', menu: PATTERN_TOOLS_MENU, stars: () => starredPatternTools, key: 'sp_starred_pattern_tools', last: () => lastPatternTool, setLast: v => lastPatternTool = v },
    proj:    { pop: 'tv-proj-pop',     btn: 'btn-proj-group',     svg: 'btn-proj-svg',     menu: PROJ_TOOLS_MENU,    stars: () => starredProjTools,    key: 'sp_starred_proj_tools',    last: () => lastProjTool,    setLast: v => lastProjTool = v }
};

const ALL_TOOLS_MAP = {};
Object.entries(TOOL_GROUPS).forEach(([gKey, g]) => g.menu.forEach(item => { if (item.id) ALL_TOOLS_MAP[item.id] = { ...item, group: gKey }; }));

function renderGroupMenu(gKey) {
    const g = TOOL_GROUPS[gKey], pop = document.getElementById(g.pop);
    if (!pop) return;
    pop.innerHTML = g.menu.map((item, idx) => item.section
        ? `<div class="tv-menu-sec ${idx > 0 ? 'border-t border-[#2a2e39] mt-1 pt-2' : ''}">${item.section}</div>`
        : `<div class="tv-line-row ${currentDrawTool === item.id ? 'active' : ''}" onclick="chooseGroupTool('${gKey}','${item.id}',event)"><div class="tv-line-left"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${item.svg}</svg><span>${item.label}</span></div><div class="tv-line-right">${item.shortcut ? `<span>${item.shortcut}</span>` : ''}<span class="tv-line-star ${g.stars().includes(item.id) ? 'starred' : ''}" onclick="toggleGroupStar('${gKey}','${item.id}',event)">★</span></div></div>`
    ).join('');
}

function openGroupMenu(gKey, e) {
    if (e) e.stopPropagation();
    const g = TOOL_GROUPS[gKey], pop = document.getElementById(g.pop), isVis = pop.style.display === 'flex';
    closeAllPopMenus();
    if (!isVis) {
        renderGroupMenu(gKey);
        const r = document.getElementById(g.btn).getBoundingClientRect();
        Object.assign(pop.style, { display: 'flex', left: (r.right + 4) + 'px', top: Math.max(54, Math.min(window.innerHeight - 380, r.top)) + 'px' });
    }
    selectDrawTool(g.last());
}

function chooseGroupTool(gKey, toolId, e) {
    if (e) e.stopPropagation();
    const g = TOOL_GROUPS[gKey], found = ALL_TOOLS_MAP[toolId];
    g.setLast(toolId);
    if (found) {
        document.getElementById(g.svg).innerHTML = (gKey === 'shape' && toolId === 'rect') ? '<rect x="3" y="5" width="18" height="14" rx="1" fill="currentColor" fill-opacity="0.18"/>' : found.svg;
        document.getElementById(g.btn).title = found.label;
    }
    closeAllPopMenus();
    selectDrawTool(toolId);
}

function toggleGroupStar(gKey, toolId, e) {
    if (e) e.stopPropagation();
    const g = TOOL_GROUPS[gKey], arr = g.stars(), idx = arr.indexOf(toolId);
    idx > -1 ? arr.splice(idx, 1) : arr.push(toolId);
    localStorage.setItem(g.key, JSON.stringify(arr));
    renderGroupMenu(gKey); renderFavDrawBar();
}

const openLinesMenu = e => openGroupMenu('line', e);
const openFibMenu = e => openGroupMenu('fib', e);
const openShapesMenu = e => openGroupMenu('shape', e);
const openPatternsMenu = e => openGroupMenu('pattern', e);
const openProjMenu = e => openGroupMenu('proj', e);

let favDrawBarVisible = JSON.parse(localStorage.getItem('sp_fav_draw_bar_visible') || 'false');
const getAllStarredToolsMeta = () => Object.entries(TOOL_GROUPS).flatMap(([gKey, g]) => g.menu.filter(x => x.id && g.stars().includes(x.id)).map(x => ({ ...x, group: gKey })));

function renderFavDrawBar() {
    const bar = document.getElementById('tv-fav-bar'), listEl = document.getElementById('tv-fav-list'), toggleBtn = document.getElementById('btn-fav-bar-toggle');
    if (!bar || !listEl) return;
    if (toggleBtn) { toggleBtn.classList.toggle('active', favDrawBarVisible); toggleBtn.style.color = favDrawBarVisible ? '#f59e0b' : ''; }
    if (!favDrawBarVisible) { bar.style.display = 'none'; return; }
    const favs = getAllStarredToolsMeta();
    bar.style.display = 'flex';
    listEl.innerHTML = favs.length ? favs.map(item => `<button class="tv-fav-item ${currentDrawTool === item.id ? 'active' : ''}" onclick="selectFavBarTool('${item.id}', '${item.group}')" title="${item.label}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${item.svg}</svg></button>`).join('') : `<span class="text-[11px] text-gray-400 px-2">Click ★ on any tool to pin here</span>`;
}

function selectFavBarTool(toolId, group) {
    if (currentDrawTool === toolId) return selectDrawTool('cursor');
    TOOL_GROUPS[group] ? chooseGroupTool(group, toolId) : selectDrawTool(toolId);
}

function toggleFavDrawBar() {
    favDrawBarVisible = !favDrawBarVisible;
    localStorage.setItem('sp_fav_draw_bar_visible', JSON.stringify(favDrawBarVisible));
    renderFavDrawBar();
}

(function initDraggableBars() {
    function makeDraggable(barId, handleId) {
        const bar = document.getElementById(barId), handle = document.getElementById(handleId);
        if (!bar || !handle) return;
        let dragging = false, ox = 0, oy = 0;
        handle.addEventListener('mousedown', (e) => { dragging = true; const r = bar.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault(); });
        window.addEventListener('mousemove', (e) => { if (!dragging) return; bar.style.left = Math.max(46, Math.min(window.innerWidth - 120, e.clientX - ox)) + 'px'; bar.style.top = Math.max(54, Math.min(window.innerHeight - 44, e.clientY - oy)) + 'px'; });
        window.addEventListener('mouseup', () => { dragging = false; });
    }
    window.addEventListener('DOMContentLoaded', () => { makeDraggable('tv-fav-bar', 'tv-fav-drag'); makeDraggable('tv-float-bar', 'tv-fb-drag'); renderFavDrawBar(); });
})();

function getDefaultDrawProps(type) {
    const savedTpl = JSON.parse(localStorage.getItem('sp_draw_default_tpl') || '{}'), isFib = FIB_TOOL_IDS.has(type);
    const clonedLevels = DEFAULT_FIB_LEVELS.map(lv => ({ ...lv, enabled: type === 'fib_ext' && lv.val === 1.618 ? false : lv.enabled }));
    const defaultColor = (FILLED_SHAPE_TYPES.has(type) || CHANNEL_TYPES.has(type) || type === 'regression_trend' || type === 'path' || type === 'arrow') ? '#2962ff' : (isFib ? '#787b86' : '#ffffff');
    return {
        id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), type,
        color: savedTpl.color || defaultColor, fillColor: savedTpl.fillColor || '#2962ff',
        opacity: savedTpl.opacity || (isFib ? 0.16 : 0.20), width: savedTpl.width || (isFib ? 1 : 2), dash: savedTpl.dash || 'solid',
        extendLeft: (type === 'extended'), extendRight: (type === 'ray' || type === 'extended' || type === 'hray'),
        middlePoint: true, priceLabels: (type === 'infoline'), priceRange: (type === 'infoline'), pctChange: (type === 'infoline'),
        barsRange: (type === 'infoline'), distance: (type === 'infoline' || type === 'trendangle'),
        text: '', textColor: '#ffffff', textSize: 12, textBold: false, textAlign: 'center',
        fibShowTrendLine: true, fibTrendColor: '#787b86', fibTrendDash: 'dashed', fibLevels: clonedLevels,
        fibUseOneColor: false, fibOneColor: '#2962ff', fibShowBg: true, fibReverse: false,
        fibShowPrices: (type === 'fib'), fibShowLevels: true, fibLevelsFmt: 'values',
        fibLabelAlign: (type === 'fib_ext' ? 'right' : 'left'), fibLabelVAlign: 'middle', fibLogScale: false,
        locked: false, p1: null, p2: null, p3: null, points: []
    };
}

function ensureFibProps(d) {
    if (!Array.isArray(d.fibLevels) || d.fibLevels.length < 10) d.fibLevels = DEFAULT_FIB_LEVELS.map(lv => ({ ...lv }));
    if (d.fibShowTrendLine === undefined) d.fibShowTrendLine = true;
    if (!d.fibTrendColor) d.fibTrendColor = '#787b86';
    if (!d.fibTrendDash) d.fibTrendDash = 'dashed';
    if (d.fibShowBg === undefined) d.fibShowBg = true;
    if (d.fibShowPrices === undefined) d.fibShowPrices = (d.type === 'fib');
    if (d.fibShowLevels === undefined) d.fibShowLevels = true;
    if (!d.fibLevelsFmt) d.fibLevelsFmt = 'values';
    if (!d.fibLabelAlign) d.fibLabelAlign = (d.type === 'fib_ext' ? 'right' : 'left');
    if (!d.fibLabelVAlign) d.fibLabelVAlign = 'middle';
}

function toggleLeftDrawBar() {
    const bar = document.getElementById('tv-left-bar'), btn = document.getElementById('tv-bar-toggle');
    bar.classList.toggle('collapsed'); btn.classList.toggle('collapsed');
    btn.textContent = bar.classList.contains('collapsed') ? '›' : '‹';
    setTimeout(() => Object.values(panes).forEach(p => p.resizeChart()), 160);
}

function selectDrawTool(tool) {
    currentDrawTool = tool;
    renderFavDrawBar();
    document.querySelectorAll('#tv-left-bar .tv-tool-btn[data-tool]').forEach(b => {
        if (b.id === 'btn-lines-group') b.classList.toggle('active', LINE_TOOL_IDS.has(tool));
        else if (b.id === 'btn-fib-group') b.classList.toggle('active', FIB_TOOL_IDS.has(tool));
        else if (b.id === 'btn-shapes-group') b.classList.toggle('active', SHAPE_TOOL_IDS.has(tool));
        else if (b.id === 'btn-patterns-group') b.classList.toggle('active', PATTERN_TOOL_IDS.has(tool));
        else if (b.id === 'btn-proj-group') b.classList.toggle('active', PROJ_TOOL_IDS.has(tool));
        else b.classList.toggle('active', b.dataset.tool === tool);
    });
    Object.values(panes).forEach(p => {
        if (!p.drawCanvas) return;
        p.activeDraft = null; p.draftStep = 0;
        const isDrawing = (tool !== 'cursor');
        p.chart.applyOptions({ handleScroll: !isDrawing, handleScale: !isDrawing });
        p.container.style.cursor = isDrawing ? 'crosshair' : 'default';
        p.requestDraw?.();
    });
}

function closeAllPopMenus() {
    ['tv-lines-pop', 'tv-fib-pop', 'tv-shapes-pop', 'tv-patterns-pop', 'tv-proj-pop', 'tv-width-pop', 'tv-style-pop', 'tv-tpl-pop', 'tv-del-pop'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
}

function finishDraft(pane, item = pane.activeDraft) {
    if (!item) return;
    pane.drawings.push(item); pane.activeDraft = null; pane.draftStep = 0;
    pane.saveDrawings(); selectDrawing(pane, item);
    if (!stayInDrawingMode) selectDrawTool('cursor');
    pane.requestDraw();
}

function hitPts(mx, my, pts, r = 8) {
    for (const [name, pt] of pts) { if (pt && Math.hypot(mx - pt.x, my - pt.y) <= r) return name; }
    return null;
}

function initPaneDrawingEngine(pane) {
    const canvas = document.createElement('canvas');
    canvas.className = 'draw-canvas';
    pane.container.appendChild(canvas);
    pane.drawCanvas = canvas;
    pane.drawCtx = canvas.getContext('2d');
    pane.drawings = []; pane.activeDraft = null; pane.draftStep = 0; pane.hoveredItem = null; pane.dragState = null; pane.isChartPanning = false;

    pane.saveDrawings = () => localStorage.setItem(`sp_drawings_${pane.symbol}`, JSON.stringify(pane.drawings));
    pane.loadDrawings = () => {
        try { pane.drawings = JSON.parse(localStorage.getItem(`sp_drawings_${pane.symbol}`) || '[]'); }
        catch (e) { pane.drawings = []; }
        pane.requestDraw();
    };

    pane.requestDraw = () => renderPaneDrawings(pane);

    pane.chart.timeScale().subscribeVisibleLogicalRangeChange(() => renderPaneDrawings(pane));
    pane.chart.subscribeCrosshairMove((param) => {
        if (pane.activeDraft || pane.isChartPanning) renderPaneDrawings(pane);
        if (syncCrosshairEnabled) {
            const newT = param?.time || null;
            if (newT !== syncedCrosshairTime) {
                syncedCrosshairTime = newT;
                Object.values(panes).forEach(p => { if (p !== pane) renderPaneDrawings(p); });
            }
        }
    });

    pane.container.addEventListener('wheel', () => {
        renderPaneDrawings(pane);
        requestAnimationFrame(() => renderPaneDrawings(pane));
    }, { passive: true });
    pane.container.addEventListener('touchmove', () => renderPaneDrawings(pane), { passive: true });

    pane.ro = new ResizeObserver(() => {
        const r = pane.container.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            pane.chart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.floor(r.width * dpr);
            canvas.height = Math.floor(r.height * dpr);
            canvas.style.width = r.width + 'px';
            canvas.style.height = r.height + 'px';
            renderPaneDrawings(pane);
        }
    });
    pane.ro.observe(pane.container);

    // OHLC Magnet Snap support inside xyToTimePrice
    function xyToTimePrice(x, y, disableMagnet = false) {
        const ts = pane.chart.timeScale();
        let time = ts.coordinateToTime(x);
        if (!time && pane.rawData.length > 0) {
            const log = ts.coordinateToLogical(x);
            if (log !== null) {
                const idx = Math.max(0, Math.min(pane.rawData.length - 1, Math.round(log)));
                const baseT = pane.rawData[idx].time + 19800;
                const step = pane.rawData.length > 1 ? (pane.rawData[1].time - pane.rawData[0].time) : 300;
                time = baseT + Math.round(log - idx) * step;
            }
        }
        let price = pane.candleSeries.coordinateToPrice(y) || 0;
        const finalTime = time || (pane.lastCandleTime || 0);

        if (magnetEnabled && !disableMagnet && currentDrawTool !== 'brush') {
            const c = pane.candleMap.get(finalTime);
            if (c) {
                const ohlc = [c.open, c.high, c.low, c.close];
                let bestP = price, minDist = 42; // Snap within 42px of candle OHLC
                for (const pVal of ohlc) {
                    const py = pane.candleSeries.priceToCoordinate(pVal);
                    if (py !== null && Math.abs(py - y) < minDist) {
                        minDist = Math.abs(py - y);
                        bestP = pVal;
                    }
                }
                price = bestP;
            }
        }
        return { time: finalTime, price: Number(price.toFixed(2)) };
    }

    function timePriceToXY(pt) {
        if (!pt) return null;
        const ts = pane.chart.timeScale();
        let x = ts.timeToCoordinate(pt.time);
        if (x === null && pane.rawData.length > 0) {
            const step = pane.rawData.length > 1 ? (pane.rawData[1].time - pane.rawData[0].time) : 300;
            const lastT = pane.rawData[pane.rawData.length - 1].time + 19800;
            x = ts.logicalToCoordinate((pane.rawData.length - 1) + (pt.time - lastT) / (step || 300));
        }
        const y = pane.candleSeries.priceToCoordinate(pt.price);
        return (x === null || y === null) ? null : { x, y };
    }
    pane.timePriceToXY = timePriceToXY;

    function distToSeg(mx, my, x1, y1, x2, y2) {
        const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
        if (l2 === 0) return Math.hypot(mx - x1, my - y1);
        const t = Math.max(0, Math.min(1, ((mx - x1) * (x2 - x1) + (my - y1) * (y2 - y1)) / l2));
        return Math.hypot(mx - (x1 + t * (x2 - x1)), my - (y1 + t * (y2 - y1)));
    }

    function hitTest(mx, my) {
        if (hideAllDrawings) return null;
        for (let i = pane.drawings.length - 1; i >= 0; i--) {
            const d = pane.drawings[i];
            if (d.type === 'hline') {
                const y = pane.candleSeries.priceToCoordinate(d.p1.price);
                if (y !== null && Math.abs(my - y) <= 7) return { item: d, handle: 'p1' };
                continue;
            }
            if ((MULTI_POINT_TYPES.has(d.type) || PATTERN_TOOL_IDS.has(d.type)) && d.points?.length) {
                const coords = d.points.map(pt => timePriceToXY(pt));
                const h = hitPts(mx, my, coords.map((pt, k) => ['pt_' + k, pt]), 8);
                if (h) return { item: d, handle: h };
                for (let k = 0; k < coords.length - 1; k++) {
                    if (coords[k] && coords[k + 1] && distToSeg(mx, my, coords[k].x, coords[k].y, coords[k + 1].x, coords[k + 1].y) <= 7) return { item: d, handle: 'body' };
                }
                continue;
            }
            const c1 = timePriceToXY(d.p1);
            if (!c1) continue;
            if (d.type === 'avwap') { if (Math.hypot(mx - c1.x, my - c1.y) <= 10) return { item: d, handle: 'p1' }; continue; }
            if (d.type === 'vline') { if (Math.abs(mx - c1.x) <= 7) return { item: d, handle: 'p1' }; continue; }
            if (d.type === 'crossline') {
                if (Math.hypot(mx - c1.x, my - c1.y) <= 9 || Math.abs(mx - c1.x) <= 6 || Math.abs(my - c1.y) <= 6) return { item: d, handle: 'p1' };
                continue;
            }
            const c2 = d.p2 ? timePriceToXY(d.p2) : c1;
            if (!c2) continue;

            if (d.type === 'long_pos' || d.type === 'short_pos') {
                const c3 = d.p3 ? timePriceToXY(d.p3) : c1;
                const h = hitPts(mx, my, [['p1', c1], ['p2', c2], ['p3', c3 ? { x: c2.x, y: c3.y } : null]], 9);
                if (h) return { item: d, handle: h };
                if (c3 && mx >= Math.min(c1.x, c2.x) && mx <= Math.max(c1.x, c2.x) && my >= Math.min(c1.y, c2.y, c3.y) && my <= Math.max(c1.y, c2.y, c3.y)) return { item: d, handle: 'body' };
                continue;
            }
            if (FIB_TOOL_IDS.has(d.type)) {
                ensureFibProps(d);
                const c3 = (d.type === 'fib_ext' && d.p3) ? timePriceToXY(d.p3) : null;
                const h = hitPts(mx, my, [['p1', c1], ['p2', c2], ['p3', c3]], 9);
                if (h) return { item: d, handle: h };
                const ys = d.fibLevels.filter(l => l.enabled).map(lv => pane.candleSeries.priceToCoordinate(computeFibLevelPrice(d, lv.val))).filter(y => y !== null);
                const xS = c3 ? Math.min(c1.x, c2.x, c3.x) : Math.min(c1.x, c2.x), xE = c3 ? Math.max(c1.x, c2.x, c3.x) : Math.max(c1.x, c2.x);
                if ((ys.length && mx >= xS - 6 && mx <= xE + 6 && my >= Math.min(...ys) - 6 && my <= Math.max(...ys) + 6) || distToSeg(mx, my, c1.x, c1.y, c2.x, c2.y) <= 7) return { item: d, handle: 'body' };
                continue;
            }
            if (CHANNEL_TYPES.has(d.type) || d.type === 'rotated_rect') {
                const c3 = d.p3 ? timePriceToXY(d.p3) : { x: c2.x, y: c2.y + 35 };
                const h = hitPts(mx, my, [['p1', c1], ['p2', c2], ['p3', c3]], 9);
                if (h) return { item: d, handle: h };
                if (distToSeg(mx, my, c1.x, c1.y, c2.x, c2.y) <= 7) return { item: d, handle: 'body' };
                if (c3) {
                    const dy = c3.y - c2.y, y1b = d.type === 'flat_channel' ? c3.y : (d.type === 'disjoint_channel' ? c1.y - dy : c1.y + dy);
                    if (distToSeg(mx, my, c1.x, y1b, c2.x, c3.y) <= 7) return { item: d, handle: 'p3' };
                    if (mx >= Math.min(c1.x, c2.x) && mx <= Math.max(c1.x, c2.x) && my >= Math.min(c1.y, c2.y, y1b, c3.y) && my <= Math.max(c1.y, c2.y, y1b, c3.y)) return { item: d, handle: 'body' };
                }
                continue;
            }
            if (d.type === 'circle') {
                const h = hitPts(mx, my, [['p1', c1], ['p2', c2]], 8);
                if (h) return { item: d, handle: h };
                if (Math.hypot(mx - c1.x, my - c1.y) <= Math.hypot(c2.x - c1.x, c2.y - c1.y) + 5) return { item: d, handle: 'body' };
                continue;
            }
            if (BOX_TOOLS.has(d.type)) {
                const xL = Math.min(c1.x, c2.x), xR = Math.max(c1.x, c2.x), yT = Math.min(c1.y, c2.y), yB = Math.max(c1.y, c2.y), xM = (xL + xR) / 2, yM = (yT + yB) / 2;
                const h = hitPts(mx, my, [['tl',{x:c1.x,y:c1.y}],['tr',{x:c2.x,y:c1.y}],['bl',{x:c1.x,y:c2.y}],['br',{x:c2.x,y:c2.y}],['tm',{x:xM,y:c1.y}],['bm',{x:xM,y:c2.y}],['ml',{x:c1.x,y:yM}],['mr',{x:c2.x,y:yM}]], 8);
                if (h) return { item: d, handle: h };
                if (mx >= xL - 5 && mx <= xR + 5 && my >= yT - 5 && my <= yB + 5) return { item: d, handle: 'body' };
            } else if (LINE_TOOL_IDS.has(d.type) || d.type === 'arrow' || d.type === 'arrow_marker') {
                const y2 = d.type === 'hray' ? c1.y : c2.y, xm = (c1.x + c2.x) / 2, ym = (c1.y + y2) / 2;
                const h = hitPts(mx, my, [['p1', c1], ['p2', { x: c2.x, y: y2 }], ['body', { x: xm, y: ym }]], 8);
                if (h) return { item: d, handle: h };
                if (distToSeg(mx, my, c1.x, c1.y, c2.x, y2) <= 10) return { item: d, handle: 'body' };
            } else if (d.type === 'text' && Math.abs(mx - c1.x) <= 55 && Math.abs(my - c1.y) <= 18) {
                return { item: d, handle: 'p1' };
            } else if (d.type === 'brush' && d.points?.some((pt, k) => k % 2 === 0 && (pt = timePriceToXY(pt)) && Math.hypot(mx - pt.x, my - pt.y) <= 8)) {
                return { item: d, handle: 'body' };
            }
        }
        return null;
    }

    pane.container.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        closeAllPopMenus();
        setActivePane(pane.id);
        const rect = pane.container.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top, tp = xyToTimePrice(mx, my);

        if (currentDrawTool !== 'cursor') {
            if (['hline', 'vline', 'crossline', 'avwap'].includes(currentDrawTool)) {
                const item = getDefaultDrawProps(currentDrawTool);
                item.p1 = tp; item.p2 = tp;
                return finishDraft(pane, item);
            }
            if (currentDrawTool === 'text') {
                const txt = prompt('Enter chart note / label:', 'Breakout Level');
                if (txt) {
                    const item = getDefaultDrawProps('text');
                    item.p1 = tp; item.p2 = tp; item.text = txt;
                    return finishDraft(pane, item);
                }
                if (!stayInDrawingMode) selectDrawTool('cursor');
                return;
            }
            if (currentDrawTool === 'brush') {
                const item = getDefaultDrawProps('brush');
                item.p1 = tp; item.p2 = tp; item.points = [tp];
                pane.activeDraft = item;
                return;
            }
            if (PATTERN_TOOL_IDS.has(currentDrawTool)) {
                const maxPts = PATTERN_TOOL_MAP[currentDrawTool].pts;
                if (!pane.activeDraft) {
                    const item = getDefaultDrawProps(currentDrawTool);
                    item.p1 = tp; item.p2 = tp; item.points = [tp, { ...tp }];
                    pane.activeDraft = item; pane.requestDraw();
                } else {
                    const pts = pane.activeDraft.points;
                    pts[pts.length - 1] = tp;
                    if (pts.length >= maxPts) return finishDraft(pane);
                    pts.push({ ...tp }); pane.requestDraw();
                }
                return;
            }
            if (MULTI_POINT_TYPES.has(currentDrawTool)) {
                if (!pane.activeDraft) {
                    const item = getDefaultDrawProps(currentDrawTool);
                    item.p1 = tp; item.p2 = tp; item.points = [tp, { ...tp }];
                    pane.activeDraft = item; pane.requestDraw();
                } else {
                    const pts = pane.activeDraft.points;
                    if (pts.length >= 3) {
                        const firstXY = timePriceToXY(pts[0]), prevXY = timePriceToXY(pts[pts.length - 2]);
                        if ((firstXY && Math.hypot(mx - firstXY.x, my - firstXY.y) <= 10) || (prevXY && Math.hypot(mx - prevXY.x, my - prevXY.y) <= 8)) {
                            pts.pop(); return finishDraft(pane);
                        }
                    }
                    pts[pts.length - 1] = tp; pts.push({ ...tp }); pane.requestDraw();
                }
                return;
            }
            if (THREE_POINT_TYPES.has(currentDrawTool)) {
                if (!pane.activeDraft) {
                    const item = getDefaultDrawProps(currentDrawTool);
                    item.p1 = tp; item.p2 = { ...tp }; item.p3 = { ...tp };
                    pane.activeDraft = item; pane.draftStep = 1; pane.requestDraw();
                } else if (pane.draftStep === 1) {
                    pane.activeDraft.p2 = tp;
                    const pDiff = (pane.candleSeries.coordinateToPrice(my + 36) || tp.price) - tp.price;
                    pane.activeDraft.p3 = currentDrawTool === 'fib_ext' ? { ...tp } : { time: tp.time, price: Number((tp.price + pDiff).toFixed(2)) };
                    pane.draftStep = 2; pane.requestDraw();
                } else {
                    pane.activeDraft.p3 = tp; finishDraft(pane);
                }
                return;
            }
            if (!pane.activeDraft) {
                const item = getDefaultDrawProps(currentDrawTool);
                item.p1 = tp; item.p2 = { ...tp };
                if (currentDrawTool === 'long_pos' || currentDrawTool === 'short_pos') {
                    const isLong = currentDrawTool === 'long_pos', stepSec = pane.rawData.length > 1 ? (pane.rawData[1].time - pane.rawData[0].time) : 300;
                    item.p2 = { time: tp.time + stepSec * 12, price: Number((pane.candleSeries.coordinateToPrice(isLong ? my - 55 : my + 55) || tp.price).toFixed(2)) };
                    item.p3 = { time: item.p2.time, price: Number((pane.candleSeries.coordinateToPrice(isLong ? my + 30 : my - 30) || tp.price).toFixed(2)) };
                    return finishDraft(pane, item);
                }
                pane.activeDraft = item; pane.requestDraw();
            } else {
                pane.activeDraft.p2 = (pane.activeDraft.type === 'hray') ? { time: tp.time, price: pane.activeDraft.p1.price } : tp;
                finishDraft(pane);
            }
            return;
        }

        const hit = hitTest(mx, my);
        if (hit) {
            selectDrawing(pane, hit.item);
            if (!lockAllDrawings && !hit.item.locked) {
                pane.chart.applyOptions({ handleScroll: false, handleScale: false });
                pane.dragState = {
                    item: hit.item, handle: hit.handle, startX: mx, startY: my,
                    origC1: hit.item.p1 ? timePriceToXY(hit.item.p1) : null,
                    origC2: hit.item.p2 ? timePriceToXY(hit.item.p2) : null,
                    origC3: hit.item.p3 ? timePriceToXY(hit.item.p3) : null,
                    origPts: (hit.item.points || []).map(pt => timePriceToXY(pt))
                };
            }
        } else {
            selectDrawing(null, null);
            pane.isChartPanning = true;
        }
        pane.requestDraw();
    });

    pane.onWinMouseMove = () => { if (pane.isChartPanning) renderPaneDrawings(pane); };
    window.addEventListener('mousemove', pane.onWinMouseMove, { passive: true });

    pane.container.addEventListener('mousemove', (e) => {
        const rect = pane.container.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;

        if (pane.activeDraft) {
            const tp = xyToTimePrice(mx, my), ad = pane.activeDraft;
            if (ad.type === 'brush') ad.points.push(tp);
            else if (MULTI_POINT_TYPES.has(ad.type) || PATTERN_TOOL_IDS.has(ad.type)) ad.points[ad.points.length - 1] = tp;
            else if (THREE_POINT_TYPES.has(ad.type)) {
                if (pane.draftStep === 1) {
                    ad.p2 = tp;
                    const pDiff = (pane.candleSeries.coordinateToPrice(my + 35) || tp.price) - tp.price;
                    ad.p3 = ad.type === 'fib_ext' ? { ...tp } : { time: tp.time, price: Number((tp.price + pDiff).toFixed(2)) };
                } else ad.p3 = tp;
            } else {
                ad.p2 = ad.type === 'hray' ? { time: tp.time, price: ad.p1.price } : tp;
            }
            pane.requestDraw();
            return;
        }

        if (pane.dragState) {
            const ds = pane.dragState, dx = mx - ds.startX, dy = my - ds.startY, d = ds.item;
            if (ds.handle.startsWith('pt_')) {
                const idx = parseInt(ds.handle.split('_')[1], 10);
                if (d.points?.[idx]) d.points[idx] = xyToTimePrice(mx, my);
            } else if (ds.handle === 'p1') d.p1 = xyToTimePrice(mx, my);
            else if (ds.handle === 'p2') {
                const np = xyToTimePrice(mx, my);
                d.p2 = d.type === 'hray' ? { time: np.time, price: d.p1.price } : np;
            } else if (ds.handle === 'p3') d.p3 = xyToTimePrice(mx, my);
            else if (ds.handle === 'body') {
                if ((MULTI_POINT_TYPES.has(d.type) || PATTERN_TOOL_IDS.has(d.type)) && ds.origPts?.length) {
                    d.points = ds.origPts.map(op => op ? xyToTimePrice(op.x + dx, op.y + dy, true) : d.p1);
                } else if (ds.origC1 && ds.origC2) {
                    d.p1 = xyToTimePrice(ds.origC1.x + dx, ds.origC1.y + dy, true);
                    d.p2 = xyToTimePrice(ds.origC2.x + dx, ds.origC2.y + dy, true);
                    if (ds.origC3) d.p3 = xyToTimePrice(ds.origC3.x + dx, ds.origC3.y + dy, true);
                }
            } else if (ds.origC1 && ds.origC2) {
                let x1 = ds.origC1.x, y1 = ds.origC1.y, x2 = ds.origC2.x, y2 = ds.origC2.y;
                if (ds.handle.includes('l')) x1 = mx;
                if (ds.handle.includes('r')) x2 = mx;
                if (ds.handle.includes('t')) y1 = my;
                if (ds.handle.includes('b')) y2 = my;
                d.p1 = xyToTimePrice(x1, y1); d.p2 = xyToTimePrice(x2, y2);
            }
            pane.requestDraw();
            return;
        }

        if (pane.isChartPanning) { renderPaneDrawings(pane); return; }

        if (currentDrawTool === 'cursor') {
            const hit = hitTest(mx, my), prevHover = pane.hoveredItem;
            pane.hoveredItem = hit ? hit.item : null;
            pane.container.style.cursor = hit ? (hit.handle === 'body' ? 'grab' : 'pointer') : 'default';
            if (prevHover !== pane.hoveredItem) pane.requestDraw();
        }
    });

    pane.onWinMouseUp = () => {
        if (pane.isChartPanning) { pane.isChartPanning = false; renderPaneDrawings(pane); }
        if (pane.activeDraft?.type === 'brush') finishDraft(pane);
        if (pane.dragState) {
            pane.dragState = null; pane.saveDrawings();
            if (currentDrawTool === 'cursor') pane.chart.applyOptions({ handleScroll: true, handleScale: true });
        }
    };
    window.addEventListener('mouseup', pane.onWinMouseUp);

    pane.container.addEventListener('dblclick', (e) => {
        if (pane.activeDraft && MULTI_POINT_TYPES.has(pane.activeDraft.type)) {
            if (pane.activeDraft.points.length > 2) pane.activeDraft.points.pop();
            return finishDraft(pane);
        }
        const rect = pane.container.getBoundingClientRect();
        const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) { selectDrawing(pane, hit.item); openDrawSettingsModal(); }
        else { renderPaneDrawings(pane); requestAnimationFrame(() => renderPaneDrawings(pane)); }
    });

    pane.loadDrawings();
}

function computeFibLevelPrice(d, lvVal) {
    const r = d.fibReverse ? (1 - lvVal) : lvVal;
    return d.type === 'fib_ext' ? (d.p3 || d.p2).price + (d.p2.price - d.p1.price) * r : d.p2.price + (d.p1.price - d.p2.price) * r;
}

function formatTvTimeAxisLabel(t) {
    if (!t) return '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const d = new Date((typeof t === 'number' ? t : 0) * 1000);
    const dayName = days[d.getUTCDay()];
    const dateNum = d.getUTCDate();
    const monName = MONTHS_SHORT[d.getUTCMonth()];
    const yr = String(d.getUTCFullYear()).slice(-2);
    const hrs = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    return `${dayName} ${dateNum} ${monName} '${yr}  ${hrs}:${mins}`;
}

function drawPriceScaleBadge(ctx, price, y, w, h, bgColor = '#2962ff') {
    const plotH = h - 26;
    if (y === null || isNaN(y) || y < 0 || y > plotH) return;
    const pScaleW = 62, xStart = w - pScaleW, txt = Number(price).toFixed(2), badgeH = 19;
    const by = Math.max(1, Math.min(plotH - badgeH - 1, y - badgeH / 2));
    ctx.save(); ctx.setLineDash([]); ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = bgColor; ctx.beginPath(); ctx.moveTo(xStart, y); ctx.lineTo(xStart + 6, by); ctx.lineTo(w - 1, by); ctx.lineTo(w - 1, by + badgeH); ctx.lineTo(xStart + 6, by + badgeH); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, xStart + 9, by + badgeH / 2 + 0.5);
    ctx.restore();
}

function drawTimeScaleBadge(ctx, time, x, w, h, bgColor = '#2962ff') {
    const plotW = w - 62, timeAxisH = 26, yTop = h - timeAxisH;
    if (x === null || isNaN(x) || x < 0 || x > plotW) return;
    const txt = formatTvTimeAxisLabel(time);
    if (!txt) return;
    ctx.save(); ctx.setLineDash([]); ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const tw = ctx.measureText(txt).width + 16, bx = Math.max(2, Math.min(plotW - tw - 2, x - tw / 2));
    ctx.fillStyle = bgColor; ctx.fillRect(bx, yTop + 2, tw, timeAxisH - 4);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, bx + tw / 2, yTop + timeAxisH / 2);
    ctx.restore();
}

function renderDrawingAxisHighlights(ctx, pane, d, w, h, isSelectedOrActive) {
    const badgeCol = (d.color && d.color !== '#ffffff') ? d.color : '#2962ff';
    if (d.type === 'hline' && d.p1) { drawPriceScaleBadge(ctx, d.p1.price, pane.candleSeries.priceToCoordinate(d.p1.price), w, h, badgeCol); return; }
    if (d.type === 'vline' && d.p1) { const c1 = pane.timePriceToXY(d.p1); if (c1) drawTimeScaleBadge(ctx, d.p1.time, c1.x, w, h, badgeCol); return; }
    if (d.type === 'crossline' && d.p1) {
        const c1 = pane.timePriceToXY(d.p1);
        if (c1) { drawPriceScaleBadge(ctx, d.p1.price, c1.y, w, h, badgeCol); drawTimeScaleBadge(ctx, d.p1.time, c1.x, w, h, badgeCol); }
        return;
    }
    if (d.type === 'hray' && d.p1) {
        const c1 = pane.timePriceToXY(d.p1);
        if (c1) { drawPriceScaleBadge(ctx, d.p1.price, c1.y, w, h, badgeCol); if (isSelectedOrActive) drawTimeScaleBadge(ctx, d.p1.time, c1.x, w, h, badgeCol); }
        return;
    }
    if (!isSelectedOrActive) return;
    const pts = [];
    if ((MULTI_POINT_TYPES.has(d.type) || PATTERN_TOOL_IDS.has(d.type)) && d.points?.length) pts.push(d.points[0], d.points[d.points.length - 1]);
    else { if (d.p1) pts.push(d.p1); if (d.p2 && (d.p2.price !== d.p1?.price || d.p2.time !== d.p1?.time)) pts.push(d.p2); if (d.p3 && THREE_POINT_TYPES.has(d.type)) pts.push(d.p3); }
    pts.forEach(pt => { const xy = pane.timePriceToXY(pt); if (xy) { drawPriceScaleBadge(ctx, pt.price, xy.y, w, h, badgeCol); drawTimeScaleBadge(ctx, pt.time, xy.x, w, h, badgeCol); } });
}

function drawHandleCircle(ctx, x, y) {
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#131722'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#2962ff'; ctx.stroke(); ctx.restore();
}

function drawHandles(ctx, show, ...pts) {
    if (!show) return;
    pts.forEach(p => p && drawHandleCircle(ctx, p.x ?? p[0], p.y ?? p[1]));
}

function drawArrowHead(ctx, x1, y1, x2, y2, size, color) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save(); ctx.setLineDash([]); ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
    ctx.closePath(); ctx.fill(); ctx.restore();
}

function drawCanvasBadge(ctx, text, x, y, bgCol, txtCol = '#ffffff', borderCol = null, font = 'bold 11px sans-serif') {
    ctx.save(); ctx.setLineDash([]); ctx.font = font; ctx.textAlign = 'center';
    const tw = ctx.measureText(text).width + 12;
    ctx.fillStyle = bgCol; ctx.fillRect(x - tw / 2, y - 14, tw, 18);
    if (borderCol) { ctx.strokeStyle = borderCol; ctx.strokeRect(x - tw / 2, y - 14, tw, 18); }
    ctx.fillStyle = txtCol; ctx.fillText(text, x, y - 1); ctx.restore();
}

function fillPoly(ctx, coords, indices) {
    if (indices.some(i => !coords[i])) return;
    ctx.beginPath();
    indices.forEach((idx, k) => k === 0 ? ctx.moveTo(coords[idx].x, coords[idx].y) : ctx.lineTo(coords[idx].x, coords[idx].y));
    ctx.closePath(); ctx.fill();
}

function strokeSegs(ctx, coords, pairs) {
    ctx.beginPath();
    pairs.forEach(([a, b]) => { if (coords[a] && coords[b]) { ctx.moveTo(coords[a].x, coords[a].y); ctx.lineTo(coords[b].x, coords[b].y); } });
    ctx.stroke();
}

function renderPaneDrawings(pane) {
    const canvas = pane.drawCanvas, ctx = pane.drawCtx;
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    const w = canvas.width / dpr, h = canvas.height / dpr;

    // Multi-Chart Synced Crosshair Overlay (Vertical Time Line + Candle Close Dot)
    if (syncCrosshairEnabled && syncedCrosshairTime && pane.id !== activePaneId) {
        const sx = pane.chart.timeScale().timeToCoordinate(syncedCrosshairTime);
        if (sx !== null && sx >= 0 && sx <= w) {
            ctx.save();
            ctx.strokeStyle = 'rgba(107, 114, 128, 0.75)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
            const c = pane.candleMap.get(syncedCrosshairTime);
            if (c) {
                const sy = pane.candleSeries.priceToCoordinate(c.close);
                if (sy !== null) {
                    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
                    ctx.setLineDash([]); ctx.fillStyle = '#eab308';
                    ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill();
                }
            }
            ctx.restore();
        }
    }

    if (hideAllDrawings) return;
    const items = pane.activeDraft ? [...pane.drawings, pane.activeDraft] : pane.drawings;

    for (const d of items) {
        const showH = (selectedDrawingRef?.item === d) || (pane.hoveredItem === d) || (pane.activeDraft === d);
        ctx.save();
        ctx.strokeStyle = d.color || '#ffffff';
        ctx.lineWidth = d.width || 2;
        ctx.setLineDash(d.dash === 'dashed' ? [6, 5] : (d.dash === 'dotted' ? [2, 4] : []));

        if (d.type === 'hline') {
            const y = pane.candleSeries.priceToCoordinate(d.p1.price);
            if (y !== null) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
                drawHandles(ctx, showH, [w / 2, y]);
            }
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'avwap' && d.p1) {
            const anchorRawT = d.p1.time - 19800;
            let startIdx = pane.rawData.findIndex(c => c.time >= anchorRawT);
            if (startIdx < 0) startIdx = Math.max(0, pane.rawData.length - 30);
            let cumPV = 0, cumV = 0, started = false;
            ctx.strokeStyle = d.color || '#eab308'; ctx.lineWidth = d.width || 2;
            ctx.beginPath();
            for (let k = startIdx; k < pane.rawData.length; k++) {
                const c = pane.rawData[k], vol = (c.volume && c.volume > 0) ? c.volume : 1;
                cumPV += ((c.high + c.low + c.close) / 3) * vol; cumV += vol;
                const xy = pane.timePriceToXY({ time: c.time + 19800, price: cumPV / cumV });
                if (xy) { started ? ctx.lineTo(xy.x, xy.y) : ctx.moveTo(xy.x, xy.y); started = true; }
            }
            ctx.stroke();
            drawHandles(ctx, showH, pane.timePriceToXY(d.p1));
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (PATTERN_TOOL_IDS.has(d.type) && d.points?.length > 1) {
            const coords = d.points.map(pt => pane.timePriceToXY(pt)).filter(Boolean);
            if (coords.length > 1) {
                const strokeCol = d.color || '#2962ff', meta = PATTERN_TOOL_MAP[d.type];
                ctx.save(); ctx.setLineDash([]);
                ctx.fillStyle = hexToRgba(d.fillColor || strokeCol, d.opacity || 0.20);
                if (d.type === 'xabcd' || d.type === 'cypher') { fillPoly(ctx, coords, [0,1,2]); fillPoly(ctx, coords, [2,3,4]); }
                else if (d.type === 'abcd') { fillPoly(ctx, coords, [0,1,2]); fillPoly(ctx, coords, [1,2,3]); }
                else if (d.type === 'head_shoulders' || d.type === 'three_drives') { [[0,1,2],[2,3,4],[4,5,6]].forEach(tri => fillPoly(ctx, coords, tri)); }
                else if (d.type === 'triangle_pattern') fillPoly(ctx, coords, coords.map((_, i) => i));
                ctx.restore();

                ctx.strokeStyle = strokeCol; ctx.beginPath();
                coords.forEach((pt, idx) => idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
                ctx.stroke();

                ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = strokeCol;
                if (d.type === 'xabcd' || d.type === 'cypher') strokeSegs(ctx, coords, [[0,2],[1,3],[2,4],[0,4]]);
                else if (d.type === 'abcd' || d.type === 'triangle_pattern') strokeSegs(ctx, coords, [[0,2],[1,3]]);
                else if (d.type === 'head_shoulders' && coords.length >= 5) {
                    const n1 = coords[2], n2 = coords[4], dx = n2.x - n1.x, dy = n2.y - n1.y;
                    ctx.beginPath();
                    if (Math.abs(dx) > 1) {
                        const xS = coords[0].x - 20, xE = (coords[6] ? coords[6].x : coords[coords.length - 1].x) + 25;
                        ctx.moveTo(xS, n1.y + (dy / dx) * (xS - n1.x)); ctx.lineTo(xE, n1.y + (dy / dx) * (xE - n1.x));
                    } else { ctx.moveTo(n1.x, n1.y); ctx.lineTo(n2.x, n2.y); }
                    ctx.stroke();
                }
                ctx.restore();

                ctx.save(); ctx.setLineDash([]); ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'; ctx.textAlign = 'center';
                coords.forEach((pt, idx) => {
                    const lbl = meta?.labels?.[idx] || '';
                    if (lbl) {
                        const prev = coords[idx - 1] || coords[idx + 1] || pt, ly = pt.y <= prev.y ? (pt.y - 10) : (pt.y + 16), bw = Math.max(16, ctx.measureText(lbl).width + 8);
                        ctx.fillStyle = '#131722dd'; ctx.fillRect(pt.x - bw / 2, ly - 10, bw, 14);
                        ctx.fillStyle = '#ffffff'; ctx.fillText(lbl, pt.x, ly);
                    }
                    drawHandles(ctx, showH, pt);
                });
                ctx.restore();
            }
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (MULTI_POINT_TYPES.has(d.type) && d.points?.length > 1) {
            const coords = d.points.map(pt => pane.timePriceToXY(pt)).filter(Boolean);
            if (coords.length > 1) {
                if (d.type === 'polyline') {
                    ctx.save(); ctx.setLineDash([]); ctx.fillStyle = hexToRgba(d.fillColor || d.color || '#2962ff', d.opacity || 0.20);
                    fillPoly(ctx, coords, coords.map((_, i) => i)); ctx.restore();
                }
                ctx.beginPath();
                coords.forEach((pt, idx) => idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
                if (d.type === 'polyline' && pane.activeDraft !== d) ctx.closePath();
                ctx.stroke();
                if (d.type === 'path') {
                    const a = coords[coords.length - 2], b = coords[coords.length - 1];
                    drawArrowHead(ctx, a.x, a.y, b.x, b.y, 10 + (d.width || 2), d.color || '#2962ff');
                }
                drawHandles(ctx, showH, ...coords);
            }
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        const c1 = pane.timePriceToXY(d.p1);
        if (!c1) { renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue; }

        if (d.type === 'vline') {
            ctx.beginPath(); ctx.moveTo(c1.x, 0); ctx.lineTo(c1.x, h); ctx.stroke();
            drawHandles(ctx, showH, [c1.x, h / 2]);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }
        if (d.type === 'crossline') {
            ctx.beginPath(); ctx.moveTo(0, c1.y); ctx.lineTo(w, c1.y); ctx.moveTo(c1.x, 0); ctx.lineTo(c1.x, h); ctx.stroke();
            drawHandles(ctx, showH, c1);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        const c2 = d.p2 ? pane.timePriceToXY(d.p2) : c1;
        if (!c2) { renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue; }

        if (FIB_TOOL_IDS.has(d.type)) {
            ensureFibProps(d);
            const c3 = (d.type === 'fib_ext' && d.p3) ? pane.timePriceToXY(d.p3) : null;
            let xL = (d.type === 'fib_ext' && c3) ? Math.min(c2.x, c3.x) : Math.min(c1.x, c2.x);
            let xR = (d.type === 'fib_ext' && c3) ? Math.max(c2.x, c3.x) : Math.max(c1.x, c2.x);
            if (Math.abs(xR - xL) < 25) xR = xL + 80;
            const drawXL = d.extendLeft ? 0 : xL, drawXR = d.extendRight ? w : xR;

            const enabledLvs = d.fibLevels.filter(l => l.enabled).map(l => {
                const price = computeFibLevelPrice(d, l.val);
                return { val: l.val, price, y: pane.candleSeries.priceToCoordinate(price), color: d.fibUseOneColor ? (d.fibOneColor || '#2962ff') : l.color };
            }).filter(l => l.y !== null).sort((a, b) => a.val - b.val);

            if (d.fibShowBg && enabledLvs.length > 1) {
                const bgAlpha = d.opacity || 0.16;
                for (let k = 0; k < enabledLvs.length - 1; k++) {
                    const cur = enabledLvs[k], nxt = enabledLvs[k + 1], topY = Math.min(cur.y, nxt.y), botY = Math.max(cur.y, nxt.y);
                    ctx.fillStyle = hexToRgba(nxt.color || cur.color, bgAlpha);
                    ctx.fillRect(drawXL, topY, drawXR - drawXL, botY - topY);
                }
            }

            ctx.lineWidth = d.width || 1;
            ctx.setLineDash(d.dash === 'dashed' ? [6, 4] : (d.dash === 'dotted' ? [2, 3] : []));
            const fSize = d.textSize || 12;
            ctx.font = `${fSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

            enabledLvs.forEach(lv => {
                ctx.strokeStyle = lv.color;
                ctx.beginPath(); ctx.moveTo(drawXL, lv.y); ctx.lineTo(drawXR, lv.y); ctx.stroke();
                const parts = [];
                if (d.fibShowLevels) parts.push(d.fibLevelsFmt === 'percent' ? (lv.val * 100).toFixed(1) + '%' : String(lv.val));
                if (d.fibShowPrices) parts.push(`(${lv.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`);
                if (parts.length) {
                    ctx.fillStyle = lv.color;
                    let lx = drawXL - 6;
                    if (d.fibLabelAlign === 'right') { ctx.textAlign = 'left'; lx = drawXR + 6; }
                    else if (d.fibLabelAlign === 'center') { ctx.textAlign = 'center'; lx = (drawXL + drawXR) / 2; }
                    else ctx.textAlign = 'right';
                    const ly = d.fibLabelVAlign === 'top' ? (lv.y - 4) : (d.fibLabelVAlign === 'bottom' ? (lv.y + fSize) : (lv.y + 4));
                    ctx.fillText(parts.join(' '), lx, ly);
                }
            });

            if (d.fibShowTrendLine) {
                ctx.save(); ctx.strokeStyle = d.fibTrendColor || '#787b86'; ctx.lineWidth = 1;
                ctx.setLineDash(d.fibTrendDash === 'solid' ? [] : (d.fibTrendDash === 'dotted' ? [2, 3] : [5, 4]));
                ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
                if (d.type === 'fib_ext' && c3) ctx.lineTo(c3.x, c3.y);
                ctx.stroke(); ctx.restore();
            }
            drawHandles(ctx, showH, c1, c2, d.type === 'fib_ext' ? c3 : null);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (CHANNEL_TYPES.has(d.type) || d.type === 'regression_trend' || d.type === 'rotated_rect') {
            const c3 = d.p3 ? pane.timePriceToXY(d.p3) : { x: c2.x, y: c2.y + 38 };
            const dy = c3 ? (c3.y - c2.y) : 38, y2b = c3 ? c3.y : (c2.y + 38);
            const y1b = d.type === 'flat_channel' ? y2b : (d.type === 'disjoint_channel' ? c1.y - dy : c1.y + dy);

            ctx.save(); ctx.setLineDash([]);
            ctx.fillStyle = hexToRgba(d.fillColor || d.color || '#2962ff', d.opacity || 0.18);
            fillPoly(ctx, [c1, c2, { x: c2.x, y: y2b }, { x: c1.x, y: y1b }], [0, 1, 2, 3]);
            ctx.restore();

            ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
            if (d.type === 'rotated_rect') { ctx.lineTo(c2.x, y2b); ctx.lineTo(c1.x, y1b); ctx.closePath(); }
            else { ctx.moveTo(c1.x, y1b); ctx.lineTo(c2.x, y2b); }
            ctx.stroke();

            if (d.type !== 'rotated_rect') {
                ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(c1.x, (c1.y + y1b) / 2); ctx.lineTo(c2.x, (c2.y + y2b) / 2); ctx.stroke();
                ctx.restore();
            }
            drawHandles(ctx, showH, c1, c2, [c2.x, y2b], [(c1.x + c2.x) / 2, (c1.y + c2.y) / 2]);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'long_pos' || d.type === 'short_pos') {
            const c3 = d.p3 ? pane.timePriceToXY(d.p3) : { x: c2.x, y: c1.y + 30 };
            const xL = Math.min(c1.x, c2.x), rw = Math.max(40, Math.max(c1.x, c2.x) - xL);
            const yEntry = c1.y, yTgt = c2.y, ySl = c3 ? c3.y : (c1.y + 30), midX = xL + rw / 2;

            ctx.save(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(8, 153, 129, 0.28)'; ctx.fillRect(xL, Math.min(yEntry, yTgt), rw, Math.abs(yTgt - yEntry));
            ctx.strokeStyle = '#089981'; ctx.strokeRect(xL, Math.min(yEntry, yTgt), rw, Math.abs(yTgt - yEntry));
            ctx.fillStyle = 'rgba(242, 54, 69, 0.28)'; ctx.fillRect(xL, Math.min(yEntry, ySl), rw, Math.abs(ySl - yEntry));
            ctx.strokeStyle = '#f23645'; ctx.strokeRect(xL, Math.min(yEntry, ySl), rw, Math.abs(ySl - yEntry));
            ctx.strokeStyle = '#787b86'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xL, yEntry); ctx.lineTo(xL + rw, yEntry); ctx.stroke();

            const tgtDiff = Math.abs(d.p2.price - d.p1.price), slPrice = d.p3 ? d.p3.price : d.p1.price, slDiff = Math.max(0.01, Math.abs(d.p1.price - slPrice));
            const rr = (tgtDiff / slDiff).toFixed(2), tgtPct = d.p1.price ? ((tgtDiff / d.p1.price) * 100).toFixed(2) : '0.00', slPct = d.p1.price ? ((slDiff / d.p1.price) * 100).toFixed(2) : '0.00';

            drawCanvasBadge(ctx, `Target: ${d.p2.price.toFixed(2)} (+${tgtDiff.toFixed(2)} / ${tgtPct}%)`, midX, yTgt - 4, '#089981', '#ffffff', null, 'bold 10px sans-serif');
            drawCanvasBadge(ctx, `R:R = 1 : ${rr}`, midX, yEntry + 5, '#1e222d', '#eab308', null, 'bold 10px sans-serif');
            drawCanvasBadge(ctx, `Stop: ${slPrice.toFixed(2)} (-${slDiff.toFixed(2)} / ${slPct}%)`, midX, ySl + 16, '#f23645', '#ffffff', null, 'bold 10px sans-serif');
            ctx.restore();

            drawHandles(ctx, showH, [c1.x, yEntry], [c2.x, yTgt], [c2.x, ySl]);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'frvp') {
            const xL = Math.min(c1.x, c2.x), xR = Math.max(c1.x, c2.x), rw = Math.max(30, xR - xL);
            const tMin = Math.min(d.p1.time, d.p2.time) - 19800, tMax = Math.max(d.p1.time, d.p2.time) - 19800;
            const slice = pane.rawData.filter(c => c.time >= tMin && c.time <= tMax), bars = slice.length ? slice : pane.rawData.slice(-30);
            if (bars.length) {
                let pLow = Infinity, pHigh = -Infinity;
                bars.forEach(b => { if (b.low < pLow) pLow = b.low; if (b.high > pHigh) pHigh = b.high; });
                const rows = 18, stepP = Math.max(0.05, (pHigh - pLow) / rows), buckets = new Array(rows).fill(0), upVol = new Array(rows).fill(0);
                bars.forEach(b => {
                    const idx = Math.min(rows - 1, Math.max(0, Math.floor(((b.close - pLow) / (pHigh - pLow || 1)) * rows))), v = (b.volume && b.volume > 0) ? b.volume : 1;
                    buckets[idx] += v; if (b.close >= b.open) upVol[idx] += v;
                });
                const maxV = Math.max(...buckets, 1), pocIdx = buckets.indexOf(maxV);

                ctx.save(); ctx.setLineDash([]); ctx.fillStyle = 'rgba(41, 98, 255, 0.07)';
                const yTopAll = pane.candleSeries.priceToCoordinate(pHigh) || Math.min(c1.y, c2.y), yBotAll = pane.candleSeries.priceToCoordinate(pLow) || Math.max(c1.y, c2.y);
                ctx.fillRect(xL, Math.min(yTopAll, yBotAll), rw, Math.abs(yBotAll - yTopAll));

                for (let r = 0; r < rows; r++) {
                    const pA = pLow + r * stepP, yA = pane.candleSeries.priceToCoordinate(pA), yB = pane.candleSeries.priceToCoordinate(pA + stepP);
                    if (yA === null || yB === null) continue;
                    const bw = (buckets[r] / maxV) * (rw * 0.78), uw = buckets[r] > 0 ? (upVol[r] / buckets[r]) * bw : 0, topY = Math.min(yA, yB), bh = Math.max(2, Math.abs(yA - yB) - 1);
                    ctx.fillStyle = 'rgba(34, 197, 94, 0.55)'; ctx.fillRect(xL, topY, uw, bh);
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.55)'; ctx.fillRect(xL + uw, topY, bw - uw, bh);
                    if (r === pocIdx) {
                        const yPoc = (yA + yB) / 2;
                        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
                        ctx.beginPath(); ctx.moveTo(xL, yPoc); ctx.lineTo(xR, yPoc); ctx.stroke();
                    }
                }
                ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(xL, Math.min(yTopAll, yBotAll)); ctx.lineTo(xL, Math.max(yTopAll, yBotAll)); ctx.moveTo(xR, Math.min(yTopAll, yBotAll)); ctx.lineTo(xR, Math.max(yTopAll, yBotAll)); ctx.stroke();
                ctx.restore();
            }
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'forecast') {
            const col = d.p2.price >= d.p1.price ? '#089981' : '#f23645';
            ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
            drawArrowHead(ctx, c1.x, c1.y, c2.x, c2.y, 11, col);
            const diff = d.p2.price - d.p1.price, pct = d.p1.price ? ((diff / d.p1.price) * 100).toFixed(2) : '0.00';
            drawCanvasBadge(ctx, `Forecast: ${d.p2.price.toFixed(2)} (${diff >= 0 ? '+' : ''}${pct}%)`, c2.x, c2.y - 12, col);
            ctx.restore();
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'bars_pattern' || d.type === 'ghost_feed') {
            const count = 8, dx = (c2.x - c1.x) / count, dy = (c2.y - c1.y) / count, cw = Math.max(4, Math.min(14, Math.abs(dx) * 0.65));
            ctx.save(); ctx.setLineDash([]);
            for (let k = 0; k < count; k++) {
                const wave = Math.sin(k * 1.3) * 12, ox = c1.x + k * dx;
                const oy = c1.y + k * dy + (k % 2 === 0 ? -wave * 0.4 : wave * 0.4), cy = c1.y + (k + 1) * dy + (k % 2 === 0 ? wave * 0.4 : -wave * 0.4);
                const col = d.type === 'bars_pattern' ? '#2962ff' : (cy <= oy ? 'rgba(34,197,94,0.65)' : 'rgba(239,68,68,0.65)');
                ctx.strokeStyle = col; ctx.fillStyle = col;
                ctx.beginPath(); ctx.moveTo(ox, Math.min(oy, cy) - 7); ctx.lineTo(ox, Math.max(oy, cy) + 7); ctx.stroke();
                ctx.fillRect(ox - cw / 2, Math.min(oy, cy), cw, Math.max(3, Math.abs(cy - oy)));
            }
            ctx.restore();
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'price_range' || d.type === 'date_range' || d.type === 'date_price_range') {
            const xL = Math.min(c1.x, c2.x), xR = Math.max(c1.x, c2.x), rw = Math.max(20, xR - xL);
            const yT = Math.min(c1.y, c2.y), yB = Math.max(c1.y, c2.y), rh = Math.max(10, yB - yT), xm = xL + rw / 2, ym = yT + rh / 2, isUp = d.p2.price >= d.p1.price;
            const mainCol = d.type === 'date_range' ? '#2962ff' : (isUp ? '#22c55e' : '#ef4444');

            ctx.save(); ctx.setLineDash([]);
            ctx.fillStyle = d.type === 'date_range' ? 'rgba(41, 98, 255, 0.16)' : (isUp ? 'rgba(34, 197, 94, 0.16)' : 'rgba(239, 68, 68, 0.16)');
            ctx.fillRect(xL, yT, rw, rh); ctx.strokeStyle = mainCol; ctx.lineWidth = 1.5;

            if (d.type === 'price_range' || d.type === 'date_price_range') {
                ctx.beginPath(); ctx.moveTo(xL, c1.y); ctx.lineTo(xR, c1.y); ctx.moveTo(xL, c2.y); ctx.lineTo(xR, c2.y); ctx.moveTo(xm, c1.y); ctx.lineTo(xm, c2.y); ctx.stroke();
                drawArrowHead(ctx, xm, c1.y, xm, c2.y, 8, mainCol);
            }
            if (d.type === 'date_range' || d.type === 'date_price_range') {
                ctx.beginPath(); ctx.moveTo(c1.x, yT); ctx.lineTo(c1.x, yB); ctx.moveTo(c2.x, yT); ctx.lineTo(c2.x, yB); ctx.moveTo(c1.x, ym); ctx.lineTo(c2.x, ym); ctx.stroke();
                drawArrowHead(ctx, c1.x, ym, c2.x, ym, 8, mainCol);
            }

            const pDiff = d.p2.price - d.p1.price, pPct = d.p1.price ? ((pDiff / d.p1.price) * 100).toFixed(2) : '0.00';
            const stepSec = pane.rawData.length > 1 ? Math.max(60, pane.rawData[1].time - pane.rawData[0].time) : 300;
            const barsCount = Math.round(Math.abs(d.p2.time - d.p1.time) / stepSec), hrs = Math.floor(Math.abs(d.p2.time - d.p1.time) / 3600), mins = Math.floor((Math.abs(d.p2.time - d.p1.time) % 3600) / 60);
            const timeStr = hrs > 0 ? `${barsCount} bars (${hrs}h ${mins}m)` : `${barsCount} bars (${mins}m)`;
            const lbl = d.type === 'price_range' ? `${pDiff >= 0 ? '+' : ''}${pDiff.toFixed(2)} (${pPct}%)` : (d.type === 'date_range' ? timeStr : `${pDiff >= 0 ? '+' : ''}${pDiff.toFixed(2)} (${pPct}%) • ${timeStr}`);

            drawCanvasBadge(ctx, lbl, xm, yB + 20, '#1e222d', '#ffffff', mainCol);
            ctx.restore();
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'circle') {
            const rad = Math.hypot(c2.x - c1.x, c2.y - c1.y);
            ctx.fillStyle = hexToRgba(d.fillColor || d.color || '#2962ff', d.opacity || 0.20);
            ctx.beginPath(); ctx.arc(c1.x, c1.y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }
        if (d.type === 'ellipse') {
            const cx = (c1.x + c2.x) / 2, cy = (c1.y + c2.y) / 2, rx = Math.max(2, Math.abs(c2.x - c1.x) / 2), ry = Math.max(2, Math.abs(c2.y - c1.y) / 2);
            ctx.fillStyle = hexToRgba(d.fillColor || d.color || '#2962ff', d.opacity || 0.20);
            ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            drawHandles(ctx, showH, [cx, cy - ry], [cx, cy + ry], [cx - rx, cy], [cx + rx, cy]);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (d.type === 'arrow') {
            ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
            drawArrowHead(ctx, c1.x, c1.y, c2.x, c2.y, 12 + (d.width || 2), d.color || '#2962ff');
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }
        if (d.type === 'arrow_marker') {
            const dx = c2.x - c1.x, dy = c2.y - c1.y, len = Math.max(24, Math.hypot(dx, dy)), headW = Math.min(28, Math.max(14, len * 0.35)), shaftW = headW * 0.42;
            ctx.save(); ctx.translate(c1.x, c1.y); ctx.rotate(Math.atan2(dy, dx)); ctx.setLineDash([]);
            ctx.fillStyle = hexToRgba(d.fillColor || d.color || '#2962ff', 0.85);
            ctx.beginPath(); ctx.moveTo(0, -shaftW / 2); ctx.lineTo(len - headW, -shaftW / 2); ctx.lineTo(len - headW, -headW); ctx.lineTo(len, 0); ctx.lineTo(len - headW, headW); ctx.lineTo(len - headW, shaftW / 2); ctx.lineTo(0, shaftW / 2); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
            drawHandles(ctx, showH, c1, c2);
            renderDrawingAxisHighlights(ctx, pane, d, w, h, showH); ctx.restore(); continue;
        }

        if (LINE_TOOL_IDS.has(d.type)) {
            const x1 = c1.x, y1 = c1.y, x2 = c2.x, y2 = d.type === 'hray' ? c1.y : c2.y, dx = x2 - x1, dy = y2 - y1;
            const extL = d.extendLeft || d.type === 'extended', extR = d.extendRight || d.type === 'ray' || d.type === 'extended' || d.type === 'hray';

            ctx.beginPath();
            ctx.moveTo(extL && Math.abs(dx) > 0.1 ? 0 : x1, extL && Math.abs(dx) > 0.1 ? y1 - (dy / dx) * x1 : y1);
            ctx.lineTo(extR && Math.abs(dx) > 0.1 ? w : x2, extR && Math.abs(dx) > 0.1 ? y1 + (dy / dx) * (w - x1) : y2);
            ctx.stroke();

            const xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
            if (d.type === 'trendangle') {
                const deg = Math.round(-Math.atan2(dy, dx) * (180 / Math.PI));
                ctx.save(); ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + 55, y1); ctx.stroke();
                ctx.beginPath(); ctx.arc(x1, y1, 28, 0, Math.atan2(dy, dx), dy < 0); ctx.stroke();
                ctx.fillStyle = d.color || '#eab308'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(`${deg}°`, x1 + 34, y1 - 6);
                ctx.restore();
            }
            if (d.type === 'infoline' || d.priceRange || d.pctChange || d.distance) {
                const diff = d.p2.price - d.p1.price, pct = d.p1.price ? ((diff / d.p1.price) * 100).toFixed(2) + '%' : '';
                drawCanvasBadge(ctx, `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct}) • ${Math.round(Math.hypot(dx, dy))}px`, xm, ym + 22, '#1e222d', diff >= 0 ? '#4ade80' : '#f87171', '#2a2e39', 'bold 10px sans-serif');
            }
            if (d.text) {
                ctx.setLineDash([]); ctx.font = `${d.textBold ? 'bold ' : ''}${d.textSize || 12}px sans-serif`;
                ctx.fillStyle = d.textColor || '#ffffff'; ctx.textAlign = d.textAlign || 'center'; ctx.fillText(d.text, xm, ym - 8);
            }
            drawHandles(ctx, showH, [x1, y1], [x2, y2], d.middlePoint !== false ? [xm, ym] : null);
        } else if (d.type === 'rect' || d.type === 'measure') {
            const xL = Math.min(c1.x, c2.x), yT = Math.min(c1.y, c2.y), rw = Math.abs(c2.x - c1.x), rh = Math.abs(c2.y - c1.y);
            ctx.fillStyle = d.type === 'measure' ? (d.p2.price >= d.p1.price ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)') : hexToRgba(d.fillColor || d.color || '#2962ff', d.opacity || 0.22);
            ctx.fillRect(xL, yT, rw, rh); ctx.strokeRect(xL, yT, rw, rh);

            if (d.type === 'measure' || d.priceRange || d.pctChange) {
                const diff = d.p2.price - d.p1.price, pct = d.p1.price ? ((diff / d.p1.price) * 100).toFixed(2) : '0.00';
                drawCanvasBadge(ctx, `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct}%)`, xL + rw / 2, yT + rh / 2 + 4, '#1e222d', diff >= 0 ? '#4ade80' : '#f87171');
            }
            if (d.text) {
                ctx.setLineDash([]); ctx.font = `${d.textBold ? 'bold ' : ''}${d.textSize || 12}px sans-serif`;
                ctx.fillStyle = d.textColor || '#ffffff'; ctx.textAlign = 'center'; ctx.fillText(d.text, xL + rw / 2, yT + rh / 2 + 4);
            }
            if (showH) {
                const xR = xL + rw, yB = yT + rh, xM = xL + rw / 2, yM = yT + rh / 2;
                drawHandles(ctx, true, [xL, yT], [xR, yT], [xL, yB], [xR, yB], [xM, yT], [xM, yB], [xL, yM], [xR, yM]);
            }
        } else if (d.type === 'text') {
            ctx.font = `bold ${d.textSize || 13}px sans-serif`; ctx.fillStyle = d.color || '#eab308';
            ctx.fillText(d.text || 'Note', c1.x, c1.y);
            drawHandles(ctx, showH, c1);
        } else if (d.type === 'brush' && d.points?.length > 1) {
            ctx.beginPath();
            d.points.forEach((pt, idx) => { const bp = pane.timePriceToXY(pt); if (bp) idx === 0 ? ctx.moveTo(bp.x, bp.y) : ctx.lineTo(bp.x, bp.y); });
            ctx.stroke();
        }
        renderDrawingAxisHighlights(ctx, pane, d, w, h, showH);
        ctx.restore();
    }
}

function hexToRgba(hex, alpha) {
    let c = String(hex || '#2962ff').replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const n = parseInt(c, 16) || 0x2962ff;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function selectDrawing(pane, item) {
    if (!pane || !item) {
        selectedDrawingRef = null; hideFloatingToolbar();
        Object.values(panes).forEach(p => p.requestDraw?.());
        return;
    }
    selectedDrawingRef = { pane, item };
    showFloatingToolbar(pane, item);
    pane.requestDraw();
}

function showFloatingToolbar(pane, item) {
    const fb = document.getElementById('tv-float-bar'), rect = pane.container.getBoundingClientRect();
    fb.style.display = 'flex';
    fb.style.left = Math.max(60, rect.left + rect.width / 2 - 150) + 'px';
    fb.style.top = Math.max(58, rect.top + 10) + 'px';
    document.getElementById('fb-stroke-col').value = item.color || '#ffffff';
    document.getElementById('fb-fill-col').value = item.fillColor || '#2962ff';
    document.getElementById('fb-fill-wrap').style.display = (FILLED_SHAPE_TYPES.has(item.type) || CHANNEL_TYPES.has(item.type) || item.type === 'regression_trend') ? 'flex' : 'none';
    document.getElementById('fb-width-btn').textContent = (item.width || 2) + 'px';
    document.getElementById('fb-style-btn').textContent = item.dash === 'dashed' ? '- - -' : (item.dash === 'dotted' ? '····' : '───');
    document.getElementById('fb-lock-btn').textContent = item.locked ? '🔒' : '🔓';
}

function hideFloatingToolbar() { document.getElementById('tv-float-bar').style.display = 'none'; closeAllPopMenus(); }

function updateSelectedDrawingProp(key, val) {
    if (!selectedDrawingRef) return;
    selectedDrawingRef.item[key] = val;
    selectedDrawingRef.pane.saveDrawings();
    showFloatingToolbar(selectedDrawingRef.pane, selectedDrawingRef.item);
    selectedDrawingRef.pane.requestDraw();
    closeAllPopMenus();
}

function toggleSelectedLock() {
    if (!selectedDrawingRef) return;
    selectedDrawingRef.item.locked = !selectedDrawingRef.item.locked;
    selectedDrawingRef.pane.saveDrawings();
    showFloatingToolbar(selectedDrawingRef.pane, selectedDrawingRef.item);
}

function openPopNear(id, e) {
    if (e) e.stopPropagation();
    closeAllPopMenus();
    const pop = document.getElementById(id), r = (e.currentTarget || e).getBoundingClientRect();
    Object.assign(pop.style, { display: 'flex', left: Math.min(window.innerWidth - 250, r.left) + 'px', top: Math.min(window.innerHeight - 160, r.bottom + 6) + 'px' });
}
const openWidthPop = e => openPopNear('tv-width-pop', e);
const openStylePop = e => openPopNear('tv-style-pop', e);
const openTemplatePop = e => openPopNear('tv-tpl-pop', e);
const openDeleteMenu = e => openPopNear('tv-del-pop', e);

function saveCurrentAsDefaultTemplate() {
    if (!selectedDrawingRef) return;
    const d = selectedDrawingRef.item;
    localStorage.setItem('sp_draw_default_tpl', JSON.stringify({ color: d.color, fillColor: d.fillColor, opacity: d.opacity, width: d.width, dash: d.dash }));
    closeAllPopMenus();
}

function applyDefaultTemplate() {
    if (!selectedDrawingRef) return;
    Object.assign(selectedDrawingRef.item, JSON.parse(localStorage.getItem('sp_draw_default_tpl') || '{}'));
    selectedDrawingRef.pane.saveDrawings();
    showFloatingToolbar(selectedDrawingRef.pane, selectedDrawingRef.item);
    selectedDrawingRef.pane.requestDraw();
    closeAllPopMenus();
}

function deleteSelectedDrawing() {
    if (!selectedDrawingRef) return;
    const { pane, item } = selectedDrawingRef;
    pane.drawings = pane.drawings.filter(d => d !== item);
    pane.saveDrawings(); selectDrawing(null, null);
}

function clearActivePaneDrawings() {
    const p = panes[activePaneId] || Object.values(panes)[0];
    if (p) { p.drawings = []; p.saveDrawings(); p.requestDraw(); }
    selectDrawing(null, null);
}

function clearAllSymbolsDrawings() {
    Object.keys(localStorage).forEach(k => { if (k.startsWith('sp_drawings_')) localStorage.removeItem(k); });
    Object.values(panes).forEach(p => { p.drawings = []; p.requestDraw?.(); });
    selectDrawing(null, null);
}

const REG_MODAL_MAP = [
    ['dsm-color', 'color', 'val', '#ffffff'], ['dsm-width', 'width', 'int', 2], ['dsm-dash', 'dash', 'val', 'solid'],
    ['dsm-fill', 'fillColor', 'val', '#2962ff'], ['dsm-opacity', 'opacity', 'flt', 0.22],
    ['dsm-ext-l', 'extendLeft', 'chk', false], ['dsm-ext-r', 'extendRight', 'chk', false],
    ['dsm-mid', 'middlePoint', 'chk', true], ['dsm-plbl', 'priceLabels', 'chk', false],
    ['dsm-prng', 'priceRange', 'chk', false], ['dsm-pct', 'pctChange', 'chk', false],
    ['dsm-brng', 'barsRange', 'chk', false], ['dsm-dist', 'distance', 'chk', false],
    ['dsm-txt-col', 'textColor', 'val', '#ffffff'], ['dsm-txt-size', 'textSize', 'int', 12],
    ['dsm-txt-b', 'textBold', 'chk', false], ['dsm-txt-val', 'text', 'val', ''], ['dsm-txt-align', 'textAlign', 'val', 'center']
];

const FIB_MODAL_MAP = [
    ['fib-show-tl', 'fibShowTrendLine', 'chk', true], ['fib-tl-color', 'fibTrendColor', 'val', '#787b86'],
    ['fib-tl-dash', 'fibTrendDash', 'val', 'dashed'], ['fib-lvl-width', 'width', 'int', 1],
    ['fib-lvl-dash', 'dash', 'val', 'solid'], ['fib-ext-l', 'extendLeft', 'chk', false],
    ['fib-ext-r', 'extendRight', 'chk', false], ['fib-use-one-col', 'fibUseOneColor', 'chk', false],
    ['fib-one-col', 'fibOneColor', 'val', '#2962ff'], ['fib-bg-show', 'fibShowBg', 'chk', true],
    ['fib-bg-opacity', 'opacity', 'flt', 0.16], ['fib-reverse', 'fibReverse', 'chk', false],
    ['fib-prices', 'fibShowPrices', 'chk', true], ['fib-levels-show', 'fibShowLevels', 'chk', true],
    ['fib-levels-fmt', 'fibLevelsFmt', 'val', 'values'], ['fib-lbl-align', 'fibLabelAlign', 'val', 'left'],
    ['fib-lbl-valign', 'fibLabelVAlign', 'val', 'middle'], ['fib-font-size', 'textSize', 'int', 12],
    ['fib-log-scale', 'fibLogScale', 'chk', false]
];

function syncModalFields(d, map, toModal = true) {
    map.forEach(([id, prop, type, def]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (toModal) {
            if (type === 'chk') el.checked = d[prop] !== undefined ? !!d[prop] : def;
            else el.value = d[prop] !== undefined ? String(d[prop]) : String(def);
        } else {
            if (type === 'chk') d[prop] = el.checked;
            else if (type === 'int') d[prop] = parseInt(el.value, 10) || def;
            else if (type === 'flt') d[prop] = parseFloat(el.value) || def;
            else d[prop] = el.value.trim();
        }
    });
}

function switchDsmTab(tab) {
    const isFib = selectedDrawingRef && FIB_TOOL_IDS.has(selectedDrawingRef.item.type);
    document.getElementById('dsm-body-style-reg').classList.toggle('hidden', tab !== 'style' || isFib);
    document.getElementById('dsm-body-style-fib').classList.toggle('hidden', tab !== 'style' || !isFib);
    document.getElementById('dsm-body-text').classList.toggle('hidden', tab !== 'text');
    document.getElementById('dsm-body-coord').classList.toggle('hidden', tab !== 'coord');
    document.getElementById('dsm-body-vis').classList.toggle('hidden', tab !== 'vis');
    ['style', 'text', 'coord', 'vis'].forEach(t => {
        document.getElementById(`dsm-tab-${t}`).className = (t === tab) ? 'py-2.5 border-b-2 border-white text-white' : 'py-2.5 border-b-2 border-transparent text-gray-400 hover:text-white';
    });
}

function renderFibLevelsGridInModal(d) {
    const grid = document.getElementById('fib-levels-grid');
    if (!grid) return;
    ensureFibProps(d);
    grid.innerHTML = d.fibLevels.map((lv, idx) => `<div class="flex items-center gap-1.5"><input type="checkbox" data-fib-chk="${idx}" ${lv.enabled ? 'checked' : ''} onchange="liveSyncFibSettingsFromModal()" class="cursor-pointer"><input type="number" step="0.001" data-fib-val="${idx}" value="${lv.val}" oninput="liveSyncFibSettingsFromModal()" class="w-20 bg-[#131722] border border-gray-700 focus:border-[#2962ff] rounded px-2 py-0.5 text-white text-xs focus:outline-none"><input type="color" data-fib-col="${idx}" value="${lv.color}" oninput="liveSyncFibSettingsFromModal()" class="w-6 h-6 bg-transparent border-0 cursor-pointer p-0"></div>`).join('');
}

function onFibUseOneColor(checked) { if (!selectedDrawingRef) return; selectedDrawingRef.item.fibUseOneColor = checked; liveSyncFibSettingsFromModal(); }
function onFibOneColorChange(col) { if (!selectedDrawingRef) return; selectedDrawingRef.item.fibOneColor = col; document.getElementById('fib-use-one-col').checked = true; liveSyncFibSettingsFromModal(); }

function liveSyncFibSettingsFromModal() {
    if (!selectedDrawingRef || !FIB_TOOL_IDS.has(selectedDrawingRef.item.type)) return;
    const d = selectedDrawingRef.item;
    syncModalFields(d, FIB_MODAL_MAP, false);
    d.fibLevels.forEach((lv, idx) => {
        const chk = document.querySelector(`[data-fib-chk="${idx}"]`), valIn = document.querySelector(`[data-fib-val="${idx}"]`), colIn = document.querySelector(`[data-fib-col="${idx}"]`);
        if (chk) lv.enabled = chk.checked;
        if (valIn && !isNaN(parseFloat(valIn.value))) lv.val = parseFloat(valIn.value);
        if (colIn) lv.color = colIn.value;
    });
    selectedDrawingRef.pane.saveDrawings();
    selectedDrawingRef.pane.requestDraw();
}

function openDrawSettingsModal() {
    if (!selectedDrawingRef) return;
    const d = selectedDrawingRef.item, isFib = FIB_TOOL_IDS.has(d.type);
    document.getElementById('dsm-title').textContent = ALL_TOOLS_MAP[d.type]?.label || (d.type === 'text' ? 'Text Note' : 'Drawing Settings');
    document.getElementById('dsm-tab-text').classList.toggle('hidden', isFib);

    if (isFib) {
        ensureFibProps(d); syncModalFields(d, FIB_MODAL_MAP, true); renderFibLevelsGridInModal(d);
        FIB_MODAL_MAP.forEach(([id]) => { const el = document.getElementById(id); if (el) el.oninput = liveSyncFibSettingsFromModal; });
    } else syncModalFields(d, REG_MODAL_MAP, true);

    document.getElementById('dsm-p1').value = d.p1 ? d.p1.price : 0;
    document.getElementById('dsm-p2').value = d.p2 ? d.p2.price : (d.p1 ? d.p1.price : 0);
    document.getElementById('dsm-b1').value = 123; document.getElementById('dsm-b2').value = 162;

    const hasP3 = THREE_POINT_TYPES.has(d.type);
    toggleFlexModal('dsm-coord-p3-wrap', hasP3);
    if (hasP3) { document.getElementById('dsm-p3').value = d.p3 ? d.p3.price : (d.p2 ? d.p2.price : 0); document.getElementById('dsm-b3').value = 173; }
    switchDsmTab('style');
    toggleFlexModal('draw-settings-modal', true);
}

function closeDrawSettingsModal() { toggleFlexModal('draw-settings-modal', false); }

function applyDrawSettingsModal() {
    if (!selectedDrawingRef) return;
    const d = selectedDrawingRef.item;
    FIB_TOOL_IDS.has(d.type) ? liveSyncFibSettingsFromModal() : syncModalFields(d, REG_MODAL_MAP, false);
    if (d.p1) d.p1.price = parseFloat(document.getElementById('dsm-p1').value) || d.p1.price;
    if (d.p2) d.p2.price = parseFloat(document.getElementById('dsm-p2').value) || d.p2.price;
    if (d.p3 && THREE_POINT_TYPES.has(d.type)) d.p3.price = parseFloat(document.getElementById('dsm-p3').value) || d.p3.price;
    selectedDrawingRef.pane.saveDrawings();
    showFloatingToolbar(selectedDrawingRef.pane, d);
    selectedDrawingRef.pane.requestDraw();
    closeDrawSettingsModal();
}

const ALT_DRAW_SHORTCUTS = {
    t: () => chooseGroupTool('line', 'trendline'), f: () => chooseGroupTool('fib', 'fib'),
    h: () => chooseGroupTool('line', 'hline'), j: () => chooseGroupTool('line', 'hray'),
    v: () => chooseGroupTool('line', 'vline'), c: () => chooseGroupTool('line', 'crossline'),
    m: () => toggleMagnetMode()
};

window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); closeIntervalModal(); openSearchModal(); return; }
    if (!document.getElementById('interval-modal').classList.contains('hidden')) {
        if (e.key === 'Escape') { e.preventDefault(); closeIntervalModal(); }
        else if (e.key === 'Enter') { e.preventDefault(); submitIntervalModal(); }
        return;
    }
    const tag = document.activeElement?.tagName?.toUpperCase() || '';
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
    if (e.key === 'Escape') {
        closeSearchModal(); closeAllPopMenus(); closeDrawSettingsModal();
        selectDrawTool('cursor'); selectDrawing(null, null); return;
    }
    if (isTyping) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingRef) { e.preventDefault(); deleteSelectedDrawing(); return; }
    if (e.altKey) {
        if (e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); chooseGroupTool('shape', 'rect'); return; }
        const fn = ALT_DRAW_SHORTCUTS[e.key.toLowerCase()];
        if (fn) { e.preventDefault(); fn(); return; }
    }
    const isSearchOpen = !document.getElementById('search-modal').classList.contains('hidden');
    const isChartsView = !document.getElementById('view-charts').classList.contains('hidden');
    if (!isSearchOpen && isChartsView && !e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault(); openIntervalModal(e.key);
    }
});

// =========================================================================
// LIVE STRATEGY SETTINGS, SOUND BEEP, TOASTS & SAVED NOTIFICATIONS DRAWER
// =========================================================================
let spConfig = JSON.parse(localStorage.getItem('sp_user_config') || '{"atr_mult":1.75,"atr_period":2.0,"alert_gap":2.50,"sound_on":true,"pre_on":true,"sig_on":true,"star_only":false}');
if (!localStorage.getItem('sp_ha_175_20_migrated')) {
    spConfig.atr_mult = 1.75;
    spConfig.atr_period = 2.0;
    spConfig.alert_gap = 2.50;
    localStorage.setItem('sp_user_config', JSON.stringify(spConfig));
    localStorage.setItem('sp_ha_175_20_migrated', '1');
}
let savedNotifications = JSON.parse(localStorage.getItem('sp_saved_notifs') || '[]'), unreadNotifCount = 0, prevStockAlertState = {};

fetchHistoryDeduplicated = async function(symbol, timeframe) {
    const key = `${symbol}_${timeframe}_${spConfig.atr_mult}_${spConfig.atr_period}`;
    if (pendingHistoryMap.has(key)) return pendingHistoryMap.get(key);
    const p = fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&mult=${spConfig.atr_mult}&period=${spConfig.atr_period}`)
        .then(r => { if (!r.ok) throw new Error("API Error"); return r.json(); }).finally(() => pendingHistoryMap.delete(key));
    pendingHistoryMap.set(key, p); return p;
};

const updateStratBadge = () => setTxt(document, '#hdr-strat-badge', `(${spConfig.atr_mult}|${spConfig.atr_period})`);

function openStrategyModal() {
    document.getElementById('inp-atr-mult').value = spConfig.atr_mult;
    document.getElementById('inp-atr-period').value = spConfig.atr_period;
    document.getElementById('inp-alert-gap').value = spConfig.alert_gap ?? 2.50;
    document.getElementById('chk-notif-sound').checked = spConfig.sound_on !== false;
    document.getElementById('chk-notif-pre').checked = spConfig.pre_on !== false;
    document.getElementById('chk-notif-sig').checked = spConfig.sig_on !== false;
    document.getElementById('chk-notif-star').checked = !!spConfig.star_only;
    toggleFlexModal('strategy-modal', true);
}

async function saveStrategySettings() {
    spConfig = {
        atr_mult: parseFloat(document.getElementById('inp-atr-mult').value) || 1.75,
        atr_period: parseFloat(document.getElementById('inp-atr-period').value) || 2.0,
        alert_gap: parseFloat(document.getElementById('inp-alert-gap').value) || 2.50,
        sound_on: document.getElementById('chk-notif-sound').checked,
        pre_on: document.getElementById('chk-notif-pre').checked,
        sig_on: document.getElementById('chk-notif-sig').checked,
        star_only: document.getElementById('chk-notif-star').checked
    };
    localStorage.setItem('sp_user_config', JSON.stringify(spConfig));
    updateStratBadge(); toggleFlexModal('strategy-modal', false);
    try { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spConfig) }); } catch (e) {}
    Object.values(panes).forEach(p => p.resetAndLoad());
}

let sharedAudioCtx = null;
function getAudioCtx() {
    if (!sharedAudioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) sharedAudioCtx = new AudioContextClass();
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
}
window.addEventListener('click', () => {
    getAudioCtx();
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
    }
}, { once: true });

function playAlertBeep(kind, speechText = '') {
    if (spConfig.sound_on === false) return;
    try {
        const ctx = getAudioCtx();
        if (ctx) {
            const now = ctx.currentTime;
            if (kind === 'PRE') {
                // Double radar alert beep for Ready to Buy/Sell (<= 2.50 gap)
                [0, 0.18].forEach(offset => {
                    const osc = ctx.createOscillator(), g = ctx.createGain();
                    osc.connect(g); g.connect(ctx.destination);
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(760, now + offset);
                    g.gain.setValueAtTime(0.24, now + offset);
                    g.gain.exponentialRampToValueAtTime(0.01, now + offset + 0.14);
                    osc.start(now + offset); osc.stop(now + offset + 0.15);
                });
            } else {
                // Loud 3-tone chime for BUY / SELL Executed
                const freqs = kind === 'BUY' ? [587.33, 783.99, 1046.50] : [880, 659.25, 440];
                freqs.forEach((freq, i) => {
                    const osc = ctx.createOscillator(), g = ctx.createGain();
                    osc.connect(g); g.connect(ctx.destination);
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, now + i * 0.13);
                    g.gain.setValueAtTime(0.30, now + i * 0.13);
                    g.gain.exponentialRampToValueAtTime(0.01, now + i * 0.13 + 0.18);
                    osc.start(now + i * 0.13); osc.stop(now + i * 0.13 + 0.19);
                });
            }
        }
        if (speechText && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(speechText);
            utter.rate = 1.05;
            utter.volume = 1.0;
            window.speechSynthesis.speak(utter);
        }
    } catch (e) {}
}

let activeNotifTab = 'PRE';

function switchNotifTab(tab) {
    activeNotifTab = tab;
    const preBtn = document.getElementById('tab-notif-pre'), execBtn = document.getElementById('tab-notif-exec');
    if (preBtn) preBtn.className = tab === 'PRE' ? 'flex-1 py-2 text-center text-yellow-400 border-b-2 border-yellow-400' : 'flex-1 py-2 text-center text-gray-400 border-b-2 border-transparent hover:text-gray-200';
    if (execBtn) execBtn.className = tab === 'EXEC' ? 'flex-1 py-2 text-center text-emerald-400 border-b-2 border-emerald-400' : 'flex-1 py-2 text-center text-gray-400 border-b-2 border-transparent hover:text-gray-200';
    renderNotifHistory();
}

function toggleQuickSetting(key, val) {
    spConfig[key] = val;
    localStorage.setItem('sp_user_config', JSON.stringify(spConfig));
    if (key === 'pre_on') { const el = document.getElementById('chk-notif-pre'); if(el) el.checked = val; }
    if (key === 'sig_on') { const el = document.getElementById('chk-notif-sig'); if(el) el.checked = val; }
    if (key === 'sound_on') { const el = document.getElementById('chk-notif-sound'); if(el) el.checked = val; }
}

function toggleNotifDrawer() {
    const drw = document.getElementById('notif-drawer');
    drw.classList.toggle('translate-x-full');
    if (!drw.classList.contains('translate-x-full')) { unreadNotifCount = 0; setTxt(document, '#notif-unread-badge', 0); renderNotifHistory(); }
}

function clearSavedNotifications() {
    if (activeNotifTab === 'EXEC') {
        savedNotifications = savedNotifications.filter(n => n.kind !== 'BUY' && n.kind !== 'SELL');
        localStorage.setItem('sp_saved_notifs', JSON.stringify(savedNotifications));
    }
    unreadNotifCount = 0;
    setTxt(document, '#notif-unread-badge', 0); 
    renderNotifHistory();
}

function renderNotifHistory() {
    const el = document.getElementById('notif-history-list');
    if (!el) return;
    
    // Quick toggles sync
    const cPre = document.getElementById('drw-chk-pre'); if(cPre) cPre.checked = spConfig.pre_on !== false;
    const cSig = document.getElementById('drw-chk-sig'); if(cSig) cSig.checked = spConfig.sig_on !== false;
    const cSnd = document.getElementById('drw-chk-snd'); if(cSnd) cSnd.checked = spConfig.sound_on !== false;

    el.innerHTML = '';

    if (activeNotifTab === 'PRE') {
        // LIVE TRACKING FOR READY TAB (Sidha Live Data se)
        const threshold = spConfig.alert_gap || 2.50;
        const readyStocks = screenerRows.filter(r => {
            if (r.stock.endsWith('_HOLD')) return false;
            if (spConfig.star_only && !starredSymbols.includes(r.stock)) return false;
            const gapNum = parseFloat(String(r.signal_gap || '').replace(/[^\d.]/g, ''));
            return !isNaN(gapNum) && gapNum > 0 && gapNum <= threshold;
        });

        if (readyStocks.length) {
            el.innerHTML = readyStocks.map(r => {
                const nextStr = String(r.next_level || '').toUpperCase(), brkStr = String(r.breakout || '').toUpperCase(), sigStr = String(r.signal || '').toUpperCase();
                let upcomingSide = 'BUY';
                if (nextStr.includes('SELL') || brkStr.includes('DOWN') || sigStr.includes('BUY')) upcomingSide = 'SELL';
                const gapNum = parseFloat(String(r.signal_gap || '').replace(/[^\d.]/g, ''));
                const trigPrice = extractTriggerPrice(r.next_level, r.ltp, gapNum, upcomingSide);
                
                return `<div onclick="loadSymbolIntoActivePane('${r.fyers_symbol}')" class="p-2.5 rounded-lg bg-[#0b0f19] hover:bg-gray-800 border border-yellow-500/40 cursor-pointer mb-1.5 shadow-[0_0_8px_rgba(234,179,8,0.1)]">
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold border text-yellow-400 border-yellow-500/30 bg-yellow-500/10">🚨 READY TO ${upcomingSide}</span>
                        <span class="text-[11px] text-white font-bold">${r.stock}</span>
                    </div>
                    <div class="text-[11px] text-gray-300 flex justify-between items-center">
                        <span>LTP: ₹${r.ltp.toFixed(2)}</span>
                        <span class="text-yellow-500 font-bold">Gap: ${r.signal_gap}</span>
                    </div>
                    <div class="text-[10px] text-gray-400 mt-0.5">Expected Trigger: ${trigPrice}</div>
                </div>`;
            }).join('');
        } else {
            el.innerHTML = `<div class="p-6 text-center text-xs text-gray-500">Koi stock abhi Ready zone (Gap &le; ${threshold.toFixed(2)}) mein nahi hai.</div>`;
        }
    } else {
        // EXECUTED HISTORY TAB (Saved history se)
        const filtered = savedNotifications.filter(n => n.kind === 'BUY' || n.kind === 'SELL');
        if (filtered.length) {
            el.innerHTML = filtered.map(n => {
                const isB = n.kind === 'BUY';
                const col = isB ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-red-400 border-red-500/30 bg-red-500/10';
                return `<div onclick="loadSymbolIntoActivePane('${n.fyers_symbol}')" class="p-2 rounded-lg bg-[#0b0f19] hover:bg-gray-800 border border-gray-800 cursor-pointer mb-1.5">
                    <div class="flex items-center justify-between">
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold border ${col}">${n.title}</span>
                        <span class="text-[10px] text-gray-400">${n.time}</span>
                    </div>
                    <div class="text-[11px] text-gray-300 mt-1">${n.msg}</div>
                </div>`;
            }).join('');
        } else {
            el.innerHTML = `<div class="p-6 text-center text-xs text-gray-500">No Executed notifications yet.</div>`;
        }
    }
}

function pushAlert(n) {
    if (n.kind === 'BUY' || n.kind === 'SELL') {
        savedNotifications.unshift(n);
        if (savedNotifications.length > 100) savedNotifications.pop();
        localStorage.setItem('sp_saved_notifs', JSON.stringify(savedNotifications));
        if (document.getElementById('notif-drawer').classList.contains('translate-x-full')) setTxt(document, '#notif-unread-badge', ++unreadNotifCount);
    }
    
    renderNotifHistory();
    playAlertBeep(n.kind, n.voice || '');
    
    const box = document.getElementById('toast-container'), t = document.createElement('div');
    const bCol = n.kind === 'BUY' ? 'border-emerald-500' : (n.kind === 'SELL' ? 'border-red-500' : 'border-yellow-500');
    t.className = `pointer-events-auto bg-[#161f30] border-l-4 ${bCol} border border-gray-700 rounded-lg p-2.5 shadow-2xl cursor-pointer hover:bg-gray-800`;
    t.onclick = () => { loadSymbolIntoActivePane(n.fyers_symbol); t.remove(); };
    t.innerHTML = `<div class="flex justify-between gap-2"><span class="font-bold text-xs text-white">${n.title}</span><span class="text-[10px] text-gray-400">${n.time}</span></div><div class="text-[11px] text-gray-300 mt-0.5">${n.msg}</div>`;
    box.appendChild(t); setTimeout(() => t.remove(), 8000);
    
    if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification(n.title, { body: n.msg }); } catch (e) {}
    }
}

function extractTriggerPrice(nextLevelStr, ltp, gapNum, upcomingSide) {
    const m = String(nextLevelStr || '').match(/(\d+(?:\.\d+)?)/);
    if (m) return `₹${parseFloat(m[1]).toFixed(2)}`;
    if (!isNaN(gapNum)) return `₹${(upcomingSide === 'BUY' ? (ltp + gapNum) : (ltp - gapNum)).toFixed(2)}`;
    return nextLevelStr || `₹${ltp.toFixed(2)}`;
}

const _baseApplyScreener = applyScreenerPayload;
applyScreenerPayload = function(data) {
    _baseApplyScreener(data);
    if (!data?.rows?.length) return;
    const nowStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const threshold = spConfig.alert_gap || 2.50;
    const firstRun = Object.keys(prevStockAlertState).length === 0;

    if (activeNotifTab === 'PRE' && !document.getElementById('notif-drawer').classList.contains('translate-x-full')) {
        renderNotifHistory();
    }

    for (const r of data.rows) {
        if (r.stock.endsWith('_HOLD')) continue;
        if (spConfig.star_only && !starredSymbols.includes(r.stock)) continue;

        const prev = prevStockAlertState[r.stock] || { gapNum: 999, alertedPreFor: null, alertedExecFor: null }; 
        const gapNum = parseFloat(String(r.signal_gap || '').replace(/[^\d.]/g, ''));
        const nextStr = String(r.next_level || '').toUpperCase(), brkStr = String(r.breakout || '').toUpperCase(), sigStr = String(r.signal || '').toUpperCase();
        
        let upcomingSide = 'BUY';
        if (nextStr.includes('SELL') || brkStr.includes('DOWN') || sigStr.includes('BUY')) upcomingSide = 'SELL';
        
        const triggerPriceStr = extractTriggerPrice(r.next_level, r.ltp, gapNum, upcomingSide);
        const isReady = !isNaN(gapNum) && gapNum > 0 && gapNum <= threshold;
        const hitZero = !isNaN(gapNum) && gapNum === 0 && prev.gapNum > 0;
        const brkTriggered = r.breakout && r.breakout !== '-' && prev.breakout !== r.breakout;
        const sigChanged = prev.signal !== undefined && r.signal !== prev.signal && (sigStr.includes('BUY') || sigStr.includes('SELL'));

        let triggeredExec = false;
        const newState = { signal: r.signal, breakout: r.breakout, gapNum: gapNum, upcomingSide: upcomingSide, alertedPreFor: prev.alertedPreFor, alertedExecFor: prev.alertedExecFor };

        // Silently Lock on First Load to prevent spam
        if (firstRun) {
            if (isReady) newState.alertedPreFor = `${upcomingSide}_${r.next_level}`;
            if (r.signal || r.breakout !== '-') newState.alertedExecFor = `${upcomingSide}_${r.signal}_${r.breakout}`;
        } else {
            // 1. EXECUTED ALERT (Only 1 time per state change)
            if (spConfig.sig_on !== false && (sigChanged || hitZero || brkTriggered)) {
                let execSide = upcomingSide;
                if (sigChanged) execSide = sigStr.includes('BUY') ? 'BUY' : 'SELL';
                else if (brkTriggered) execSide = brkStr.includes('UP') ? 'BUY' : (brkStr.includes('DOWN') ? 'SELL' : (prev.upcomingSide || upcomingSide));
                else if (hitZero) execSide = prev.upcomingSide || upcomingSide;

                const currentExecId = `${execSide}_${r.signal}_${r.breakout}`;
                
                if (prev.alertedExecFor !== currentExecId) {
                    triggeredExec = true;
                    newState.alertedExecFor = currentExecId; 
                    newState.alertedPreFor = null; 
                    
                    const isB = execSide === 'BUY';
                    const execPrice = (sigChanged && r.entry_price > 0) ? r.entry_price : r.ltp;
                    const execTime = (sigChanged && r.entry_time && r.entry_time !== '-') ? `${r.entry_time} (${nowStr})` : nowStr;

                    pushAlert({
                        kind: execSide,
                        title: `${isB ? '🟢 BUY' : '🔴 SELL'} EXECUTED — ${r.stock}`,
                        msg: `${execSide} ₹${ r.ltp.toFixed(2) } price aur ${execTime} time par aaya hai! • Entry: ₹${execPrice.toFixed(2)} • Target: ₹${r.target_price.toFixed(2)}`,
                        voice: `${r.stock.replace(/[^a-zA-Z0-9]/g, ' ')} ${execSide} executed`,
                        time: nowStr,
                        fyers_symbol: r.fyers_symbol
                    });
                }
            }

            // 2. PRE-ALERT (Sound / Toast ONLY ONCE, Live tab will show it automatically)
            if (!triggeredExec && spConfig.pre_on !== false && isReady) {
                const currentPreId = `${upcomingSide}_${r.next_level}`;
                
                if (prev.alertedPreFor !== currentPreId) {
                    newState.alertedPreFor = currentPreId; 
                    pushAlert({
                        kind: 'PRE',
                        title: `🚨 READY TO ${upcomingSide} — ${r.stock} (Gap: ${gapNum.toFixed(2)})`,
                        msg: `${upcomingSide} ${triggerPriceStr} price par aane wala hai! • Abhi LTP: ₹${r.ltp.toFixed(2)} • Gap: 🚨${gapNum.toFixed(2)} • Time: ${nowStr}`,
                        voice: `${r.stock.replace(/[^a-zA-Z0-9]/g, ' ')} ready to ${upcomingSide}`,
                        time: nowStr,
                        fyers_symbol: r.fyers_symbol
                    });
                }
            }
        }
        prevStockAlertState[r.stock] = newState;
    }
};

socket.on('strategy_updated', cfg => {
    if (!cfg) return;
    spConfig.atr_mult = cfg.atr_mult ?? spConfig.atr_mult;
    spConfig.atr_period = cfg.atr_period ?? spConfig.atr_period;
    spConfig.alert_gap = cfg.alert_gap ?? spConfig.alert_gap;
    localStorage.setItem('sp_user_config', JSON.stringify(spConfig));
    updateStratBadge();
});

fetch('/api/settings').then(r => r.json()).then(srv => {
    spConfig.atr_mult = srv.atr_mult ?? spConfig.atr_mult;
    spConfig.atr_period = srv.atr_period ?? spConfig.atr_period;
    if (srv.alert_gap && srv.alert_gap !== 5.5) spConfig.alert_gap = srv.alert_gap;
    localStorage.setItem('sp_user_config', JSON.stringify(spConfig));
    updateStratBadge();
}).catch(() => updateStratBadge());
renderNotifHistory();