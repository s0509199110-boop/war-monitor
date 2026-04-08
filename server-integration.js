'use strict';
require('dotenv').config({ path: './_env' });

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const axios     = require('axios');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.static(__dirname)); // serves monitor.html

// ─── CONFIG FROM .env ────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 8080;
const OREF_URL     = process.env.OREF_URL    || 'https://www.oref.org.il/warningMessages/alert/alerts.json';
const OREF_TIMEOUT = parseInt(process.env.OREF_TIMEOUT_MS) || 4500;
const OPENSKY_URL  = process.env.OPENSKY_URL || 'https://opensky-network.org/api/states/all';

// Oref headers (required by their server)
const OREF_HEADERS = {
  'Referer':          process.env.OREF_REFERER || 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0',
};

// ─── STATE ───────────────────────────────────────────────────────────────────
let activeAlertsCache = new Map(); // cityName → missile data  (for missile tracking)
let lastOrefData      = '';        // raw JSON string from previous poll

// ─── MISSILE SOURCE LOGIC ─────────────────────────────────────────────────────
function getMissileSource(lat, lng) {
  if (lat > 32.8)  return { lng: 35.55, lat: 33.55, country: 'לבנון' };
  if (lat < 31.2) {
    return lng < 34.6
      ? { lng: 34.35, lat: 31.35, country: 'עזה' }
      : { lng: 44.20, lat: 15.35, country: 'תימן' };
  }
  return { lng: 44.4, lat: 33.3, country: 'איראן / עיראק' };
}

// ─── OREF POLLING (every 3 seconds) ──────────────────────────────────────────
async function pollOref() {
  try {
    const res = await axios.get(OREF_URL, {
      headers: OREF_HEADERS,
      timeout: OREF_TIMEOUT,
      responseType: 'text',
    });

    const raw = (res.data || '').trim();

    // Oref returns empty string / whitespace when there are no alerts
    if (!raw || raw === '' || raw === '\r\n') {
      handleOrefClear();
      lastOrefData = '';
      return;
    }

    // Avoid reprocessing the same payload
    if (raw === lastOrefData) return;
    lastOrefData = raw;

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }

    // Format: { data: ["City A","City B"], cat: "1", title: "ירי רקטות ופגזים" }
    const cities   = parsed.data  || [];
    const title    = parsed.title || 'התרעה';

    handleOrefAlerts(cities, title);

  } catch (err) {
    // Network errors are normal — just log quietly
    if (process.env.DEBUG) console.warn('[Oref] poll error:', err.message);
  }
}

// City → approximate coordinates (simplified lookup)
const CITY_COORDS = {
  'תל אביב':         [34.78, 32.08],
  'תל אביב - יפו':   [34.78, 32.08],
  'ירושלים':         [35.22, 31.77],
  'חיפה':            [34.99, 32.80],
  'נהריה':           [35.09, 33.00],
  'נצרת':            [35.30, 32.70],
  'אשקלון':          [34.57, 31.67],
  'אשדוד':           [34.65, 31.80],
  'באר שבע':         [34.80, 31.25],
  'אילת':            [34.95, 29.56],
  'ראשון לציון':     [34.80, 31.97],
  'פתח תקוה':        [34.89, 32.09],
  'בני ברק':         [34.83, 32.08],
  'רמת גן':          [34.82, 32.07],
  'נתניה':           [34.86, 32.33],
  'חדרה':            [34.92, 32.43],
  'עכו':             [35.08, 32.93],
  'כרמיאל':          [35.30, 32.92],
  'קריית שמונה':     [35.57, 33.21],
  'מטולה':           [35.57, 33.28],
  'צפת':             [35.50, 32.97],
  'טבריה':           [35.53, 32.79],
  'בית שאן':         [35.50, 32.50],
  'אופקים':          [34.62, 31.32],
  'נתיבות':          [34.59, 31.42],
  'שדרות':           [34.60, 31.52],
  'כפר סבא':         [34.91, 32.18],
  'הרצליה':          [34.85, 32.16],
  'רעננה':           [34.87, 32.18],
  'מודיעין':         [35.01, 31.90],
  'לוד':             [34.89, 31.95],
  'רמלה':            [34.87, 31.93],
  'ריינה':           [35.31, 32.73],
};

function getCityCoords(cityName) {
  if (CITY_COORDS[cityName]) return CITY_COORDS[cityName];
  // Guess by name fragments
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (cityName.includes(key) || key.includes(cityName)) return coords;
  }
  // Default to center of Israel
  return [34.85, 31.50];
}

function handleOrefAlerts(cities, title) {
  const currentCities = new Set(cities);

  cities.forEach(cityName => {
    if (!activeAlertsCache.has(cityName)) {
      const coords = getCityCoords(cityName);
      const [lng, lat] = coords;
      const src = getMissileSource(lat, lng);

      const missileData = {
        id:            `missile_${cityName}_${Date.now()}`,
        city:          cityName,
        source:        [src.lng, src.lat],
        target:        [lng, lat],
        sourceCountry: src.country,
        timestamp:     Date.now(),
        flightMs:      20000,
      };

      activeAlertsCache.set(cityName, missileData);

      // Broadcast alert
      io.emit('new_alert', {
        cityName,
        title,
        coordinates: coords,
        timestamp: Date.now(),
      });

      // Broadcast missile
      io.emit('real_time_missile', missileData);

      console.log(`[Oref] 🚨 התרעה: ${cityName} (מקור: ${src.country})`);
    }
  });

  // Clear ended alerts
  for (const [city, data] of activeAlertsCache.entries()) {
    if (!currentCities.has(city)) {
      io.emit('clear_city_alert', { city, alertId: data.id, timestamp: Date.now() });
      activeAlertsCache.delete(city);
      console.log(`[Oref] ✅ שוחרר: ${city}`);
    }
  }
}

