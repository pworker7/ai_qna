#!/usr/bin/env node
const API = 'https://www.alphavantage.co/query';
const KEY = process.env.ALPHAVANTAGE_API_KEY || "YOUR_API_KEY";

export async function getLastClose(symbol, interval = 'daily') {
  if (!KEY) throw new Error('Missing ALPHAVANTAGE_API_KEY env var');

  const endpoint = interval === 'weekly'
    ? 'TIME_SERIES_WEEKLY'
    : interval === 'monthly'
    ? 'TIME_SERIES_MONTHLY'
    : 'TIME_SERIES_DAILY';

  const url = `${API}?function=${endpoint}&symbol=${encodeURIComponent(symbol)}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();

  if (data.Note) throw new Error(`Rate limit: ${data.Note}`);
  if (data['Error Message']) throw new Error(`API error: ${data['Error Message']}`);

  const seriesKey =
    endpoint === 'TIME_SERIES_WEEKLY' ? 'Weekly Time Series'
    : endpoint === 'TIME_SERIES_MONTHLY' ? 'Monthly Time Series'
    : 'Time Series (Daily)';

  const series = data[seriesKey];
  if (!series) throw new Error('Missing price series');

  const keys = Object.keys(series).sort();
  if (keys.length === 0) throw new Error('Empty price series');

  const lastTs = keys[keys.length - 1];
  const close = Number(series[lastTs]['4. close']);
  if (!Number.isFinite(close)) throw new Error(`Invalid close value: ${series[lastTs]['4. close']}`);

  return { close, timestamp: lastTs };
}

export async function getATR(symbol, timePeriod = 14, interval = 'daily') {
  if (!KEY) throw new Error('Missing ALPHAVANTAGE_API_KEY env var');
  const url = `${API}?function=ATR&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&time_period=${encodeURIComponent(timePeriod)}&series_type=close&apikey=${KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();

  if (data.Note) throw new Error(`Rate limit: ${data.Note}`);
  if (data['Error Message']) throw new Error(`API error: ${data['Error Message']}`);

  const series = data['Technical Analysis: ATR'];
  if (!series) throw new Error('Missing ATR series in response');

  const keys = Object.keys(series).sort();
  if (keys.length === 0) throw new Error('Empty ATR series');

  const lastTs = keys[keys.length - 1];
  const raw = series[lastTs]?.ATR;
  const atr = Number(raw);
  if (!Number.isFinite(atr)) throw new Error(`Invalid ATR value: ${raw}`);

  const { close } = await getLastClose(symbol, interval);
  const atrPct = (atr / close) * 100;

  return {
    symbol,
    interval,
    timePeriod,
    timestamp: lastTs,
    atr,
    close,
    atrPct: Number(atrPct.toFixed(2)),
    meta: data['Meta Data'] ?? null,
  };
}

// CLI
if (require.main === module) {
  (async () => {
    try {
      const [symbol = 'AAPL', tpArg = '14', interval = 'daily'] = process.argv.slice(2);
      const timePeriod = Number(tpArg);
      if (!symbol) throw new Error('Usage: node atr.js SYMBOL [TIME_PERIOD=14] [INTERVAL=daily|weekly|monthly]');
      if (!Number.isFinite(timePeriod) || timePeriod <= 0) throw new Error('TIME_PERIOD must be a positive integer');

      const r = await getATR(symbol.toUpperCase(), timePeriod, interval);
      console.log(JSON.stringify(r, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  })();
}