function handleOrefClear() {
  if (activeAlertsCache.size > 0) {
    io.emit('clear_all_threats', { timestamp: Date.now() });
    io.emit('alert_release', { message: 'כל האזורים שוחררו' });
    activeAlertsCache.clear();
    console.log('[Oref] 🛑 כל ההתרעות שוחררו');
  }
}

// ─── OPENSKY FLIGHT DATA (every 60 seconds) ──────────────────────────────────
async function pollFlights() {
  try {
    // Bounding box around Israel + neighbours
    const params = { lamin: 28, lomin: 32, lamax: 37, lomax: 42 };
    const auth   = process.env.OPENSKY_USERNAME
      ? { username: process.env.OPENSKY_USERNAME, password: process.env.OPENSKY_PASSWORD }
      : undefined;

    const res = await axios.get(OPENSKY_URL, {
      params, auth,
      timeout: parseInt(process.env.OPENSKY_TIMEOUT_MS) || 5000,
    });

    const states = res.data?.states || [];
    const flights = states.map(s => ({
      callsign:      (s[1] || '').trim(),
      origin_country: s[2],
      longitude:     s[5],
      latitude:      s[6],
      baro_altitude: s[7],
      velocity:      s[9],
    })).filter(f => f.latitude && f.longitude);

    io.emit('flights_update', flights);
    console.log(`[OpenSky] ✈️  ${flights.length} טיסות`);
  } catch (err) {
    if (process.env.DEBUG) console.warn('[OpenSky] error:', err.message);
  }
}

// ─── USGS SEISMIC (every 5 minutes) ──────────────────────────────────────────
async function pollSeismic() {
  try {
    const res = await axios.get(
      'https://earthquake.usgs.gov/fdsnws/event/1/query',
      {
        params: { format: 'geojson', minmagnitude: 2.5, minlatitude: 28, maxlatitude: 38, minlongitude: 30, maxlongitude: 48, limit: 10, orderby: 'time' },
        timeout: 8000,
      }
    );
    const events = (res.data?.features || []).map(f => ({
      magnitude: f.properties.mag,
      place:     f.properties.place,
      time:      f.properties.time,
      lat:       f.geometry.coordinates[1],
      lng:       f.geometry.coordinates[0],
    }));
    io.emit('seismic_update', events);
    if (events.length) console.log(`[USGS] 🌍 ${events.length} רעידות`);
  } catch (err) {
    if (process.env.DEBUG) console.warn('[USGS] error:', err.message);
  }
}

// ─── MARKETS via Yahoo Finance (every 5 minutes) ──────────────────────────────
async function pollMarkets() {
  const symbols = { vix: '^VIX', sp500: '^GSPC', nasdaq: '^IXIC' };
  const result  = {};
  for (const [key, sym] of Object.entries(symbols)) {
    try {
      const r = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`,
        { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const price = r.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      result[key] = { value: price ? price.toFixed(2) : '—', symbol: sym };
    } catch { result[key] = { value: '—' }; }
  }
  io.emit('markets_update', result);
  console.log(`[Markets] 📈 VIX=${result.vix?.value} S&P=${result.sp500?.value}`);
}

// ─── NEWS RSS (every 3 minutes) ───────────────────────────────────────────────
async function pollNews() {
  const urls = (process.env.NEWS_RSS_URLS || '').split(',').filter(Boolean);
  if (!urls.length) return;

  const articles = [];
  for (const url of urls.slice(0, 5)) { // limit to 5 feeds
    try {
      const r = await axios.get(url.trim(), { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      // Very basic RSS parsing (title extraction)
      const matches = r.data.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>|<title>(.+?)<\/title>/gs);
      let count = 0;
      for (const m of matches) {
        if (count++ > 5) break;
        const title = (m[1] || m[2] || '').trim();
        if (title && !title.includes('RSS') && title.length > 10) {
          articles.push({ title, seendate: Date.now() });
        }
      }
    } catch { /* skip failed feeds */ }
  }

  if (articles.length) {
    io.emit('news_update', { articles: articles.slice(0, 20) });
    console.log(`[News] 📰 ${articles.length} כתבות`);
  }
}

// ─── HTTP API ENDPOINT ────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), activeAlerts: activeAlertsCache.size });
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: [...activeAlertsCache.values()] });
});

// ─── SOCKET CONNECTION ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] 🔌 לקוח חדש: ${socket.id}`);

  // Send any currently active alerts to new client
  activeAlertsCache.forEach((missileData, city) => {
    socket.emit('real_time_missile', missileData);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] ❌ מנותק: ${socket.id}`);
  });
});

// ─── START SERVER + POLLING ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  🛡️  מוניטור מלחמה - שרת פעיל');
  console.log(`  📡  http://localhost:${PORT}/monitor.html`);
  console.log('══════════════════════════════════════════════════');
  console.log('');

  // Start all polls immediately, then on intervals
  pollOref();
  pollFlights();
  pollSeismic();
  pollMarkets();
  pollNews();

  setInterval(pollOref,    3_000);   // every 3 seconds
  setInterval(pollFlights, 60_000);  // every minute
  setInterval(pollSeismic, 300_000); // every 5 minutes
  setInterval(pollMarkets, 300_000); // every 5 minutes
  setInterval(pollNews,    180_000); // every 3 minutes

  console.log('[Server] ✅ כל הסקרים הופעלו');
});
