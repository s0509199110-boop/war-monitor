const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

try {
  const dotenv = require('dotenv');
  const envPaths = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const p of envPaths) {
    try {
      if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
    } catch (_) {}
  }
} catch (e) {
  /* ׳׳ ׳׳™׳ ׳—׳‘׳™׳׳× dotenv (׳¨׳§ npm install ׳‘׳×׳•׳ backend ׳׳׳ ׳©׳•׳¨׳©) ג€” ׳”׳©׳¨׳× ׳¢׳“׳™׳™׳ ׳™׳¢׳׳” */
}

/** true רק אם TZOFAR_BACKUP_ENABLED מוגדר במפורש כמופעל (מקבל גם רווחים / true / yes). */
function isTzofarBackupEnvEnabled() {
  const v = String(process.env.TZOFAR_BACKUP_ENABLED ?? '')
    .trim()
    .toLowerCase();
  if (!v) return false;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

const { getServiceStatus } = require('./OrefAlertService');
const { startNewsService, getNews, getNewsStoreWarRelatedBlob, newsStore } = require('./NewsService');
const {
  getCityCoordinates,
  getDefaultCoordinates,
  getDefaultTargetFallbackCoordinates,
  normalizeHebrewSettlementName,
  finalizeOrefAlertSettlementName,
  settlementMatchKey,
  resolveCanonicalOrefSettlementName,
  LOCALITIES,
  CITIES_MAP,
} = require('./citiesMap');

const CRITICAL_SETTLEMENT_COORD_OVERRIDES = {
  'מטולה': { lat: 33.2778, lng: 35.5833 },
  'מרגליות': { lat: 33.216473, lng: 35.544355 },
  'כפר גלעדי': { lat: 33.233, lng: 35.5747 },
  'כפר יובל': { lat: 33.246576, lng: 35.597065 },
  "ע'ג'ר": { lat: 33.2749, lng: 35.6234 },
  'ע׳ג׳ר': { lat: 33.2749, lng: 35.6234 },
  'בית הלל': { lat: 33.2186, lng: 35.6061 },
  'מנרה': { lat: 33.2456, lng: 35.5448 },
  'מעיין ברוך': { lat: 33.2398, lng: 35.6090 },
  'משגב עם': { lat: 33.247571, lng: 35.548501 },
  'קריית שמונה': { lat: 33.2079, lng: 35.5702 },
  'קרית שמונה': { lat: 33.2079, lng: 35.5702 },
  'תל חי': { lat: 33.2358, lng: 35.5795 },
  'הגושרים': { lat: 33.2215, lng: 35.6215 },
  'זרעית': { lat: 33.0983, lng: 35.2847 },
  'דפנה': { lat: 33.2418, lng: 35.6391 },
  'שאר ישוב': { lat: 33.2257, lng: 35.6481 },
  'קיבוץ דן': { lat: 33.2402, lng: 35.6530 },
  'דן': { lat: 33.2402, lng: 35.6530 },
  'שניר': { lat: 33.2443, lng: 35.6508 },
  'כפר סאלד': { lat: 33.196034, lng: 35.657995 },
  'רמת טראמפ': { lat: 33.1298, lng: 35.7871 },
};

function getReliableCityCoordinates(cityName) {
  if (cityName == null) return null;
  const raw = String(cityName).trim();
  if (!raw) return null;
  const normalized = normalizeHebrewSettlementName(raw);
  return (
    CRITICAL_SETTLEMENT_COORD_OVERRIDES[raw] ||
    CRITICAL_SETTLEMENT_COORD_OVERRIDES[normalized] ||
    getCityCoordinates(normalized) ||
    getCityCoordinates(raw) ||
    null
  );
}
const { enrichOrefAlertsGeocode } = require('./settlementGeocode');
const { TzofarBackupClient } = require('./tzofarBackupClient');
const { matchThreatAxisInBlob, matchExplicitThreatAxisInBlob } = require('./threatAxisPatterns');
const {
  refreshOsintHints,
  getOsintAxisHintSync,
  getOsintDebugSnapshot,
  fetchTelegramOnlyChunks,
  fetchTelegramPublicMessagesForOsint,
} = require('./osintHintService');
const { extractMissileTracksFromChunks } = require('./telegramMissileExtractor');
const launchAxisAiEngine = require('./launchAxisAiEngine');
const {
  buildOrefGuidelineFullText,
  classifyOrefGuidelinePhase,
  resolveOfficialOrefFeedTag,
} = require('./orefGuidelines');
const {
  reconcileOsintImpactRegistry,
  registryToClientList,
  loadOsintImpactRegistryFromDisk,
  saveOsintImpactRegistryToDisk,
} = require('./osintImpactLayer');

const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.join(__dirname, '..');
const AI_SUMMARY_WINDOW_MS = 30 * 60 * 1000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OREF_HISTORY_URL =
  process.env.OREF_HISTORY_URL ||
  'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he';

const app = express();
/** מאחורי פרוקסי (Render / nginx) — נדרש ל־req.ip ולמגבלת קצב לפי לקוח אמיתי */
app.set('trust proxy', Math.max(0, Number(process.env.TRUST_PROXY_HOPS) || 1));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

let aiSummaryRefreshInFlight = null;
let aiSummaryLastRefreshAt = 0;
let orefBurstOsintLastAt = 0;
const AI_SUMMARY_MIN_REFRESH_MS = Math.max(5_000, Number(process.env.AI_SUMMARY_MIN_REFRESH_MS) || 15_000);
const OREF_OSINT_BURST_MIN_MS = Math.max(5_000, Number(process.env.OREF_OSINT_BURST_MIN_MS) || 15_000);

let telegramMissilePollInFlight = false;
let telegramMissileLastRunAt = 0;

const SOURCE_CREDIBILITY_BASE = {
  oref: 0.98,
  telegram_verified: 0.85,
  telegram_ai: 0.78,
  telegram_osint: 0.62,
  rss_major: 0.75,
  gdelt: 0.6,
  prediction_market: 0.4,
  geometry: 0.38,
};

function applyCredibilityTimeDecay(
  score,
  timestampMs,
  halfLifeMs = Math.max(60_000, Number(process.env.CREDIBILITY_HALF_LIFE_MS) || 5 * 60_000)
) {
  if (!Number.isFinite(score)) return SOURCE_CREDIBILITY_BASE.geometry;
  if (!timestampMs) return Math.min(0.99, score);
  const age = Date.now() - Number(timestampMs);
  return Math.max(0.12, score * Math.pow(0.5, age / halfLifeMs));
}

function crossSourceCredibilityBonus(sourceCount) {
  return sourceCount >= 2 ? 0.15 : 0;
}

app.use(cors());
app.use(express.json());

const DASHBOARD_RATE_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.DASHBOARD_RATE_WINDOW_MS) || 60_000
);
const DASHBOARD_RATE_MAX = Math.max(
  30,
  Number(process.env.DASHBOARD_RATE_MAX) || 150
);
const dashboardRateBuckets = new Map();
let dashboardRatePruneAt = 0;

function pruneDashboardRateBuckets(now) {
  if (now < dashboardRatePruneAt) return;
  dashboardRatePruneAt = now + 300_000;
  const staleBefore = now - DASHBOARD_RATE_WINDOW_MS * 2;
  for (const [ip, b] of dashboardRateBuckets) {
    if (b.resetAt <= staleBefore) dashboardRateBuckets.delete(ip);
  }
}

function dashboardRateLimit(req, res, next) {
  const now = Date.now();
  pruneDashboardRateBuckets(now);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = dashboardRateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { resetAt: now + DASHBOARD_RATE_WINDOW_MS, count: 0 };
    dashboardRateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > DASHBOARD_RATE_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSec });
  }
  next();
}

function sendMonitorHtml(req, res) {
  res.sendFile(path.join(ROOT_DIR, 'monitor.html'), (err) => {
    if (err) {
      console.error('[HTTP] sendFile monitor.html:', err.message);
      if (!res.headersSent) res.status(500).send('Server error');
    }
  });
}

app.get('/', sendMonitorHtml);
app.get('/monitor.html', sendMonitorHtml);

app.use(express.static(ROOT_DIR));

app.get('/api/israel-localities', (_req, res) => {
  try {
    const out = [];
    const seen = new Set();
    const appendEntries = (source) => {
      Object.entries(source || {}).forEach(([name, coords]) => {
        if (!name || !coords || !Number.isFinite(coords.lng) || !Number.isFinite(coords.lat)) return;
        if (coords.lat < 29.45 || coords.lat > 33.72 || coords.lng < 34.22 || coords.lng > 36.22) return;
        const cleanName = normalizeHebrewSettlementName(String(name));
        if (!cleanName || seen.has(cleanName)) return;
        seen.add(cleanName);
        out.push({
          name: cleanName,
          position: [Number(coords.lng), Number(coords.lat)],
        });
      });
    };
    appendEntries(CITIES_MAP);
    appendEntries(LOCALITIES);
    out.sort((a, b) => a.name.localeCompare(b.name, 'he'));
    res.json({ ok: true, count: out.length, localities: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'failed_to_build_localities' });
  }
});

const state = {
  flights: [],
  seismic: [],
  markets: {},
  fires: [],
  ships: [],
  activeMissiles: [],
  aiSummary: null,
  clientEventFeed: [],
  startedAt: new Date().toISOString(),
  gdeltEvents: [],
  gdeltCorroboration: { axis: null, confidence: 0, updatedAt: 0 },
  predictionMarketsSnapshot: { markets: [], escalationScore: 0, updatedAt: 0 },
  osintImpacts: [],
  osintImpactRegistry: {},
};

/** פיד פיקוד: 12 שעות אחורה; מעל מגבלת הפריטים — מוחקים מהכי ישן, עם העדפת שמירה על שורות איום */
const CLIENT_FEED_RETENTION_MS =
  Number(process.env.CLIENT_EVENT_FEED_RETENTION_HOURS) > 0
    ? Math.min(72, Number(process.env.CLIENT_EVENT_FEED_RETENTION_HOURS)) * 60 * 60 * 1000
    : 12 * 60 * 60 * 1000;

const CLIENT_FEED_MAX =
  Number(process.env.CLIENT_EVENT_FEED_MAX) > 0
    ? Math.min(2500, Number(process.env.CLIENT_EVENT_FEED_MAX))
    : 1500;
let clientEventFeedSeq = 0;

const CLIENT_EVENT_FEED_FILE = path.join(ROOT_DIR, 'data', 'client-event-feed.json');
const OSINT_IMPACT_REGISTRY_FILE = path.join(ROOT_DIR, 'data', 'osint-impact-registry.json');
let osintImpactRegistrySaveTimer = null;

function scheduleSaveOsintImpactRegistry() {
  if (osintImpactRegistrySaveTimer) clearTimeout(osintImpactRegistrySaveTimer);
  osintImpactRegistrySaveTimer = setTimeout(() => {
    osintImpactRegistrySaveTimer = null;
    try {
      saveOsintImpactRegistryToDisk(state.osintImpactRegistry, OSINT_IMPACT_REGISTRY_FILE);
    } catch (_) {
      /* ignore */
    }
  }, 500);
}

function loadPersistedClientEventFeed() {
  try {
    if (!fs.existsSync(CLIENT_EVENT_FEED_FILE)) return;
    const raw = fs.readFileSync(CLIENT_EVENT_FEED_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    if (arr.length === 0) {
      state.clientEventFeed = [];
      console.log('[Feed] client-event-feed.json ריק — פיד אירועים מאופס (הפעל מחדש את השרת אם הוא כבר רץ)');
      return;
    }
    const out = [];
    const loadCap = Math.min(arr.length, 8000);
    for (let i = 0; i < loadCap; i++) {
      const r = arr[i];
      if (!r || typeof r !== 'object') continue;
      const timestampMs = Number(r.timestampMs);
      const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
      const title = String(r.title || 'אירוע');
      const tag = String(r.tag || 'עדכון');
      let cityName = String(r.cityName || '');
      if (!cityName && title.startsWith('שחרור:')) cityName = title.slice('שחרור:'.length).trim();
      if (!cityName && !title.startsWith('פיקוד העורף שחרר')) cityName = title.trim();
      let alertPhase = String(r.alertPhase || '');
      let liveState = String(r.liveState || '');
      const looksLikeDirectSirenTag =
        tag.includes('ירי רקטות') || tag.includes('חדירת כלי טיס') || tag.includes('צבע אדום');
      const looksLikeReleaseTag =
        tag.includes('האירוע הסתיים') ||
        tag.includes('שחרור') ||
        title.includes('יכולים לצאת') ||
        title.includes('האירוע הסתיים');
      if (!alertPhase) {
        if (tag.includes('אזעקה פעילה')) alertPhase = 'siren_active';
        else if (tag.includes('הישארו במרחב המוגן')) alertPhase = 'hold_after_siren';
        else if (tag.includes('בדקות הקרובות')) alertPhase = 'pre_alert';
        else if (tag.includes('התראה מוקדמת')) alertPhase = 'pre_alert';
        else if (looksLikeDirectSirenTag) alertPhase = 'siren_active';
        else if (looksLikeReleaseTag || tag.includes('האירוע הסתיים') || tag.includes('שחרור')) alertPhase = 'released';
      }
      if (alertPhase === 'pre_alert' && looksLikeDirectSirenTag && !tag.includes('מוקדמת')) {
        alertPhase = 'siren_active';
      }
      if (!liveState) {
        if (alertPhase === 'siren_active') liveState = 'אזעקה פעילה';
        else if (alertPhase === 'hold_after_siren') liveState = 'במרחב מוגן';
        else if (alertPhase === 'pre_alert') liveState = 'התראה מוקדמת';
        else if (alertPhase === 'released') liveState = 'שוחרר';
      }
      if (looksLikeReleaseTag) {
        alertPhase = 'released';
        liveState = liveState || 'שוחרר';
      }
      const activePh =
        alertPhase === 'pre_alert' || alertPhase === 'siren_active' || alertPhase === 'hold_after_siren';
      const normalizedType =
        alertPhase === 'released' || looksLikeReleaseTag
          ? 'defense'
          : activePh
            ? 'attack'
            : String(r.type || 'intel');
      const oWall = r.orefTimeMs != null && Number.isFinite(Number(r.orefTimeMs)) ? Number(r.orefTimeMs) : null;
      const rRecv = r.receivedAtMs != null && Number.isFinite(Number(r.receivedAtMs)) ? Number(r.receivedAtMs) : null;
      out.push({
        id: typeof r.id === 'string' && r.id ? r.id : `srvfeed-${ts}-load-${i}`,
        timestampMs: ts,
        ...(oWall != null ? { orefTimeMs: oWall } : {}),
        ...(rRecv != null ? { receivedAtMs: rRecv } : {}),
        title,
        type: normalizedType,
        tag,
        severity: Number.isFinite(Number(r.severity)) ? Number(r.severity) : 0,
        zone: String(r.zone || 'israel'),
        source: 'oref',
        cityName,
        alertPhase,
        liveState,
        threatType: String(r.threatType || ''),
      });
    }
    const deduped = [];
    const seenKeys = new Set();
    for (const row of out) {
      const k = serverFeedLogicalDedupeKey(row);
      if (!k || seenKeys.has(k)) continue;
      seenKeys.add(k);
      deduped.push(row);
    }
    state.clientEventFeed = finalizeClientEventFeedRows(deduped, Date.now());
    let maxSeq = 0;
    for (const row of state.clientEventFeed) {
      const m = String(row.id).match(/srvfeed-\d+-(\d+)$/);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]) || 0);
    }
    if (maxSeq > 0) clientEventFeedSeq = maxSeq;
    if ((state.clientEventFeed || []).length > 0) {
      console.log(
        `[Feed] Loaded ${state.clientEventFeed.length} event(s) (12h + cap; from ${deduped.length} raw rows)`
      );
      /* שמירה מיידית אחרי נרמול טעינה — הקובץ תואם למה שבזיכרון (בלי debounce של 400ms) */
      savePersistedClientEventFeedSync();
    }
  } catch (e) {
    console.warn('[Feed] Could not load persisted feed:', e.message);
  }
}

function savePersistedClientEventFeedSync() {
  try {
    const dir = path.dirname(CLIENT_EVENT_FEED_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLIENT_EVENT_FEED_FILE, JSON.stringify(state.clientEventFeed), 'utf8');
  } catch (e) {
    console.warn('[Feed] Could not save feed:', e.message);
  }
}

function flushPersistClientEventFeedSync() {
  savePersistedClientEventFeedSync();
}

function runShutdownPersistSync() {
  flushPersistClientEventFeedSync();
  flushPersistChatHistorySync();
}

process.once('SIGINT', () => {
  runShutdownPersistSync();
  process.exit(0);
});
process.once('SIGTERM', () => {
  runShutdownPersistSync();
  process.exit(0);
});

function resolveFeedEventTimestampMs(entry) {
  if (entry.timestampMs != null && Number.isFinite(Number(entry.timestampMs))) {
    return Number(entry.timestampMs);
  }
  if (entry.orefTimeMs != null && Number.isFinite(Number(entry.orefTimeMs))) {
    return Number(entry.orefTimeMs);
  }
  if (entry.receivedAtMs != null && Number.isFinite(Number(entry.receivedAtMs))) {
    return Number(entry.receivedAtMs);
  }
  return Date.now();
}

/** מפתח לוגי לאותו אירוע פיקוד — מונע "בארי|בארי" בפיד כשאותה שורה נדחפת מדי poll */
function serverFeedLogicalDedupeKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const ts = resolveFeedEventTimestampMs(entry);
  const sec = Math.floor(Number(ts) / 1000);
  const cityRaw = String(entry.cityName || '').trim();
  const titleRaw = String(entry.title || '').trim();
  const city = (normalizeHebrewSettlementName(cityRaw) || cityRaw) || (normalizeHebrewSettlementName(titleRaw) || titleRaw);
  const phase = String(entry.alertPhase || '');
  const tag = String(entry.tag || '');
  const typ = String(entry.type || '');
  const isRel = phase === 'released' || tag.includes('האירוע הסתיים');
  if (isRel && city) {
    return `r|${city}|${sec}`;
  }
  if (isRel) {
    const head = `${typ}|${tag}|${titleRaw.slice(0, 48)}`;
    return `r0|${sec}|${head}`;
  }
  return `e|${city || titleRaw}|${phase}|${tag}|${typ}|${sec}`;
}

function findDuplicateClientFeedEntry(entry) {
  const want = serverFeedLogicalDedupeKey(entry);
  if (!want) return null;
  const list = state.clientEventFeed || [];
  const scan = Math.min(list.length, 250);
  for (let i = 0; i < scan; i++) {
    const row = list[i];
    if (row && serverFeedLogicalDedupeKey(row) === want) return row;
  }
  return null;
}

function appendServerFeedEntry(entry) {
  const dup = findDuplicateClientFeedEntry(entry);
  if (dup) {
    return dup;
  }
  const nextTimestampMs = resolveFeedEventTimestampMs(entry);
  clientEventFeedSeq += 1;
  const timestampMs = nextTimestampMs;
  const orefWall =
    entry.orefTimeMs != null && Number.isFinite(Number(entry.orefTimeMs))
      ? Number(entry.orefTimeMs)
      : undefined;
  const recv =
    entry.receivedAtMs != null && Number.isFinite(Number(entry.receivedAtMs))
      ? Number(entry.receivedAtMs)
      : undefined;
  const row = {
    id: `srvfeed-${timestampMs}-${clientEventFeedSeq}`,
    timestampMs,
    ...(orefWall !== undefined ? { orefTimeMs: orefWall } : {}),
    ...(recv !== undefined ? { receivedAtMs: recv } : {}),
    title: entry.title || 'אירוע',
    type: entry.type || 'intel',
    tag: entry.tag || 'עדכון',
    severity: entry.severity != null ? entry.severity : 0,
    zone: entry.zone || 'israel',
    source: 'oref',
    cityName: entry.cityName || '',
    alertPhase: entry.alertPhase || '',
    liveState: entry.liveState || '',
    threatType: entry.threatType || '',
  };
  if (String(row.alertPhase) === 'released') {
    row.type = 'defense';
  } else if (isActiveAlertPhase(row.alertPhase)) {
    row.type = 'attack';
  }
  state.clientEventFeed.unshift(row);
  state.clientEventFeed = finalizeClientEventFeedRows(state.clientEventFeed, Date.now());
  try {
    io.emit('feed_append', row);
  } catch (e) {
    /* ignore */
  }
  /* שמירה מיידית לדיסק — אותו עיקרון כמו בצ׳אט; מונע איבוד שורה אחרונה בכיבוי/פריסה מהירה */
  flushPersistClientEventFeedSync();
  return row;
}

function appendFeedFromNewAlertPayload(d) {
  if (!d) return;
  const phase = d.alertPhase || 'pre_alert';
  const orefWall =
    d.orefTimeMs != null && Number.isFinite(Number(d.orefTimeMs)) ? Number(d.orefTimeMs) : null;
  const recv =
    d.receivedAtMs != null && Number.isFinite(Number(d.receivedAtMs)) ? Number(d.receivedAtMs) : null;
  const ts = orefWall ?? recv ?? Date.now();
  const liveState =
    phase === 'siren_active'
      ? 'אזעקה פעילה'
      : phase === 'hold_after_siren'
        ? 'במרחב מוגן'
        : 'התראה מוקדמת';
  const sev = phase === 'siren_active' ? 4 : phase === 'hold_after_siren' ? 3 : 2;
  const tag = resolveOfficialOrefFeedTag(phase, d);
  appendServerFeedEntry({
    timestampMs: ts,
    ...(orefWall != null ? { orefTimeMs: orefWall } : {}),
    ...(recv != null ? { receivedAtMs: recv } : {}),
    title: d.cityName || 'התרעה',
    type: 'attack',
    tag,
    severity: sev,
    cityName: d.cityName || '',
    alertPhase: phase,
    liveState,
    threatType: d.threatType || '',
  });
}

function appendFeedFromAlertPhase(payload) {
  if (!payload || !payload.cityName) return;
  const phase = String(payload.alertPhase || '');
  const recv =
    payload.receivedAtMs != null && Number.isFinite(Number(payload.receivedAtMs))
      ? Number(payload.receivedAtMs)
      : undefined;
  if (phase === 'released') {
    const orefWall =
      payload.orefTimeMs != null && Number.isFinite(Number(payload.orefTimeMs))
        ? Number(payload.orefTimeMs)
        : null;
    const ts =
      orefWall ??
      (payload.timestampMs != null && Number.isFinite(Number(payload.timestampMs))
        ? Number(payload.timestampMs)
        : recv ?? Date.now());
    appendServerFeedEntry({
      timestampMs: ts,
      ...(orefWall != null ? { orefTimeMs: orefWall } : {}),
      ...(recv !== undefined ? { receivedAtMs: recv } : {}),
      title: payload.cityName,
      type: 'defense',
      tag: 'האירוע הסתיים',
      severity: 1,
      cityName: payload.cityName,
      alertPhase: 'released',
      liveState: 'שוחרר',
      threatType: payload.threatType || '',
    });
    return;
  }
  if (phase !== 'pre_alert' && phase !== 'siren_active' && phase !== 'hold_after_siren') return;

  const liveState =
    phase === 'siren_active'
      ? 'אזעקה פעילה'
      : phase === 'hold_after_siren'
        ? 'במרחב מוגן'
        : 'התראה מוקדמת';
  const tag = resolveOfficialOrefFeedTag(phase, payload);
  const wall =
    payload.timestampMs != null && Number.isFinite(Number(payload.timestampMs))
      ? Number(payload.timestampMs)
      : recv ?? Date.now();
  const sev = phase === 'siren_active' ? 4 : phase === 'hold_after_siren' ? 3 : 2;
  appendServerFeedEntry({
    timestampMs: wall,
    ...(recv !== undefined ? { receivedAtMs: recv } : {}),
    title: payload.cityName,
    type: 'attack',
    tag,
    severity: sev,
    cityName: payload.cityName,
    alertPhase: phase,
    liveState,
    threatType: payload.threatType || '',
  });
}

function orefClientFeedSnapshotSig(alert) {
  if (!alert || typeof alert !== 'object') return '';
  const phase = inferOrefAlertPhase(alert);
  const orefMs =
    alert.orefTimeMs != null && Number.isFinite(Number(alert.orefTimeMs)) ? Number(alert.orefTimeMs) : 0;
  const title = String(alert.title || '').trim().slice(0, 320);
  const gid = String(alert.orefAlertGroupId || alert.id || '');
  return `${phase}|${orefMs}|${title}|${gid}`;
}

function orefRecordClientFeedSnapshot(alert) {
  if (!alert?.cityName) return;
  const key = normalizeHebrewSettlementName(String(alert.cityName).trim()) || String(alert.cityName).trim();
  if (!key) return;
  const phase = inferOrefAlertPhase(alert);
  if (phase === 'released') {
    orefLastClientFeedSnapshotByCity.delete(key);
    return;
  }
  orefLastClientFeedSnapshotByCity.set(key, orefClientFeedSnapshotSig(alert));
}

/**
 * מזינים את פיד האירועים ישירות מכל רשומה ב-alerts.json (effectiveAlerts).
 * מתעדכן בכל poll; שורה חדשה רק כשהחתימה הרשמית (פאזה / זמן / כותרת / קבוצה) משתנה.
 */
function syncClientEventFeedFromOrefEffectiveAlerts(effectiveAlerts, releasedCityNames, now = Date.now()) {
  if (!Array.isArray(effectiveAlerts)) return;
  const released = releasedCityNames instanceof Set ? releasedCityNames : new Set();
  const seenKeys = new Set();
  for (const alert of effectiveAlerts) {
    if (!alert?.cityName) continue;
    const key = normalizeHebrewSettlementName(String(alert.cityName).trim()) || String(alert.cityName).trim();
    if (!key) continue;
    const tp = getTargetPosition(alert);
    if (!tp || !isPlausibleIsraelAlertTarget(Number(tp[0]), Number(tp[1]))) continue;
    seenKeys.add(key);
    const phase = inferOrefAlertPhase(alert);
    if (phase === 'released' || released.has(alert.cityName)) {
      orefLastClientFeedSnapshotByCity.delete(key);
      continue;
    }
    const sig = orefClientFeedSnapshotSig(alert);
    const prev = orefLastClientFeedSnapshotByCity.get(key);
    if (prev === sig) continue;
    const orefWall =
      alert.orefTimeMs != null && Number.isFinite(Number(alert.orefTimeMs)) ? Number(alert.orefTimeMs) : null;
    const payload = {
      cityName: alert.cityName,
      title: alert.title || 'התרעה',
      orefTextBlob: alert.orefTextBlob || '',
      threatType: alert.threatType || 'missile',
      alertPhase: phase,
      orefTimeMs: orefWall ?? now,
      receivedAtMs: now,
    };
    enrichPayloadWithOrefGuideline(alert, payload);
    appendFeedFromNewAlertPayload(payload);
    orefLastClientFeedSnapshotByCity.set(key, sig);
  }
  for (const k of orefLastClientFeedSnapshotByCity.keys()) {
    if (!seenKeys.has(k)) orefLastClientFeedSnapshotByCity.delete(k);
  }
}

function clampSummaryNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function inferSummaryNewsRegion(article) {
  const text = `${article?.titleHe || article?.title || ''} ${article?.description || ''}`.toLowerCase();
  if (!text) return null;
  if (/איראן|iran|טהראן|tehran/.test(text)) return 'iran';
  if (/לבנון|lebanon|חיזבאללה|hezbollah/.test(text)) return 'lebanon';
  if (/סוריה|syria|דמשק|damascus/.test(text)) return 'lebanon';
  if (/עזה|gaza|חמאס|hamas/.test(text)) return 'gaza';
  if (/עיראק|iraq/.test(text)) return 'iraq';
  if (/תימן|yemen|חותי|houthi/.test(text)) return 'yemen';
  if (/ישראל|israel|ירושלים|תל אביב|צהל|idf/.test(text)) return 'israel';
  return null;
}

function getSummaryArticleThreatWeight(article) {
  const text = `${article?.titleHe || article?.title || ''} ${article?.description || ''}`.toLowerCase();
  let weight = 0.2;
  if (/טיל|טילים|missile|rocket|רקט/.test(text)) weight += 0.8;
  if (/שיגור|שיגורים|launch|salvo|מטח/.test(text)) weight += 0.7;
  if (/כטב"ם|חדירת כלי טיס|uav|drone/.test(text)) weight += 0.7;
  if (/יירוט|intercept/.test(text)) weight += 0.45;
  if (/אזעקה|התרעה|warning|siren/.test(text)) weight += 0.4;
  if (/תקיפה|attack|strike|פגיעה|explosion|blast/.test(text)) weight += 0.55;
  return clampSummaryNumber(weight, 0.2, 2.4);
}

function inferSummaryFlightRegion(flight) {
  const lat = Number(flight?.latitude);
  const lng = Number(flight?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat >= 32 && lat <= 37 && lng >= 34 && lng <= 37) return 'lebanon';
  if (lat >= 31 && lat <= 37 && lng > 37 && lng <= 42) return 'lebanon';
  if (lat >= 24 && lat <= 33 && lng >= 43 && lng <= 49) return 'iraq';
  // DISABLED: Iran missiles disabled per user request
  // if (lat >= 24 && lat <= 40 && lng > 49 && lng <= 64) return 'iran';
  if (lat >= 24 && lat <= 40 && lng > 49 && lng <= 64) return 'lebanon'; // Fallback to Lebanon
  if (lat >= 12 && lat <= 19 && lng >= 41 && lng <= 55) return 'yemen';
  if (lat >= 30 && lat <= 33 && lng >= 34 && lng <= 35.7) return 'gaza';
  if (lat >= 29 && lat <= 34.8 && lng >= 34 && lng <= 35.9) return 'israel';
  return null;
}

function formatSummaryWindowTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jerusalem',
  });
}

function getRecentNewsWindow(windowMs = AI_SUMMARY_WINDOW_MS) {
  const now = Date.now();
  return getNews(200).filter((article) => {
    const pub = article?.pubDate ? new Date(article.pubDate).getTime() : NaN;
    return Number.isFinite(pub) && now - pub <= windowMs;
  });
}

function getRecentNewsStoreArticles(windowMs = AI_SUMMARY_WINDOW_MS, limit = 600) {
  const now = Date.now();
  const rows = Array.isArray(newsStore?.articles) ? newsStore.articles : [];
  return rows
    .filter((article) => {
      const raw = article?.pubDate ?? article?.publishedAt ?? article?.ingestedAtMs ?? null;
      const ts =
        typeof raw === 'number'
          ? raw
          : raw instanceof Date
            ? raw.getTime()
            : raw
              ? new Date(raw).getTime()
              : NaN;
      return Number.isFinite(ts) && now - ts <= windowMs;
    })
    .sort((a, b) => {
      const at = a?.pubDate ? new Date(a.pubDate).getTime() : (Number(a?.ingestedAtMs) || 0);
      const bt = b?.pubDate ? new Date(b.pubDate).getTime() : (Number(b?.ingestedAtMs) || 0);
      return bt - at;
    })
    .slice(0, limit);
}

function getRecentFeedWindow(windowMs = AI_SUMMARY_WINDOW_MS) {
  const now = Date.now();
  return (state.clientEventFeed || []).filter((row) => Number.isFinite(Number(row?.timestampMs)) && now - Number(row.timestampMs) <= windowMs);
}

function getSourceConfidenceScore(confidence) {
  if (confidence === 'official') return 0.96;
  if (confidence === 'corroborated') return 0.78;
  if (confidence === 'telegram_ai') return 0.74;
  return 0.52;
}

function buildAiSummaryContext(windowMs = AI_SUMMARY_WINDOW_MS) {
  const now = Date.now();
  const activeMissiles = Array.isArray(state.activeMissiles) ? state.activeMissiles : [];
  const activeAlerts = Array.isArray(state.activeAlerts) ? state.activeAlerts : [];
  const activeCities = [...new Set(activeAlerts.map((a) => a && a.cityName).filter(Boolean))];
  const recentFeed = getRecentFeedWindow(windowMs);
  const newsArticles = getRecentNewsWindow(windowMs);
  const flights = Array.isArray(state.flights) ? state.flights : [];
  const seismicEvents = Array.isArray(state.seismic) ? state.seismic : [];
  const fires = Array.isArray(state.fires) ? state.fires : [];
  const ships = Array.isArray(state.ships) ? state.ships : [];
  return {
    generatedAt: new Date(now).toISOString(),
    windowMinutes: Math.round(windowMs / 60000),
    activeMissiles,
    activeAlerts,
    activeCities,
    recentFeed,
    newsArticles,
    flights,
    seismicEvents,
    fires,
    ships,
    markets: state.markets || {},
  };
}

function buildAiPromptFromContext(context, baseSummary) {
  const topFeed = (context.recentFeed || [])
    .slice(0, 12)
    .map((row) => `${formatSummaryWindowTime(row.timestampMs)} | ${row.title} | ${row.tag} | ${row.liveState || ''}`)
    .join('\n');
  const topNews = (context.newsArticles || [])
    .slice(0, 12)
    .map((article) => {
      const ts = article?.pubDate ? formatSummaryWindowTime(article.pubDate) : '';
      const source = article?.sourceLabel || article?.source || '';
      const title = article?.titleHe || article?.title || '';
      return `${ts} | ${source} | ${title}`;
    })
    .join('\n');
  const topFlights = (context.flights || [])
    .slice(0, 15)
    .map((flight) => {
      const region = inferSummaryFlightRegion(flight) || 'unknown';
      return `${flight.callsign || flight.icao24 || 'flight'} | ${region} | ${Math.round(Number(flight.latitude) || 0)},${Math.round(Number(flight.longitude) || 0)} | alt ${Math.round(Number(flight.baro_altitude) || 0)}`;
    })
    .join('\n');
  const markets = context.markets || {};
  const marketLine = [
    `VIX=${markets?.vix?.value || markets?.vix?.price || 'n/a'}`,
    `SP500=${markets?.sp500?.value || markets?.sp500?.price || 'n/a'} (${markets?.sp500?.changePercent || 'n/a'}%)`,
    `NASDAQ=${markets?.nasdaq?.value || markets?.nasdaq?.price || 'n/a'} (${markets?.nasdaq?.changePercent || 'n/a'}%)`,
    `BTC=${markets?.btc?.value || markets?.btc?.price || 'n/a'} (${markets?.btc?.changePercent || 'n/a'}%)`,
    `ETH=${markets?.eth?.value || markets?.eth?.price || 'n/a'} (${markets?.eth?.changePercent || 'n/a'}%)`,
  ].join(' | ');
  return [
    'אתה מסכם מודיעיני-אזרחי עבור דשבורד מלחמה אזורי.',
    'כתוב בעברית בלבד.',
    'הסיכום חייב להתבסס רק על נתוני 30 הדקות האחרונות שסופקו כאן.',
    'אל תכתוב שאין נתונים אם כן יש נתונים.',
    'אם אין איום חי, עדיין סכם את תמונת המצב מהחדשות, השווקים, הטיסות, פיד האירועים, השריפות, הסייסמיקה וכלי השיט.',
    'החזר JSON תקין בלבד עם השדות: headline, body, status.',
    'headline קצר עד 90 תווים. body מפורט אבל תמציתי, 2-4 משפטים. status אחד מהבאים בלבד: idle, watch, hot, hold, clear.',
    '',
    `חלון זמן: ${context.windowMinutes} דקות אחרונות`,
    `סיכום בסיס מקומי: ${baseSummary.headline} || ${baseSummary.body}`,
    `איומים חיים: ${context.activeMissiles.length} | התראות פעילות: ${context.activeAlerts.length} | ערים פעילות: ${context.activeCities.join(', ') || 'אין'}`,
    `שווקים: ${marketLine}`,
    `טיסות פעילות: ${context.flights.length}`,
    `סייסמיקה: ${context.seismicEvents.length} | שריפות: ${context.fires.length} | כלי שיט: ${context.ships.length}`,
    '',
    'פיד אירועים אחרון:',
    topFeed || 'אין',
    '',
    'כתבות אחרונות:',
    topNews || 'אין',
    '',
    'טיסות אחרונות:',
    topFlights || 'אין',
  ].join('\n');
}

async function tryGenerateModelAiSummary(context, baseSummary) {
  if (!OPENAI_API_KEY) return null;
  const prompt = buildAiPromptFromContext(context, baseSummary);
  const response = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: OPENAI_MODEL,
      input: prompt,
      max_output_tokens: 300,
      text: { format: { type: 'json_object' } },
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const text =
    response?.data?.output_text ||
    response?.data?.output?.map((part) => part?.content?.map((c) => c?.text || '').join('')).join('') ||
    '';
  if (!text) return null;
  const parsed = JSON.parse(text);
  const headline = String(parsed?.headline || '').trim();
  const body = String(parsed?.body || '').trim();
  const status = String(parsed?.status || '').trim();
  if (!headline || !body) return null;
  return {
    ...baseSummary,
    headline,
    body,
    status: ['idle', 'watch', 'hot', 'hold', 'clear'].includes(status) ? status : baseSummary.status,
    generatedAt: new Date().toISOString(),
    generatedBy: 'openai',
  };
}

function buildAiSummary() {
  const context = buildAiSummaryContext(AI_SUMMARY_WINDOW_MS);
  const activeMissiles = context.activeMissiles;
  const activeAlerts = context.activeAlerts;
  const activeCities = context.activeCities;
  const recentFeed = context.recentFeed.slice(0, 20);
  const newsArticles = context.newsArticles;
  const topRegions = {};
  const newsRegionPressure = {};
  const flightRegionCounts = {};
  const flights = context.flights;
  const seismicEvents = context.seismicEvents;
  const fires = context.fires;
  const ships = context.ships;
  let missileCount = 0;
  let uavCount = 0;
  let official = 0;
  let corroborated = 0;
  let estimated = 0;

  activeMissiles.forEach((row) => {
    const count = Math.max(1, Number(row?.mergedTargetCount) || 1);
    const region = row?.sourceRegion || 'unknown';
    topRegions[region] = (topRegions[region] || 0) + count;
    if (row?.threatType === 'uav') uavCount += count;
    else missileCount += count;
    if (row?.sourceConfidence === 'official') official += count;
    else if (row?.sourceConfidence === 'corroborated') corroborated += count;
    else estimated += count;
  });

  const regionLine = Object.entries(topRegions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([region, count]) => `${getSourceRegionLabel(region)} ×${count}`)
    .join(' · ');

  const sirenCount = activeAlerts.filter((row) => row?.alertPhase === 'siren_active').length;
  const holdCount = activeAlerts.filter((row) => row?.alertPhase === 'hold_after_siren').length;
  const earlyCount = activeAlerts.filter((row) => row?.alertPhase === 'pre_alert').length;
  const releaseCount = recentFeed.filter((row) => String(row?.tag || '').includes('האירוע הסתיים')).length;
  const hotNewsCount = newsArticles.filter((article) => {
    const text = `${article?.titleHe || article?.title || ''} ${article?.description || ''}`;
    return /טיל|טילים|שיגור|שיגורים|כטב"ם|חדירת כלי טיס|יירוט|אזעקה|התרעה|איראן|לבנון|סוריה|עיראק|תימן|עזה/i.test(text);
  }).length;
  newsArticles.forEach((article) => {
    const region = inferSummaryNewsRegion(article);
    if (!region) return;
    newsRegionPressure[region] = (newsRegionPressure[region] || 0) + getSummaryArticleThreatWeight(article);
  });
  flights.forEach((flight) => {
    const region = inferSummaryFlightRegion(flight);
    if (!region) return;
    flightRegionCounts[region] = (flightRegionCounts[region] || 0) + 1;
  });
  const vix = Number(state.markets?.vix?.value || state.markets?.vix?.price || 0);
  const sp500Chg = Number(state.markets?.sp500?.changePercent || 0);
  const nasdaqChg = Number(state.markets?.nasdaq?.changePercent || 0);
  const btcChg = Number(state.markets?.btc?.changePercent || 0);
  const ethChg = Number(state.markets?.eth?.changePercent || 0);
  const marketPressure =
    clampSummaryNumber((vix - 18) * 0.08, 0, 2.8) +
    clampSummaryNumber(-sp500Chg * 0.22, 0, 1.8) +
    clampSummaryNumber(-nasdaqChg * 0.18, 0, 1.6) +
    clampSummaryNumber(-btcChg * 0.1, 0, 1.1) +
    clampSummaryNumber(-ethChg * 0.08, 0, 0.9);
  const flightPressure = Array.isArray(state.flights) && state.flights.length < 10 ? 'דלילות טיסות אזורית' : '';
  const topNewsRegions = Object.entries(newsRegionPressure)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([region, weight]) => `${region === 'israel' ? 'ישראל' : getSourceRegionLabel(region)} (${weight.toFixed(1)})`)
    .join(' · ');
  const lowFlightRegions = Object.entries(flightRegionCounts)
    .filter(([region, count]) => region !== 'israel' && count <= 3)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([region]) => getSourceRegionLabel(region))
    .join(' · ');
  const topReleaseCities = recentFeed
    .filter((row) => row?.alertPhase === 'released' && row?.cityName)
    .slice(0, 4)
    .map((row) => row.cityName)
    .join(' · ');
  const topHoldCities = activeAlerts
    .filter((row) => row?.alertPhase === 'hold_after_siren' && row?.cityName)
    .slice(0, 4)
    .map((row) => row.cityName)
    .join(' · ');
  const topSirenCities = activeAlerts
    .filter((row) => row?.alertPhase === 'siren_active' && row?.cityName)
    .slice(0, 4)
    .map((row) => row.cityName)
    .join(' · ');
  const contextBits = [];
  if (topNewsRegions) contextBits.push(`מוקדי כיסוי עיקריים: ${topNewsRegions}`);
  if (marketPressure > 0.35) contextBits.push(`לחץ שווקים משוקלל: ${marketPressure.toFixed(1)}`);
  if (lowFlightRegions) contextBits.push(`דלילות טיסות מעל: ${lowFlightRegions}`);
  if (seismicEvents.length > 0) contextBits.push(`אירועים סייסמיים אחרונים: ${Math.min(seismicEvents.length, 20)}`);
  if (fires.length > 0) contextBits.push(`מוקדי אש/חום: ${fires.length}`);
  if (ships.length > 0) contextBits.push(`תנועת כלי שיט במעקב: ${ships.length}`);

  let headline = 'אין סיכום AI חי זמין כרגע.';
  let body =
    'המערכת עוקבת אחר הזירה בזמן אמת. אם ייקלטו אירועים חיים הם יוצגו כאן באופן אחוד. רצוי להמשיך במעקב.';
  let status = 'idle';

  if (activeAlerts.length > 0 || activeMissiles.length > 0) {
    headline =
      sirenCount > 0
        ? `התראות פעילות ב־${activeCities.length} יישובים`
        : holdCount > 0
          ? `אירוע נמשך: שהייה במרחב מוגן ב־${activeCities.length} יישובים`
          : `התראה מוקדמת ב־${activeCities.length} יישובים`;
    body =
      `כעת מזוהים ${missileCount} מסלולי טיל ו־${uavCount} מסלולי כטב"ם. ` +
      (regionLine ? `מקורות מסלול מובילים: ${regionLine}. ` : '') +
      (topSirenCities ? `אזעקות פעילות כעת: ${topSirenCities}. ` : '') +
      (topHoldCities ? `הישארו במרחב מוגן: ${topHoldCities}. ` : '') +
      `ודאות מקור: רשמי ${official}, מאומת ${corroborated}, משוער ${estimated}. ` +
      (flightPressure ? `${flightPressure}. ` : '') +
      (hotNewsCount > 0 ? `יש ${hotNewsCount} כתבות איום רלוונטיות התומכות בתמונת המצב. ` : '') +
      (contextBits.length ? `${contextBits.join('. ')}.` : '');
    status = sirenCount > 0 ? 'hot' : holdCount > 0 ? 'hold' : 'watch';
  } else if (releaseCount > 0) {
    headline = 'האירועים האחרונים שוחררו';
    body =
      `פיקוד העורף סימן ${releaseCount} שחרורים אחרונים בפיד. ` +
      (topReleaseCities ? `היישובים האחרונים ששוחררו: ${topReleaseCities}. ` : '') +
      `אין כרגע מסלולי איום חיים על המפה, והשוהים במרחב המוגן יכולים לצאת בהתאם להנחיות המעודכנות. ` +
      (contextBits.length ? `${contextBits.join('. ')}.` : '');
    status = 'clear';
  } else if (hotNewsCount > 0 || marketPressure > 0.5) {
    headline = 'הזירה במתח גם ללא איום חי פעיל';
    body =
      `נרשמות ${hotNewsCount} כתבות רלוונטיות בזירה. ` +
      (marketPressure > 0.5 ? `לחץ שוק משוקלל: ${marketPressure.toFixed(1)}. ` : '') +
      (topNewsRegions ? `מוקדי עניין מובילים: ${topNewsRegions}. ` : '') +
      (lowFlightRegions ? `דלילות טיסות ניכרת: ${lowFlightRegions}. ` : '') +
      'כרגע אין התראת פיקוד העורף פעילה על המפה.';
    status = 'watch';
  }

  return {
    headline,
    body,
    status,
    generatedAt: new Date().toISOString(),
    generatedBy: 'local',
    counts: {
      activeAlerts: activeAlerts.length,
      activeMissiles: activeMissiles.length,
      activeCities: activeCities.length,
      sirenCount,
      holdCount,
      earlyCount,
      releaseCount,
      missileCount,
      uavCount,
      hotNewsCount,
    },
  };
}

function refreshAiSummary(options = {}) {
  const now = Date.now();
  if (options.force !== true && now - aiSummaryLastRefreshAt < AI_SUMMARY_MIN_REFRESH_MS) {
    return state.aiSummary;
  }
  aiSummaryLastRefreshAt = now;
  const nextSummary = buildAiSummary();
  const hasExistingSummary =
    state.aiSummary &&
    String(state.aiSummary.headline || '').trim() &&
    String(state.aiSummary.headline || '').trim() !== 'אין סיכום AI חי זמין כרגע.';
  const shouldPreserveLastSummary =
    nextSummary &&
    nextSummary.status === 'idle' &&
    hasExistingSummary &&
    options.force !== true;
  state.aiSummary = shouldPreserveLastSummary
    ? { generatedBy: state.aiSummary?.generatedBy || 'local', ...state.aiSummary }
    : nextSummary;
  if (options.emit !== false) {
    try {
      io.emit('summary_update', state.aiSummary);
    } catch (e) {
      /* ignore */
    }
  }
  if (OPENAI_API_KEY && !aiSummaryRefreshInFlight) {
    const context = buildAiSummaryContext(AI_SUMMARY_WINDOW_MS);
    aiSummaryRefreshInFlight = tryGenerateModelAiSummary(context, state.aiSummary)
      .then((modelSummary) => {
        if (!modelSummary) return;
        state.aiSummary = modelSummary;
        if (options.emit !== false) {
          try {
            io.emit('summary_update', state.aiSummary);
          } catch (e) {
            /* ignore */
          }
        }
      })
      .catch((err) => {
        console.warn('[AI Summary] model generation failed:', err.message);
      })
      .finally(() => {
        aiSummaryRefreshInFlight = null;
      });
  }
  return state.aiSummary;
}

function canAdvanceLifecycleForCity(cityName) {
  if (!cityName) return false;
  if (!activeAlertsCache.includes(cityName)) return false;
  const detail = activeAlertDetailsByCity.get(cityName);
  return detail?.alertPhase !== 'released';
}

function feedRowSortKeyMs(row) {
  if (!row) return 0;
  const o = row.orefTimeMs != null && Number.isFinite(Number(row.orefTimeMs)) ? Number(row.orefTimeMs) : null;
  const t = row.timestampMs != null && Number.isFinite(Number(row.timestampMs)) ? Number(row.timestampMs) : 0;
  return o != null ? o : t;
}

function buildClientFacingOrefFeedRows(rawRows) {
  return (Array.isArray(rawRows) ? rawRows : [])
    .filter((row) => String(row?.source || '') === 'oref')
    .map(normalizeDashboardFeedRow)
    .sort((a, b) => feedRowSortKeyMs(b) - feedRowSortKeyMs(a));
}

/**
 * בלוקים מעמוד היסטוריית פיקוד → שורות פיד (לכל יישוב בכל רשומת זמן).
 */
function buildFeedRowsFromOrefHistoryBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const out = [];
  let seq = 0;
  for (const block of blocks) {
    if (!block || !block.phase || !Number.isFinite(Number(block.timestampMs))) continue;
    const cities = Array.isArray(block.cityNames) ? block.cityNames : [];
    const ts = Number(block.timestampMs);
    const pseudo = {
      title: block.title || '',
      orefTextBlob: [block.title || '', ...(Array.isArray(block.lines) ? block.lines : [])].join(' '),
    };
    for (const cityName of cities) {
      if (!cityName || String(cityName).trim().length < 2) continue;
      const coords = getReliableCityCoordinates(cityName);
      if (!coords || !isPlausibleIsraelAlertTarget(coords.lng, coords.lat)) continue;
      const phase = String(block.phase);
      const tag = resolveOfficialOrefFeedTag(phase, pseudo);
      seq += 1;
      if (phase === 'released') {
        out.push({
          id: `orefHist-${ts}-${seq}`,
          timestampMs: ts,
          orefTimeMs: ts,
          title: cityName,
          type: 'defense',
          tag,
          severity: 1,
          zone: 'israel',
          source: 'oref',
          cityName,
          alertPhase: 'released',
          liveState: 'שוחרר',
          threatType: 'missile',
        });
        continue;
      }
      const liveState =
        phase === 'siren_active'
          ? 'אזעקה פעילה'
          : phase === 'hold_after_siren'
            ? 'במרחב מוגן'
            : 'התראה מוקדמת';
      const sev = phase === 'siren_active' ? 4 : phase === 'hold_after_siren' ? 3 : 2;
      out.push({
        id: `orefHist-${ts}-${seq}`,
        timestampMs: ts,
        orefTimeMs: ts,
        title: cityName,
        type: 'attack',
        tag,
        severity: sev,
        zone: 'israel',
        source: 'oref',
        cityName,
        alertPhase: phase,
        liveState,
        threatType: 'missile',
      });
    }
  }
  return out;
}

let lastOrefHistoryFeedSig = '';

function mergeOrefHistoryIntoClientFeed(historyRows) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) return;
  const byKey = new Map();
  const put = (row) => {
    if (!row || typeof row !== 'object') return;
    const k = serverFeedLogicalDedupeKey(row);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, row);
  };
  for (const r of state.clientEventFeed || []) put(r);
  for (const r of historyRows) put(r);
  const merged = Array.from(byKey.values()).sort((a, b) => feedRowSortKeyMs(b) - feedRowSortKeyMs(a));
  const capped = finalizeClientEventFeedRows(merged, Date.now());
  const sig = capped
    .slice(0, 48)
    .map((r) => serverFeedLogicalDedupeKey(r))
    .join('\n');
  state.clientEventFeed = capped;
  flushPersistClientEventFeedSync();
  if (sig !== lastOrefHistoryFeedSig) {
    lastOrefHistoryFeedSig = sig;
    try {
      io.emit('feed_bootstrap', buildClientFacingOrefFeedRows(state.clientEventFeed));
    } catch (e) {
      /* ignore */
    }
  }
}

function sanitizeDashboardFeedRows(rows) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeDashboardFeedRow)
    .filter(Boolean)
    .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

  /** היסטורית סוננו התראות מוקדמות כדי לרדץ כפילויות; כותרת רשמית מלאה מוצגת בפיד */
  const noisyPhaseTags = new Set(['הישארו במרחב המוגן']);
  const phaseFilteredRows = normalizedRows.filter((row) => {
    if (row?.alertPhase === 'released') return true;
    return !noisyPhaseTags.has(String(row?.tag || '').trim());
  });

  const latestReleaseByCity = new Map();
  for (const row of phaseFilteredRows) {
    if (row?.cityName && row.alertPhase === 'released' && !latestReleaseByCity.has(row.cityName)) {
      latestReleaseByCity.set(row.cityName, row.timestampMs || 0);
    }
  }

  const FEED_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
  const latestSeenByKey = new Map();
  return phaseFilteredRows.filter((row) => {
    if (!row?.cityName) return true;
    const dedupeKey = `${row.cityName}::${row.alertPhase || ''}::${row.tag || ''}`;
    const rowTs = row.timestampMs || 0;
    const latestSeenTs = latestSeenByKey.get(dedupeKey);
    if (latestSeenTs != null && Math.abs(latestSeenTs - rowTs) <= FEED_DEDUPE_WINDOW_MS) {
      return false;
    }
    latestSeenByKey.set(dedupeKey, rowTs);
    if (row.alertPhase === 'released') return true;
    const releaseTs = latestReleaseByCity.get(row.cityName);
    if (!releaseTs) return true;
    const staleAfterRelease =
      row.alertPhase &&
      row.alertPhase !== 'released' &&
      rowTs >= releaseTs &&
      rowTs - releaseTs <= 2 * 60 * 1000;
    return !staleAfterRelease;
  });
}

function buildFallbackActiveAlertsFromFeed(rows) {
  const sanitized = sanitizeDashboardFeedRows(rows);
  const latestByCity = new Map();
  const maxActiveAgeMs = OREF_ALERT_HOLD_MS + 2 * 60 * 1000;
  const now = Date.now();
  for (const row of sanitized) {
    if (!row?.cityName) continue;
    const cityName = String(row.cityName).trim();
    if (!cityName || latestByCity.has(cityName)) continue;
    latestByCity.set(cityName, row);
  }

  const out = [];
  latestByCity.forEach((row, cityName) => {
    if (!isActiveAlertPhase(row.alertPhase)) return;
    const rowTs = Number(row.timestampMs || row.updatedAt || row.orefTimeMs || 0);
    if (!Number.isFinite(rowTs) || rowTs <= 0) return;
    if (now - rowTs > maxActiveAgeMs) return;
    const existing = activeAlertDetailsByCity.get(cityName);
    const cityCoords = getReliableCityCoordinates(cityName);
    const coords =
      (existing && existing.coordinates) ||
      (cityCoords ? [cityCoords.lng, cityCoords.lat] : null);
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [lng, lat] = normalizeLngLat(coords);
    if (!isPlausibleIsraelAlertTarget(lng, lat)) return;
    const fallbackAxis =
      (isTrustedSourceConfidence(existing?.sourceConfidence) ? existing?.sourceRegion : null) ||
      null;
    const pseudoAlert = {
      cityName,
      title: row.title || row.tag || existing?.title || 'התראה פעילה',
      threatType: existing?.threatType || row.threatType || 'missile',
      sourceAxisHint: fallbackAxis,
      sourceAxisConfidence:
        fallbackAxis && isTrustedSourceConfidence(existing?.sourceConfidence)
          ? existing?.sourceConfidence
          : null,
      sourceAxisConfidenceScore:
        fallbackAxis &&
        isTrustedSourceConfidence(existing?.sourceConfidence) &&
        existing?.sourceConfidenceScore != null
          ? existing.sourceConfidenceScore
          : null,
    };
    const targetPosition = [lng, lat];
    const sourcePosition = resolveSourcePosition(pseudoAlert, targetPosition);
    const resolvedSourceRegion = resolveSourceRegionFromAlert(pseudoAlert, sourcePosition, targetPosition);
    out.push({
      cityName,
      coordinates: targetPosition,
      title:
        row.tag === 'הישארו במרחב המוגן'
          ? 'הישארו במרחב המוגן'
          : row.tag === 'אזעקה פעילה'
            ? 'אזעקה פעילה'
            : existing?.title || row.tag || 'התראה פעילה',
      threatType: existing?.threatType || row.threatType || 'missile',
      alertPhase: row.alertPhase,
      liveState: row.liveState || '',
      sourceRegion: resolvedSourceRegion,
      sourceLocation: existing?.sourceLocation || getSourceRegionLabel(resolvedSourceRegion),
      sourceConfidence: existing?.sourceConfidence || 'estimated',
      sourceConfidenceScore: existing?.sourceConfidenceScore ?? 0.32,
      flightMs: existing?.flightMs || 45000,
      displayFlightMs: existing?.displayFlightMs || 22000,
      displayElapsedMs: Math.max(
        existing?.displayElapsedMs || 18000,
        row.alertPhase === 'hold_after_siren' ? 20000 : 0
      ),
      orefTimeMs: existing?.orefTimeMs || row.timestampMs || Date.now(),
      updatedAt: existing?.updatedAt || row.timestampMs || Date.now(),
      timestamp: existing?.timestamp || row.timestampMs || Date.now(),
    });
  });
  return out.sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0));
}

function getFeedHeldActiveCities(rows, now = Date.now()) {
  const fallbackAlerts = buildFallbackActiveAlertsFromFeed(rows);
  const maxActiveAgeMs = OREF_ALERT_HOLD_MS + 2 * 60 * 1000;
  return fallbackAlerts
    .filter((row) => {
      const rowTs = Number(row.updatedAt || row.timestamp || row.orefTimeMs || 0);
      return Number.isFinite(rowTs) && rowTs > 0 && now - rowTs <= maxActiveAgeMs;
    })
    .map((row) => String(row.cityName || '').trim())
    .filter(Boolean);
}

function getLatestFeedRowByCity(rows) {
  const latestByCity = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row?.cityName) return;
    const cityName = String(row.cityName).trim();
    if (!cityName || latestByCity.has(cityName)) return;
    latestByCity.set(cityName, row);
  });
  return latestByCity;
}

function filterActiveRowsByLatestFeed(rows, latestFeedByCity) {
  const now = Date.now();
  const maxActiveAgeMs = OREF_ALERT_HOLD_MS + 2 * 60 * 1000;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const cityName = row?.cityName ? String(row.cityName).trim() : '';
    if (!cityName) return true;
    const latestRow = latestFeedByCity.get(cityName);
    if (!latestRow) return true;
    if (!isActiveAlertPhase(latestRow.alertPhase)) return false;
    const latestTs = Number(latestRow.timestampMs || latestRow.updatedAt || latestRow.orefTimeMs || 0);
    if (!Number.isFinite(latestTs) || latestTs <= 0) return false;
    return now - latestTs <= maxActiveAgeMs;
  });
}

function decodeBasicHtmlEntities(raw) {
  return String(raw || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractTextLinesFromHtml(html) {
  const cleaned = decodeBasicHtmlEntities(String(html || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/section|\/article|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleaned
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseHistoryClockToTimestamp(clockText, now = Date.now()) {
  const m = String(clockText || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hours, minutes, 0, 0);
  let ts = d.getTime();
  if (ts - now > 60 * 60 * 1000) {
    ts -= 24 * 60 * 60 * 1000;
  }
  return ts;
}

function looksLikeInstructionLine(line) {
  const text = String(line || '').trim();
  if (!text) return true;
  return (
    text.includes('היכנסו למרחב המוגן') ||
    text.includes('היכנסו למרחב מוגן') ||
    text.includes('יש לפעול בהתאם להנחיות') ||
    text.includes('לרשימת כל') ||
    text.includes('להנחיות מצילות חיים') ||
    text === 'התרעות' ||
    text === 'כל ההתרעות'
  );
}

function splitHistoryCities(line) {
  return String(line || '')
    .split(/[,|•·]+/)
    .map((part) => normalizeHebrewSettlementName(String(part || '').trim()))
    .filter((name) => name && /[\u0590-\u05FF]/.test(name));
}

function inferHistoryBlockPhase(block) {
  const text = [block.title, ...(block.lines || [])].join(' | ');
  const g = classifyOrefGuidelinePhase(text);
  return g.phase || '';
}

function logOrefGuidelineMatch(cityName, guidelineResult) {
  if (process.env.OREF_GUIDELINE_LOG !== '1' || !guidelineResult?.matchedPhrase) return;
  const city = cityName && String(cityName).trim() ? String(cityName).trim() : '?';
  console.log(
    `[OrefGuideline] ${city} -> ${guidelineResult.phase || '?'} ("${guidelineResult.matchedPhrase}")`
  );
}

function enrichPayloadWithOrefGuideline(alert, payload) {
  if (!alert || !payload || payload.telegramEarly === true) return payload;
  const g = classifyOrefGuidelinePhase(buildOrefGuidelineFullText(alert));
  if (g.matchedPhrase) {
    payload.orefGuidelineMatch = g.matchedPhrase;
    payload.orefGuidelinePhase = g.phase;
  }
  return payload;
}

function parseOrefHistoryHtml(html, now = Date.now()) {
  const lines = extractTextLinesFromHtml(html);
  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || !current.timeText) return;
    const phase = inferHistoryBlockPhase(current);
    if (!phase) return;
    const timestampMs = parseHistoryClockToTimestamp(current.timeText, now);
    if (!timestampMs || now - timestampMs > OREF_HISTORY_WINDOW_MS) return;
    const cityNames = [];
    for (const line of current.lines) {
      if (looksLikeInstructionLine(line)) continue;
      const parsedCities = splitHistoryCities(line);
      parsedCities.forEach((city) => {
        if (!cityNames.includes(city)) cityNames.push(city);
      });
    }
    if (cityNames.length === 0 && current.title && !looksLikeInstructionLine(current.title)) {
      splitHistoryCities(current.title).forEach((city) => {
        if (!cityNames.includes(city)) cityNames.push(city);
      });
    }
    if (cityNames.length === 0) return;
    blocks.push({
      timestampMs,
      phase,
      title: current.title || '',
      cityNames,
    });
  };

  for (const line of lines) {
    const timeMatch = line.match(/(?:\d{2}\.\d{2}\.\d{2}\s*[•·]?\s*)?(\d{1,2}:\d{2})/);
    if (timeMatch) {
      pushCurrent();
      current = { timeText: timeMatch[1], title: '', lines: [] };
      continue;
    }
    if (!current) continue;
    if (!current.title && !looksLikeInstructionLine(line)) {
      current.title = line;
    } else {
      current.lines.push(line);
    }
  }
  pushCurrent();

  const latestByCity = new Map();
  for (const block of blocks.sort((a, b) => b.timestampMs - a.timestampMs)) {
    block.cityNames.forEach((cityName) => {
      if (!cityName || latestByCity.has(cityName)) return;
      latestByCity.set(cityName, {
        cityName,
        timestampMs: block.timestampMs,
        alertPhase: block.phase,
        title: block.title,
      });
    });
  }

  const activeCities = new Set();
  const releasedCities = new Set();
  latestByCity.forEach((entry, cityName) => {
    if (entry.alertPhase === 'released') releasedCities.add(cityName);
    if (isActiveAlertPhase(entry.alertPhase)) activeCities.add(cityName);
  });

  const blocksSnapshot = blocks.slice().sort((a, b) => b.timestampMs - a.timestampMs);

  return { fetchedAt: now, latestByCity, activeCities, releasedCities, blocks: blocksSnapshot };
}

function inferOrefHistoryPhaseFromAjaxEntry(entry) {
  const category = Number(entry?.category);
  const desc = String(entry?.category_desc || '').trim();
  if (category === 13 || desc.includes('האירוע הסתיים') || desc.includes('שחרור') || desc.includes('יכולים לצאת')) {
    return 'released';
  }
  if (desc.includes('הישארו במרחב המוגן')) return 'hold_after_siren';
  if (desc.includes('בדקות הקרובות') || desc.includes('התראה מוקדמת')) return 'pre_alert';
  return 'siren_active';
}

function parseOrefHistoryAjaxJson(rawText, now = Date.now()) {
  let arr;
  try {
    arr = JSON.parse(String(rawText || '[]'));
  } catch (e) {
    arr = [];
  }
  if (!Array.isArray(arr)) arr = [];
  const normalized = arr
    .map((entry) => {
      const cityRaw = String(entry?.data || '').trim();
      const cityBase = cityRaw ? normalizeHebrewSettlementName(cityRaw) || cityRaw : '';
      const cityName = cityBase ? resolveCanonicalOrefSettlementName(cityBase) || cityBase : '';
      const ts = Date.parse(String(entry?.alertDate || ''));
      const phase = inferOrefHistoryPhaseFromAjaxEntry(entry);
      const title = String(entry?.category_desc || '').trim();
      return {
        cityName,
        timestampMs: Number.isFinite(ts) ? ts : null,
        phase,
        title,
      };
    })
    .filter((x) => x.cityName && Number.isFinite(x.timestampMs))
    .sort((a, b) => b.timestampMs - a.timestampMs);

  const blocks = normalized.map((x) => ({
    timestampMs: x.timestampMs,
    phase: x.phase,
    title: x.title || x.cityName,
    cityNames: [x.cityName],
    lines: [x.title || x.cityName],
  }));

  const latestByCity = new Map();
  // נתוני היסטוריה מיועדים לפיד בלבד — לא מסיקים מהם מצב איומים חיים למפה.
  const activeCities = new Set();
  const releasedCities = new Set();
  for (const entry of normalized) {
    const cityName = entry.cityName;
    if (!latestByCity.has(cityName)) latestByCity.set(cityName, entry);
  }

  return {
    fetchedAt: now,
    latestByCity,
    activeCities,
    releasedCities,
    blocks,
  };
}

async function refreshOrefHistoryState(now = Date.now()) {
  if (orefHistoryRefreshInFlight) return orefHistoryRefreshInFlight;
  if (orefHistoryState.fetchedAt && now - orefHistoryState.fetchedAt < OREF_HISTORY_STALE_MS) {
    return orefHistoryState;
  }
  orefHistoryRefreshInFlight = axios
    .get(OREF_HISTORY_URL, {
      headers: {
        ...OREF_HEADERS,
        Accept: 'application/json,text/plain,*/*',
      },
      timeout: 7000,
      responseType: 'text',
    })
    .then((response) => {
      const raw = String(response.data || '');
      const trimmed = raw.trim();
      const parsed =
        trimmed.startsWith('[') || trimmed.startsWith('{')
          ? parseOrefHistoryAjaxJson(raw, now)
          : parseOrefHistoryHtml(raw, now);
      orefHistoryState.fetchedAt = parsed.fetchedAt;
      orefHistoryState.latestByCity = parsed.latestByCity;
      orefHistoryState.activeCities = parsed.activeCities;
      orefHistoryState.releasedCities = parsed.releasedCities;
      const histRows = buildFeedRowsFromOrefHistoryBlocks(parsed.blocks || []);
      mergeOrefHistoryIntoClientFeed(histRows);
      return orefHistoryState;
    })
    .catch((error) => {
      console.warn('[OrefHistory] Sync failed:', error.message);
      return orefHistoryState;
    })
    .finally(() => {
      orefHistoryRefreshInFlight = null;
    });
  return orefHistoryRefreshInFlight;
}

function normalizeDashboardFeedRow(row) {
  const src = row || {};
  const title = String(src.title || '');
  const rawTag = String(src.tag || '');
  const type = String(src.type || 'intel');
  const phaseHint = String(src.alertPhase || '').trim();
  const looksLikeRelease =
    phaseHint === 'released' ||
    rawTag.includes('האירוע הסתיים') ||
    rawTag.includes('שחרור') ||
    title.includes('האירוע הסתיים') ||
    title.includes('יכולים לצאת') ||
    rawTag.includes('׳”׳׳™׳¨׳•׳¢ ׳”׳¡׳×׳™׳™׳') ||
    rawTag.includes('׳©׳—׳¨׳•׳¨');
  const alertPhase =
    src.alertPhase ||
    (looksLikeRelease
      ? 'released'
      : rawTag.includes('הישארו במרחב המוגן')
        ? 'hold_after_siren'
        : rawTag.includes('אזעקה פעילה') ||
            rawTag.includes('חדירת כלי טיס עוין') ||
            rawTag.includes('ירי רקטות וטילים') ||
            rawTag.includes('חדירת כטב"ם') ||
            rawTag.includes('צבע אדום') ||
            rawTag.includes('ירי בליסטי') ||
            title.includes('חדירת כלי טיס עוין') ||
            title.includes('ירי רקטות וטילים')
          ? 'siren_active'
          : rawTag.includes('התראה מוקדמת') ||
              rawTag.includes('בדקות הקרובות') ||
              title.includes('בדקות הקרובות')
            ? 'pre_alert'
            : '');
  const normalizedTagMap = {
    released: 'האירוע הסתיים',
    hold_after_siren: 'הישארו במרחב המוגן',
    siren_active: 'ירי רקטות וטילים',
    pre_alert: 'בדקות הקרובות צפויות להתקבל התרעות באזורך',
  };
  const normalizedLiveStateMap = {
    released: 'שוחרר',
    hold_after_siren: 'במרחב מוגן',
    siren_active: 'אזעקה פעילה',
    pre_alert: 'התראה מוקדמת',
  };
  let normalizedTag = rawTag;
  if (alertPhase === 'released' || looksLikeRelease) {
    normalizedTag = normalizedTagMap.released;
  } else if (alertPhase === 'hold_after_siren') {
    normalizedTag = normalizedTagMap.hold_after_siren;
  } else if (alertPhase === 'pre_alert') {
    normalizedTag = normalizedTagMap.pre_alert;
  } else if (alertPhase === 'siren_active') {
    const t = String(rawTag || '').trim();
    const legacyGeneric =
      !t ||
      t === 'אזעקה פעילה' ||
      t === 'התרעה' ||
      t === 'התראה מוקדמת' ||
      t === 'התראה פעילה';
    normalizedTag = legacyGeneric ? normalizedTagMap.siren_active : t;
  } else {
    normalizedTag = normalizedTagMap[alertPhase] || rawTag;
  }
  const normalizedLiveState = normalizedLiveStateMap[alertPhase] || String(src.liveState || '');

  let resolvedType = type;
  if (alertPhase === 'released' || looksLikeRelease) {
    resolvedType = 'defense';
  } else if (
    alertPhase === 'pre_alert' ||
    alertPhase === 'siren_active' ||
    alertPhase === 'hold_after_siren'
  ) {
    resolvedType = 'attack';
  }

  return {
    ...src,
    type: resolvedType,
    alertPhase,
    tag: normalizedTag,
    liveState: normalizedLiveState,
  };
}

function getAlertPhaseRank(phase) {
  if (phase === 'released') return 4;
  if (phase === 'hold_after_siren') return 3;
  if (phase === 'siren_active') return 2;
  if (phase === 'pre_alert') return 1;
  return 0;
}

function isActiveAlertPhase(phase) {
  return phase === 'pre_alert' || phase === 'siren_active' || phase === 'hold_after_siren';
}

/** שורת פיד שמייצגת איום (לא שחרור) — לשימוש בחיתוך מגבלה: לא זורקים אותן לטובת מאות שורות "האירוע הסתיים" */
function isOrefThreatTimelineFeedRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.source || '') !== 'oref') return false;
  const ph = String(row.alertPhase || '');
  if (ph === 'released') return false;
  if (String(row.type || '') === 'defense') return false;
  const tag = String(row.tag || '');
  if (tag.includes('האירוע הסתיים') || tag.includes('שוחרר')) return false;
  if (isActiveAlertPhase(ph)) return true;
  return String(row.type || '') === 'attack';
}

/** חיתוך לפי מגבלה: שומרים את האירועים הכי חדשים בלבד (ללא העדפה לאיום/שחרור). */
function capMergedClientEventFeedRows(mergedNewestFirst, maxItems) {
  if (!Array.isArray(mergedNewestFirst) || mergedNewestFirst.length <= maxItems) {
    return mergedNewestFirst;
  }
  return mergedNewestFirst.slice(0, maxItems);
}

function filterClientEventFeedByRetention(rows, now = Date.now()) {
  const cutoff = now - CLIENT_FEED_RETENTION_MS;
  return (Array.isArray(rows) ? rows : []).filter((row) => row && feedRowSortKeyMs(row) >= cutoff);
}

/** אחרי 12 שעות: מסנן ישן; מעל CLIENT_FEED_MAX — מסיר מהכי ישן (שחרורים לפני איומים) */
function finalizeClientEventFeedRows(rows, now = Date.now()) {
  const kept = filterClientEventFeedByRetention(rows, now);
  kept.sort((a, b) => feedRowSortKeyMs(b) - feedRowSortKeyMs(a));
  return capMergedClientEventFeedRows(kept, CLIENT_FEED_MAX);
}

function inferOrefAlertPhase(alert) {
  if (!alert || typeof alert !== 'object') return 'siren_active';
  const category = Number(alert.orefCategory ?? alert.cat ?? alert.category ?? alert.Category ?? alert.alertCat);
  if (category === 14) return 'pre_alert';
  if (category === 13) return 'released';

  const g = classifyOrefGuidelinePhase(buildOrefGuidelineFullText(alert));
  if (g.phase === 'released') {
    logOrefGuidelineMatch(alert.cityName, g);
    return 'released';
  }
  if (g.phase === 'hold_after_siren') {
    logOrefGuidelineMatch(alert.cityName, g);
    return 'hold_after_siren';
  }
  if (g.phase === 'pre_alert') {
    logOrefGuidelineMatch(alert.cityName, g);
    return 'pre_alert';
  }
  if (g.phase === 'siren_active') {
    logOrefGuidelineMatch(alert.cityName, g);
    return 'siren_active';
  }

  return inferOrefEarlyWarning(alert) ? 'pre_alert' : 'siren_active';
}

let activeAlertsCache = [];
let lastOrefRawPayload = '';
let lastUnifiedOrefAlertAt = null;
let emptyOrefPollCount = 0;
let orefHistoryRefreshInFlight = null;
let orefPollInFlight = false;
let orefPollLastStartedAt = 0;
let orefPollSkippedOverlaps = 0;
/** נקבע כשטיק של setInterval נדחה כי פול קודם עדיין רץ — אחרי סיום הפול מוזמן פול נוסף (setImmediate) שלא צריך לחכות 3 שניות */
let orefPollPendingFollowUp = false;
let orefPollOverlapWarnAt = 0;
/** נקבע true אחרי poll שבו הוזרק מטען מגיבוי צופר (פיקוד נכשל ויש נתוני צל מ-WS). */
let orefLastPollUsedTzofarBackup = false;
const missileLifecycleTimers = new Map();
const activeMissilesById = new Map();
/** מנוע AI לציר שיגור — זמן ריצה אחרון לפי id טיל (מניעת הצפות API) */
const launchAxisAiLastCycleAt = new Map();
let launchAxisAiCycleInFlight = false;
const activeUavTracksByKey = new Map();
const activeAlertLastSeenAt = new Map();
const activeAlertDetailsByCity = new Map();
/** ׳‘׳׳”׳׳ pollOrefMissileLayer ג€” ׳›׳ ׳”׳”׳×׳¨׳׳•׳× ׳”׳׳ ׳•׳¨׳׳׳•׳× ׳‘׳׳•׳×׳• JSON (׳׳׳¦׳™׳¨׳× ׳¦׳™׳¨ ׳׳˜׳§׳¡׳˜ ׳׳©׳•׳×׳£) */
let orefPollContextAlerts = null;
/** ׳›׳׳” ׳–׳׳ ׳׳”׳—׳–׳™׳§ ׳¢׳™׳¨/׳׳™׳•׳ ׳׳—׳¨׳™ ׳©׳”׳¢׳™׳¨ ׳ ׳¢׳׳׳” ׳-JSON (׳©׳—׳¨׳•׳¨ ׳¨׳©׳׳™ ׳׳“׳•׳׳”). ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳ ~10 ׳“׳§׳³ */
const OREF_ALERT_HOLD_MS =
  Number(process.env.OREF_ALERT_HOLD_MINUTES) > 0
    ? Number(process.env.OREF_ALERT_HOLD_MINUTES) * 60 * 1000
    : 10 * 60 * 1000;
/** חלון זמן מדף alerts-history של פיקוד — ברירת מחדל 12 שעות לפיד אירועים מלא */
const OREF_HISTORY_WINDOW_MS =
  Number(process.env.OREF_HISTORY_WINDOW_MINUTES) > 0
    ? Number(process.env.OREF_HISTORY_WINDOW_MINUTES) * 60 * 1000
    : 12 * 60 * 60 * 1000;
const OREF_HISTORY_STALE_MS =
  Number(process.env.OREF_HISTORY_STALE_SECONDS) > 0
    ? Number(process.env.OREF_HISTORY_STALE_SECONDS) * 1000
    : 15 * 1000;
const orefHistoryState = {
  fetchedAt: 0,
  latestByCity: new Map(),
  activeCities: new Set(),
  releasedCities: new Set(),
};
/**
 * ׳׳¡׳₪׳¨ ׳¡׳™׳‘׳•׳‘׳™ ׳₪׳•׳׳™׳ ׳’ ׳¨׳¦׳•׳₪׳™׳ ׳©׳‘׳”׳ ׳”׳¢׳™׳¨ ׳›׳‘׳¨ ׳׳ ׳׳•׳₪׳™׳¢׳” ׳‘-OREF ׳׳₪׳ ׳™ ׳©׳—׳¨׳•׳¨ ׳׳¡׳׳•׳/׳”׳×׳¨׳׳”.
 * ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳ 1 = ׳׳¡׳•׳ ׳›׳ ׳׳™׳“ ׳¢׳ ׳”׳¡׳¨׳× ׳”׳¢׳™׳¨ ׳׳”-JSON (׳›׳׳• ׳׳•׳ ׳™׳˜׳•׳¨׳™ ׳™׳™׳—׳•׳¡).
 * ׳׳”׳’׳“׳¨׳”: OREF_CITY_CLEAR_CONFIRM_POLLS=3 ׳׳׳™׳—׳•׳¨ ׳§׳˜׳ ׳ ׳’׳“ ׳×׳§׳׳× ׳¨׳©׳×.
 */
const OREF_CITY_CLEAR_CONFIRM_POLLS = Math.max(
  1,
  Number(process.env.OREF_CITY_CLEAR_CONFIRM_POLLS) || 1
);
const cityClearConfirmPolls = new Map();
/** פיזור שליחות Socket ללקוח — מונע מאות הודעות בפריים אחד וקריסת דפדפן בשיגור המוני */
let orefClientSocketEmitSlot = 0;
const OREF_CLIENT_SOCKET_EMIT_GAP_MS = Math.max(
  20,
  Number(process.env.OREF_CLIENT_SOCKET_EMIT_GAP_MS) || 36
);
function resetOrefClientSocketEmitStagger() {
  orefClientSocketEmitSlot = 0;
}
function scheduleOrefClientSocketEmit(fn) {
  const delay = orefClientSocketEmitSlot * OREF_CLIENT_SOCKET_EMIT_GAP_MS;
  orefClientSocketEmitSlot += 1;
  setTimeout(fn, delay);
}
/** חתימת מצב אחרון של alerts.json לכל יישוב — מסנכרן את clientEventFeed עם פיד ההתראות של פיקוד העורף ללא כפילות בכל poll */
const orefLastClientFeedSnapshotByCity = new Map();
let openSkyAuthToken = null;
let openSkyAuthTokenExpiresAt = 0;
let openSkyRateLimitedUntil = 0;
let openSkyLastRateLimitLogAt = 0;

const OREF_URL =
  process.env.OREF_URL || 'https://www.oref.org.il/WarningMessages/Alert/alerts.json';
/** Timeout לבקשת alerts.json — כדי שלא poll ייתקע את ה-event loop כשפיקוד איטי/לא מגיב. */
const OREF_HTTP_TIMEOUT_MS = (() => {
  const n = Number(process.env.OREF_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1500 && n <= 60_000) return Math.floor(n);
  return 5000;
})();
/** מרווח בין poll ל-poll — ברירת מחדל 1.5s לסנכרון צמוד יותר לפיקוד (OREF_POLL_MS=1000..60000) */
const OREF_POLL_INTERVAL_MS = (() => {
  const n = Number(process.env.OREF_POLL_MS);
  if (Number.isFinite(n) && n >= 1000 && n <= 60_000) return Math.floor(n);
  return 1_500;
})();
/** מגבלת גודל גוף תשובה (מגן מפני תשובות חריגות שמאטות את השרת). */
const OREF_MAX_RESPONSE_BYTES = (() => {
  const n = Number(process.env.OREF_MAX_RESPONSE_BYTES);
  if (Number.isFinite(n) && n >= 100_000 && n <= 20_000_000) return Math.floor(n);
  return 2_000_000;
})();
const OREF_HEADERS = {
  Referer: 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
};

const TZOFAR_BACKUP_ENABLED = isTzofarBackupEnvEnabled();
console.log(`[SERVER INIT] TZOFAR_BACKUP_ENABLED=${TZOFAR_BACKUP_ENABLED}, env value="${process.env.TZOFAR_BACKUP_ENABLED}"`);
const tzofarBackupClient = TZOFAR_BACKUP_ENABLED ? new TzofarBackupClient({ enabled: true }) : null;
console.log(`[SERVER INIT] tzofarBackupClient created: ${tzofarBackupClient !== null}`);

/** ׳׳¢׳¨׳ [lng,lat] ׳-Leaflet; ׳׳ ׳”׳’׳™׳¢ [lat,lng] (׳ ׳₪׳•׳¥ ׳‘-API) ג€” ׳׳×׳§׳ */
function normalizeCoordPairToLngLat(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return pair;
  const a = Number(pair[0]);
  const b = Number(pair[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return pair;
  const aLooksLat = a >= 29 && a <= 34.35;
  const bLooksLng = b >= 34 && b <= 36.5;
  if (aLooksLat && bLooksLng && a < b) {
    return [b, a];
  }
  return [a, b];
}

/**
 * ׳™׳¢׳“ ׳”׳×׳¨׳׳” ׳¡׳‘׳™׳¨ ׳‘׳™׳©׳¨׳׳ / ׳¨׳׳× ׳”׳’׳•׳׳ / ׳™׳ ׳”׳׳׳— (׳׳ ׳™׳ ׳×׳™׳›׳•׳ / ׳׳™׳¨׳•׳₪׳”).
 * ׳׳©׳׳© ׳’׳ ׳׳¡׳™׳ ׳•׳ ׳§׳•׳׳•׳¨׳“׳™׳ ׳˜׳•׳× ׳©׳’׳•׳™׳•׳× ׳׳׳§׳•׳¨ ׳—׳™׳¦׳•׳ ׳™.
 */
function isPlausibleIsraelAlertTarget(lng, lat) {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lat >= 29.45 &&
    lat <= 33.72 &&
    lng >= 34.22 &&
    lng <= 36.22
  );
}

function isPlausibleUaeAlertTarget(lng, lat) {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lat >= 22.4 &&
    lat <= 26.6 &&
    lng >= 51.4 &&
    lng <= 56.8
  );
}

function isPlausibleSupportedAlertTarget(lng, lat) {
  return isPlausibleIsraelAlertTarget(lng, lat) || isPlausibleUaeAlertTarget(lng, lat);
}

function getTargetPosition(alert) {
  if (!alert || typeof alert !== 'object') {
    return null;
  }

  const rawCity =
    alert.cityName ||
    alert.city ||
    alert.name ||
    (typeof alert.data === 'string' ? alert.data : null);

  if (rawCity != null && String(rawCity).trim()) {
    const cityStr = normalizeHebrewSettlementName(String(rawCity));
    const byCity = getReliableCityCoordinates(cityStr);
    if (byCity) {
      return [byCity.lng, byCity.lat];
    }
  }

  const coordsValue = alert.coordinates || alert.targetPosition || alert.target;
  if (Array.isArray(coordsValue) && coordsValue.length === 2) {
    const p = normalizeCoordPairToLngLat(coordsValue);
    const plng = Number(p[0]);
    const plat = Number(p[1]);
    if (isPlausibleSupportedAlertTarget(plng, plat)) {
      return p;
    }
    if (rawCity != null && String(rawCity).trim()) {
        const fallbackCity = getReliableCityCoordinates(normalizeHebrewSettlementName(String(rawCity)));
      if (fallbackCity) {
        return [fallbackCity.lng, fallbackCity.lat];
      }
    }
    return null;
  }

  if (coordsValue && typeof coordsValue === 'object' && typeof coordsValue.lng === 'number' && typeof coordsValue.lat === 'number') {
    if (isPlausibleSupportedAlertTarget(coordsValue.lng, coordsValue.lat)) {
      return [coordsValue.lng, coordsValue.lat];
    }
    if (rawCity != null && String(rawCity).trim()) {
        const fallbackCity = getReliableCityCoordinates(normalizeHebrewSettlementName(String(rawCity)));
      if (fallbackCity) {
        return [fallbackCity.lng, fallbackCity.lat];
      }
    }
    return null;
  }

  return null;
}

/** ׳™׳¢׳“ ׳”׳×׳¨׳׳” ׳—׳™׳™׳‘ ׳׳”׳™׳•׳× ׳‘׳™׳©׳¨׳׳ ג€” ׳׳ ׳׳—׳–׳™׳¨׳™׳ ׳§׳•׳׳•׳¨׳“׳™׳ ׳˜׳•׳× ׳׳—׳•׳¥ ׳׳×׳™׳‘׳” (׳׳•׳ ׳¢ ׳§׳©׳× ׳׳¢׳‘׳¨ ׳׳™׳¨׳•׳₪׳” ׳•׳›׳•׳³). */
function clampTargetLngLatToSupportedRegion(alert, targetPosition) {
  const [lng, lat] = normalizeLngLat(targetPosition);
  if (isPlausibleSupportedAlertTarget(lng, lat)) {
    return [lng, lat];
  }
  const rawCity =
    alert?.cityName ||
    alert?.city ||
    alert?.name ||
    (typeof alert?.data === 'string' ? alert.data : null);
  if (rawCity != null && String(rawCity).trim()) {
      const byCity = getReliableCityCoordinates(normalizeHebrewSettlementName(String(rawCity)));
    if (byCity && isPlausibleSupportedAlertTarget(byCity.lng, byCity.lat)) {
      return [byCity.lng, byCity.lat];
    }
  }
  /* לא משתמשים בברירת מחדל צפונית (חיפה) ליעד — גרמה ל״פגיעות״ ספוריות בצפון בלי התרעת Oref מתאימה */
  const fb = getDefaultTargetFallbackCoordinates();
  return [fb.lng, fb.lat];
}

/**
 * ׳¨׳§ ׳©׳™׳’׳•׳¨׳™׳ ׳›׳׳₪׳™ ׳™׳©׳¨׳׳: ׳׳×׳§׳ ׳”׳—׳׳₪׳× ׳׳•׳¦׳/׳™׳¢׳“, ׳™׳¢׳“ ׳׳—׳•׳¥ ׳׳׳¨׳¥, ׳•׳׳•׳¦׳ ׳©׳ ׳•׳₪׳ ׳‘׳×׳•׳ ׳™׳©׳¨׳׳ (׳׳—׳©׳‘ ׳׳—׳“׳© ׳׳—׳•׳¥ ׳׳׳¨׳¥).
 */
function normalizeMissileEndpointsForInbound(alert, sourcePosition, targetPosition) {
  const threatType = alert?.threatType || 'missile';
  let tgt = normalizeLngLat(targetPosition);
  let src = normalizeLngLat(sourcePosition);
  if (threatType === 'uav') {
    tgt = clampTargetLngLatToSupportedRegion(alert, tgt);
    if (isPlausibleSupportedAlertTarget(src[0], src[1])) {
      src = resolveSourcePosition(alert, tgt);
    }
    return { sourcePosition: src, targetPosition: tgt };
  }
  let tIn = isPlausibleSupportedAlertTarget(tgt[0], tgt[1]);
  let sIn = isPlausibleSupportedAlertTarget(src[0], src[1]);
  if (tIn && sIn) {
    src = resolveSourcePosition(alert, tgt);
  } else if (!tIn && sIn) {
    const sx = src[0];
    const sy = src[1];
    src = [tgt[0], tgt[1]];
    tgt = [sx, sy];
  }
  tgt = clampTargetLngLatToSupportedRegion(alert, tgt);
  if (isPlausibleSupportedAlertTarget(src[0], src[1])) {
    src = resolveSourcePosition(alert, tgt);
  }
  return { sourcePosition: src, targetPosition: tgt };
}

function normalizeLngLat(value) {
  if (Array.isArray(value) && value.length >= 2) {
    return [Number(value[0]), Number(value[1])];
  }
  if (value && typeof value === 'object' && typeof value.lng === 'number' && typeof value.lat === 'number') {
    return [value.lng, value.lat];
  }
  const fallback = getDefaultCoordinates();
  return [fallback.lng, fallback.lat];
}

function getUnifiedOrefStatus() {
  const legacyStatus = getServiceStatus();
  const feedHeldCities = getFeedHeldActiveCities(state.clientEventFeed);
  const historyHeldCities =
    orefHistoryState && orefHistoryState.activeCities instanceof Set
      ? [...orefHistoryState.activeCities]
      : [];
  const activeCitySet = new Set([...(activeAlertsCache || []), ...feedHeldCities, ...historyHeldCities]);
  return {
    ...legacyStatus,
    isRunning: true,
    lastAlertTime: lastUnifiedOrefAlertAt || legacyStatus.lastAlertTime || null,
    pollInterval: 3000,
    activeCities: [...activeCitySet],
  };
}

function hasRenderableAlertCoordinates(detail) {
  if (!detail || typeof detail !== 'object') return false;
  const tp = getTargetPosition(detail);
  return (
    Array.isArray(tp) &&
    tp.length >= 2 &&
    isPlausibleSupportedAlertTarget(Number(tp[0]), Number(tp[1]))
  );
}

function hasRenderableMissileTarget(missileEvent) {
  if (!missileEvent || typeof missileEvent !== 'object') return false;
  const tp = getTargetPosition(missileEvent);
  return (
    Array.isArray(tp) &&
    tp.length >= 2 &&
    isPlausibleSupportedAlertTarget(Number(tp[0]), Number(tp[1]))
  );
}

function computeHeldActiveCities(now = Date.now()) {
  const activeCities = [];
  activeAlertLastSeenAt.forEach((lastSeenAt, cityName) => {
    if (now - lastSeenAt <= OREF_ALERT_HOLD_MS) {
      activeCities.push(cityName);
    }
  });
  return activeCities;
}

function pruneExpiredAlertCache(now = Date.now()) {
  activeAlertLastSeenAt.forEach((lastSeenAt, cityName) => {
    if (now - lastSeenAt > OREF_ALERT_HOLD_MS) {
      activeAlertLastSeenAt.delete(cityName);
    }
  });
}

/**
 * ׳ ׳§׳•׳“׳× ׳׳•׳¦׳ ׳¢׳ ׳”׳׳©׳ ׳׳”׳¢׳•׳’׳ (׳©׳˜׳— ׳׳•׳™׳‘) ׳׳ ׳”׳™׳¢׳“ ג€” ׳›׳ ׳”׳׳¡׳׳•׳ ׳×׳׳™׳“ "׳ ׳›׳ ׳¡" ׳׳›׳™׳•׳•׳ ׳”׳¢׳™׳¨ ׳•׳׳ ׳–׳– ׳׳§׳¨׳׳™׳× ׳׳™׳.
 * backDeg ~0.4ֲ° ג‰ˆ 44 ׳§"׳ ׳׳₪׳ ׳™ ׳”׳™׳¢׳“ ׳׳׳•׳¨׳ ׳׳•׳×׳• ׳•׳§׳˜׳•׳¨.
 */
function backwardTowardAnchor(targetPosition, anchorLng, anchorLat, backDeg) {
  const [tlng, tlat] = normalizeLngLat(targetPosition);
  const dx = tlng - anchorLng;
  const dy = tlat - anchorLat;
  const len = Math.hypot(dx, dy) || 1e-9;
  const ux = dx / len;
  const uy = dy / len;
  return [tlng - ux * backDeg, tlat - uy * backDeg];
}

const LEBANON_ROUTE_ANCHOR = { lng: 35.53, lat: 33.25, back: 0.42 }; // South Lebanon border (near Fatma Gate/Metula area)

/** ׳ ׳§׳•׳“׳× ׳׳•׳¦׳ ׳¢׳ ׳§׳• ׳׳”׳¢׳•׳’׳ ׳”׳׳¡׳˜׳¨׳˜׳’׳™ ׳׳ ׳”׳™׳¢׳“ (׳׳—׳•׳– ׳׳”׳׳¨׳—׳§ ג€” ׳§׳¨׳•׳‘ ׳׳¢׳•׳’׳ = ׳‘׳×׳•׳ ׳׳™׳¨׳׳/׳¢׳™׳¨׳׳§ ׳•׳›׳•') */
function pointOnRayFromAnchorTowardTarget(anchorLng, anchorLat, targetPosition, fractionFromAnchor) {
  const [tlng, tlat] = normalizeLngLat(targetPosition);
  const t = Math.max(0.035, Math.min(0.38, fractionFromAnchor));
  return [anchorLng + (tlng - anchorLng) * t, anchorLat + (tlat - anchorLat) * t];
}

/** ׳׳™׳¡׳•׳£ ׳¨׳§׳•׳¨׳¡׳™׳‘׳™ ׳©׳ ׳›׳ ׳׳—׳¨׳•׳–׳•׳× ׳”ײ¾JSON ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ג€” ׳›׳“׳™ ׳׳ ׳׳₪׳¡׳₪׳¡ ׳©׳“׳” ׳¢׳ ׳¦׳™׳¨ ׳׳™׳•׳ */
function collectOrefStringBlob(obj, depth = 0, maxLen = 12000) {
  if (depth > 8 || obj == null) return '';
  const parts = [];
  const walk = (v, d) => {
    if (parts.join(' ').length >= maxLen) return;
    if (v == null) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) parts.push(s);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(String(v));
      return;
    }
    if (d > 8 || parts.join(' ').length >= maxLen) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && parts.join(' ').length < maxLen; i++) walk(v[i], d + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (parts.join(' ').length >= maxLen) return;
        walk(v[k], d + 1);
      }
    }
  };
  walk(obj, depth);
  return parts.join(' ').slice(0, maxLen);
}

/**
 * ׳–׳™׳”׳•׳™ ׳¦׳™׳¨ ׳׳™׳•׳ (׳׳“׳™׳ ׳” / ׳׳–׳•׳¨ ׳©׳™׳’׳•׳¨ ׳׳©׳•׳¢׳¨) ג€” ׳׳₪׳™ ׳˜׳§׳¡׳˜, ׳›׳™ ׳‘-JSON ׳©׳ ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ׳׳¨׳•׳‘ ׳׳™׳ ׳©׳“׳” ׳׳•׳‘׳ ׳” "׳׳“׳™׳ ׳”".
 *
 * ׳¡׳“׳¨ (׳×׳׳™׳“ ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ׳׳₪׳ ׳™ ׳”׳›׳):
 * 1) ׳›׳ ׳׳—׳¨׳•׳–׳•׳× ׳”-JSON ׳©׳ ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (orefTextBlob + ׳©׳“׳•׳× ׳ ׳₪׳•׳¦׳™׳)
 * 2) ׳׳•׳×׳• ׳₪׳•׳: ׳˜׳§׳¡׳˜ ׳׳׳•׳–׳’ ׳׳›׳ ׳©׳•׳¨׳•׳× ׳”׳”׳×׳¨׳׳” (׳׳¢׳™׳×׳™׳ ׳”׳¨׳׳– ׳׳•׳₪׳™׳¢ ׳¨׳§ ׳‘׳¨׳©׳•׳׳” ׳׳—׳× ׳‘-JSON)
 * 3) ׳¨׳§ ׳׳ ׳׳™׳ ׳¦׳™׳¨: ׳¨׳׳– OSINT ג€” ׳‘׳–׳׳ ׳”׳×׳¨׳׳” ׳₪׳¢׳™׳׳” ׳׳×׳‘׳¦׳¢ ׳¨׳™׳¢׳ ׳•׳ burst ׳׳₪׳ ׳™ ׳—׳™׳©׳•׳‘ ׳”׳׳¡׳׳•׳ (׳›׳ ~10s)
 * 4) ׳׳•׳₪׳¦׳™׳•׳ ׳׳™: OREF_NEWS_AXIS_HINT=1 ג€” ׳₪׳׳ ׳ ׳¢׳‘׳¨׳™׳× (׳׳׳•׳׳¥ ׳‘׳–׳׳ ׳׳™׳•׳ ׳₪׳¢׳™׳)
 * 5) OREF_DEFAULT_THREAT_AXIS ג€” ׳ ׳‘׳“׳§ ׳‘-resolveSourcePosition
 * 6) ׳׳׳ ׳¦׳™׳¨: ׳¢׳•׳’׳ ׳׳™׳•׳ ׳’׳׳•׳’׳¨׳₪׳™ ׳§׳¨׳•׳‘ ׳׳™׳¢׳“ (getSourcePositionNearestThreatArc)
 *
 * ׳›׳™׳‘׳•׳™ OSINT: OSINT_AXIS_HINTS=0
 *
 * ׳ ׳§׳•׳“׳× ׳ ׳₪׳™׳׳”: ׳©׳ ׳™׳™׳©׳•׳‘ ג†’ citiesMap + israel-localities.geojson; ׳׳ ׳—׳¡׳¨ ג€” Open-Meteo (׳‘׳¨׳™׳¨׳× ׳׳—׳“׳)
 * ׳•׳׳•׳₪׳¦׳™׳•׳ ׳׳™׳× Nominatim (OREF_GEOCODE_NOMINATIM=1). ׳›׳™׳‘׳•׳™ ׳’׳™׳׳•׳§׳•׳“: OREF_GEOCODE_FALLBACK=0.
 */
let newsThreatAxisBlob = '';
let newsThreatAxisBlobAt = 0;

function refreshNewsThreatAxisBlob(options = {}) {
  if (process.env.OREF_NEWS_AXIS_HINT !== '1') {
    newsThreatAxisBlob = '';
    return;
  }
  const force = options.force === true;
  const ttl = 45_000;
  if (!force && Date.now() - newsThreatAxisBlobAt < ttl && newsThreatAxisBlob) return;
  try {
    const articles = getNews(50);
    newsThreatAxisBlob = articles
      .map((x) => [x && x.titleHe, x && x.title, x && x.description].filter(Boolean).join(' '))
      .join(' | ');
    newsThreatAxisBlobAt = Date.now();
  } catch {
    newsThreatAxisBlob = '';
  }
}

/**
 * ׳׳™׳—׳•׳“ ׳׳§׳•׳¨׳•׳× (׳¡׳“׳¨ IWM): ׳׳§׳•׳¨ ׳¨׳‘-׳׳§׳•׳¨ Oref+Telegram AI+OSINT+GDELT+׳©׳•׳§׳™׳.
 */
function computeThreatFusionResult(alert) {
  const empty = {
    axis: null,
    fusionTier: 'geometry',
    trajectoryLocked: false,
    trajectoryConfidence: SOURCE_CREDIBILITY_BASE.geometry,
    fusionSources: ['׳׳¡׳׳•׳ ׳’׳׳•׳’׳¨׳₪׳™ ׳׳©׳•׳¢׳¨'],
    targetSettlementConfidence: 0.65,
    sourceConfidence: 'estimated',
    sourceConfidenceScore: SOURCE_CREDIBILITY_BASE.geometry,
  };
  if (!alert || typeof alert !== 'object') return empty;

  const settlementKnown = alert.usedSettlementFallback === false;
  empty.targetSettlementConfidence = settlementKnown ? 0.94 : 0.68;

  if (
    alert._multiSourceConfirmed === true &&
    alert._multiSourceAxis &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(alert._multiSourceAxis)) /* Iran disabled */
  ) {
    const bonus = crossSourceCredibilityBonus(2);
    const msAxis = applyCeasefireBallisticLaunchPrior(alert, String(alert._multiSourceAxis));
    return {
      axis: msAxis,
      fusionTier: 'confirmed_multi_source',
      trajectoryLocked: true,
      trajectoryConfidence: Math.min(0.99, 0.92 + bonus),
      fusionSources: ['Oref + Telegram AI (מאומת מרובה מקורות)'],
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: 'official',
      sourceConfidenceScore: Math.min(0.99, 0.94 + bonus * 0.5),
    };
  }

  const blob =
    (typeof alert.orefTextBlob === 'string' && alert.orefTextBlob.trim()
      ? alert.orefTextBlob
      : [
          alert.title,
          alert.desc,
          alert.description,
          alert.subtitle,
          alert.msg,
          alert.message,
          alert.name,
          alert.type,
          alert.alertDate,
          alert.datetime,
          alert.info,
          alert.text,
        ]
          .filter(Boolean)
          .join(' ')) + '';

  const fromDirect = alert.telegramAiExtraction ? null : matchExplicitThreatAxisInBlob(blob);
  if (fromDirect) {
    const ts = alert.orefTimeMs || alert.receivedAtMs || Date.now();
    return {
      axis: fromDirect,
      fusionTier: 'oref_direct',
      trajectoryLocked: true,
      trajectoryConfidence: applyCredibilityTimeDecay(
        Math.min(0.98, 0.9 + (settlementKnown ? 0.06 : 0.04)),
        ts
      ),
      fusionSources: ['׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ג€” ׳˜׳§׳¡׳˜ ׳”׳×׳¨׳׳”'],
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: 'official',
      sourceConfidenceScore: applyCredibilityTimeDecay(
        Math.min(0.99, SOURCE_CREDIBILITY_BASE.oref * (settlementKnown ? 0.99 : 0.97)),
        ts
      ),
    };
  }

  let fromGroup = null;
  if (!alert.telegramAiExtraction && Array.isArray(orefPollContextAlerts) && orefPollContextAlerts.length > 0) {
    const mergedGroup = orefPollContextAlerts
      .map((a) => {
        if (a && typeof a.orefTextBlob === 'string' && a.orefTextBlob.trim()) return a.orefTextBlob.trim();
        return [a && a.title, a && a.desc, a && a.description].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join(' | ');
    fromGroup = matchExplicitThreatAxisInBlob(mergedGroup);
  }
  if (fromGroup) {
    const ts = alert.orefTimeMs || alert.receivedAtMs || Date.now();
    const axisResolved = regionalAxisOverrideForNorthIsraelTarget(fromGroup, alert) || fromGroup;
    const axisPrior = applyCeasefireBallisticLaunchPrior(alert, axisResolved);
    const geometryAdjusted = axisPrior !== fromGroup;
    return {
      axis: axisPrior,
      fusionTier: geometryAdjusted ? 'oref_group_geometry' : 'oref_group',
      trajectoryLocked: !geometryAdjusted,
      trajectoryConfidence: applyCredibilityTimeDecay(
        Math.min(0.92, (geometryAdjusted ? 0.76 : 0.82) + (settlementKnown ? 0.08 : 0.05)),
        ts
      ),
      fusionSources: geometryAdjusted
        ? ['פיקוד העורף — ציר גל + תיקון גאוגרפי (צפון)']
        : ['פיקוד העורף — כלל ההתראות בפול'],
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: geometryAdjusted ? 'corroborated' : 'official',
      sourceConfidenceScore: applyCredibilityTimeDecay(
        geometryAdjusted
          ? Math.min(0.82, 0.66 + (settlementKnown ? 0.06 : 0.04))
          : Math.min(0.94, 0.84 + (settlementKnown ? 0.06 : 0.04)),
        ts
      ),
    };
  }

  if (
    alert.telegramAiExtraction === true &&
    alert.telegramAiAxis &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(alert.telegramAiAxis)) /* Iran disabled */ &&
    Number(alert.telegramAiConfidence) >= 0.7
  ) {
    const ts = alert.receivedAtMs || Date.now();
    const conf = Number(alert.telegramAiConfidence);
    const baseScore = SOURCE_CREDIBILITY_BASE.telegram_ai * conf;
    const tgAxis = applyCeasefireBallisticLaunchPrior(alert, String(alert.telegramAiAxis));
    return {
      axis: tgAxis,
      fusionTier: 'telegram_ai',
      trajectoryLocked: true,
      trajectoryConfidence: Math.min(0.88, 0.68 + conf * 0.18),
      fusionSources: ['Telegram AI track extraction'],
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: 'telegram_ai',
      sourceConfidenceScore: applyCredibilityTimeDecay(baseScore, ts),
    };
  }

  const osintAxis = getOsintAxisHintSync();
  const alertTargetZone = inferAlertTargetZone(alert);
  const osintTargetZone = inferOsintTargetZone(osintAxis);
  const corroboratedAxis = osintAxis?.axis || null;
  const corroboratedConfidence = Number(osintAxis?.confidence || 0);
  const hasMatchingZone = !alertTargetZone || (osintTargetZone && alertTargetZone === osintTargetZone);
  const corroboratedEvidenceCount = corroboratedAxis
    ? getOsintAxisEvidenceCount(corroboratedAxis, alertTargetZone || osintTargetZone || null)
    : 0;
  const isDistantAxis = corroboratedAxis ? ['iraq', 'yemen'].includes(corroboratedAxis) : false; /* Iran disabled */
  const passesCorroborationThreshold = corroboratedAxis
    ? isDistantAxis
      ? hasMatchingZone && corroboratedConfidence >= 0.42 && corroboratedEvidenceCount >= 3
      : hasMatchingZone && corroboratedConfidence >= 0.32 && corroboratedEvidenceCount >= 3
    : false;

  if (corroboratedAxis && passesCorroborationThreshold) {
    const ts = alert.receivedAtMs || Date.now();
    const predBoost =
      (state.predictionMarketsSnapshot?.escalationScore || 0) > 0.58 ? 0.03 + SOURCE_CREDIBILITY_BASE.prediction_market * 0.05 : 0;
    const osAxis = applyCeasefireBallisticLaunchPrior(alert, corroboratedAxis);
    return {
      axis: osAxis,
      fusionTier: 'telegram_osint',
      trajectoryLocked: true,
      trajectoryConfidence: applyCredibilityTimeDecay(Math.min(0.85, 0.55 + corroboratedConfidence * 0.38 + predBoost), ts),
      fusionSources: ['Telegram OSINT (regex)', predBoost > 0 ? 'prediction_markets_signal' : null].filter(Boolean),
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: 'corroborated',
      sourceConfidenceScore: applyCredibilityTimeDecay(
        Math.min(0.86, SOURCE_CREDIBILITY_BASE.telegram_osint + corroboratedConfidence * 0.22 + predBoost),
        ts
      ),
    };
  }

  const gHint = getGdeltCorroborationForAlert(alert);
  if (gHint) {
    const ts = gHint.updatedAt || Date.now();
    const predBoost =
      (state.predictionMarketsSnapshot?.escalationScore || 0) > 0.55
        ? 0.04
        : 0;
    const gdAxis = applyCeasefireBallisticLaunchPrior(alert, gHint.axis);
    return {
      axis: gdAxis,
      fusionTier: 'gdelt_news',
      trajectoryLocked: false,
      trajectoryConfidence: applyCredibilityTimeDecay(
        Math.min(0.72, 0.45 + gHint.confidence * 0.28 + predBoost),
        ts
      ),
      fusionSources: ['GDELT / news corpus', predBoost > 0 ? 'prediction_markets' : null].filter(Boolean),
      targetSettlementConfidence: empty.targetSettlementConfidence,
      sourceConfidence: 'estimated',
      sourceConfidenceScore: applyCredibilityTimeDecay(
        Math.min(0.62, SOURCE_CREDIBILITY_BASE.gdelt + gHint.confidence * 0.12 + predBoost),
        ts
      ),
    };
  }

  return empty;
}

function getGdeltCorroborationForAlert(alert) {
  const g = state.gdeltCorroboration;
  if (!g?.axis || !['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(g.axis)) /* Iran disabled */) return null;
  if (Date.now() - (g.updatedAt || 0) > 20 * 60_000) return null;
  if ((g.confidence || 0) < 0.42) return null;
  return g;
}

async function fetchGdeltDocArticlesWithQuery(q, opts = {}) {
  const timeout =
    opts.timeout != null ? opts.timeout : Math.max(4000, Number(process.env.GDELT_TIMEOUT_MS) || 5000);
  const query = String(q || '').trim() || '(iran OR israel OR missile OR rocket OR strike)';
  const timespan = opts.timespan != null ? opts.timespan : process.env.GDELT_TIMESPAN || '1h';
  const maxrec =
    opts.maxrec != null
      ? opts.maxrec
      : Math.min(150, Number(process.env.GDELT_MAXRECORDS) || 50);
  const docUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=artlist&maxrecords=${maxrec}&timespan=${encodeURIComponent(timespan)}&format=json&sort=datedesc`;
  try {
    const r = await axios.get(docUrl, { timeout, validateStatus: (s) => s >= 200 && s < 400 });
    if (r.data?.articles && Array.isArray(r.data.articles)) return r.data.articles;
  } catch (e) {
    console.warn('[GDELT] fetch failed:', e.message);
  }
  return [];
}

async function fetchGdeltDocArticles() {
  const q = process.env.GDELT_QUERY || '(israel OR lebanon OR hezbollah OR gaza OR missile OR rocket OR strike)'; /* Iran removed */
  return fetchGdeltDocArticlesWithQuery(q);
}

function getGdeltFusionBurstQueries() {
  try {
    const raw = process.env.GDELT_FUSION_BURST_QUERIES_JSON;
    if (raw && String(raw).trim()) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map((x) => String(x).trim()).filter(Boolean);
    }
  } catch (e) {
    console.warn('[GDELT] GDELT_FUSION_BURST_QUERIES_JSON parse failed:', e.message);
  }
  const base = process.env.GDELT_QUERY || '(israel OR lebanon OR hezbollah OR gaza OR missile OR rocket OR strike)'; /* Iran removed */
  return [
    base,
    '(lebanon OR hezbollah OR beirut) (missile OR rocket OR strike OR attack)',
    '(yemen OR houthi OR houthis) (missile OR rocket OR strike OR attack)',
    '(iraq OR baghdad) (missile OR rocket OR strike OR attack)',
    '(iran OR irgc OR tehran) (missile OR rocket OR strike OR attack)',
    '(gaza OR hamas OR "gaza strip") (missile OR rocket OR strike OR attack)',
  ];
}

function mergeGdeltArticleLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const a of list || []) {
      const key =
        (a && a.url && String(a.url)) ||
        (a && a.socialimage && String(a.socialimage)) ||
        (a && `${a.title || ''}|${a.domain || ''}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
      if (out.length >= 150) return out;
    }
  }
  return out;
}

async function emitGdeltSocketUpdate() {
  try {
    io.emit('gdelt_update', {
      count: state.gdeltEvents.length,
      corroboration: state.gdeltCorroboration,
      sample: state.gdeltEvents.slice(0, 12),
    });
  } catch (_) {
    /* */
  }
}

/** מספר שאילתות DOC במקביל לפני fusion (חיסכון: GDELT_FUSION_BURST=0 משתמש בשאילתה אחת כמו הפולר הרגיל). */
async function updateGdeltFusionBurst() {
  if (process.env.GDELT_ENABLED === '0') return;
  if (process.env.GDELT_FUSION_BURST === '0') {
    return updateGdelt();
  }
  const queries = getGdeltFusionBurstQueries();
  if (!queries.length) {
    return updateGdelt();
  }
  const timeout = Math.max(3500, Number(process.env.GDELT_TIMEOUT_MS) || 5000);
  const timespan = process.env.GDELT_TIMESPAN || '1h';
  const perQ = Math.min(50, Math.max(12, Math.floor(120 / Math.max(1, queries.length))));
  const settled = await Promise.allSettled(
    queries.map((q) => fetchGdeltDocArticlesWithQuery(q, { timeout, timespan, maxrec: perQ }))
  );
  const merged = mergeGdeltArticleLists(settled.filter((s) => s.status === 'fulfilled').map((s) => s.value));
  ingestGdeltArticles(merged);
  await emitGdeltSocketUpdate();
}

function ingestGdeltArticles(articles) {
  const votes = { iraq: 0, yemen: 0, lebanon: 0, gaza: 0 }; /* Iran removed */
  const conflictRe = /(missile|rocket|strike|attack|שיגור|טיל|ירי|war|airstrike|ballistic|houthis|hezbollah)/i;
  const kw = [
    /* [/\biran\b|ایران|tehran|irgc/i, 'iran'], // Iran disabled */
    [/\biraq\b|baghdad/i, 'iraq'],
    [/\byemen\b|houthi|houthis|sanaa/i, 'yemen'],
    [/\blebanon\b|hezbollah|beirut/i, 'lebanon'],
    [/\bgaza\b|hamas/i, 'gaza'],
  ];
  for (const a of (articles || []).slice(0, 120)) {
    const blob = `${a?.title || ''} ${a?.domain || ''}`;
    if (!conflictRe.test(blob)) continue;
    for (const [re, axis] of kw) {
      if (re.test(blob)) votes[axis]++;
    }
  }
  let best = null;
  let n = 0;
  for (const [ax, c] of Object.entries(votes)) {
    if (c > n) {
      best = ax;
      n = c;
    }
  }
  if (best && n > 0) {
    state.gdeltCorroboration = {
      axis: best,
      confidence: Math.min(0.65, 0.48 + n * 0.04),
      updatedAt: Date.now(),
    };
  } else {
    state.gdeltCorroboration = { axis: null, confidence: 0, updatedAt: Date.now() };
  }
  state.gdeltEvents = (articles || []).slice(0, 50);
}

async function updateGdelt() {
  if (process.env.GDELT_ENABLED === '0') return;
  const articles = await fetchGdeltDocArticles();
  ingestGdeltArticles(articles);
  await emitGdeltSocketUpdate();
}

async function fetchPredictionMarketsCombined() {
  const out = { polymarket: [], manifold: [], escalationScore: 0 };
  const keywords = /israel|gaza|lebanon|yemen|war|missile|hezbollah|houthis|-idf|idf/i; /* Iran removed */
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { limit: 100, active: true, closed: false },
      timeout: 12000,
      validateStatus: () => true,
    });
    if (r.status === 200 && Array.isArray(r.data)) {
      out.polymarket = r.data
        .filter((m) => keywords.test(`${m.question || ''} ${m.description || ''}`))
        .slice(0, 35);
    }
  } catch (e) {
    console.warn('[Polymarket]', e.message);
  }
  try {
    const r2 = await axios.get('https://api.manifold.markets/v0/search-markets', {
      params: { term: 'Israel Iran war', limit: '20' },
      timeout: 12000,
      validateStatus: () => true,
    });
    if (r2.status === 200 && Array.isArray(r2.data)) {
      out.manifold = r2.data.filter((m) => keywords.test(`${m.question || ''}`)).slice(0, 20);
    }
  } catch (e) {
    console.warn('[Manifold]', e.message);
  }
  const probs = [];
  for (const m of out.polymarket) {
    const raw = Array.isArray(m.outcomePrices) ? m.outcomePrices[0] : m.bestAsk ?? m.lastTradePrice;
    const p = Number(raw);
    if (Number.isFinite(p) && p >= 0 && p <= 1) probs.push(p);
  }
  for (const m of out.manifold) {
    const p = Number(m.probability);
    if (Number.isFinite(p) && p >= 0 && p <= 1) probs.push(p);
  }
  out.escalationScore = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
  return out;
}

async function updatePredictionMarkets() {
  if (process.env.PREDICTION_MARKETS_ENABLED === '0') return;
  const snap = await fetchPredictionMarketsCombined();
  state.predictionMarketsSnapshot = {
    markets: [...snap.polymarket.slice(0, 8), ...snap.manifold.slice(0, 8)].map((m) => ({
      question: m.question || m.text || '',
      probability: m.probability ?? (Array.isArray(m.outcomePrices) ? m.outcomePrices[0] : null),
      source: m.probability != null && !m.outcomePrices ? 'manifold' : 'polymarket',
    })),
    escalationScore: snap.escalationScore,
    updatedAt: Date.now(),
  };
  try {
    io.emit('predictions_update', state.predictionMarketsSnapshot);
  } catch (_) {
    /* */
  }
}

function inferExplicitOrefThreatAxis(alert) {
  if (!alert || typeof alert !== 'object') return null;

  const settlementKnown = alert.usedSettlementFallback === false;
  const blob =
    (typeof alert.orefTextBlob === 'string' && alert.orefTextBlob.trim()
      ? alert.orefTextBlob
      : [
          alert.title,
          alert.desc,
          alert.description,
          alert.subtitle,
          alert.msg,
          alert.message,
          alert.name,
          alert.data,
        ]
          .filter(Boolean)
          .join(' ')) || '';

  const fromText = matchExplicitThreatAxisInBlob(blob);
  if (fromText) {
    return {
      axis: fromText,
      fusionTier: 'oref_direct',
      trajectoryLocked: true,
      trajectoryConfidence: Math.min(0.98, 0.9 + (settlementKnown ? 0.06 : 0.04)),
      fusionSources: ['׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ג€” ׳˜׳§׳¡׳˜ ׳”׳×׳¨׳׳”'],
      sourceConfidence: 'official',
      sourceConfidenceScore: Math.min(0.99, 0.92 + (settlementKnown ? 0.04 : 0.02)),
    };
  }

  if (Array.isArray(orefPollContextAlerts) && orefPollContextAlerts.length > 0) {
    const mergedGroup = orefPollContextAlerts
      .map((a) => {
        if (a && typeof a.orefTextBlob === 'string' && a.orefTextBlob.trim()) return a.orefTextBlob.trim();
        return [a && a.title, a && a.desc, a && a.description].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join(' | ');
    const fromGroup = matchExplicitThreatAxisInBlob(mergedGroup);
    if (fromGroup) {
      const axisG = regionalAxisOverrideForNorthIsraelTarget(fromGroup, alert) || fromGroup;
      const geomG = axisG !== fromGroup;
      return {
        axis: axisG,
        fusionTier: geomG ? 'oref_group_geometry' : 'oref_group',
        trajectoryLocked: !geomG,
        trajectoryConfidence: Math.min(0.92, (geomG ? 0.76 : 0.82) + (settlementKnown ? 0.08 : 0.05)),
        fusionSources: geomG
          ? ['פיקוד העורף — ציר גל + תיקון גאוגרפי (צפון)']
          : ['פיקוד העורף — כלל ההתראות בפול'],
        sourceConfidence: geomG ? 'corroborated' : 'official',
        sourceConfidenceScore: Math.min(geomG ? 0.82 : 0.94, (geomG ? 0.66 : 0.84) + (settlementKnown ? 0.06 : 0.04)),
      };
    }
  }

  if (
    alert.sourceAxisHint &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(alert.sourceAxisHint)) /* Iran disabled */
  ) {
    const hintAx = String(alert.sourceAxisHint);
    const axisH = regionalAxisOverrideForNorthIsraelTarget(hintAx, alert) || hintAx;
    const geomH = axisH !== hintAx;
    return {
      axis: axisH,
      fusionTier: geomH ? 'poll_hint_geometry' : 'poll_hint',
      trajectoryLocked: !geomH,
      trajectoryConfidence: geomH ? 0.74 : 0.84,
      fusionSources: geomH
        ? ['הצלבת גל התראות + תיקון גאוגרפי (צפון)']
        : ['הצלבת מקורות גל ההתראות'],
      sourceConfidence: geomH ? 'corroborated' : alert.sourceAxisConfidence || 'corroborated',
      sourceConfidenceScore: geomH
        ? Math.min(0.8, 0.64 + (settlementKnown ? 0.06 : 0))
        : alert.sourceAxisConfidenceScore != null
          ? Number(alert.sourceAxisConfidenceScore)
          : 0.8,
    };
  }

  return null;
}

function inferOrefThreatAxis(alert) {
  const explicit = inferExplicitOrefThreatAxis(alert);
  if (explicit?.axis) return explicit.axis;
  return null;
}

function computeOrefPollAxisHint(effectiveAlerts, historySnapshot) {
  const axisVotes = new Map();
  (Array.isArray(effectiveAlerts) ? effectiveAlerts : []).forEach((alert) => {
    const text =
      (typeof alert?.orefTextBlob === 'string' && alert.orefTextBlob.trim()
        ? alert.orefTextBlob.trim()
        : [alert?.title, alert?.desc, alert?.description, alert?.message].filter(Boolean).join(' '));
    if (!text) return;
    const axis = matchExplicitThreatAxisInBlob(text);
    if (!axis) return;
    axisVotes.set(axis, (axisVotes.get(axis) || 0) + 1);
  });
  if (historySnapshot && historySnapshot.latestByCity instanceof Map) {
    historySnapshot.latestByCity.forEach((entry) => {
      const text = entry?.title || '';
      if (!text) return;
      const axis = matchExplicitThreatAxisInBlob(text);
      if (!axis) return;
      axisVotes.set(axis, (axisVotes.get(axis) || 0) + 0.5);
    });
  }
  let bestAxis = null;
  let bestVotes = 0;
  axisVotes.forEach((count, axis) => {
    if (count > bestVotes) {
      bestAxis = axis;
      bestVotes = count;
    }
  });
  if (bestAxis && bestVotes >= 2) {
    return {
      axis: bestAxis,
      sourceConfidence: 'corroborated',
      sourceConfidenceScore: 0.72,
    };
  }
  const isDistantAxis = bestAxis && ['iraq', 'yemen'].includes(bestAxis); /* Iran disabled */
  const alertCount = Array.isArray(effectiveAlerts) ? effectiveAlerts.length : 0;
  if (bestAxis && bestVotes >= 1 && isDistantAxis && axisVotes.size === 1 && alertCount >= 2) {
    return {
      axis: bestAxis,
      sourceConfidence: 'single_explicit',
      sourceConfidenceScore: 0.58,
    };
  }
  return null;
}

function inferTargetZoneFromText(blob) {
  const text = String(blob || '').trim();
  if (!text) return null;
  if (/(צפון|לצפון|גליל|גליל העליון|קריות|נהריה|מטולה|קריית שמונה|מלכיה|יראון|דפנה|בית הלל|הגושרים|שאר ישוב|כפר גלעדי|אביבים|זרעית)/i.test(text)) {
    return 'north';
  }
  if (/(מרכז|למרכז|גוש\s*דן|תל אביב|נתניה|כפר יונה|אבן יהודה|שפיים|רמת גן|הרצליה|פתח תקווה|שפלה|שרון|חדרה|ראשון לציון)/i.test(text)) {
    return 'center';
  }
  if (/(דרום|לדרום|נגב|באר שבע|אילת|ערבה|אשקלון|אשדוד|עוטף|שדרות|נתיבות|אופקים)/i.test(text)) {
    return 'south';
  }
  if (/(ירושלים|הרי ירושלים|שפלת ירושלים|מבשרת)/i.test(text)) {
    return 'jerusalem';
  }
  return null;
}

function inferTargetZoneFromCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = normalizeLngLat(coords);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat >= 32.75) return 'north';
  if (lat <= 31.6) return 'south';
  if (lat >= 31.65 && lat <= 31.95 && lng >= 35.0 && lng <= 35.35) return 'jerusalem';
  return 'center';
}

function inferAlertTargetZone(alert) {
  if (!alert || typeof alert !== 'object') return null;
  const fromText = inferTargetZoneFromText(
    [alert.cityName, alert.title, alert.desc, alert.description, alert.message, alert.orefTextBlob]
      .filter(Boolean)
      .join(' ')
  );
  if (fromText) return fromText;
  if (Array.isArray(alert.targetPosition)) return inferTargetZoneFromCoordinates(alert.targetPosition);
  if (Array.isArray(alert.coordinates)) return inferTargetZoneFromCoordinates(alert.coordinates);
  const cityCoords = alert.cityName ? getReliableCityCoordinates(alert.cityName) : null;
  if (cityCoords) return inferTargetZoneFromCoordinates([cityCoords.lng, cityCoords.lat]);
  return null;
}

/** צירים ארוכי־טווח — כשהצבעה מגל ההתראות טועה, לא לכפות על יעד בצפון */
function isDistantThreatAxisForRegionalOverride(axis) {
  const a = String(axis || '').toLowerCase();
  return a === 'iraq' || a === 'yemen'; /* Iran disabled - was: a === 'iran' || a === 'iraq' || a === 'yemen' */
}

function nearestLebanonOrSyriaAxisForTargetLngLat(_tp) {
  return 'lebanon';
}

/**
 * כמו IWM: אם אין "מאיראן" בטקסט ההתרעה של היישוב אבל גל ההתראות שייך לאיראן/עיראק/תימן —
 * ליעד בצפון/מרכז/ירושלים נעדיף מוצא מלבנון (לא מסוריה — מדיניות מוצא אחיד).
 */
function regionalAxisOverrideForNorthIsraelTarget(distantAxis, alert) {
  if (!alert || !isDistantThreatAxisForRegionalOverride(distantAxis)) return null;
  if (String(alert.threatType || 'missile') === 'uav') return null;
  const tp = getTargetPosition(alert);
  if (!tp || tp.length < 2) return null;
  const lng = Number(tp[0]);
  const lat = Number(tp[1]);
  if (!isPlausibleIsraelAlertTarget(lng, lat)) return null;
  const zone = inferTargetZoneFromCoordinates(tp);
  if (zone !== 'north' && zone !== 'center' && zone !== 'jerusalem') return null;
  return nearestLebanonOrSyriaAxisForTargetLngLat(tp);
}

function isLebanonFirstGeographicZone(zone) {
  return zone === 'north' || zone === 'center' || zone === 'jerusalem';
}

/** כתבות/מקורות OSINT עם ניסוח מפורש (מאיראן / מעיראק / מתימן) — מאפשרים לעדכן מסלול מעבר לברירת מחדל לבנון */
function newsAndOsintExplicitlyConfirmDistantAxis(axis) {
  const ax = String(axis || '').toLowerCase();
  if (!['iraq', 'yemen'].includes(ax)) return false; /* Iran disabled */
  const corp = String(newsThreatAxisBlob || '').trim();
  if (corp && matchExplicitThreatAxisInBlob(corp) === ax) return true;
  try {
    const snap = getOsintDebugSnapshot();
    const hints = Array.isArray(snap?.matchedHints) ? snap.matchedHints : [];
    for (let i = 0; i < hints.length; i++) {
      const h = hints[i];
      if (!h || String(h.axis || '').toLowerCase() !== ax) continue;
      const chunk = [h.text, h.sourcePattern, h.targetPattern].filter(Boolean).join(' ');
      if (chunk && matchExplicitThreatAxisInBlob(chunk) === ax) return true;
    }
  } catch (_) {
    /* */
  }
  return false;
}

/**
 * ברירת מחדל גאופוליטית: הפסקת אש עם איראן — רוב הירי לצפון/מרכז מלבנון; לדרום, טילים רחוקי־טווח
 * סבירים יותר מתימן מאשר מאיראן. שומרים ציר רחוק רק אם פיקוד (טקסט התרעה), או כתבות/OSINT מפורשים,
 * או אימות רב־מקור (Telegram+Oref).
 */
function applyCeasefireBallisticLaunchPrior(alert, axis) {
  if (!alert || axis == null || axis === '') return axis;
  const ax = String(axis).toLowerCase();
  if (launchAiGeometryPreferred(alert)) return axis;
  if (String(alert.threatType || 'missile') === 'uav') return axis;
  const tp = getTargetPosition(alert);
  if (!tp || tp.length < 2) return axis;
  if (!isPlausibleIsraelAlertTarget(Number(tp[0]), Number(tp[1]))) return axis;

  if (
    alert._multiSourceConfirmed === true &&
    String(alert._multiSourceAxis || '').toLowerCase() === ax &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(ax) /* Iran disabled */
  ) {
    return axis;
  }

  const zone = inferTargetZoneFromCoordinates(tp);

  const blob =
    (typeof alert.orefTextBlob === 'string' && alert.orefTextBlob.trim()
      ? alert.orefTextBlob.trim()
      : [
          alert.title,
          alert.desc,
          alert.description,
          alert.subtitle,
          alert.msg,
          alert.message,
        ]
          .filter(Boolean)
          .join(' ')) || '';
  const explicitOnAlert = blob ? matchExplicitThreatAxisInBlob(blob) : null;
  if (explicitOnAlert === ax) return axis;
  if (newsAndOsintExplicitlyConfirmDistantAxis(ax)) return axis;

  if (isLebanonFirstGeographicZone(zone)) {
    if (!isDistantThreatAxisForRegionalOverride(ax)) return axis;
    return nearestLebanonOrSyriaAxisForTargetLngLat(tp);
  }

  if (zone === 'south' && (ax === 'iran' || ax === 'iraq')) {
    return 'yemen';
  }

  return axis;
}

function inferOsintTargetZone(osintAxisHint) {
  const hints = Array.isArray(osintAxisHint?.matchedHints) ? osintAxisHint.matchedHints : [];
  const votes = new Map();
  hints.forEach((hint) => {
    if (!hint?.axis || !hint?.targetZone) return;
    if (osintAxisHint?.axis && hint.axis !== osintAxisHint.axis) return;
    votes.set(hint.targetZone, (votes.get(hint.targetZone) || 0) + 1);
  });
  let bestZone = null;
  let bestCount = 0;
  votes.forEach((count, zone) => {
    if (count > bestCount) {
      bestCount = count;
      bestZone = zone;
    }
  });
  return bestZone;
}

function getOsintAxisEvidenceCount(axis, targetZone = null) {
  if (!axis) return 0;
  try {
    const snapshot = getOsintDebugSnapshot();
    const hints = Array.isArray(snapshot?.matchedHints) ? snapshot.matchedHints : [];
    return hints.filter((hint) => {
      if (!hint || hint.axis !== axis) return false;
      if (!targetZone) return true;
      return !hint.targetZone || hint.targetZone === targetZone;
    }).length;
  } catch (_) {
    return 0;
  }
}

function isCurrentCorroboratedSourceStillValid(entity) {
  if (!entity || entity.sourceConfidence !== 'corroborated' || !entity.sourceRegion) return false;
  const osintAxis = getOsintAxisHintSync();
  if (!osintAxis?.axis || osintAxis.axis !== entity.sourceRegion) return false;
  const alertTargetZone = inferAlertTargetZone(entity);
  const osintTargetZone = inferOsintTargetZone(osintAxis);
  const hasMatchingZone = !alertTargetZone || !osintTargetZone || alertTargetZone === osintTargetZone;
  if (!hasMatchingZone) return false;
  const corroboratedEvidenceCount = getOsintAxisEvidenceCount(entity.sourceRegion, alertTargetZone || osintTargetZone || null);
  const isDistantAxis = ['iraq', 'yemen'].includes(entity.sourceRegion); /* Iran disabled */
  const confidence = Number(osintAxis.confidence || 0);
  return isDistantAxis
    ? confidence >= 0.42 && corroboratedEvidenceCount >= 3
    : confidence >= 0.32 && corroboratedEvidenceCount >= 3;
}

function sanitizeEntityTrustedSource(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  if (entity.sourceConfidence === 'official') return entity;
  if (entity.sourceConfidence === 'corroborated' && isCurrentCorroboratedSourceStillValid(entity)) return entity;
  if (entity.sourceConfidence === 'telegram_ai' && Number(entity.sourceConfidenceScore) >= 0.65) return entity;
  return {
    ...entity,
    sourceRegion: null,
    sourceLocation: 'מקור לא מאומת',
    sourceConfidence: 'estimated',
    sourceConfidenceScore:
      entity?.sourceConfidenceScore != null ? Math.min(Number(entity.sourceConfidenceScore) || 0.38, 0.38) : 0.38,
  };
}

/** ׳׳“׳™׳ ׳×/׳׳–׳•׳¨ ׳׳•׳¦׳: ׳§׳•׳“׳ ׳˜׳§׳¡׳˜ ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (׳׳“׳•׳™׳§), ׳׳—׳¨ ׳›׳ ׳’׳׳•׳׳˜׳¨׳™׳” */
function getCorroboratedOsintAxis(alert) {
  try {
    const osintHint = getOsintAxisHintSync();
    if (!osintHint?.axis) return null;
    if (String(osintHint.axis).toLowerCase() === 'iran') return null;
    const confidence = Number(osintHint.confidence || 0);
    const evidenceCount = getOsintAxisEvidenceCount(osintHint.axis, inferAlertTargetZone(alert));
    const isDistant = ['iraq', 'yemen'].includes(osintHint.axis);
    if (isDistant) {
      return confidence >= 0.42 && evidenceCount >= 3 ? osintHint.axis : null;
    }
    return confidence >= 0.32 && evidenceCount >= 3 ? osintHint.axis : null;
  } catch (_) {
    return null;
  }
}

function getGdeltCorroborationAxisSync(alert) {
  const h = getGdeltCorroborationForAlert(alert);
  return h?.axis || null;
}

/** מסלולי מפה: לא מוצא עזה; לא מוצגת איראן — עזה/איראן ממופים לתימן (ארוך טווח ללא שיגור מאיראן במפה) */
const GAZA_BALLISTIC_MAP_ORIGIN_DISABLED = true;

function mapMissileDisplaySourceRegion(region) {
  if (region == null || region === '') return region;
  const r = String(region).toLowerCase();
  if (r === 'syria') return 'lebanon';
  if (r === 'iran') return 'yemen';
  if (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && r === 'gaza') return 'yemen';
  return region;
}

function launchGeometryAlert(orefAlert, missile) {
  const a = orefAlert && typeof orefAlert === 'object' ? { ...orefAlert } : {};
  if (
    missile &&
    missile.launchAiAxis &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(missile.launchAiAxis)) /* Iran disabled */
  ) {
    a.launchAiAxis = String(missile.launchAiAxis);
    a.launchAiConfidence = Number(missile.launchAiConfidence) || 0;
  }
  return a;
}

/** האם מנוע חקירת השיגור (AI) שולט על מיקום מוצא במפה לפי ביטחון */
function launchAiGeometryPreferred(alert) {
  const aiAx = alert?.launchAiAxis;
  const c = Number(alert?.launchAiConfidence) || 0;
  if (!aiAx || !['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(aiAx)) /* Iran disabled */) {
    return false;
  }
  const minWeak = Math.max(0.55, Number(process.env.LAUNCH_AXIS_AI_MIN_CONFIDENCE) || 0.72);
  const minStrong = Math.max(minWeak + 0.08, Number(process.env.LAUNCH_AXIS_AI_STRONG_CONFIDENCE) || 0.85);
  if (c >= minStrong) return true;
  if (process.env.LAUNCH_AXIS_AI_OVERRIDE_OFFICIAL === '1' && c >= minWeak + 0.05) return true;
  if (c < minWeak) return false;
  const explicit = inferExplicitOrefThreatAxis(alert);
  return !explicit?.axis;
}

function resolveSourceRegionFromAlert(alert, sourcePosition, targetPosition) {
  if (launchAiGeometryPreferred(alert)) {
    return mapMissileDisplaySourceRegion(String(alert.launchAiAxis));
  }
  const inferredAxis = inferOrefThreatAxis(alert);
  if (inferredAxis) {
    return mapMissileDisplaySourceRegion(applyCeasefireBallisticLaunchPrior(alert, inferredAxis));
  }
  const osintAxis = getCorroboratedOsintAxis(alert);
  if (osintAxis) {
    return mapMissileDisplaySourceRegion(applyCeasefireBallisticLaunchPrior(alert, osintAxis));
  }
  if (
    alert.telegramAiAxis &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(alert.telegramAiAxis)) /* Iran disabled */ &&
    Number(alert.telegramAiConfidence) >= 0.7
  ) {
    return mapMissileDisplaySourceRegion(
      applyCeasefireBallisticLaunchPrior(alert, String(alert.telegramAiAxis))
    );
  }
  const gdAxis = getGdeltCorroborationAxisSync(alert);
  if (gdAxis) {
    return mapMissileDisplaySourceRegion(applyCeasefireBallisticLaunchPrior(alert, gdAxis));
  }
  return mapMissileDisplaySourceRegion(
    applyCeasefireBallisticLaunchPrior(alert, getSourceRegion(sourcePosition, targetPosition))
  );
}

const THREAT_LAUNCH_CANDIDATES = [
  { lng: LEBANON_ROUTE_ANCHOR.lng, lat: LEBANON_ROUTE_ANCHOR.lat, frac: 0.12 },
  { lng: 44.2, lat: 15.35, frac: 0.055 },
  { lng: 44.58, lat: 33.32, frac: 0.13 },
  { lng: 51.28, lat: 32.52, frac: 0.11 },
];

/**
 * ׳›׳©׳׳™׳ ׳‘ײ¾Oref ׳¦׳™׳¨ ׳׳₪׳•׳¨׳© ג€” ׳‘׳•׳—׳¨׳™׳ ׳¢׳•׳’׳ ׳׳™׳•׳ ׳’׳׳•׳’׳¨׳₪׳™׳× ׳”׳§׳¨׳•׳‘ ׳׳™׳¢׳“ (׳›׳ ׳¢׳™׳¨ ׳‘׳™׳©׳¨׳׳ ׳™׳›׳•׳׳” ׳׳§׳‘׳ ׳׳¡׳׳•׳ ׳׳›׳ ׳›׳™׳•׳•׳ ׳›׳©׳”׳˜׳§׳¡׳˜ ׳׳’׳“׳™׳¨).
 */
function getSourcePositionNearestThreatArc(targetPosition) {
  const [tlng, tlat] = normalizeLngLat(targetPosition);
  if (!isPlausibleSupportedAlertTarget(tlng, tlat)) {
    return [35.5, 33.8]; /* Default to Lebanon - most launches are from Lebanon */
  }
  let bestPt = THREAT_LAUNCH_CANDIDATES[0];
  let bestD = Infinity;
  for (const c of THREAT_LAUNCH_CANDIDATES) {
    const d = haversineKm([c.lng, c.lat], [tlng, tlat]);
    if (d < bestD) {
      bestD = d;
      bestPt = c;
    }
  }
  return [bestPt.lng, bestPt.lat];
}

function getSourcePositionStrategic(targetPosition, axis, threatType) {
  let effAxis = String(axis).toLowerCase();
  if (effAxis === 'iran') effAxis = 'yemen';
  if (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && effAxis === 'gaza') effAxis = 'yemen';
  if (effAxis === 'syria') effAxis = 'lebanon';
  const isUav = threatType === 'uav';
  const anchors = {
    iran: { lng: 51.28, lat: 32.52, frac: isUav ? 0.09 : 0.11 },
    iraq: { lng: 44.58, lat: 33.32, frac: isUav ? 0.12 : 0.14 },
    yemen: { lng: 44.2, lat: 15.35, frac: isUav ? 0.05 : 0.055 },
    lebanon: { lng: LEBANON_ROUTE_ANCHOR.lng, lat: LEBANON_ROUTE_ANCHOR.lat, frac: isUav ? 0.1 : 0.12 },
  };
  const a = anchors[effAxis];
  if (!a) return getSourcePositionNearestThreatArc(targetPosition);
  return [a.lng, a.lat];
}

/**
 * ׳׳™׳§׳•׳ ׳׳•׳¦׳: ׳§׳•׳“׳ ׳›׳ ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (׳˜׳§׳¡׳˜ ׳׳׳), ׳׳—׳¨ ׳›׳ OREF_DEFAULT_THREAT_AXIS ׳‘׳¡׳‘׳™׳‘׳”, ׳׳—׳¨ ׳›׳ ׳¢׳•׳’׳ ׳§׳¨׳•׳‘ (׳׳ "׳—׳™׳₪׳”=׳¨׳§ ׳׳‘׳ ׳•׳").
 */
function resolveSourcePosition(alert, targetPosition) {
  if (launchAiGeometryPreferred(alert)) {
    let eff = String(alert.launchAiAxis).toLowerCase();
    if (eff === 'iran') eff = 'yemen';
    if (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && eff === 'gaza') eff = 'yemen';
    if (eff === 'syria') eff = 'lebanon';
    return getSourcePositionStrategic(targetPosition, eff, alert?.threatType);
  }
  const envRaw = process.env.OREF_DEFAULT_THREAT_AXIS;
  const envAxisRaw =
    envRaw && ['iran', 'iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(envRaw).toLowerCase())
      ? String(envRaw).toLowerCase()
      : null;
  let envAxis = envAxisRaw;
  if (envAxis === 'iran') envAxis = 'yemen';
  if (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && envAxis === 'gaza') envAxis = 'yemen';
  const inferred = inferOrefThreatAxis(alert);
  let inferredEff = inferred;
  if (inferredEff === 'iran') inferredEff = 'yemen';
  const axis = (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && inferred === 'gaza' ? 'yemen' : inferredEff) || envAxis;
  if (axis) {
    const axisEff = applyCeasefireBallisticLaunchPrior(alert, axis);
    return getSourcePositionStrategic(targetPosition, axisEff, alert?.threatType);
  }
  const osintAxis = getCorroboratedOsintAxis(alert);
  if (osintAxis) {
    let oAx = osintAxis === 'iran' ? 'yemen' : osintAxis;
    if (GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && oAx === 'gaza') oAx = 'yemen';
    const oEff = applyCeasefireBallisticLaunchPrior(alert, oAx);
    return getSourcePositionStrategic(targetPosition, oEff, alert?.threatType);
  }
  if (
    alert.telegramAiAxis &&
    ['iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(String(alert.telegramAiAxis)) /* Iran disabled */ &&
    Number(alert.telegramAiConfidence) >= 0.7
  ) {
    const tgAx = String(alert.telegramAiAxis);
    const tgEff = applyCeasefireBallisticLaunchPrior(
      alert,
      GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && tgAx === 'gaza' ? 'yemen' : tgAx === 'iran' ? 'yemen' : tgAx
    );
    return getSourcePositionStrategic(targetPosition, tgEff, alert?.threatType);
  }
  const gdAxis = getGdeltCorroborationAxisSync(alert);
  if (gdAxis) {
    const gEff = applyCeasefireBallisticLaunchPrior(
      alert,
      GAZA_BALLISTIC_MAP_ORIGIN_DISABLED && gdAxis === 'gaza' ? 'yemen' : gdAxis === 'iran' ? 'yemen' : gdAxis
    );
    return getSourcePositionStrategic(targetPosition, gEff, alert?.threatType);
  }
  return getSourcePosition(targetPosition);
}

function getSourcePosition(targetPosition) {
  const [lng, lat] = normalizeLngLat(targetPosition);
  const inSupportedRegion = isPlausibleSupportedAlertTarget(lng, lat);

  if (inSupportedRegion) {
    return getSourcePositionNearestThreatArc(targetPosition);
  }
  return getSourcePositionNearestThreatArc(targetPosition);
}

function getSourceRegion(sourcePosition, targetPosition) {
  const [sourceLng, sourceLat] = normalizeLngLat(sourcePosition);
  const anchors = [
    { region: 'lebanon', lng: LEBANON_ROUTE_ANCHOR.lng, lat: LEBANON_ROUTE_ANCHOR.lat },
    ...(GAZA_BALLISTIC_MAP_ORIGIN_DISABLED ? [] : [{ region: 'gaza', lng: 34.35, lat: 31.35 }]),
    { region: 'yemen', lng: 44.2, lat: 15.35 },
    { region: 'iraq', lng: 44.58, lat: 33.32 },
  ];

  let best = anchors[0];
  let bestDistance = Infinity;
  for (const anchor of anchors) {
    const d = haversineKm([sourceLng, sourceLat], [anchor.lng, anchor.lat]);
    if (d < bestDistance) {
      bestDistance = d;
      best = anchor;
    }
  }

  return best.region;
}

function haversineKm([lng1, lat1], [lng2, lat2]) {
  [lng1, lat1] = normalizeLngLat([lng1, lat1]);
  [lng2, lat2] = normalizeLngLat([lng2, lat2]);
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLebanonMissileFlightMs(distanceKm) {
  const ksCoords =
    CRITICAL_SETTLEMENT_COORD_OVERRIDES['קרית שמונה'] ||
    CRITICAL_SETTLEMENT_COORD_OVERRIDES['קריית שמונה'] ||
    { lat: 33.2079, lng: 35.5702 };
  const lebanonAnchor = [LEBANON_ROUTE_ANCHOR.lng, LEBANON_ROUTE_ANCHOR.lat];
  const ksPoint = [Number(ksCoords.lng), Number(ksCoords.lat)];
  const calibrationDistanceKm = Math.max(1, haversineKm(lebanonAnchor, ksPoint));
  const secondsPerKm = 10 / calibrationDistanceKm; // כיול: לבנון -> קרית שמונה ≈ 10 שניות
  const estimatedMs = Number(distanceKm) * secondsPerKm * 1000;
  return Math.round(clamp(estimatedMs, 8000, 8 * 60 * 1000));
}

function getEstimatedFlightMs(sourcePosition, targetPosition, threatType = 'missile', alert = null) {
  const region = alert
    ? resolveSourceRegionFromAlert(alert, sourcePosition, targetPosition)
    : getSourceRegion(sourcePosition, targetPosition);
  const distanceKm = haversineKm(sourcePosition, targetPosition);

  if (region === 'lebanon' && threatType !== 'uav') {
    return {
      region,
      distanceKm: Math.round(distanceKm),
      flightMs: getLebanonMissileFlightMs(distanceKm),
    };
  }

  const profile = getThreatTimingProfile(region, threatType);
  const estimatedMs = (distanceKm / profile.speedKmPerSec) * 1000;

  return {
    region,
    distanceKm: Math.round(distanceKm),
    flightMs: Math.round(clamp(estimatedMs, profile.minMs, profile.maxMs)),
  };
}

function getSourceRegionLabel(region) {
  const labels = {
    lebanon: 'לבנון',
    syria: 'סוריה',
    gaza: 'עזה',
    yemen: 'תימן',
    iraq: 'עיראק',
    iran: 'איראן',
  };

  return labels[region] || 'מקור משוער';
}

function shouldRenderCountryLaunchTrajectory(sourceConfidence) {
  return (
    sourceConfidence === 'official' ||
    sourceConfidence === 'corroborated' ||
    sourceConfidence === 'telegram_ai'
  );
}

function isTrustedSourceConfidence(sourceConfidence) {
  return (
    sourceConfidence === 'official' ||
    sourceConfidence === 'corroborated' ||
    sourceConfidence === 'telegram_ai'
  );
}

function getUnverifiedSourcePosition(targetPosition) {
  const zone = inferTargetZoneFromCoordinates(targetPosition);
  switch (zone) {
    case 'north':
      return [34.92, 33.34];
    case 'south':
      return [34.18, 31.03];
    case 'jerusalem':
      return [34.92, 31.96];
    case 'center':
    default:
      return [34.28, 32.11];
  }
}

/** יישור sourceRegion/sourceLocation לפי נקודות המסלול (ללא מוצא איראן במפה — ממופה לתימן ב-mapMissileDisplaySourceRegion) */
function syncMissileSourceFromGeometry(missileEvent) {
  if (!missileEvent || typeof missileEvent !== 'object') return;
  const sp = missileEvent.sourcePosition || missileEvent.source;
  const tp = missileEvent.targetPosition || missileEvent.target;
  if (!Array.isArray(sp) || sp.length < 2 || !Array.isArray(tp) || tp.length < 2) return;
  const region = missileEvent.alertContext
    ? resolveSourceRegionFromAlert(missileEvent.alertContext, sp, tp)
    : getSourceRegion(sp, tp);
  missileEvent.sourceRegion = region;
  missileEvent.sourceLocation = getSourceRegionLabel(region);
}

function coordsRoughlyEqual(a, b, eps = 0.0004) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return false;
  return Math.abs(Number(a[0]) - Number(b[0])) < eps && Math.abs(Number(a[1]) - Number(b[1])) < eps;
}

/**
 * ׳‘׳›׳ ׳₪׳•׳׳™׳ ׳’ ג€” ׳׳¢׳“׳›׳ ׳˜׳™׳/׳׳¡׳׳•׳ ׳§׳™׳™׳ ׳׳₪׳™ ׳”׳”׳×׳¨׳׳” ׳”׳¢׳“׳›׳ ׳™׳× ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (׳’׳™׳׳•׳§׳•׳“, ׳¦׳™׳¨ ׳˜׳§׳¡׳˜).
 * ׳›׳ ׳›׳ ׳¢׳™׳¨ ׳₪׳¢׳™׳׳” ׳ ׳©׳׳¨׳× ׳׳—׳•׳‘׳¨׳× ׳׳׳¡׳׳•׳ ׳ ׳›׳•׳ ׳’׳ ׳׳—׳¨׳™ ׳×׳™׳§׳•׳ ׳§׳•׳׳•׳¨׳“׳™׳ ׳˜׳•׳× ׳׳• ׳©׳™׳ ׳•׳™ ׳ ׳™׳¡׳•׳—.
 */
/** זמן מרבי לעדכון אותו טיל מאותה הודעת Oref; מעבר לכך — נחשב שיגור נפרד (מסלול נפרד במפה) */
const OREF_MISSILE_SAME_WAVE_MAX_MS = 50 * 1000;

function findMissileForOrefAlertUpdate(alert) {
  if (!alert?.cityName) return null;
  const cityNorm =
    normalizeHebrewSettlementName(String(alert.cityName).trim()) || String(alert.cityName).trim();
  const candidates = [...activeMissilesById.values()].filter((m) => {
    if (!m?.cityName) return false;
    const mn =
      normalizeHebrewSettlementName(String(m.cityName).trim()) || String(m.cityName).trim();
    return mn === cityNorm;
  });
  if (candidates.length === 0) return null;

  const alertGid =
    alert.orefAlertGroupId != null && String(alert.orefAlertGroupId).length > 0
      ? String(alert.orefAlertGroupId)
      : null;
  if (alertGid) {
    const byGid = candidates.find(
      (m) =>
        m.orefAlertGroupId != null && String(m.orefAlertGroupId).length > 0 && String(m.orefAlertGroupId) === alertGid
    );
    if (byGid) return byGid;
  }

  const alertOt = Number(alert.orefTimeMs);
  if (!Number.isFinite(alertOt)) return candidates.length === 1 ? candidates[0] : null;

  let best = null;
  let bestDelta = Infinity;
  for (const m of candidates) {
    const mot = Number(m.orefTimeMs);
    if (!Number.isFinite(mot)) continue;
    const d = Math.abs(mot - alertOt);
    if (d <= OREF_MISSILE_SAME_WAVE_MAX_MS && d < bestDelta) {
      bestDelta = d;
      best = m;
    }
  }
  return best;
}

function syncActiveMissileGeometryFromOrefAlert(alert, sourcePosition, targetPosition) {
  if (!alert?.cityName) return;
  const missile = findMissileForOrefAlertUpdate(alert);
  if (!missile) return;

  const phaseBefore = missile.alertPhase;

  const geomAlert = launchGeometryAlert(alert, missile);
  const resolvedSource = resolveSourcePosition(geomAlert, targetPosition);
  sourcePosition = resolvedSource;

  const fusion = computeThreatFusionResult(alert);
  const explicitAxis = inferExplicitOrefThreatAxis(alert)?.axis || null;
  const timing = getEstimatedFlightMs(
    sourcePosition,
    targetPosition,
    alert.threatType || 'missile',
    geomAlert
  );
  const travelMs = timing.flightMs;
  const displayFlightMs = getDisplayFlightMs(timing.region, alert.threatType || 'missile', travelMs);
  const earlyWarning = inferOrefEarlyWarning(alert);
  const orefTrajectoryLeadFraction = getDisplayLeadFraction(
    timing.region,
    alert.threatType || 'missile',
    earlyWarning
  );
  const displayElapsedMs = computeDisplayElapsedMs(
    displayFlightMs,
    alert.threatType || 'missile',
    timing.region,
    earlyWarning
  );
  const inferredPhase = inferOrefAlertPhase(alert);

  const prevRegion = missile.sourceRegion;
  const prevLocked = missile.trajectoryLocked;
  const prevT = missile.targetPosition || missile.target;
  const prevS = missile.sourcePosition || missile.source;
  const shouldRenderTrajectory = shouldRenderCountryLaunchTrajectory(
    fusion.sourceConfidence || 'estimated'
  );

  let trajectoryLocked = fusion.trajectoryLocked;
  let fusionTier = fusion.fusionTier;
  let fusionSources = Array.isArray(fusion.fusionSources) ? [...fusion.fusionSources] : [];
  let trajectoryConfidence = fusion.trajectoryConfidence;
  let sourceConfidenceScore =
    fusion.sourceConfidenceScore != null ? fusion.sourceConfidenceScore : fusion.trajectoryConfidence;

  if (launchAiGeometryPreferred(geomAlert)) {
    const lc = Number(missile.launchAiConfidence) || 0;
    fusionTier = 'ai_launch_investigation';
    const ev = Array.isArray(missile.launchAiEvidence) ? missile.launchAiEvidence : [];
    fusionSources = [
      `חקירת שיגור AI (${(lc * 100).toFixed(0)}%)`,
      ...ev.slice(0, 5).map((e) => `ראיה: ${String(e).slice(0, 140)}`),
      ...fusionSources,
    ].slice(0, 12);
    const lockMin = Number(process.env.LAUNCH_AXIS_AI_LOCK_MIN_CONFIDENCE);
    const lockThresh = Number.isFinite(lockMin) && lockMin > 0 && lockMin <= 1 ? lockMin : 0.76;
    trajectoryLocked = lc >= lockThresh || fusion.trajectoryLocked;
    trajectoryConfidence = Math.max(trajectoryConfidence || 0, lc * 0.95);
    sourceConfidenceScore = Math.max(sourceConfidenceScore || 0, lc);
  }
  if (missile.launchOriginAxisLocked === true && launchAiGeometryPreferred(geomAlert)) {
    trajectoryLocked = true;
  }

  missile.sourcePosition = sourcePosition;
  missile.targetPosition = targetPosition;
  missile.source = sourcePosition;
  missile.target = targetPosition;
  missile.threatAxisFromOref = explicitAxis;
  missile.alertContext = {
    cityName: alert.cityName,
    title: alert.title,
    threatType: alert.threatType,
    orefTextBlob: alert.orefTextBlob,
    usedSettlementFallback: alert.usedSettlementFallback,
  };
  missile.trajectoryLocked = trajectoryLocked;
  missile.trajectoryConfidence = trajectoryConfidence;
  missile.fusionTier = fusionTier;
  missile.fusionSources = fusionSources;
  missile.sourceConfidence = fusion.sourceConfidence || 'estimated';
  missile.sourceConfidenceScore = sourceConfidenceScore;
  missile.targetSettlementConfidence = fusion.targetSettlementConfidence;
  missile.flightMs = travelMs;
  missile.displayFlightMs = displayFlightMs;
  missile.displayElapsedMs = displayElapsedMs;
  missile.displayLeadFraction = displayFlightMs > 0 ? displayElapsedMs / displayFlightMs : 0;
  missile.orefTrajectoryLeadFraction = orefTrajectoryLeadFraction;
  missile.estimatedDistanceKm = timing.distanceKm;
  if (getAlertPhaseRank(inferredPhase) > getAlertPhaseRank(missile.alertPhase)) {
    missile.alertPhase = inferredPhase;
  }

  missile.sourceRegion = timing.region;
  missile.sourceLocation = getSourceRegionLabel(timing.region);
  syncMissileSourceFromGeometry(missile);
  upsertActiveAlertDetail({
    cityName: missile.cityName,
    alertPhase: missile.alertPhase || inferredPhase,
  });

  if (missile.threatType === 'uav' && Array.isArray(missile.routePoints) && missile.routePoints.length > 0) {
    missile.routePoints = appendUniqueRoutePoint([...missile.routePoints], targetPosition);
  }

  storeActiveMissile(missile);

  const geomChanged =
    !coordsRoughlyEqual(prevT, targetPosition) ||
    !coordsRoughlyEqual(prevS, sourcePosition) ||
    prevRegion !== missile.sourceRegion ||
    prevLocked !== trajectoryLocked;
  const phaseUpgraded = getAlertPhaseRank(missile.alertPhase) > getAlertPhaseRank(phaseBefore);

  if (geomChanged || phaseUpgraded) {
    clearMissileTimers(missile.id);
    scheduleMissileLifecycle(missile);
    try {
      scheduleOrefClientSocketEmit(() => {
        try {
          io.emit('real_time_missile', missile);
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * ׳׳—׳¨׳™ ׳™׳¦׳™׳¨׳× salvo: ׳׳›׳ ׳¢׳™׳¨ ׳׳”׳₪׳•׳ ׳”׳ ׳•׳›׳—׳™ + ׳׳›׳ ׳¢׳™׳¨ ׳‘׳—׳–׳§׳× hold (׳’׳ ׳›׳©׳”-JSON ׳¨׳™׳§ ׳׳¨׳’׳¢) ג€”
 * ׳•׳™׳“׳•׳ ׳©׳™׳© ׳˜׳™׳/׳׳¡׳׳•׳ ׳•׳¢׳“׳›׳•׳ ׳’׳׳•׳׳˜׳¨׳™׳”. ׳›׳ ׳›׳ ׳”׳×׳¨׳׳× Oref ׳₪׳¢׳™׳׳” ׳׳—׳•׳‘׳¨׳× ׳׳׳₪׳”.
 */
function finalizeAllActiveOrefTrajectories(normalizedAlerts, nextActiveCities) {
  const fromCurrentPoll = new Set();
  (normalizedAlerts || []).forEach((alert) => {
    if (!alert?.cityName || String(alert.cityName).trim().length < 2) return;
    fromCurrentPoll.add(alert.cityName);
    const targetPosition = getTargetPosition(alert);
    if (
      !targetPosition ||
      !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
    ) {
      return;
    }
    const fusion = computeThreatFusionResult(alert);
    const missilePre = findMissileForOrefAlertUpdate(alert);
    const geomAlert0 = launchGeometryAlert(alert, missilePre);
    const rawSourcePosition = resolveSourcePosition(geomAlert0, targetPosition);
    const sourcePosition = rawSourcePosition;
    const sr = resolveSourceRegionFromAlert(geomAlert0, sourcePosition, targetPosition);
    const hasWaveMissile = missilePre != null;
    if (!hasWaveMissile) {
      ensureThreatExistsForCity(
        { ...alert, targetPosition, sourcePosition },
        sr,
        getSourceRegionLabel(sr),
        { skipMissileIfFresh: false }
      );
    }
    syncActiveMissileGeometryFromOrefAlert(alert, sourcePosition, targetPosition);
  });

  (nextActiveCities || []).forEach((cityName) => {
    if (!cityName || fromCurrentPoll.has(cityName)) return;
    const detail = activeAlertDetailsByCity.get(cityName);
    if (!detail) return;
    const alert = {
      cityName,
      title: detail.title || '׳”׳×׳¨׳׳”',
      coordinates: detail.coordinates,
      threatType: detail.threatType || 'missile',
      orefTextBlob: detail.orefTextBlob,
      orefTimeMs: detail.orefTimeMs != null ? detail.orefTimeMs : Date.now(),
      receivedAtMs: detail.receivedAtMs != null ? detail.receivedAtMs : Date.now(),
      orefCategory: detail.orefCategory != null ? detail.orefCategory : null,
    };
    const targetPosition = getTargetPosition(alert);
    if (
      !targetPosition ||
      !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
    ) {
      return;
    }
    const holdAlert = { ...alert, targetPosition };
    const missileHold = findMissileForOrefAlertUpdate(holdAlert);
    const geomHold = launchGeometryAlert(holdAlert, missileHold);
    const rawSourcePosition =
      (Array.isArray(detail?.sourcePosition) && detail.sourcePosition.length >= 2
        ? normalizeLngLat(detail.sourcePosition)
        : null) || resolveSourcePosition(geomHold, targetPosition);
    const sourcePosition = rawSourcePosition;
    const sr = resolveSourceRegionFromAlert(geomHold, sourcePosition, targetPosition);
    const holdAlertFull = { ...alert, targetPosition, sourcePosition };
    const hasWaveMissileHold = missileHold != null;
    if (!hasWaveMissileHold) {
      ensureThreatExistsForCity(holdAlertFull, sr, getSourceRegionLabel(sr), { skipMissileIfFresh: false });
    }
    syncActiveMissileGeometryFromOrefAlert(holdAlertFull, sourcePosition, targetPosition);
  });
}

/** ׳§׳˜׳’׳•׳¨׳™׳•׳× ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (׳×׳™׳¢׳•׳“ ׳§׳”׳™׳׳×׳™): 1=׳¨׳§׳˜׳•׳×/׳˜׳™׳׳™׳, 2=׳—׳“׳™׳¨׳× ׳›׳׳™ ׳˜׳™׳¡ ׳¢׳•׳™׳, 13=׳¡׳™׳•׳ ׳׳™׳¨׳•׳¢, 14=׳”׳×׳¨׳¢׳” ׳׳•׳§׳“׳׳× */
function threatTypeFromOrefCategory(cat) {
  const n = Number(cat);
  if (n === 2) return 'uav';
  if (n === 1) return 'missile';
  return null;
}

function detectThreatType(alert) {
  if (!alert || typeof alert !== 'object') {
    console.log('[detectThreatType] Invalid alert, defaulting to missile');
    return 'missile';
  }

  // Check numeric category from Oref (1=missile, 2=UAV)
  const fromNumericCategory =
    threatTypeFromOrefCategory(alert.orefCategory) ||
    threatTypeFromOrefCategory(alert.cat) ||
    threatTypeFromOrefCategory(alert.category) ||
    threatTypeFromOrefCategory(alert.Category) ||
    threatTypeFromOrefCategory(alert.alertCat);

  if (fromNumericCategory) {
    console.log('[detectThreatType] Detected from category:', fromNumericCategory, 'categories:', {cat: alert.cat, category: alert.category, orefCategory: alert.orefCategory});
    return fromNumericCategory;
  }

  // Collect all text fields for analysis
  const textFields = [
    alert.title,
    alert.desc,
    alert.description,
    alert.subtitle,
    alert.name,
    alert.type,
    typeof alert.category === 'string' ? alert.category : '',
    alert.msg,
    alert.message,
    alert.info,
    alert.text,
  ].filter(Boolean);
  
  const text = textFields
    .join(' ')
    .toLowerCase();

  // Comprehensive UAV/Drone detection in Hebrew and English
  const uavKeywords = [
    // Hebrew UAV terms
    'כטב"ם', 'כטבם', 'כלי טיס בלתי מאויש', 'כלי טייס בלתי מאויש',
    'רחפן', 'רחפנים', 'כטב"מים', 'כטבמים',
    'כלי טיס עוין', 'כלי טייס עוין',
    'כלי טיס בלתי מאוייש', 'כלי טייס בלתי מאוייש',
    // English UAV terms
    'drone', 'uav', 'unmanned aerial', 'quadcopter', 'hexacopter',
    'suicide drone', 'loitering munition', 'kamikaze drone',
  ];
  
  const missileKeywords = [
    // Hebrew missile terms
    'טיל', 'טילים', 'רקטה', 'רקטות',
    'טיל בליסטי', 'טילים בליסטיים',
    'ירי רקטות', 'ירי טילים',
    // English missile terms
    'missile', 'rocket', 'ballistic', 'salvo', 'barrage',
  ];

  // Check for UAV keywords
  for (const keyword of uavKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      console.log('[detectThreatType] Detected UAV from keyword:', keyword, 'in text:', text.substring(0, 100));
      return 'uav';
    }
  }

  // Check for missile keywords
  for (const keyword of missileKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      console.log('[detectThreatType] Detected missile from keyword:', keyword, 'in text:', text.substring(0, 100));
      return 'missile';
    }
  }

  // Default to missile for alerts (safer assumption)
  console.log('[detectThreatType] No specific keywords found, defaulting to missile. Text:', text.substring(0, 100));
  return 'missile';
}

/**
 * מטא־מצרר ללקוח: ירי לאזור עם 2+ יעדי טיל באותו salvo — מסלול "אם" לריכוז גאוגרפי ואז התפצלות לערים.
 * אם אין waveId תקין או פחות משני יעדי טיל — null.
 */
function buildClusterMunitionMeta(salvo) {
  if (!salvo || salvo.count == null || salvo.count < 2 || !Array.isArray(salvo.alerts)) return null;
  const alerts = salvo.alerts.filter(
    (a) =>
      a &&
      a.threatType !== 'uav' &&
      Array.isArray(a.targetPosition) &&
      a.targetPosition.length >= 2 &&
      a.cityName &&
      Number.isFinite(Number(a.targetPosition[0])) &&
      Number.isFinite(Number(a.targetPosition[1]))
  );
  if (alerts.length < 2) return null;
  const sisters = alerts.map((a) => ({
    name: String(a.cityName),
    lng: Number(a.targetPosition[0]),
    lat: Number(a.targetPosition[1]),
  }));
  const slng = sisters.reduce((s, p) => s + p.lng, 0) / sisters.length;
  const slat = sisters.reduce((s, p) => s + p.lat, 0) / sisters.length;
  const centroid = [slng, slat];
  const primary = [...alerts].sort((a, b) => String(a.cityName || '').localeCompare(String(b.cityName || ''), 'he'))[0];
  const primaryName = String(primary.cityName);
  return { centroid, sisters, primaryName };
}

function clusterAlertsIntoSalvos(alerts) {
  const clusters = [];

  alerts.forEach((alert) => {
    const match = clusters.find((cluster) => {
      if (cluster.region !== alert.sourceRegion) {
        return false;
      }

      return haversineKm(cluster.centerTarget, alert.targetPosition) <= 140;
    });

    if (match) {
      match.alerts.push(alert);
      const count = match.alerts.length;
      match.centerTarget = [
        (match.centerTarget[0] * (count - 1) + alert.targetPosition[0]) / count,
        (match.centerTarget[1] * (count - 1) + alert.targetPosition[1]) / count,
      ];
      return;
    }

    clusters.push({
      region: alert.sourceRegion,
      centerTarget: alert.targetPosition,
      alerts: [alert],
    });
  });

  const batchTime = Date.now();
  return clusters.map((cluster, index) => ({
    waveId: `wave-${cluster.region}-${batchTime}-${index + 1}`,
    sourceRegion: cluster.region,
    sourceLocation: getSourceRegionLabel(cluster.region),
    count: cluster.alerts.length,
    alerts: cluster.alerts,
  }));
}

function hashCityName(cityName) {
  return String(cityName || '')
    .split('')
    .reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

const THREAT_TIMING_MODEL = {
  missile: {
    lebanon: { speedKmPerSec: 3.3, minMs: 8_000, maxMs: 120_000, displayScale: 1.0, displayMinMs: 8_000, displayMaxMs: 120_000, sirenLeadMs: 8_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 7_000 },
    syria: { speedKmPerSec: 3.5, minMs: 10_000, maxMs: 120_000, displayScale: 1.0, displayMinMs: 10_000, displayMaxMs: 120_000, sirenLeadMs: 10_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 8_000 },
    gaza: { speedKmPerSec: 1.5, minMs: 8_000, maxMs: 90_000, displayScale: 1.0, displayMinMs: 8_000, displayMaxMs: 90_000, sirenLeadMs: 7_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 7_000 },
    iraq: { speedKmPerSec: 6.5, minMs: 240_000, maxMs: 240_000, displayScale: 1.0, displayMinMs: 240_000, displayMaxMs: 240_000, sirenLeadMs: 16_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 9_000 },
    iran: { speedKmPerSec: 6.25, minMs: 300_000, maxMs: 300_000, displayScale: 1.0, displayMinMs: 300_000, displayMaxMs: 300_000, sirenLeadMs: 18_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 9_000 },
    yemen: { speedKmPerSec: 8.3, minMs: 300_000, maxMs: 300_000, displayScale: 1.0, displayMinMs: 300_000, displayMaxMs: 300_000, sirenLeadMs: 22_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 9_000 },
    default: { speedKmPerSec: 3.0, minMs: 30_000, maxMs: 300_000, displayScale: 1.0, displayMinMs: 30_000, displayMaxMs: 300_000, sirenLeadMs: 12_000, leadFraction: 0.0, earlyWarningBoost: 0.0, minTailMs: 9_000 },
  },
  uav: {
    // UAV speed: 130 km/h = 0.036 km/sec (user specified)
    lebanon: { speedKmPerSec: 0.036, minMs: 20 * 60_000, maxMs: 90 * 60_000, displayScale: 0.18, displayMinMs: 120_000, displayMaxMs: 300_000, sirenLeadMs: 30_000, leadFraction: 0.15, earlyWarningBoost: 0.15, minTailMs: 20_000 },
    syria: { speedKmPerSec: 0.036, minMs: 25 * 60_000, maxMs: 120 * 60_000, displayScale: 0.18, displayMinMs: 150_000, displayMaxMs: 400_000, sirenLeadMs: 35_000, leadFraction: 0.20, earlyWarningBoost: 0.15, minTailMs: 20_000 },
    gaza: { speedKmPerSec: 0.036, minMs: 15 * 60_000, maxMs: 60 * 60_000, displayScale: 0.18, displayMinMs: 100_000, displayMaxMs: 250_000, sirenLeadMs: 25_000, leadFraction: 0.10, earlyWarningBoost: 0.12, minTailMs: 20_000 },
    iraq: { speedKmPerSec: 0.036, minMs: 120 * 60_000, maxMs: 300 * 60_000, displayScale: 0.18, displayMinMs: 200_000, displayMaxMs: 500_000, sirenLeadMs: 60_000, leadFraction: 0.40, earlyWarningBoost: 0.15, minTailMs: 20_000 },
    iran: { speedKmPerSec: 0.036, minMs: 180 * 60_000, maxMs: 400 * 60_000, displayScale: 0.18, displayMinMs: 250_000, displayMaxMs: 600_000, sirenLeadMs: 75_000, leadFraction: 0.45, earlyWarningBoost: 0.15, minTailMs: 20_000 },
    yemen: { speedKmPerSec: 0.036, minMs: 200 * 60_000, maxMs: 450 * 60_000, displayScale: 0.18, displayMinMs: 300_000, displayMaxMs: 700_000, sirenLeadMs: 80_000, leadFraction: 0.42, earlyWarningBoost: 0.15, minTailMs: 20_000 },
    default: { speedKmPerSec: 0.036, minMs: 30 * 60_000, maxMs: 150 * 60_000, displayScale: 0.18, displayMinMs: 120_000, displayMaxMs: 350_000, sirenLeadMs: 35_000, leadFraction: 0.20, earlyWarningBoost: 0.15, minTailMs: 20_000 },
  },
};

function getThreatTimingProfile(region, threatType = 'missile') {
  const threatKey = threatType === 'uav' ? 'uav' : 'missile';
  const table = THREAT_TIMING_MODEL[threatKey] || THREAT_TIMING_MODEL.missile;
  return table[region] || table.default;
}

function getAlertPhasePlan(region, threatType, displayFlightMs) {
  const profile = getThreatTimingProfile(region, threatType);
  const requestedLeadMs = profile.sirenLeadMs;
  const maxLeadMs = Math.max(4_000, displayFlightMs - 4_000);
  const sirenLeadMs = clamp(requestedLeadMs, 4_000, maxLeadMs);

  return {
    sirenAtMs: Math.max(1_500, displayFlightMs - sirenLeadMs),
    holdAtMs: displayFlightMs,
  };
}

function buildMissileLifecycle(alert, sourcePosition, targetPosition) {
    const { sourcePosition: sp, targetPosition: tp } = normalizeMissileEndpointsForInbound(
      alert,
      sourcePosition,
      targetPosition
    );
    sourcePosition = sp;
    targetPosition = tp;
    const cityHash = hashCityName(alert.cityName);
  const fusion = computeThreatFusionResult(alert);
  const explicitAxis = inferExplicitOrefThreatAxis(alert)?.axis || null;
  const timing = getEstimatedFlightMs(sourcePosition, targetPosition, alert.threatType, alert);
  const shouldRenderCountryLaunchTrajectoryLine = shouldRenderCountryLaunchTrajectory(
    fusion.sourceConfidence || 'estimated'
  );
  const travelMs = timing.flightMs;
    const shouldIntercept = alert.threatType === 'uav' ? cityHash % 4 !== 0 : cityHash % 3 !== 0;
    const eventId = `rtm-${alert.id || alert.cityName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const displayFlightMs = getDisplayFlightMs(timing.region, alert.threatType, travelMs);
    const phasePlan = getAlertPhasePlan(timing.region, alert.threatType, displayFlightMs);
    const earlyWarning = inferOrefEarlyWarning(alert);
    const initialAlertPhase = inferOrefAlertPhase(alert);
    const orefGuidelineMeta = classifyOrefGuidelinePhase(buildOrefGuidelineFullText(alert));
    const orefTrajectoryLeadFraction = getDisplayLeadFraction(
      timing.region,
      alert.threatType || 'missile',
      earlyWarning
    );
    const displayElapsedMs = computeDisplayElapsedMs(
      displayFlightMs,
      alert.threatType || 'missile',
      timing.region,
      earlyWarning
    );

  return {
    id: eventId,
    cityName: alert.cityName,
    source: sourcePosition,
    target: targetPosition,
    sourcePosition,
    targetPosition,
    timestamp: Date.now(),
    orefTimeMs: alert.orefTimeMs != null ? alert.orefTimeMs : Date.now(),
    receivedAtMs: alert.receivedAtMs != null ? alert.receivedAtMs : Date.now(),
    ...(alert?.orefAlertGroupId != null && String(alert.orefAlertGroupId).length > 0
      ? { orefAlertGroupId: String(alert.orefAlertGroupId) }
      : {}),
    flightMs: travelMs,
    displayFlightMs,
    displayElapsedMs,
    displayLeadFraction: displayFlightMs > 0 ? displayElapsedMs / displayFlightMs : 0,
    orefTrajectoryLeadFraction,
    orefEarlyWarning: earlyWarning,
    threatAxisFromOref: explicitAxis,
    alertContext: {
      cityName: alert.cityName,
      title: alert.title,
      threatType: alert.threatType || 'missile',
      orefTextBlob: alert.orefTextBlob,
      usedSettlementFallback: alert.usedSettlementFallback,
    },
    trajectoryLocked: fusion.trajectoryLocked,
    trajectoryConfidence: fusion.trajectoryConfidence,
    fusionTier: fusion.fusionTier,
    fusionSources: fusion.fusionSources,
    sourceConfidence: fusion.sourceConfidence || 'estimated',
    sourceConfidenceScore:
      fusion.sourceConfidenceScore != null ? fusion.sourceConfidenceScore : fusion.trajectoryConfidence,
    targetSettlementConfidence: fusion.targetSettlementConfidence,
    sourceRegion: timing.region,
    sourceLocation: getSourceRegionLabel(timing.region),
    estimatedDistanceKm: timing.distanceKm,
    threatType: alert.threatType || 'missile',
    alertPhase: initialAlertPhase,
    ...(orefGuidelineMeta.matchedPhrase
      ? {
          orefGuidelineMatch: orefGuidelineMeta.matchedPhrase,
          orefGuidelinePhase: orefGuidelineMeta.phase,
        }
      : {}),
    sirenAtMs: phasePlan.sirenAtMs,
    holdAtMs: phasePlan.holdAtMs,
    threatLabel: alert.threatType === 'uav' ? '׳›׳˜׳‘"׳' : '׳˜׳™׳',
    phase: 'launch',
    status: 'inbound',
    outcome: shouldIntercept ? 'intercepted' : 'impact',
    interceptAt: shouldIntercept ? Math.round(travelMs * 0.62) : null,
    impactAt: shouldIntercept ? null : travelMs,
    interceptPoint: shouldIntercept
      ? [
          sourcePosition[0] + (targetPosition[0] - sourcePosition[0]) * 0.62,
          sourcePosition[1] + (targetPosition[1] - sourcePosition[1]) * 0.62,
        ]
      : null,
  };
}

function clearMissileTimers(missileId) {
  const timers = missileLifecycleTimers.get(missileId);
  if (!timers) {
    return;
  }

  timers.forEach((timerId) => clearTimeout(timerId));
  missileLifecycleTimers.delete(missileId);
}

function syncActiveMissilesState() {
  state.activeMissiles = [...activeMissilesById.values()]
    .filter((missile) => isActiveAlertPhase(missile.alertPhase))
    .sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0));
}

function syncActiveAlertsState() {
  state.activeAlerts = [...activeAlertDetailsByCity.values()]
    .filter((alert) => activeAlertsCache.includes(alert.cityName))
    .filter((alert) => isActiveAlertPhase(alert.alertPhase))
    .filter((alert) => hasRenderableAlertCoordinates(alert))
    .sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0));
}

function synthesizeMissingMissilesFromAlerts(activeAlerts) {
  const out = [];
  const alerts = Array.isArray(activeAlerts) ? activeAlerts : [];
  alerts.forEach((alert) => {
    if (!alert?.cityName || !hasRenderableAlertCoordinates(alert)) return;
    const already = findMissileForOrefAlertUpdate(alert);
    if (already && hasRenderableMissileTarget(already)) return;
    const targetPosition = getTargetPosition(alert);
    if (
      !targetPosition ||
      !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
    ) {
      return;
    }
    const sourceConfidence = alert.sourceConfidence || 'estimated';
    const sourcePosition =
      Array.isArray(alert.sourcePosition) && alert.sourcePosition.length >= 2
        ? normalizeCoordPairToLngLat(alert.sourcePosition)
        : resolveSourcePosition(
            {
              cityName: alert.cityName,
              title: alert.title || 'התראה פעילה',
              threatType: alert.threatType || 'missile',
              orefTextBlob: alert.orefTextBlob || '',
              orefTimeMs: alert.orefTimeMs || Date.now(),
              receivedAtMs: alert.receivedAtMs || Date.now(),
            },
            targetPosition
          );
    const sourceRegion = alert.sourceRegion || resolveSourceRegionFromAlert(alert, sourcePosition, targetPosition);
    const sourceLocation = alert.sourceLocation || getSourceRegionLabel(sourceRegion);
    const missileEvent = {
      ...buildMissileLifecycle(
        {
          id: `restore-${alert.cityName}-${alert.orefTimeMs || Date.now()}`,
          cityName: alert.cityName,
          title: alert.title || 'התראה פעילה',
          threatType: alert.threatType || 'missile',
          sourcePosition,
          targetPosition,
          orefTextBlob: alert.orefTextBlob || '',
          orefTimeMs: alert.orefTimeMs || Date.now(),
          receivedAtMs: alert.receivedAtMs || Date.now(),
        },
        sourcePosition,
        targetPosition
      ),
      source: sourcePosition,
      sourcePosition,
      sourceRegion,
      sourceLocation,
      sourceConfidence,
      sourceConfidenceScore:
        alert.sourceConfidenceScore != null ? alert.sourceConfidenceScore : getSourceConfidenceScore(alert.sourceConfidence),
      alertPhase: isActiveAlertPhase(alert.alertPhase) ? alert.alertPhase : 'hold_after_siren',
      waveId: `restore-${sourceRegion || 'unknown'}`,
      salvoCountEstimate: 1,
      salvoIndex: 1,
    };
    syncMissileSourceFromGeometry(missileEvent);
    attachTrajectoryLaunchWallMs(missileEvent);
    out.push(missileEvent);
  });
  return out;
}

function storeActiveMissile(missileEvent) {
  if (!hasRenderableMissileTarget(missileEvent)) {
    removeActiveMissileById(missileEvent?.id);
    return;
  }
  attachTrajectoryLaunchWallMs(missileEvent);
  activeMissilesById.set(missileEvent.id, { ...missileEvent });
  syncActiveMissilesState();
}

function deleteAllUavTrackKeysForMissileId(missileId) {
  [...activeUavTracksByKey.entries()].forEach(([key, id]) => {
    if (id === missileId) activeUavTracksByKey.delete(key);
  });
}

function removeActiveMissileById(missileId) {
  deleteAllUavTrackKeysForMissileId(missileId);
  clearMissileTimers(missileId);
  activeMissilesById.delete(missileId);
  syncActiveMissilesState();
}

function removeActiveMissilesByCity(cityName) {
  if (!cityName) return;
  activeMissilesById.forEach((missileEvent, missileId) => {
    if (missileEvent.cityName === cityName) {
      deleteAllUavTrackKeysForMissileId(missileId);
      activeMissilesById.delete(missileId);
      clearMissileTimers(missileId);
    }
  });
  activeAlertDetailsByCity.delete(cityName);
  syncActiveAlertsState();
  syncActiveMissilesState();
}

function clearAllActiveMissiles() {
  activeMissilesById.forEach((_, missileId) => clearMissileTimers(missileId));
  activeMissilesById.clear();
  activeUavTracksByKey.clear();
  activeAlertDetailsByCity.clear();
  state.activeAlerts = [];
  syncActiveMissilesState();
}

function scheduleMissileLifecycle(missileEvent) {
  clearMissileTimers(missileEvent.id);

  const timers = [];
  const scheduleNow = Date.now();
  const disp = missileEvent.displayFlightMs || missileEvent.flightMs || 20_000;
  const elapsed = Math.min(missileEvent.displayElapsedMs || 0, Math.max(0, disp - 500));
  const remDisp = Math.max(1, disp - elapsed);
  const isBallistic = missileEvent.threatType !== 'uav';
  let remWallToImpact = null;
  let impactWallMs = null;
  if (isBallistic) {
    const travel = missileEvent.flightMs || 20_000;
    const lead =
      typeof missileEvent.orefTrajectoryLeadFraction === 'number'
        ? missileEvent.orefTrajectoryLeadFraction
        : getDisplayLeadFraction(
            missileEvent.sourceRegion,
            missileEvent.threatType || 'missile',
            !!missileEvent.orefEarlyWarning
          );
    const orefT = missileEvent.orefTimeMs != null ? missileEvent.orefTimeMs : scheduleNow;
    impactWallMs = orefT + travel * (1 - lead);
    remWallToImpact = Math.max(0, impactWallMs - scheduleNow);
  }

  const emitSirenActive = () => {
    if (!canAdvanceLifecycleForCity(missileEvent.cityName)) {
      clearMissileTimers(missileEvent.id);
      return;
    }
    const activeMissile = activeMissilesById.get(missileEvent.id);
    if (activeMissile && activeMissile.alertPhase !== 'pre_alert') return;
    if (activeMissile) {
      activeMissile.alertPhase = 'siren_active';
      activeMissile.phaseChangedAt = Date.now();
      storeActiveMissile(activeMissile);
    }
    upsertActiveAlertDetail({
      cityName: missileEvent.cityName,
      alertPhase: 'siren_active',
    });
    io.emit('alert_phase_update', {
      id: missileEvent.id,
      cityName: missileEvent.cityName,
      threatType: missileEvent.threatType,
      alertPhase: 'siren_active',
      sourceRegion: missileEvent.sourceRegion,
      sourceLocation: missileEvent.sourceLocation,
      timestamp: Date.now(),
    });
    appendFeedFromAlertPhase({
      cityName: missileEvent.cityName,
      alertPhase: 'siren_active',
      timestampMs:
        sirenDelayMs != null && Number.isFinite(Number(sirenDelayMs))
          ? scheduleNow + Math.max(0, Number(sirenDelayMs))
          : Date.now(),
      orefTimeMs: missileEvent.orefTimeMs,
      receivedAtMs: missileEvent.receivedAtMs,
    });
  };

  const sirenAtWall =
    missileEvent.sirenAtMs != null ? missileEvent.sirenAtMs : Math.round(disp * 0.72);
  const shouldScheduleSirenTransition = missileEvent.alertPhase === 'pre_alert';
  const sirenDelayMs = shouldScheduleSirenTransition
    ? (isBallistic && remWallToImpact != null
        ? sirenAtWall <= elapsed
          ? 0
          : ((sirenAtWall - elapsed) / remDisp) * remWallToImpact
        : Math.max(0, sirenAtWall - elapsed))
    : null;
  if (shouldScheduleSirenTransition) {
    if (sirenDelayMs <= 0) {
      emitSirenActive();
    } else {
      const sirenTimer = setTimeout(emitSirenActive, Math.max(400, sirenDelayMs));
      timers.push(sirenTimer);
    }
  }

  const midAt = Math.round(disp * 0.35);
  const midDelay =
    isBallistic && remWallToImpact != null
      ? midAt <= elapsed
        ? 0
        : Math.max(300, ((midAt - elapsed) / remDisp) * remWallToImpact)
      : Math.max(0, midAt - elapsed);
  const midcourseTimer = setTimeout(() => {
    io.emit('missile_update', {
      id: missileEvent.id,
      cityName: missileEvent.cityName,
      phase: 'midcourse',
      status: 'inbound',
      sourceRegion: missileEvent.sourceRegion,
      sourceLocation: missileEvent.sourceLocation,
      salvoCountEstimate: missileEvent.salvoCountEstimate,
      salvoIndex: missileEvent.salvoIndex,
      waveId: missileEvent.waveId,
      timestamp: Date.now(),
    });
  }, Math.max(midDelay <= 0 ? 0 : 300, midDelay));
  timers.push(midcourseTimer);

  if (missileEvent.threatType === 'uav') {
    missileLifecycleTimers.set(missileEvent.id, timers);
    return;
  }

  if (missileEvent.outcome === 'intercepted' && missileEvent.interceptAt) {
    const travelI = missileEvent.flightMs || 20_000;
    const leadI =
      typeof missileEvent.orefTrajectoryLeadFraction === 'number'
        ? missileEvent.orefTrajectoryLeadFraction
        : getDisplayLeadFraction(
            missileEvent.sourceRegion,
            missileEvent.threatType || 'missile',
            !!missileEvent.orefEarlyWarning
          );
    const orefTI = missileEvent.orefTimeMs != null ? missileEvent.orefTimeMs : scheduleNow;
    const launchWallI = orefTI - travelI * leadI;
    const interceptWallClock = launchWallI + missileEvent.interceptAt;
    const interceptDelay = Math.max(800, interceptWallClock - scheduleNow);
    const interceptTimer = setTimeout(() => {
      if (!canAdvanceLifecycleForCity(missileEvent.cityName)) {
        clearMissileTimers(missileEvent.id);
        return;
      }
      const activeMissile = activeMissilesById.get(missileEvent.id);
      if (activeMissile) {
        activeMissile.phase = 'intercepted';
        activeMissile.status = 'resolved';
        activeMissile.alertPhase = 'hold_after_siren';
        activeMissile.interceptPoint = missileEvent.interceptPoint;
        storeActiveMissile(activeMissile);
      }
      upsertActiveAlertDetail({
        cityName: missileEvent.cityName,
        alertPhase: 'hold_after_siren',
      });
      io.emit('alert_phase_update', {
        id: missileEvent.id,
        cityName: missileEvent.cityName,
        threatType: missileEvent.threatType,
        alertPhase: 'hold_after_siren',
        sourceRegion: missileEvent.sourceRegion,
        sourceLocation: missileEvent.sourceLocation,
        timestamp: Date.now(),
      });
      appendFeedFromAlertPhase({
        cityName: missileEvent.cityName,
        alertPhase: 'hold_after_siren',
        timestampMs: interceptWallClock,
        orefTimeMs: missileEvent.orefTimeMs,
        receivedAtMs: missileEvent.receivedAtMs,
      });
      io.emit('missile_update', {
        id: missileEvent.id,
        cityName: missileEvent.cityName,
        phase: 'intercepted',
        status: 'resolved',
        interceptPoint: missileEvent.interceptPoint,
        sourceRegion: missileEvent.sourceRegion,
        sourceLocation: missileEvent.sourceLocation,
        salvoCountEstimate: missileEvent.salvoCountEstimate,
        salvoIndex: missileEvent.salvoIndex,
        waveId: missileEvent.waveId,
        timestamp: Date.now(),
      });
      clearMissileTimers(missileEvent.id);
    }, interceptDelay);
    timers.push(interceptTimer);
  } else {
    const impactDelay =
      isBallistic && impactWallMs != null
        ? Math.max(600, impactWallMs - scheduleNow)
        : Math.max(600, (missileEvent.holdAtMs || missileEvent.displayFlightMs || missileEvent.flightMs) - elapsed);
    const impactTimer = setTimeout(() => {
      if (!canAdvanceLifecycleForCity(missileEvent.cityName)) {
        clearMissileTimers(missileEvent.id);
        return;
      }
      const activeMissile = activeMissilesById.get(missileEvent.id);
      if (activeMissile) {
        activeMissile.phase = 'impact';
        activeMissile.status = 'resolved';
        activeMissile.alertPhase = 'hold_after_siren';
        activeMissile.impactPoint = missileEvent.target;
        storeActiveMissile(activeMissile);
      }
      upsertActiveAlertDetail({
        cityName: missileEvent.cityName,
        alertPhase: 'hold_after_siren',
      });
      io.emit('alert_phase_update', {
        id: missileEvent.id,
        cityName: missileEvent.cityName,
        threatType: missileEvent.threatType,
        alertPhase: 'hold_after_siren',
        sourceRegion: missileEvent.sourceRegion,
        sourceLocation: missileEvent.sourceLocation,
        timestamp: Date.now(),
      });
      appendFeedFromAlertPhase({
        cityName: missileEvent.cityName,
        alertPhase: 'hold_after_siren',
        timestampMs: impactWallMs != null ? impactWallMs : Date.now(),
        orefTimeMs: missileEvent.orefTimeMs,
        receivedAtMs: missileEvent.receivedAtMs,
      });
      io.emit('missile_update', {
        id: missileEvent.id,
        cityName: missileEvent.cityName,
        phase: 'impact',
        status: 'resolved',
        impactPoint: missileEvent.target,
        sourceRegion: missileEvent.sourceRegion,
        sourceLocation: missileEvent.sourceLocation,
        salvoCountEstimate: missileEvent.salvoCountEstimate,
        salvoIndex: missileEvent.salvoIndex,
        waveId: missileEvent.waveId,
        timestamp: Date.now(),
      });
      clearMissileTimers(missileEvent.id);
    }, impactDelay);
    timers.push(impactTimer);
  }

  missileLifecycleTimers.set(missileEvent.id, timers);
}

/** ׳׳₪׳×׳— ׳׳¡׳׳•׳ ׳›׳˜׳‘"׳: ׳׳•׳×׳• ׳׳–׳”׳” ׳׳›׳ ׳”׳¢׳¨׳™׳ ׳‘׳׳™׳¨׳•׳¢ Oref ׳׳—׳“ ג€” ׳›׳“׳™ ׳׳©׳¨׳©׳¨ ׳׳˜׳•׳׳” ג† ׳§׳¨׳™׳× ׳©׳׳•׳ ׳” ׳•׳›׳•' */
function getUavTrackKey(alert, sourceRegion) {
  const region = sourceRegion || alert.sourceRegion || 'unknown';
  const groupRaw =
    alert.orefAlertGroupId != null && String(alert.orefAlertGroupId).length > 0
      ? String(alert.orefAlertGroupId)
      : alert.id != null && String(alert.id).length > 0
        ? String(alert.id)
        : '';
  if (groupRaw) {
    const safe = groupRaw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
    return `uav-${region}-${safe}`;
  }
  const city = String(alert.cityName || '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return `uav-${region}-${city || 'na'}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDisplayFlightMs(region, threatType, flightMs) {
  const profile = getThreatTimingProfile(region, threatType);
  return clamp(
    Math.round(flightMs * profile.displayScale),
    profile.displayMinMs,
    profile.displayMaxMs
  );
}

/** ׳”׳×׳¨׳׳” ׳׳•׳§׳“׳׳× Oref (׳§׳˜׳’׳•׳¨׳™׳” 14 / ׳ ׳™׳¡׳•׳—) ג€” ׳׳¡׳׳•׳ ׳›׳‘׳¨ ׳׳×׳§׳“׳ ׳™׳•׳×׳¨ */
function inferOrefEarlyWarning(alert) {
  if (!alert || typeof alert !== 'object') return false;
  const n = Number(alert.orefCategory ?? alert.cat ?? alert.category ?? alert.Category);
  if (n === 14) return true;
  const t = String(alert.title || '').toLowerCase();
  return t.includes('׳׳•׳§׳“׳׳×') || t.includes('׳”׳×׳¨׳׳” ׳׳•׳§׳“׳׳×');
}

/**
 * ׳׳—׳•׳– ׳׳”׳׳¡׳׳•׳ ׳©׳›׳‘׳¨ "׳¢׳‘׳¨" ׳‘׳¨׳’׳¢ ׳©׳”׳”׳×׳¨׳׳” ׳׳’׳™׳¢׳” ׳׳׳¡׳ ג€” ׳˜׳•׳•׳— ׳׳¨׳•׳ (׳׳™׳¨׳׳) ׳ ׳¨׳׳” ׳›׳‘׳¨ ׳§׳¨׳•׳‘ ׳™׳•׳×׳¨ ׳׳׳–׳¢׳§׳”.
 */
function getDisplayLeadFraction(region, threatType, earlyWarning) {
  const profile = getThreatTimingProfile(region, threatType);
  let f = profile.leadFraction;
  if (earlyWarning) f = Math.min(0.88, f + (profile.earlyWarningBoost || 0.12));
  return f;
}

function computeDisplayElapsedMs(displayFlightMs, threatType, region, earlyWarning) {
  const profile = getThreatTimingProfile(region, threatType);
  const lead = getDisplayLeadFraction(region, threatType, earlyWarning);
  let elapsed = Math.round(displayFlightMs * lead);
  const minTailMs = profile.minTailMs;
  elapsed = Math.min(elapsed, Math.max(0, displayFlightMs - minTailMs));
  return elapsed;
}

/** זהה ללקוח (monitor): orefTimeMs − flightMs×lead — מאפשר שחזור מדויק של מיקום ראש הטיל אחרי רענון/ניתוק */
function attachTrajectoryLaunchWallMs(missileEvent) {
  if (!missileEvent || missileEvent.threatType === 'uav') return;
  const orefT =
    missileEvent.orefTimeMs != null && Number.isFinite(Number(missileEvent.orefTimeMs))
      ? Number(missileEvent.orefTimeMs)
      : Date.now();
  const physicsMs = Math.max(1000, Number(missileEvent.flightMs) || 20_000);
  let lead;
  if (
    typeof missileEvent.orefTrajectoryLeadFraction === 'number' &&
    Number.isFinite(missileEvent.orefTrajectoryLeadFraction)
  ) {
    lead = Math.min(0.95, Math.max(0, missileEvent.orefTrajectoryLeadFraction));
  } else if (missileEvent.displayFlightMs > 0) {
    lead = Math.min(0.95, Math.max(0, (missileEvent.displayElapsedMs || 0) / missileEvent.displayFlightMs));
  } else {
    lead = 0.22;
  }
  missileEvent.trajectoryLaunchWallMs = orefT - physicsMs * lead;
}

function appendUniqueRoutePoint(routePoints, targetPosition) {
  const normalizedTarget = normalizeLngLat(targetPosition);
  const lastPoint = routePoints[routePoints.length - 1] ? normalizeLngLat(routePoints[routePoints.length - 1]) : null;
  if (
    !lastPoint ||
    Math.abs(lastPoint[0] - normalizedTarget[0]) > 0.01 ||
    Math.abs(lastPoint[1] - normalizedTarget[1]) > 0.01
  ) {
    routePoints.push(normalizedTarget);
  }
  return routePoints;
}

function upsertActiveAlertDetail(detail) {
  if (!detail?.cityName) return;
  const prev = activeAlertDetailsByCity.get(detail.cityName);
  const normalizedDetail = detail;
  const receivedAtMs = prev?.receivedAtMs ?? detail.receivedAtMs ?? Date.now();
  const prevPhase = prev?.alertPhase || '';
  const nextPhase = normalizedDetail.alertPhase || prevPhase || 'pre_alert';
  const alertPhase =
    prevPhase === 'released' && isActiveAlertPhase(nextPhase)
      ? nextPhase
      : getAlertPhaseRank(nextPhase) >= getAlertPhaseRank(prevPhase)
        ? nextPhase
        : prevPhase;
  activeAlertDetailsByCity.set(detail.cityName, {
    ...prev,
    ...normalizedDetail,
    alertPhase,
    receivedAtMs,
    updatedAt: Date.now(),
  });
  syncActiveAlertsState();
}

function ensureThreatExistsForCity(alert, sourceRegion, sourceLocation, options = {}) {
  if (!alert?.cityName) return null;
  const resolvedTgt = getTargetPosition(alert);
  if (
    !resolvedTgt ||
    !isPlausibleIsraelAlertTarget(resolvedTgt[0], resolvedTgt[1])
  ) {
    return null;
  }
  alert = { ...alert, targetPosition: resolvedTgt, target: resolvedTgt };

  let existingMissile = findMissileForOrefAlertUpdate(alert);
  const nextThreat = alert.threatType || 'missile';

  if (existingMissile && existingMissile.threatType !== nextThreat) {
    removeActiveMissileById(existingMissile.id);
    existingMissile = null;
  }

  if (existingMissile) {
    const inferredPhase = inferOrefAlertPhase(alert);
    if (getAlertPhaseRank(inferredPhase) > getAlertPhaseRank(existingMissile.alertPhase)) {
      existingMissile.alertPhase = inferredPhase;
      storeActiveMissile(existingMissile);
    }
    upsertActiveAlertDetail({
      cityName: existingMissile.cityName,
      coordinates: existingMissile.targetPosition || existingMissile.target,
      title: alert.title,
      threatType: nextThreat,
      alertPhase: inferredPhase || existingMissile.alertPhase || 'pre_alert',
      sourceRegion: existingMissile.sourceRegion || sourceRegion,
      sourceLocation: existingMissile.sourceLocation || sourceLocation,
      sourceConfidence: existingMissile.sourceConfidence || 'estimated',
      sourceConfidenceScore:
        existingMissile.sourceConfidenceScore != null
          ? existingMissile.sourceConfidenceScore
          : existingMissile.trajectoryConfidence,
      orefTextBlob: alert.orefTextBlob,
      orefTimeMs: alert.orefTimeMs ?? existingMissile.orefTimeMs,
      receivedAtMs: alert.receivedAtMs ?? existingMissile.receivedAtMs,
    });
    return existingMissile;
  }

  if (options.skipMissileIfFresh) {
    return null;
  }

  const missileEvent = {
    ...buildMissileLifecycle(alert, alert.sourcePosition, alert.targetPosition),
    sourceRegion,
    sourceLocation,
    waveId: `restore-${sourceRegion || 'unknown'}`,
    salvoCountEstimate: 1,
    salvoIndex: 1,
  };
  syncMissileSourceFromGeometry(missileEvent);

  if (missileEvent.threatType === 'uav') {
    const trackKey = getUavTrackKey(alert, sourceRegion);
    missileEvent.uavTrackKey = trackKey;
    missileEvent.routePoints = [missileEvent.source, missileEvent.target];
    missileEvent.routeCities = [missileEvent.cityName];
    missileEvent.updatedAt = missileEvent.timestamp;
    activeUavTracksByKey.set(trackKey, missileEvent.id);
  }

  storeActiveMissile(missileEvent);
  scheduleMissileLifecycle(missileEvent);
  upsertActiveAlertDetail({
    cityName: missileEvent.cityName,
    coordinates: missileEvent.targetPosition || missileEvent.target,
    title: alert.title,
    threatType: missileEvent.threatType,
    alertPhase: missileEvent.alertPhase || 'pre_alert',
    sourceRegion: missileEvent.sourceRegion,
    sourceLocation: missileEvent.sourceLocation,
    sourceConfidence: missileEvent.sourceConfidence || 'estimated',
    sourceConfidenceScore:
      missileEvent.sourceConfidenceScore != null
        ? missileEvent.sourceConfidenceScore
        : missileEvent.trajectoryConfidence,
    orefTextBlob: alert.orefTextBlob,
    orefTimeMs: alert.orefTimeMs ?? missileEvent.orefTimeMs,
    receivedAtMs: alert.receivedAtMs ?? missileEvent.receivedAtMs,
  });

  const restorePayload = {
    id: missileEvent.alertId || missileEvent.id,
    cityName: missileEvent.cityName,
    coordinates: missileEvent.targetPosition,
    title:
      missileEvent.threatType === 'uav'
        ? alert.title || '׳”׳×׳¨׳¢׳× ׳›׳˜׳‘"׳'
        : alert.title || '׳”׳×׳¨׳¢׳× ׳¦׳‘׳¢ ׳׳“׳•׳',
    threatType: missileEvent.threatType,
    alertPhase: missileEvent.alertPhase || 'pre_alert',
    orefTextBlob: alert.orefTextBlob || '',
    timestamp: new Date().toISOString(),
    orefTimeMs: alert.orefTimeMs ?? missileEvent.orefTimeMs,
    receivedAtMs: alert.receivedAtMs ?? missileEvent.receivedAtMs,
  };
  enrichPayloadWithOrefGuideline(alert, restorePayload);
  if (!options.suppressFeed) {
    appendFeedFromNewAlertPayload(restorePayload);
    scheduleOrefClientSocketEmit(() => {
      io.emit('new_alert', restorePayload);
    });
  }
  scheduleOrefClientSocketEmit(() => {
    io.emit('real_time_missile', missileEvent);
  });

  return missileEvent;
}

function resolveTargetPosition(value) {
  if (value == null) return null;
  if (Array.isArray(value) && value.length === 2) {
    const p = normalizeCoordPairToLngLat(value);
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return p;
  }
  if (value && typeof value === 'object' && typeof value.lng === 'number' && typeof value.lat === 'number') {
    return [value.lng, value.lat];
  }
  return null;
}

/** ׳–׳׳ ׳”׳×׳¨׳׳” ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ (׳›׳©׳׳•׳₪׳™׳¢ ׳‘ײ¾JSON) ג€” ׳׳—׳¨׳× null */
function parseOrefAlertTimeMs(alert) {
  if (!alert || typeof alert !== 'object') return null;
  if (alert.datetime != null) {
    const d = new Date(alert.datetime);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  const raw = alert.time;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string' && /^\d{10,13}$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n < 1e12 ? n * 1000 : n;
  }
  if (alert.date && typeof alert.date === 'string' && typeof raw === 'string') {
    const d = new Date(`${alert.date}T${raw}`);
    if (!Number.isNaN(d.getTime())) return d.getTime();
    const d2 = new Date(`${alert.date} ${raw}`);
    if (!Number.isNaN(d2.getTime())) return d2.getTime();
  }
  return null;
}

function normalizeOrefAlerts(payload) {
  if (!payload) {
    return [];
  }

  const alerts = Array.isArray(payload) ? payload : [payload];
  const normalized = [];

  alerts.forEach((raw) => {
    const alert =
      raw && typeof raw === 'object' && raw.current && typeof raw.current === 'object'
        ? { ...raw, ...raw.current }
        : raw;

    const cities = Array.isArray(alert?.data)
      ? alert.data
      : typeof alert?.data === 'string'
      ? [alert.data]
      : Array.isArray(alert?.cities)
      ? alert.cities
      : [];

    const orefTimeMs = parseOrefAlertTimeMs(alert);
    const orefAlertGroupId =
      alert.id != null && String(alert.id).length > 0
        ? alert.id
        : `orefgrp-${orefTimeMs != null ? orefTimeMs : Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const orefTextBlob = collectOrefStringBlob(alert);

    cities.forEach((rawCity, index) => {
      const cityName =
        typeof rawCity === 'string' ? normalizeHebrewSettlementName(rawCity.trim()) : rawCity;
      if (!cityName || typeof cityName !== 'string' || cityName.length < 2) return;
          const cityCoords = getReliableCityCoordinates(cityName);
      const usedSettlementFallback = !cityCoords;
      const coords = cityCoords ? { lng: cityCoords.lng, lat: cityCoords.lat } : null;
      const threatType = detectThreatType(alert);
      const orefCategoryRaw = alert.cat ?? alert.category ?? alert.Category;
      const orefCategory =
        orefCategoryRaw != null && String(orefCategoryRaw).length > 0 ? Number(orefCategoryRaw) : null;
      normalized.push({
        id:
          alert.id ||
          `${alert.title || 'alert'}-${cityName}-${alert.time || Date.now()}-${index}`,
        orefAlertGroupId,
        cityName,
        title: alert.title || '׳”׳×׳¨׳¢׳”',
        coordinates: coords ? [coords.lng, coords.lat] : null,
        usedSettlementFallback,
        threatType,
        orefCategory: Number.isFinite(orefCategory) ? orefCategory : null,
        orefTextBlob,
        orefTimeMs: orefTimeMs != null ? orefTimeMs : Date.now(),
      });
    });
  });

  return normalized;
}

async function getOpenSkyAuthConfig() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (clientId && clientSecret) {
    if (openSkyAuthToken && Date.now() < openSkyAuthTokenExpiresAt - 60_000) {
      return {
        headers: {
          Authorization: `Bearer ${openSkyAuthToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      };
    }

    const tokenResponse = await axios.post(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );

    openSkyAuthToken = tokenResponse.data?.access_token || null;
    const expiresIn = Number(tokenResponse.data?.expires_in || 300);
    openSkyAuthTokenExpiresAt = Date.now() + expiresIn * 1000;

    if (openSkyAuthToken) {
      return {
        headers: {
          Authorization: `Bearer ${openSkyAuthToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      };
    }
  }

  if (process.env.OPENSKY_USERNAME) {
    return {
      auth: {
        username: process.env.OPENSKY_USERNAME,
        password: process.env.OPENSKY_PASSWORD || '',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };
  }

  return {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  };
}

async function pollOrefMissileLayer() {
  if (orefPollInFlight) {
    orefPollSkippedOverlaps += 1;
    orefPollPendingFollowUp = true;
    const now = Date.now();
    if (now - orefPollOverlapWarnAt >= 120_000 && orefPollSkippedOverlaps > 0 && orefPollSkippedOverlaps % 20 === 0) {
      orefPollOverlapWarnAt = now;
      console.warn(
        `[Oref poll] ${orefPollSkippedOverlaps} interval ticks skipped while a poll was still running (slow network or heavy load). A follow-up poll runs when the current one finishes.`
      );
    }
    return;
  }
  orefPollInFlight = true;
  orefPollLastStartedAt = Date.now();
  resetOrefClientSocketEmitStagger();
  try {
    let parsedPayload = [];
    let orefOfficialOk = false;

    try {
      const response = await axios.get(OREF_URL, {
        headers: OREF_HEADERS,
        timeout: OREF_HTTP_TIMEOUT_MS,
        responseType: 'text',
        validateStatus: () => true,
        maxContentLength: OREF_MAX_RESPONSE_BYTES,
        maxBodyLength: OREF_MAX_RESPONSE_BYTES,
      });

      if (response.status >= 200 && response.status < 300) {
        const rawPayload = String(response.data || '').trim();

        if (!rawPayload) {
          emptyOrefPollCount += 1;
          parsedPayload = [];
          orefOfficialOk = true;
        } else {
          emptyOrefPollCount = 0;
          lastOrefRawPayload = rawPayload;
          const bomStripped = rawPayload.replace(/^\uFEFF/, '');
          try {
            const root = JSON.parse(bomStripped);
            if (Array.isArray(root)) {
              parsedPayload = root;
              orefOfficialOk = true;
            } else if (root != null && typeof root === 'object') {
              parsedPayload = [root];
              orefOfficialOk = true;
            } else {
              console.log('[Oref missile layer] JSON root is not object/array');
              parsedPayload = [];
              orefOfficialOk = false;
            }
          } catch (error) {
            console.log('[Oref missile layer] JSON parse error:', error.message);
            parsedPayload = [];
            orefOfficialOk = false;
          }
        }
      } else {
        console.warn(`[Oref missile layer] HTTP ${response.status}`);
        emptyOrefPollCount += 1;
        parsedPayload = [];
        orefOfficialOk = false;
      }
    } catch (error) {
      console.log('[Oref missile layer] Request error:', error.message);
      emptyOrefPollCount += 1;
      parsedPayload = [];
      orefOfficialOk = false;
    }

    /* מקור יחיד: פיקוד העורף. גיבוי (צופר) כש־HTTP/רשת או ש־JSON לא תקין — או כשחסום (403). */
    let usedTzofarPayloadThisPoll = false;
    if (orefOfficialOk && tzofarBackupClient) {
      tzofarBackupClient.resetShadowState();
    }
    
    // Always try Tzofar backup when Oref fails or is blocked (403)
    if (!orefOfficialOk) {
      if (tzofarBackupClient) {
        const syn = tzofarBackupClient.buildOrefLikePayload();
        console.log(`[Oref] Tzofar backup check: syn.length=${syn.length}`);
        if (syn.length > 0) {
          parsedPayload = syn;
          usedTzofarPayloadThisPoll = true;
          console.warn(
            `[Oref] גיבוי צופר: ${syn.length} קבוצות התרעה (פיקוד לא זמין/חסום).`
          );
        } else {
          console.warn('[Oref] גיבוי צופר: אין נתונים זמינים מצופר');
        }
      } else {
        console.warn('[Oref] גיבוי צופר לא מאותחל - TZOFAR_BACKUP_ENABLED לא מוגדר?');
      }
    }
    orefLastPollUsedTzofarBackup = usedTzofarPayloadThisPoll;

    const now = Date.now();
    const previousActiveCities = [...activeAlertsCache];
    const historySnapshot = await refreshOrefHistoryState(now);
    const normalizedAlerts = normalizeOrefAlerts(parsedPayload);
    await enrichOrefAlertsGeocode(normalizedAlerts, {
      normalizeHebrewSettlementName,
      isPlausibleTarget: isPlausibleIsraelAlertTarget,
    });
    normalizedAlerts.forEach((a) => finalizeOrefAlertSettlementName(a));

    const mergedAlertsByCity = new Map();
    normalizedAlerts.forEach((alert) => {
      if (!alert?.cityName) return;
      const nextPhase = inferOrefAlertPhase(alert);
      const mk = settlementMatchKey(alert.cityName);
      const existing = mergedAlertsByCity.get(mk);
      if (!existing) {
        mergedAlertsByCity.set(mk, alert);
        return;
      }
      const existingPhase = inferOrefAlertPhase(existing);
      const nextRank = getAlertPhaseRank(nextPhase);
      const existingRank = getAlertPhaseRank(existingPhase);
      const nextTime = Number(alert.orefTimeMs || 0);
      const existingTime = Number(existing.orefTimeMs || 0);
      if (nextRank > existingRank || (nextRank === existingRank && nextTime >= existingTime)) {
        mergedAlertsByCity.set(mk, {
          ...existing,
          ...alert,
          orefTextBlob: alert.orefTextBlob || existing.orefTextBlob,
        });
      }
    });
    const effectiveAlerts = [...mergedAlertsByCity.values()].filter((alert) => {
      const tp = getTargetPosition(alert);
      return (
        Array.isArray(tp) &&
        tp.length >= 2 &&
        isPlausibleIsraelAlertTarget(Number(tp[0]), Number(tp[1]))
      );
    });
    const pollAxisHint = computeOrefPollAxisHint(effectiveAlerts, historySnapshot);

    orefPollContextAlerts = effectiveAlerts;
    const releasedCityNames = new Set(
      effectiveAlerts
        .filter((alert) => inferOrefAlertPhase(alert) === 'released')
        .map((alert) => alert.cityName)
        .filter(Boolean)
    );
    (historySnapshot.releasedCities || new Set()).forEach((cityName) => {
      if (cityName && !(historySnapshot.activeCities || new Set()).has(cityName)) {
        releasedCityNames.add(cityName);
      }
    });
    /* רק התרעות מהפול הנוכחי של פיקוד העורף (לא "active" מהיסטוריה) — מונע טילי דמה לערים שלא הופיעו ב־JSON */
    const seenCityNames = [
      ...new Set(
        effectiveAlerts
          .filter((alert) => !releasedCityNames.has(alert.cityName))
          .map((alert) => alert.cityName)
          .filter(Boolean)
      ),
    ];

    releasedCityNames.forEach((cityName) => {
      activeAlertLastSeenAt.delete(cityName);
      cityClearConfirmPolls.delete(cityName);
    });

    seenCityNames.forEach((cityName) => {
      activeAlertLastSeenAt.set(cityName, now);
    });

    pruneExpiredAlertCache(now);

    const nextActiveCities = computeHeldActiveCities(now);
    const hasActiveOrefThreat =
      seenCityNames.length > 0 || nextActiveCities.length > 0;
    if (hasActiveOrefThreat) {
      try {
        refreshNewsThreatAxisBlob({ force: true });
      } catch (_) {
        /* */
      }
      /* OSINT + GDELT ברקע — לא חוסמים poll של פיקוד; fusion/סוקט נשארים בזמן אמת */
      if (now - orefBurstOsintLastAt >= OREF_OSINT_BURST_MIN_MS) {
        orefBurstOsintLastAt = now;
        const parallelBurst = [
          refreshOsintHints(getNewsStoreWarRelatedBlob, { burst: true }),
        ];
        if (process.env.GDELT_ENABLED !== '0') {
          parallelBurst.push(
            updateGdeltFusionBurst().catch((e) => {
              console.warn('[GDELT] oref-sync burst:', e && e.message ? e.message : e);
            })
          );
        }
        void Promise.allSettled(parallelBurst).then(() => {
          if (
            process.env.LAUNCH_AXIS_AI_ENABLED === '1' &&
            process.env.LAUNCH_AXIS_AI_ON_OREF_BURST !== '0'
          ) {
            try {
              setImmediate(() => tickLaunchAxisAi());
            } catch (_) {
              /* */
            }
          }
        });
      }
    }

    effectiveAlerts.forEach((alert) => {
      const targetPosition = getTargetPosition(alert);
      if (
        !targetPosition ||
        !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
      ) {
        return;
      }
      const alertWithAxisHint = pollAxisHint?.axis
        ? {
            ...alert,
            sourceAxisHint: pollAxisHint.axis,
            sourceAxisConfidence: pollAxisHint.sourceConfidence,
            sourceAxisConfidenceScore: pollAxisHint.sourceConfidenceScore,
          }
        : alert;
      const fusion = computeThreatFusionResult(alertWithAxisHint);
      const missileForPoll = findMissileForOrefAlertUpdate(alertWithAxisHint);
      const geomAlertPoll = launchGeometryAlert(alertWithAxisHint, missileForPoll);
      const rawSourcePosition = resolveSourcePosition(geomAlertPoll, targetPosition);
      const sourcePosition = rawSourcePosition;
      const sourceRegion = resolveSourceRegionFromAlert(geomAlertPoll, sourcePosition, targetPosition);
      const inferredPhase = inferOrefAlertPhase(alert);
      upsertActiveAlertDetail({
        cityName: alert.cityName,
        coordinates: targetPosition,
        title: alert.title,
        threatType: alert.threatType,
        alertPhase: inferredPhase,
        sourceRegion,
        sourceLocation: getSourceRegionLabel(sourceRegion),
        sourcePosition,
        sourceConfidence: fusion.sourceConfidence || 'estimated',
        sourceConfidenceScore:
          fusion.sourceConfidenceScore != null ? fusion.sourceConfidenceScore : fusion.trajectoryConfidence,
        orefTextBlob: alert.orefTextBlob,
        orefTimeMs: alert.orefTimeMs,
        orefCategory: alert.orefCategory != null ? alert.orefCategory : undefined,
      });
    });

    const freshAlerts = effectiveAlerts
      .filter((alert) => !releasedCityNames.has(alert.cityName))
      .filter((alert) => !previousActiveCities.includes(alert.cityName))
      .map((alert) => {
        const targetPosition = getTargetPosition(alert);
        if (
          !targetPosition ||
          !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
        ) {
          return null;
        }
      const alertWithAxisHint = pollAxisHint?.axis
        ? {
            ...alert,
            sourceAxisHint: pollAxisHint.axis,
            sourceAxisConfidence: pollAxisHint.sourceConfidence,
            sourceAxisConfidenceScore: pollAxisHint.sourceConfidenceScore,
          }
        : alert;
      const fusion = computeThreatFusionResult(alertWithAxisHint);
      const missileFresh = findMissileForOrefAlertUpdate(alertWithAxisHint);
      const geomAlertFresh = launchGeometryAlert(alertWithAxisHint, missileFresh);
      const rawSourcePosition = resolveSourcePosition(geomAlertFresh, targetPosition);
      const sourcePosition = rawSourcePosition;
      const sourceRegion = resolveSourceRegionFromAlert(geomAlertFresh, sourcePosition, targetPosition);
      const receivedAtMs = activeAlertDetailsByCity.get(alert.cityName)?.receivedAtMs ?? Date.now();

      return {
        ...alertWithAxisHint,
        sourceConfidence: fusion.sourceConfidence || 'estimated',
        sourceConfidenceScore:
          fusion.sourceConfidenceScore != null ? fusion.sourceConfidenceScore : fusion.trajectoryConfidence,
        sourceLocation: getSourceRegionLabel(sourceRegion),
        receivedAtMs,
        targetPosition,
        sourcePosition,
        sourceRegion,
        };
      })
      .filter((a) => a != null);

    const freshCitySet = new Set(freshAlerts.map((a) => a.cityName));

    nextActiveCities.forEach((cityName) => {
      const detail = activeAlertDetailsByCity.get(cityName);
      if (!detail) return;
      const normalizedAlert = effectiveAlerts.find((alert) => alert.cityName === cityName) || {
        cityName,
        title: detail.title || '׳”׳×׳¨׳׳”',
        coordinates: detail.coordinates,
        threatType: detail.threatType || 'missile',
        orefTextBlob: detail.orefTextBlob,
        orefTimeMs: detail.orefTimeMs != null ? detail.orefTimeMs : Date.now(),
        receivedAtMs: detail.receivedAtMs != null ? detail.receivedAtMs : Date.now(),
        orefCategory: detail.orefCategory != null ? detail.orefCategory : null,
        sourcePosition: null,
        targetPosition: null,
      };
      if (normalizedAlert.orefTimeMs == null && detail.orefTimeMs != null) {
        normalizedAlert.orefTimeMs = detail.orefTimeMs;
      }
      if (normalizedAlert.receivedAtMs == null && detail.receivedAtMs != null) {
        normalizedAlert.receivedAtMs = detail.receivedAtMs;
      }
      const holdTargetPosition = getTargetPosition({
        ...normalizedAlert,
        coordinates: detail.coordinates,
      });
      if (
        !holdTargetPosition ||
        !isPlausibleIsraelAlertTarget(holdTargetPosition[0], holdTargetPosition[1])
      ) {
        return;
      }
      normalizedAlert.targetPosition = holdTargetPosition;
      normalizedAlert.sourcePosition =
        (Array.isArray(detail?.sourcePosition) && detail.sourcePosition.length >= 2
          ? normalizeLngLat(detail.sourcePosition)
          : null) ||
        resolveSourcePosition(
          {
            title: detail.title,
            threatType: detail.threatType,
            desc: detail.desc,
            description: detail.description,
            orefTextBlob: detail.orefTextBlob,
            sourceAxisHint: detail.sourceRegion || null,
          },
          holdTargetPosition
        );
      const resolvedRegion = detail?.sourceRegion ||
        resolveSourceRegionFromAlert(
          normalizedAlert,
          normalizedAlert.sourcePosition,
          holdTargetPosition
        );
      ensureThreatExistsForCity(
        { ...normalizedAlert, targetPosition: holdTargetPosition, sourcePosition: normalizedAlert.sourcePosition },
        resolvedRegion,
        getSourceRegionLabel(resolvedRegion),
        { skipMissileIfFresh: freshCitySet.has(cityName), suppressFeed: true }
      );
    });

    if (freshAlerts.length > 0) {
      lastUnifiedOrefAlertAt = new Date().toISOString();
      console.log(
        `[Oref realtime] ערים חדשות בפול (${freshAlerts.length}): ${freshAlerts.map((a) => a && a.cityName).filter(Boolean).join(' · ')}`
      );
    }

    const salvoes = clusterAlertsIntoSalvos(freshAlerts);

    salvoes.forEach((salvo) => {
      const clusterMeta = buildClusterMunitionMeta(salvo);
      const salvoAlertsOrdered =
        clusterMeta != null
          ? [...salvo.alerts].sort((a, b) => {
              const aM = a.cityName === clusterMeta.primaryName ? 0 : 1;
              const bM = b.cityName === clusterMeta.primaryName ? 0 : 1;
              if (aM !== bM) return aM - bM;
              return String(a.cityName || '').localeCompare(String(b.cityName || ''), 'he');
            })
          : salvo.alerts;

      salvoAlertsOrdered.forEach((alert, alertIndex) => {
        const salvoIndexResolved = salvo.alerts.indexOf(alert) >= 0 ? salvo.alerts.indexOf(alert) + 1 : alertIndex + 1;
        if (alert.threatType !== 'uav') {
          const existingForCity = findMissileForOrefAlertUpdate(alert);
          if (existingForCity) {
            if (existingForCity.telegramEarly) {
              upgradeTelegramMissileWithOref(existingForCity.id, alert, {
                waveId: salvo.waveId,
                salvoCountEstimate: salvo.count,
                salvoIndex: salvoIndexResolved,
              });
              const missileNewPayload = {
                id: existingForCity.id,
                cityName: alert.cityName,
                coordinates: getTargetPosition(alert),
                title: alert.title || 'התראה צבע אדום',
                threatType: alert.threatType || 'missile',
                alertPhase: inferOrefAlertPhase(alert) || 'siren_active',
                orefTextBlob: alert.orefTextBlob || '',
                sourceRegion: salvo.sourceRegion,
                sourceLocation: salvo.sourceLocation,
                timestamp: new Date().toISOString(),
                orefTimeMs: alert.orefTimeMs ?? Date.now(),
                receivedAtMs: alert.receivedAtMs ?? Date.now(),
              };
              enrichPayloadWithOrefGuideline(alert, missileNewPayload);
              appendFeedFromNewAlertPayload(missileNewPayload);
              orefRecordClientFeedSnapshot(alert);
              scheduleOrefClientSocketEmit(() => {
                io.emit('new_alert', missileNewPayload);
              });
              return;
            }
            return;
          }
        } else {
          [...activeMissilesById.keys()].forEach((mid) => {
            const m = activeMissilesById.get(mid);
            if (m && m.cityName === alert.cityName && m.threatType !== 'uav') {
              removeActiveMissileById(mid);
            }
          });
        }

        const missileEvent = {
          ...buildMissileLifecycle(
            alert,
            alert.sourcePosition,
            alert.targetPosition
          ),
          waveId: salvo.waveId,
          salvoCountEstimate: salvo.count,
          salvoIndex: salvoIndexResolved,
          sourceRegion: salvo.sourceRegion,
          sourceLocation: salvo.sourceLocation,
        };
        syncMissileSourceFromGeometry(missileEvent);

        if (missileEvent.threatType === 'uav') {
          const trackKey = getUavTrackKey(alert, salvo.sourceRegion);
          let activeTrackId = activeUavTracksByKey.get(trackKey);
          let activeTrack = activeTrackId ? activeMissilesById.get(activeTrackId) : null;

          if (!activeTrack) {
            const uavsInRegion = [...activeMissilesById.values()].filter(
              (m) => m.threatType === 'uav' && m.sourceRegion === salvo.sourceRegion
            );
            if (uavsInRegion.length === 1) {
              const cand = uavsInRegion[0];
              const visited = [...(cand.routeCities || []), cand.cityName].filter(Boolean);
              if (!visited.includes(alert.cityName)) {
                const age = Date.now() - (cand.updatedAt || cand.timestamp || 0);
                if (age <= 5 * 60 * 1000) {
                  activeTrack = cand;
                  activeUavTracksByKey.set(trackKey, cand.id);
                }
              }
            }
          }

          if (activeTrack) {
            activeTrack.cityName = missileEvent.cityName;
            activeTrack.target = missileEvent.target;
            activeTrack.targetPosition = missileEvent.targetPosition;
            activeTrack.sourceRegion = missileEvent.sourceRegion;
            activeTrack.sourceLocation = missileEvent.sourceLocation;
            activeTrack.salvoCountEstimate = Math.max(activeTrack.salvoCountEstimate || 1, missileEvent.salvoCountEstimate || 1);
            activeTrack.salvoIndex = missileEvent.salvoIndex;
            activeTrack.updatedAt = Date.now();
            activeTrack.routePoints = appendUniqueRoutePoint([...(activeTrack.routePoints || [activeTrack.source, activeTrack.target])], missileEvent.targetPosition);
            activeTrack.routeCities = [...(activeTrack.routeCities || [])];
            if (activeTrack.routeCities[activeTrack.routeCities.length - 1] !== missileEvent.cityName) {
              activeTrack.routeCities.push(missileEvent.cityName);
            }
            storeActiveMissile(activeTrack);

            const uavNewPayload = {
              id: activeTrack.id,
              cityName: missileEvent.cityName,
              coordinates: missileEvent.targetPosition,
              title: alert.title || '׳”׳×׳¨׳¢׳× ׳›׳˜׳‘"׳',
              threatType: activeTrack.threatType,
              alertPhase: activeTrack.alertPhase || 'pre_alert',
              orefTextBlob: alert.orefTextBlob || '',
              timestamp: new Date().toISOString(),
              orefTimeMs: alert.orefTimeMs ?? missileEvent.orefTimeMs,
              receivedAtMs: alert.receivedAtMs ?? missileEvent.receivedAtMs ?? activeTrack.receivedAtMs,
            };
            enrichPayloadWithOrefGuideline(alert, uavNewPayload);
            appendFeedFromNewAlertPayload(uavNewPayload);
            orefRecordClientFeedSnapshot(alert);
            scheduleOrefClientSocketEmit(() => {
              io.emit('new_alert', uavNewPayload);
            });
            scheduleOrefClientSocketEmit(() => {
              io.emit('uav_track_update', activeTrack);
            });
            return;
          }

          missileEvent.uavTrackKey = trackKey;
          missileEvent.routePoints = [missileEvent.source, missileEvent.target];
          missileEvent.routeCities = [missileEvent.cityName];
          missileEvent.updatedAt = missileEvent.timestamp;
          activeUavTracksByKey.set(trackKey, missileEvent.id);
        }

        const missileNewPayload = {
          id: missileEvent.alertId || missileEvent.id,
          cityName: missileEvent.cityName,
          coordinates: missileEvent.targetPosition,
          title: alert.title || '׳”׳×׳¨׳¢׳× ׳¦׳‘׳¢ ׳׳“׳•׳',
          threatType: missileEvent.threatType,
          alertPhase: missileEvent.alertPhase || 'pre_alert',
          orefTextBlob: alert.orefTextBlob || '',
          sourceRegion: missileEvent.sourceRegion,
          sourceLocation: missileEvent.sourceLocation,
          timestamp: new Date().toISOString(),
          orefTimeMs: alert.orefTimeMs ?? missileEvent.orefTimeMs,
          receivedAtMs: alert.receivedAtMs ?? missileEvent.receivedAtMs,
        };
        enrichPayloadWithOrefGuideline(alert, missileNewPayload);
        appendFeedFromNewAlertPayload(missileNewPayload);
        orefRecordClientFeedSnapshot(alert);
        scheduleOrefClientSocketEmit(() => {
          io.emit('new_alert', missileNewPayload);
        });
        const clusterMunitionEmit =
          clusterMeta && alert.threatType !== 'uav'
            ? {
                centroid: clusterMeta.centroid,
                sisters: clusterMeta.sisters,
                isMother: alert.cityName === clusterMeta.primaryName,
              }
            : null;
        scheduleOrefClientSocketEmit(() => {
          io.emit(
            'real_time_missile',
            clusterMunitionEmit ? { ...missileEvent, clusterMunition: clusterMunitionEmit } : missileEvent
          );
        });
        storeActiveMissile(missileEvent);
        scheduleMissileLifecycle(missileEvent);
      });
    });

    finalizeAllActiveOrefTrajectories(effectiveAlerts, nextActiveCities);
    syncClientEventFeedFromOrefEffectiveAlerts(effectiveAlerts, releasedCityNames, now);

    nextActiveCities.forEach((cityName) => {
      cityClearConfirmPolls.delete(cityName);
    });

    previousActiveCities.forEach((cityName) => {
      if (!nextActiveCities.includes(cityName)) {
        if (!releasedCityNames.has(cityName)) {
          // Keep the threat alive until Oref sends an explicit release for this city.
          if (!nextActiveCities.includes(cityName)) {
            nextActiveCities.push(cityName);
          }
          cityClearConfirmPolls.delete(cityName);
          return;
        }
        cityClearConfirmPolls.delete(cityName);
        removeActiveMissilesByCity(cityName);
        activeAlertLastSeenAt.delete(cityName);
        const releaseAlert = effectiveAlerts.find(
          (a) => a?.cityName === cityName && inferOrefAlertPhase(a) === 'released'
        );
        const detailForRelease = activeAlertDetailsByCity.get(cityName);
        const releaseOrefMs =
          releaseAlert?.orefTimeMs != null && Number.isFinite(Number(releaseAlert.orefTimeMs))
            ? Number(releaseAlert.orefTimeMs)
            : detailForRelease?.orefTimeMs != null && Number.isFinite(Number(detailForRelease.orefTimeMs))
              ? Number(detailForRelease.orefTimeMs)
              : null;
        const releaseTs = releaseOrefMs ?? Date.now();
        appendServerFeedEntry({
          timestampMs: releaseTs,
          ...(releaseOrefMs != null ? { orefTimeMs: releaseOrefMs } : {}),
          title: cityName,
          type: 'defense',
          tag: 'האירוע הסתיים',
          severity: 1,
          cityName,
          alertPhase: 'released',
          liveState: 'שוחרר',
        });
        const releaseGuideline = releaseAlert
          ? classifyOrefGuidelinePhase(buildOrefGuidelineFullText(releaseAlert))
          : { matchedPhrase: null };
        io.emit('clear_city_alert', {
          city: cityName,
          cityName,
          timestamp: new Date().toISOString(),
          ...(releaseGuideline.matchedPhrase ? { orefGuidelineMatch: releaseGuideline.matchedPhrase } : {}),
        });
      }
    });

    // כאשר באותו מחזור יש שחרור לכמה יישובים, מוסיפים גם שורת סיכום לפי ניסוח פיקוד (לשונית "הכל").
    if (releasedCityNames.size >= 2) {
      const releasedList = [...releasedCityNames].map((c) => String(c || '').trim()).filter(Boolean);
      if (releasedList.length >= 2) {
        const summaryTs = Date.now();
        appendServerFeedEntry({
          timestampMs: summaryTs,
          orefTimeMs: summaryTs,
          title: releasedList.join(', '),
          type: 'defense',
          tag: 'האירוע הסתיים',
          severity: 1,
          alertPhase: 'released',
          liveState: 'שוחרר',
        });
      }
    }

    if (nextActiveCities.length === 0 && previousActiveCities.length > 0 && releasedCityNames.size > 0) {
      const releaseTs = Date.now();
      const releaseMsg = '׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£ ׳©׳—׳¨׳¨ ׳׳× ׳›׳ ׳”׳”׳×׳¨׳׳•׳× - ׳ ׳™׳×׳ ׳׳¦׳׳× ׳׳”׳׳¨׳—׳‘ ׳”׳׳•׳’׳';
      appendServerFeedEntry({
        timestampMs: releaseTs,
        orefTimeMs: releaseTs,
        title: 'השוהים במרחב המוגן יכולים לצאת',
        type: 'defense',
        tag: 'האירוע הסתיים',
        severity: 1,
        alertPhase: 'released',
        liveState: 'שוחרר',
      });
      io.emit('alert_release', {
        message: releaseMsg,
        timestamp: new Date().toISOString(),
      });
      io.emit('clear_all_threats', { timestamp: new Date().toISOString() });
      clearAllActiveMissiles();
    }

    activeAlertsCache = nextActiveCities;
    refreshAiSummary();
    syncActiveAlertsState();
  } catch (error) {
    console.log('[Oref missile layer] Error:', error.message);
  } finally {
    orefPollContextAlerts = null;
    orefPollInFlight = false;
    if (orefPollPendingFollowUp) {
      orefPollPendingFollowUp = false;
      setImmediate(() => runPoller('oref', pollOrefMissileLayer));
    }
  }
}

function flightInMiddleEastBox(flight) {
  return (
    flight &&
    flight.latitude != null &&
    flight.longitude != null &&
    flight.latitude >= 28 &&
    flight.latitude <= 37 &&
    flight.longitude >= 32 &&
    flight.longitude <= 42
  );
}

/** מפתח לאיחוד רשומות מ-OpenSky ו-ADSB */
function flightDedupeKey(f) {
  const h = String(f?.icao24 || '')
    .trim()
    .toLowerCase()
    .replace(/^~/, '');
  if (h && h.length >= 4) return `h:${h}`;
  const lat = Number(f?.latitude);
  const lng = Number(f?.longitude);
  const cs = String(f?.callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (Number.isFinite(lat) && Number.isFinite(lng) && cs && cs !== 'N/A') {
    return `p:${Math.round(lat * 40) / 40}_${Math.round(lng * 40) / 40}_${cs.slice(0, 10)}`;
  }
  return `u:${cs || 'na'}_${lat}_${lng}`;
}

/** אל על — קוד ICAO ELY (למשל ELY027), לעיתים ELAL בטקסט */
function isElAlCallsign(f) {
  const raw = String(f?.callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!raw || raw === 'N/A') return false;
  if (raw.startsWith('ELY') && raw.length >= 5) return true;
  if (raw.startsWith('ELAL')) return true;
  return false;
}

function mergeFlightArrays(openSkyList, adsbList) {
  const map = new Map();
  for (const f of openSkyList) {
    const row = {
      ...f,
      dataSources: ['OpenSky'],
      isElAl: isElAlCallsign(f),
    };
    map.set(flightDedupeKey(row), row);
  }
  for (const f of adsbList) {
    const key = flightDedupeKey(f);
    if (!map.has(key)) {
      map.set(key, {
        ...f,
        dataSources: ['ADS-B'],
        isElAl: isElAlCallsign(f),
      });
    } else {
      const ex = map.get(key);
      if (!ex.dataSources.includes('ADS-B')) ex.dataSources.push('ADS-B');
      ex.isElAl = Boolean(ex.isElAl) || isElAlCallsign(f);
    }
  }
  return Array.from(map.values());
}

function sortFlightsForUi(list) {
  return [...list].sort((a, b) => {
    const ae = a.isElAl ? 1 : 0;
    const be = b.isElAl ? 1 : 0;
    if (be !== ae) return be - ae;
    return (Number(b.baro_altitude) || 0) - (Number(a.baro_altitude) || 0);
  });
}

/** מספר נקודות adsb.one (וגם ADSB_EXCHANGE_URLS) — משלים OpenSky ומדגיש כיסוי לישראל / אל על */
async function fetchAdsbMultiPointFlights() {
  const extra = String(process.env.ADSB_EXCHANGE_URLS || '')
    .split(',')
    .map((s) => normalizeAdsbUrl(s.trim()))
    .filter(Boolean);
  const defaults = [
    normalizeAdsbUrl(process.env.ADSB_EXCHANGE_URL),
    'https://api.adsb.one/v2/point/32/35/500',
    'https://api.adsb.one/v2/point/32.01/34.88/320',
    'https://api.adsb.one/v2/point/31.25/35.0/380',
    'https://api.adsb.one/v2/point/33.85/35.45/340',
    'https://api.adsb.one/v2/point/29.55/34.95/450',
  ].filter(Boolean);
  const urls = [...new Set([...extra, ...defaults])];

  const mapRow = (flight) => ({
    icao24: flight.hex || flight.icao || '',
    callsign: String(flight.flight || flight.callsign || flight.r || 'N/A').trim(),
    origin_country: flight.country || '',
    longitude: Number(flight.lon ?? flight.lng),
    latitude: Number(flight.lat),
    baro_altitude: Number(flight.alt_baro ?? flight.alt_geom ?? flight.alt ?? 0),
    on_ground: Boolean(flight.ground),
    velocity: Number(flight.gs ?? flight.speed ?? flight.tas ?? 0),
    true_track: Number(flight.track ?? 0),
    vertical_rate: Number(flight.baro_rate ?? flight.vertical ?? 0),
  });

  const byKey = new Map();
  const reqOpts = {
    timeout: Number(process.env.ADSB_TIMEOUT_MS || 8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  };
  const settled = await Promise.allSettled(urls.map((url) => axios.get(url, reqOpts)));
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    if (res.status !== 'fulfilled') {
      const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason || '');
      console.log('[ADSB multi]', String(urls[i]).slice(0, 72), msg);
      continue;
    }
    try {
      const response = res.value;
      const aircraft = Array.isArray(response.data?.ac)
        ? response.data.ac
        : Array.isArray(response.data?.aircraft)
        ? response.data.aircraft
        : [];
      for (const row of aircraft) {
        const f = mapRow(row);
        if (!Number.isFinite(f.latitude) || !Number.isFinite(f.longitude)) continue;
        if (!flightInMiddleEastBox(f)) continue;
        const key = flightDedupeKey(f);
        if (!byKey.has(key)) byKey.set(key, f);
      }
    } catch (e) {
      console.log('[ADSB multi] parse', String(urls[i]).slice(0, 72), e.message);
    }
  }
  return Array.from(byKey.values());
}

async function fetchOpenSkyData() {
  const mapFlight = (flight) => ({
    icao24: flight[0],
    callsign: flight[1]?.trim() || 'N/A',
    origin_country: flight[2],
    longitude: flight[5],
    latitude: flight[6],
    baro_altitude: flight[7],
    on_ground: flight[8],
    velocity: flight[9],
    true_track: flight[10],
    vertical_rate: flight[11],
  });

  const mergeAndCap = async (openList) => {
    const adsb = await fetchAdsbMultiPointFlights();
    const merged = mergeFlightArrays(openList, adsb);
    const sorted = sortFlightsForUi(merged);
    const cap = Math.min(250, Math.max(100, Number(process.env.FLIGHTS_MERGED_MAX) || 200));
    const out = sorted.slice(0, cap);
    if (out.length > 0) {
      const ely = out.filter((x) => x.isElAl).length;
      console.log(
        `[Flights] merged OpenSky+ADSB: ${out.length} (OpenSky ${openList.length}, ADSB uniq ${adsb.length}, אל על≈${ely})`
      );
    }
    return out.length > 0 ? out : state.flights;
  };

  try {
    if (Date.now() < openSkyRateLimitedUntil) {
      const adsbOnly = await fetchAdsbMultiPointFlights();
      const cap = Math.min(250, Math.max(100, Number(process.env.FLIGHTS_MERGED_MAX) || 200));
      const out = sortFlightsForUi(mergeFlightArrays([], adsbOnly)).slice(0, cap);
      return out.length > 0 ? out : state.flights;
    }

    const params = {
      lamin: Number(process.env.OPENSKY_LAMIN || 28),
      lamax: Number(process.env.OPENSKY_LAMAX || 37),
      lomin: Number(process.env.OPENSKY_LOMIN || 32),
      lomax: Number(process.env.OPENSKY_LOMAX || 42),
    };
    const authConfig = await getOpenSkyAuthConfig();

    const regionalResponse = await axios.get(
      process.env.OPENSKY_URL || 'https://opensky-network.org/api/states/all',
      {
        params,
        ...authConfig,
        timeout: Number(process.env.OPENSKY_TIMEOUT_MS || 10000),
      }
    );

    let openFlights = (regionalResponse.data?.states || [])
      .map(mapFlight)
      .filter(flightInMiddleEastBox);

    if (openFlights.length === 0) {
      const globalResponse = await axios.get(
        process.env.OPENSKY_URL || 'https://opensky-network.org/api/states/all',
        {
          ...authConfig,
          timeout: Number(process.env.OPENSKY_TIMEOUT_MS || 12000),
        }
      );
      openFlights = (globalResponse.data?.states || [])
        .map(mapFlight)
        .filter(flightInMiddleEastBox);
    }

    return mergeAndCap(openFlights);
  } catch (error) {
    if (error.response?.status === 429) {
      const cooldownMs = Math.max(
        5 * 60_000,
        Number(process.env.OPENSKY_429_COOLDOWN_MS) || 30 * 60_000
      );
      openSkyRateLimitedUntil = Date.now() + cooldownMs;
      if (Date.now() - openSkyLastRateLimitLogAt > 60_000) {
        openSkyLastRateLimitLogAt = Date.now();
        console.log(`[OpenSky] Rate limited (429), cooling down for ${Math.round(cooldownMs / 60000)} min`);
      }
    }

    console.log('[OpenSky] Error:', error.response?.status || error.message);
    return fetchAdsbExchangeData();
  }
}

function normalizeAdsbUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/v2\/lat\/([^/]+)\/lon\/([^/]+)\/dist\/([^/?#]+)/i);
  if (!m) return raw;
  return raw.replace(/\/v2\/lat\/[^/]+\/lon\/[^/]+\/dist\/[^/?#]+/i, `/v2/point/${m[1]}/${m[2]}/${m[3]}`);
}

async function fetchAdsbExchangeData() {
  const list = await fetchAdsbMultiPointFlights();
  if (list.length > 0) {
    const cap = Math.min(250, Math.max(100, Number(process.env.FLIGHTS_MERGED_MAX) || 200));
    const merged = sortFlightsForUi(mergeFlightArrays([], list)).slice(0, cap);
    console.log(`[ADSB] Fallback merged flights: ${merged.length}`);
    return merged;
  }
  return fetchFlightRadar24Data();
}

async function fetchFlightRadar24Data() {
  try {
    const response = await axios.get(
      process.env.FLIGHTRADAR24_URL || 'https://data-live.flightradar24.com/zones/fcgi/feed.js',
      {
        timeout: Number(process.env.FLIGHTRADAR24_TIMEOUT_MS || 8000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        params: {
          bounds: process.env.FLIGHTRADAR24_BOUNDS || '37.5,28.0,32.0,42.0',
          faa: 1,
          satellite: 1,
          mlat: 1,
          flarm: 1,
          adsb: 1,
          gnd: 1,
          air: 1,
          vehicles: 0,
          estimated: 1,
          maxage: 14400,
          gliders: 0,
          stats: 0,
        },
      }
    );

    const body = response.data && typeof response.data === 'object' ? response.data : {};
    const aircraft = Array.isArray(body.aircraft)
      ? body.aircraft
      : Object.entries(body)
          .filter(([key, value]) => key !== 'full_count' && key !== 'version' && Array.isArray(value))
          .map(([icao24, value]) => ({
            hex: icao24,
            lon: value[1],
            lat: value[2],
            track: value[3],
            alt: value[4],
            speed: value[5],
            flight: value[16] || value[13],
            ground: value[14],
            vertical: value[15],
          }));

    const flights = sortFlightsForUi(
      aircraft
        .map((flight) => ({
          icao24: flight.hex || flight.icao || '',
          callsign: String(flight.flight || flight.callsign || flight.r || 'N/A').trim(),
          origin_country: flight.country || '',
          longitude: Number(flight.lon ?? flight.lng),
          latitude: Number(flight.lat),
          baro_altitude: Number(flight.alt_baro ?? flight.alt_geom ?? flight.alt ?? 0),
          on_ground: Boolean(flight.ground),
          velocity: Number(flight.gs ?? flight.speed ?? flight.tas ?? 0),
          true_track: Number(flight.track ?? 0),
          vertical_rate: Number(flight.baro_rate ?? flight.vertical ?? 0),
          dataSources: ['FR24'],
          isElAl: isElAlCallsign({
            callsign: String(flight.flight || flight.callsign || flight.r || ''),
          }),
        }))
        .filter((flight) => Number.isFinite(flight.latitude) && Number.isFinite(flight.longitude))
    ).slice(0, 200);

    if (flights.length > 0) {
      console.log(`[FR24] Fallback flights: ${flights.length}`);
      return flights;
    }

    return state.flights;
  } catch (error) {
    console.log('[FR24] Error:', error.response?.status || error.message);
    return state.flights;
  }
}

async function fetchUSGSData() {
  try {
    const response = await axios.get(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
      { timeout: 10000 }
    );

    const events = (response.data?.features || []).slice(0, 20).map((feature) => ({
      id: feature.id,
      magnitude: feature.properties.mag,
      place: feature.properties.place,
      time: feature.properties.time,
      coordinates: feature.geometry.coordinates,
      depth: feature.geometry.coordinates?.[2],
      lat: feature.geometry.coordinates?.[1],
      lng: feature.geometry.coordinates?.[0],
    }));

    return events.length > 0 ? events : state.seismic;
  } catch (error) {
    console.log('[USGS] Error:', error.message);
    return state.seismic;
  }
}

async function fetchYahooData() {
  try {
    const nameMap = {
      '^VIX': 'vix',
      '^GSPC': 'sp500',
      '^IXIC': 'nasdaq',
    };
    const results = {};

    try {
      const quoteResponse = await axios.get(
        'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EVIX,%5EGSPC,%5EIXIC',
        {
          timeout: 7000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        }
      );

      for (const item of quoteResponse.data?.quoteResponse?.result || []) {
        const key = nameMap[item.symbol];
        if (!key) {
          continue;
        }

        const lastPrice = item.regularMarketPrice ?? item.postMarketPrice ?? item.bid;
        const prevClose = item.regularMarketPreviousClose ?? item.bid ?? lastPrice;
        const change = Number(item.regularMarketChange ?? lastPrice - prevClose);
        const changePercent = Number(
          item.regularMarketChangePercent ??
            (prevClose ? (change / prevClose) * 100 : 0)
        );

        if (lastPrice == null) {
          continue;
        }

        results[key] = {
          value: Number(lastPrice).toFixed(2),
          change: Number(change).toFixed(2),
          changePercent: Number(changePercent).toFixed(2),
          positive: change >= 0,
        };
      }
    } catch (error) {
      console.log('[Yahoo] Bulk quote failed:', error.message);
    }

    const missingSymbols = Object.entries(nameMap)
      .filter(([, key]) => !results[key])
      .map(([symbol]) => symbol);

    for (const symbol of missingSymbols) {
      try {
        const response = await axios.get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
          {
            timeout: 5000,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
          }
        );

        const meta = response.data?.chart?.result?.[0]?.meta;
        if (!meta) {
          continue;
        }

        const lastPrice = meta.regularMarketPrice || meta.previousClose;
        const prevClose = meta.chartPreviousClose || meta.previousClose;
        const change = lastPrice - prevClose;
        const changePercent = prevClose ? (change / prevClose) * 100 : 0;

        results[nameMap[symbol]] = {
          value: lastPrice?.toFixed(2) || '0.00',
          change: change?.toFixed(2) || '0.00',
          changePercent: changePercent?.toFixed(2) || '0.00',
          positive: change >= 0,
        };
      } catch (error) {
        console.log(`[Yahoo] Failed to fetch ${symbol}:`, error.message);
      }
    }

    return Object.keys(results).length > 0 ? results : state.markets;
  } catch (error) {
    console.log('[Yahoo] Error:', error.message);
    return state.markets;
  }
}

/** נקודת ייצוג מגיאומטריית EONET (Point / LineString / Polygon / MultiPolygon) */
function eonetGeometryToLngLat(geometry) {
  if (!geometry || !geometry.type) return null;
  const c = geometry.coordinates;
  if (geometry.type === 'Point' && Array.isArray(c) && c.length >= 2) {
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  }
  if (geometry.type === 'LineString' && Array.isArray(c) && c[0] && c[0].length >= 2) {
    const lng = Number(c[0][0]);
    const lat = Number(c[0][1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  }
  if (geometry.type === 'Polygon' && Array.isArray(c) && Array.isArray(c[0]) && c[0][0] && c[0][0].length >= 2) {
    const lng = Number(c[0][0][0]);
    const lat = Number(c[0][0][1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  }
  if (
    geometry.type === 'MultiPolygon' &&
    Array.isArray(c) &&
    c[0] &&
    c[0][0] &&
    c[0][0][0] &&
    c[0][0][0].length >= 2
  ) {
    const lng = Number(c[0][0][0][0]);
    const lat = Number(c[0][0][0][1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  }
  return null;
}

/** מרחק גאודזי בק״מ (לסינון שריפות לפי רדיוס מישראל) */
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function envNumOr(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const FIRE_CENTER_LAT = envNumOr('FIRE_CENTER_LAT', 31.46);
const FIRE_CENTER_LNG = envNumOr('FIRE_CENTER_LNG', 34.85);
const FIRE_RADIUS_KM = envNumOr('FIRE_RADIUS_KM', 700);
const FIRE_MAP_MAX_POINTS = Math.max(15, Math.min(200, envNumOr('FIRE_MAP_MAX_POINTS', 80)));

async function fetchNASAFIRMS() {
  try {
    /**
     * EONET wildfires — איסוף מועמדים, סינון מדויק לרדיוס FIRE_RADIUS_KM ממרכז (ברירת מחדל ~ישראל).
     * bbox v3: min_lon, max_lat, max_lon, min_lat — מרחב מורחב סביב המרכז כדי למשוך מועמדים; החיתוך הסופי ב־haversine.
     */
    const rKm = FIRE_RADIUS_KM;
    const dLat = (rKm * 1.15) / 111.32;
    const cosLat = Math.max(0.35, Math.cos((FIRE_CENTER_LAT * Math.PI) / 180));
    const dLng = (rKm * 1.15) / (111.32 * cosLat);
    const minLon = FIRE_CENTER_LNG - dLng;
    const maxLat = FIRE_CENTER_LAT + dLat;
    const maxLon = FIRE_CENTER_LNG + dLng;
    const minLat = FIRE_CENTER_LAT - dLat;
    const bboxStr = `${minLon},${maxLat},${maxLon},${minLat}`;

    const queryVariants = [
      `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&category=wildfires&days=45&limit=400&bbox=${bboxStr}`,
      `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&days=90&limit=400&bbox=${bboxStr}`,
      `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&category=wildfires&days=30&limit=500&bbox=${bboxStr}`,
      `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&days=120&limit=1000&bbox=${bboxStr}`,
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=all&category=wildfires&days=21&limit=500',
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&days=120&limit=1000',
    ];

    const eonetEventToFireCandidate = (event) => {
      const latestGeometry = Array.isArray(event.geometry)
        ? event.geometry[event.geometry.length - 1]
        : null;
      const ll = eonetGeometryToLngLat(latestGeometry);
      if (!ll) return null;
      return {
        id: event.id != null ? String(event.id) : `${ll.lat.toFixed(4)},${ll.lng.toFixed(4)}`,
        lat: ll.lat,
        lng: ll.lng,
        brightness: Number(event.geometry?.length || 1) * 100,
        confidence: event.closed ? 'medium' : 'high',
        title: event.title,
      };
    };

    const byId = new Map();

    for (const url of queryVariants) {
      try {
        const response = await axios.get(url, { timeout: 20000 });
        const events = response.data?.events || [];
        for (const event of events) {
          const cand = eonetEventToFireCandidate(event);
          if (!cand) continue;
          const km = haversineDistanceKm(FIRE_CENTER_LAT, FIRE_CENTER_LNG, cand.lat, cand.lng);
          if (km > FIRE_RADIUS_KM) continue;
          const prev = byId.get(cand.id);
          if (!prev || km < prev._km) {
            byId.set(cand.id, { ...cand, _km: km });
          }
        }
      } catch (innerError) {
        console.log('[NASA FIRMS] Variant failed:', innerError.response?.status || innerError.message);
      }
    }

    const near = [...byId.values()]
      .sort((a, b) => a._km - b._km)
      .slice(0, FIRE_MAP_MAX_POINTS)
      .map(({ lat, lng, brightness, confidence, title }) => ({
        lat,
        lng,
        brightness,
        confidence,
        title,
      }));
    if (near.length > 0) return near;

    // Fallback קשיח: אם האזור נקי/לא זמין, נחזיר את האירועים הקרובים ביותר מהעולם כדי שהווידג'ט לא יישאר ריק.
    try {
      const globalResponse = await axios.get(
        'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&days=120&limit=1000',
        { timeout: 22000 }
      );
      const events = Array.isArray(globalResponse.data?.events) ? globalResponse.data.events : [];
      const global = [];
      for (const event of events) {
        const cand = eonetEventToFireCandidate(event);
        if (!cand) continue;
        const km = haversineDistanceKm(FIRE_CENTER_LAT, FIRE_CENTER_LNG, cand.lat, cand.lng);
        global.push({
          ...cand,
          _km: km,
        });
      }
      return global
        .sort((a, b) => a._km - b._km)
        .slice(0, FIRE_MAP_MAX_POINTS)
        .map(({ lat, lng, brightness, confidence, title }) => ({
          lat,
          lng,
          brightness,
          confidence,
          title,
        }));
    } catch (globalErr) {
      console.log('[NASA FIRMS] Global fallback failed:', globalErr.response?.status || globalErr.message);
    }

    return state.fires;
  } catch (error) {
    console.log('[NASA FIRMS] Error:', error.message);
    return state.fires;
  }
}

/**
 * שורה מ־MyShipTracking vesselsonmaptempTTT: לעיתים TSV (טאבים), לעיתים מופרד ברווחים עם שם מרובה מילים.
 * פענוח שגוי (רק split לפי טאב) החזיר 0 ספינות משרתי ענן למרות תשובה תקינה.
 */
function parseMyShipTrackingLine(line) {
  if (!line || !/^\d+\s+\d+\s+\d{6,10}\s+/i.test(line)) return null;
  if (line.indexOf('\t') >= 0) {
    const cols = line
      .split(/\t+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length >= 8) {
      const lat = Number(cols[4]);
      const lng = Number(cols[5]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        lat,
        lng,
        name: String(cols[3] || 'Vessel').trim() || 'Vessel',
        type: 'AIS (public)',
        speed: Number(cols[6] || 0),
        course: Number(cols[7] || 0),
        mmsi: String(cols[2] || '').trim(),
      };
    }
  }
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 10) return null;
  const lat = Number(parts[parts.length - 6]);
  const lng = Number(parts[parts.length - 5]);
  const speed = Number(parts[parts.length - 4]);
  const course = Number(parts[parts.length - 3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const mmsi = String(parts[2] || '').trim();
  const name = parts.slice(3, parts.length - 6).join(' ').trim() || 'Vessel';
  return {
    lat,
    lng,
    name,
    type: 'AIS (public)',
    speed: Number.isFinite(speed) ? speed : 0,
    course: Number.isFinite(course) ? course : 0,
    mmsi,
  };
}

function parseMyShipTrackingTextToShips(txt) {
  const ships = [];
  const lines = String(txt || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const row = parseMyShipTrackingLine(line);
    if (row) ships.push(row);
  }
  return ships.slice(0, 200);
}

function buildMyShipBuiltinPublicUrl(bbox) {
  const minLat = bbox ? bbox.minLat : envNumOr('SHIP_PUBLIC_MIN_LAT', 29);
  const maxLat = bbox ? bbox.maxLat : envNumOr('SHIP_PUBLIC_MAX_LAT', 34.5);
  const minLng = bbox ? bbox.minLng : envNumOr('SHIP_PUBLIC_MIN_LNG', 32);
  const maxLng = bbox ? bbox.maxLng : envNumOr('SHIP_PUBLIC_MAX_LNG', 36.5);
  const zoom = bbox ? bbox.zoom : Math.max(5, Math.min(12, envNumOr('SHIP_PUBLIC_ZOOM', 7)));
  return `https://www.myshiptracking.com/requests/vesselsonmaptempTTT.php?type=json&minlat=${encodeURIComponent(
    minLat
  )}&maxlat=${encodeURIComponent(maxLat)}&minlon=${encodeURIComponent(minLng)}&maxlon=${encodeURIComponent(
    maxLng
  )}&zoom=${encodeURIComponent(zoom)}`;
}

/** בקשה ל־MyShipTracking — fullUrl מלא (מותאם אישית או buildMyShipBuiltinPublicUrl) */
async function fetchMyShipPublicShipsFromUrl(fullUrl) {
  const publicUrl = String(fullUrl || '').trim();
  if (!publicUrl) return [];
  const publicResp = await axios.get(publicUrl, {
    timeout: Number(process.env.SHIP_PUBLIC_TIMEOUT_MS || 16000),
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Referer: 'https://www.myshiptracking.com/',
      Origin: 'https://www.myshiptracking.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    responseType: 'text',
    maxRedirects: 5,
  });
  const raw = String(publicResp.data || '');
  const ships = parseMyShipTrackingTextToShips(raw);
  if (ships.length === 0 && raw.length > 0 && /[<>]|html/i.test(raw.slice(0, 80))) {
    console.warn('[AIS public] Response looks like HTML (blocked or error page), length=', raw.length);
  }
  return ships;
}

/** כל נסיונות הגיבוי הציבורי: SHIP_PUBLIC_URL, ברירת מחדל (בלי כפילות), תיבה רחבה, SHIP_FALLBACK_URLS */
async function fetchPublicShipsFallbackChain() {
  const attempts = [];
  const custom = String(process.env.SHIP_PUBLIC_URL || '').trim();
  const defaultBuiltin = buildMyShipBuiltinPublicUrl(null);
  const wideBuiltin = buildMyShipBuiltinPublicUrl({
    minLat: 28,
    maxLat: 36,
    minLng: 29,
    maxLng: 38,
    zoom: 6,
  });
  if (custom) attempts.push(() => fetchMyShipPublicShipsFromUrl(custom));
  if (!custom || custom !== defaultBuiltin) attempts.push(() => fetchMyShipPublicShipsFromUrl(defaultBuiltin));
  if (wideBuiltin !== defaultBuiltin && wideBuiltin !== custom) {
    attempts.push(() => fetchMyShipPublicShipsFromUrl(wideBuiltin));
  }
  const extras = String(process.env.SHIP_FALLBACK_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of extras) {
    if (u && u !== custom && u !== defaultBuiltin && u !== wideBuiltin) {
      attempts.push(() => fetchMyShipPublicShipsFromUrl(u));
    }
  }
  for (let i = 0; i < attempts.length; i++) {
    try {
      const ships = await attempts[i]();
      if (ships.length > 0) return ships;
    } catch (e) {
      console.warn('[AIS public] attempt', i + 1, ':', e.response?.status || e.message);
    }
  }
  return [];
}

function mapGenericAisShips(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((ship, index) => ({
      lat: Number(ship.lat ?? ship.latitude),
      lng: Number(ship.lng ?? ship.longitude),
      name: ship.name || ship.vessel_name || ship.SHIPNAME || ship.vesselName || `Vessel ${index + 1}`,
      type: ship.type || ship.category || ship.vesselType || 'Unknown',
      speed: Number(ship.speed ?? ship.sog ?? ship.SOG ?? 0),
      course: Number(ship.course ?? ship.cog ?? ship.COG ?? 0),
      mmsi: String(ship.mmsi ?? ship.MMSI ?? ''),
    }))
    .filter((ship) => Number.isFinite(ship.lat) && Number.isFinite(ship.lng))
    .slice(0, 200);
}

async function fetchShipTracking() {
  try {
    if (process.env.VESSELAPI_KEY) {
      try {
        const vesselApiResponse = await axios.get(
          'https://api.vesselapi.com/v1/vessels/positions?filters.latMin=10&filters.latMax=45&filters.lngMin=20&filters.lngMax=70&pagination.limit=50',
          {
            timeout: 10000,
            headers: {
              Authorization: `Bearer ${process.env.VESSELAPI_KEY}`,
              'User-Agent': 'Mozilla/5.0',
            },
          }
        );
        const vesselApiShips = Array.isArray(vesselApiResponse.data?.vesselPositions)
          ? vesselApiResponse.data.vesselPositions
          : [];
        if (vesselApiShips.length > 0) {
          return mapGenericAisShips(vesselApiShips);
        }
      } catch (eV) {
        console.warn('[AIS] VesselAPI failed, trying next provider:', eV.response?.status || eV.message);
      }
    }

    if (process.env.MARINETRAFFIC_API_KEY) {
      try {
        const mtMinLat = envNumOr('MARINE_MIN_LAT', 10);
        const mtMaxLat = envNumOr('MARINE_MAX_LAT', 45);
        const mtMinLng = envNumOr('MARINE_MIN_LNG', 20);
        const mtMaxLng = envNumOr('MARINE_MAX_LNG', 70);
        const mtTimespan = Math.max(5, envNumOr('MARINE_TIMESPAN_MIN', 20));
        const mtProtocol = process.env.MARINE_PROTOCOL || 'jsono';
        const mtUrl =
          process.env.MARINETRAFFIC_URL ||
          `https://services.marinetraffic.com/api/exportvessel/v:8/${encodeURIComponent(
            process.env.MARINETRAFFIC_API_KEY
          )}/timespan:${mtTimespan}/protocol:${encodeURIComponent(mtProtocol)}/minlat:${mtMinLat}/maxlat:${mtMaxLat}/minlon:${mtMinLng}/maxlon:${mtMaxLng}`;

        const mtResponse = await axios.get(mtUrl, {
          timeout: Number(process.env.MARINE_TIMEOUT_MS || 10000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const mtShips = Array.isArray(mtResponse.data)
          ? mtResponse.data
          : Array.isArray(mtResponse.data?.data)
          ? mtResponse.data.data
          : [];
        if (mtShips.length > 0) {
          return mtShips
            .map((ship, index) => ({
              lat: Number(
                ship.LAT ?? ship.LATITUDE ?? ship.lat ?? ship.latitude ?? ship.y
              ),
              lng: Number(
                ship.LON ?? ship.LONGITUDE ?? ship.lon ?? ship.lng ?? ship.longitude ?? ship.x
              ),
              name:
                ship.SHIPNAME ||
                ship.SHIP_NAME ||
                ship.NAME ||
                ship.name ||
                `Vessel ${index + 1}`,
              type: ship.SHIPTYPE || ship.TYPE_NAME || ship.type || 'Unknown',
              speed: Number(ship.SPEED ?? ship.SOG ?? ship.speed ?? ship.sog ?? 0),
              course: Number(ship.COURSE ?? ship.COG ?? ship.course ?? ship.cog ?? 0),
              mmsi: ship.MMSI || ship.mmsi || '',
            }))
            .filter((ship) => Number.isFinite(ship.lat) && Number.isFinite(ship.lng))
            .slice(0, 200);
        }
      } catch (eM) {
        console.warn('[AIS] MarineTraffic failed, trying next:', eM.response?.status || eM.message);
      }
    }

    const apiUrl = String(process.env.AIS_API_URL || '').trim();
    if (apiUrl) {
      try {
        const response = await axios.get(apiUrl, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const ships = Array.isArray(response.data)
          ? response.data
          : Array.isArray(response.data?.ships)
          ? response.data.ships
          : [];
        const mapped = mapGenericAisShips(ships);
        if (mapped.length > 0) return mapped;
        console.warn('[AIS] AIS_API_URL returned no vessels, falling back to public AIS');
      } catch (eA) {
        console.warn('[AIS] AIS_API_URL failed, falling back to public:', eA.response?.status || eA.message);
      }
    }

    const publicShips = await fetchPublicShipsFallbackChain();
    if (publicShips.length > 0) {
      console.log(`[AIS] Public fallback: ${publicShips.length} vessel(s)`);
      return publicShips;
    }

    if (!Array.isArray(state.ships) || state.ships.length === 0) {
      console.log(
        '[AIS] All providers empty or failed. Optional: VESSELAPI_KEY, MARINETRAFFIC_API_KEY, AIS_API_URL, SHIP_PUBLIC_URL, SHIP_FALLBACK_URLS'
      );
    }
    return state.ships;
  } catch (error) {
    console.warn('[AIS] Unexpected error:', error.message);
    try {
      const last = await fetchPublicShipsFallbackChain();
      if (last.length > 0) return last;
    } catch (_) {}
    return state.ships;
  }
}

function emitSnapshot(socket) {
  try {
    socket.emit('server_status', {
      connected: true,
      timestamp: new Date().toISOString(),
      oref: getUnifiedOrefStatus(),
    });

    socket.emit('flights_update', state.flights);
    socket.emit('seismic_update', state.seismic);
    socket.emit('markets_update', state.markets);
    socket.emit('fires_update', state.fires);
    socket.emit('ships_update', state.ships);
    socket.emit('osint_impacts_update', state.osintImpacts || []);

    const news = getNews(20);
    if (news.length > 0) {
      socket.emit('news_update', { articles: news, count: news.length });
    }

    if (state.activeMissiles.length > 0) {
      state.activeMissiles.forEach((missileEvent) => {
        socket.emit('real_time_missile', missileEvent);
      });
    }

    socket.emit('summary_update', state.aiSummary || refreshAiSummary({ emit: false }));
    socket.emit('feed_bootstrap', state.clientEventFeed || []);
  } catch (err) {
    console.warn('[Socket] emitSnapshot:', err.message);
    try {
      socket.emit('server_status', {
        connected: true,
        timestamp: new Date().toISOString(),
        oref: getUnifiedOrefStatus(),
      });
    } catch (_) {
      /* ignore */
    }
  }
}

async function updateMarkets() {
  state.markets = await fetchYahooData();
  io.emit('markets_update', state.markets);
  refreshAiSummary();
}

async function updateFlights() {
  state.flights = await fetchOpenSkyData();
  io.emit('flights_update', state.flights);
  refreshAiSummary();
}

async function updateSeismic() {
  state.seismic = await fetchUSGSData();
  io.emit('seismic_update', state.seismic);
  refreshAiSummary();
}

async function updateFires() {
  state.fires = await fetchNASAFIRMS();
  io.emit('fires_update', state.fires);
  refreshAiSummary();
}

async function updateShips() {
  state.ships = await fetchShipTracking();
  io.emit('ships_update', state.ships);
  refreshAiSummary();
}

async function updateOsintImpacts() {
  const now = Date.now();
  const ttlMs = Math.max(60_000, Number(process.env.OSINT_IMPACT_TTL_MS) || 12 * 60 * 60 * 1000);
  const minOutlets = Math.max(3, Number(process.env.OSINT_IMPACT_MIN_SOURCES) || 3);
  const minNonSeismicOutlets = Math.max(
    2,
    Number(process.env.OSINT_IMPACT_MIN_NON_SEISMIC) || 2
  );
  const maxAgeRaw = Number(process.env.OSINT_IMPACT_MAX_AGE_MS);
  const maxArtRaw = Number(process.env.OSINT_IMPACT_MAX_ARTICLES);
  const maxPtRaw = Number(process.env.OSINT_IMPACT_MAX_POINTS);
  try {
    let telegramMessages = [];
    try {
      telegramMessages = await fetchTelegramPublicMessagesForOsint();
    } catch (tgErr) {
      console.warn('[OSINT impacts] telegram:', tgErr && tgErr.message ? tgErr.message : tgErr);
    }
    if (!state.osintImpactRegistry || typeof state.osintImpactRegistry !== 'object') {
      state.osintImpactRegistry = {};
    }
    state.osintImpactRegistry = reconcileOsintImpactRegistry(state.osintImpactRegistry, {
      newsStore,
      telegramMessages,
      seismicEvents: state.seismic,
      getReliableCityCoordinates,
      isPlausibleMapTarget: isPlausibleSupportedAlertTarget,
      now,
      ttlMs,
      minDistinctOutlets: minOutlets,
      maxAgeMs: Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : undefined,
      maxArticlesScan: Number.isFinite(maxArtRaw) && maxArtRaw > 0 ? maxArtRaw : undefined,
      seismicMaxAgeMs:
        Number.isFinite(Number(process.env.OSINT_IMPACT_SEISMIC_MAX_AGE_MS)) &&
        Number(process.env.OSINT_IMPACT_SEISMIC_MAX_AGE_MS) > 0
          ? Number(process.env.OSINT_IMPACT_SEISMIC_MAX_AGE_MS)
          : undefined,
      seismicMinMagnitude:
        Number.isFinite(Number(process.env.OSINT_IMPACT_SEISMIC_MIN_MAG)) &&
        Number(process.env.OSINT_IMPACT_SEISMIC_MIN_MAG) > 0
          ? Number(process.env.OSINT_IMPACT_SEISMIC_MIN_MAG)
          : undefined,
    });
    state.osintImpacts = registryToClientList(state.osintImpactRegistry, {
      now,
      ttlMs,
      minDistinctOutlets: minOutlets,
      minNonSeismicOutlets,
      maxPoints: Number.isFinite(maxPtRaw) && maxPtRaw > 0 ? maxPtRaw : 50,
    });
    scheduleSaveOsintImpactRegistry();
  } catch (e) {
    console.warn('[OSINT impacts]', e && e.message ? e.message : e);
    try {
      state.osintImpacts = registryToClientList(state.osintImpactRegistry || {}, {
        now,
        ttlMs,
        minDistinctOutlets: minOutlets,
        minNonSeismicOutlets,
        maxPoints: 50,
      });
    } catch (_) {
      if (!Array.isArray(state.osintImpacts)) state.osintImpacts = [];
    }
  }
  io.emit('osint_impacts_update', state.osintImpacts || []);
}

function runPoller(name, fn) {
  Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`[Poller] ${name}:`, msg);
    });
}

function upgradeTelegramMissileWithOref(existingId, alert, salvoMeta) {
  const existing = activeMissilesById.get(existingId);
  if (!existing || !alert?.cityName) return null;
  const targetPosition = Array.isArray(alert.targetPosition) ? alert.targetPosition : getTargetPosition(alert);
  if (
    !targetPosition ||
    !isPlausibleIsraelAlertTarget(targetPosition[0], targetPosition[1])
  ) {
    return null;
  }
  const textBlob = [alert.title, alert.orefTextBlob, alert.desc].filter(Boolean).join(' ');
  const multiAxis =
    inferOrefThreatAxis({
      ...alert,
      telegramAiExtraction: false,
    }) ||
    existing.sourceRegion ||
    matchExplicitThreatAxisInBlob(textBlob) ||
    resolveSourceRegionFromAlert({ ...alert, telegramAiExtraction: false }, existing.sourcePosition, targetPosition);

  const enrichedAlert = {
    ...alert,
    telegramAiExtraction: false,
    _multiSourceConfirmed: true,
    _multiSourceAxis: multiAxis || existing.sourceRegion || 'lebanon',
  };
  const rawSource = resolveSourcePosition(enrichedAlert, targetPosition);
  const missileEvent = {
    ...buildMissileLifecycle(enrichedAlert, rawSource, targetPosition),
    id: existing.id,
    telegramEarly: false,
    telegramMessageHash: existing.telegramMessageHash,
    waveId: salvoMeta?.waveId || existing.waveId,
    salvoCountEstimate: salvoMeta?.salvoCountEstimate ?? existing.salvoCountEstimate,
    salvoIndex: salvoMeta?.salvoIndex ?? existing.salvoIndex,
    interceptionStatusReported: existing.interceptionStatusReported,
  };
  missileEvent.fusionTier = 'confirmed_multi_source';
  missileEvent.fusionSources = Array.from(new Set([...(missileEvent.fusionSources || []), 'Oref + Telegram AI']));
  missileEvent.sourceConfidence = 'official';
  missileEvent.sourceConfidenceScore = Math.min(0.99, (Number(missileEvent.sourceConfidenceScore) || 0.9) + 0.03);
  missileEvent.trajectoryConfidence = Math.min(0.99, (Number(missileEvent.trajectoryConfidence) || 0.9) + 0.03);
  syncMissileSourceFromGeometry(missileEvent);
  clearMissileTimers(existing.id);
  storeActiveMissile(missileEvent);
  scheduleMissileLifecycle(missileEvent);
  scheduleOrefClientSocketEmit(() => {
    io.emit('real_time_missile', missileEvent);
  });
  return missileEvent;
}

async function pollTelegramMissileLayer() {
  // כברירת מחדל כבוי: לא מכניסים שיגורים מושערים/סינתטיים לאתר.
  if (process.env.TELEGRAM_MISSILE_AI !== '1') return;
  if (!OPENAI_API_KEY || !OPENAI_API_KEY.trim()) return;
  const now = Date.now();
  const minGap = Math.max(8000, Number(process.env.TELEGRAM_MISSILE_POLL_MS) || 10_000);
  if (now - telegramMissileLastRunAt < minGap) return;
  if (telegramMissilePollInFlight) return;
  telegramMissilePollInFlight = true;
  telegramMissileLastRunAt = now;
  try {
    const tgTtlMs = Math.max(300_000, Number(process.env.TELEGRAM_EARLY_MISSILE_TTL_MS) || 25 * 60_000);
    activeMissilesById.forEach((m, mid) => {
      if (!m?.telegramEarly) return;
      if (Date.now() - (m.timestamp || m.receivedAtMs || 0) <= tgTtlMs) return;
      try {
        io.emit('clear_city_alert', { city: m.cityName, cityName: m.cityName, reason: 'telegram_early_ttl' });
      } catch (_) {
        /* */
      }
      removeActiveMissileById(mid);
    });

    const { chunks } = await fetchTelegramOnlyChunks();
    const tracks = await extractMissileTracksFromChunks(chunks, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    });
    for (const track of tracks) {
      const cityNorm =
        normalizeHebrewSettlementName(String(track.cityName || '').trim()) || String(track.cityName || '').trim();
      if (!cityNorm) continue;

      const orefOrNonTg = [...activeMissilesById.values()].some((m) => {
        if (m.telegramEarly) return false;
        return normalizeHebrewSettlementName(String(m.cityName || '')) === cityNorm;
      });
      if (orefOrNonTg) continue;

      const sameEarly = [...activeMissilesById.values()].find(
        (m) =>
          m.telegramEarly &&
          normalizeHebrewSettlementName(String(m.cityName || '')) === cityNorm &&
          m.telegramMessageHash === track.messageHash
      );
      if (sameEarly) continue;

      const coords = getReliableCityCoordinates(cityNorm);
      if (!coords) continue;

      const targetPosition = normalizeCoordPairToLngLat([coords.lng, coords.lat]);
      const threatType = track.missileType === 'uav' ? 'uav' : 'missile';
      const stableId = `tg-ai-${String(track.messageHash).slice(0, 22)}`;

      const syntheticAlert = {
        id: stableId,
        cityName: cityNorm,
        title: `דיווח Telegram AI (מוקדם): ${String(track.rawExcerpt || '').slice(0, 96)}`,
        threatType,
        orefTextBlob: String(track.rawExcerpt || ''),
        orefTimeMs: Date.now(),
        receivedAtMs: Date.now(),
        usedSettlementFallback: false,
        telegramAiAxis: track.sourceRegion,
        telegramAiConfidence: track.confidence,
        telegramAiExtraction: true,
        orefCategory: 14,
      };

      const sourcePosition = resolveSourcePosition(syntheticAlert, targetPosition);
      const sourceRegion =
        resolveSourceRegionFromAlert(syntheticAlert, sourcePosition, targetPosition) || track.sourceRegion;

      let missileEvent = {
        ...buildMissileLifecycle(syntheticAlert, sourcePosition, targetPosition),
        id: stableId,
        sourceRegion,
        sourceLocation: getSourceRegionLabel(sourceRegion),
        telegramEarly: true,
        telegramMessageHash: track.messageHash,
        interceptionStatusReported: track.interceptionStatus,
        waveId: `tg-ai-${sourceRegion}`,
        salvoCountEstimate: Math.max(1, track.count || 1),
        salvoIndex: 1,
      };

      if (track.interceptionStatus === 'intercepted') {
        missileEvent.outcome = 'intercepted';
      } else if (track.interceptionStatus === 'impact') {
        missileEvent.outcome = 'impact';
      }

      missileEvent.fusionTier = 'telegram_ai';
      missileEvent.sourceConfidence = 'telegram_ai';
      syncMissileSourceFromGeometry(missileEvent);
      storeActiveMissile(missileEvent);
      scheduleMissileLifecycle(missileEvent);

      const payload = {
        id: missileEvent.id,
        cityName: missileEvent.cityName,
        coordinates: missileEvent.targetPosition,
        title: syntheticAlert.title,
        threatType: missileEvent.threatType,
        alertPhase: 'pre_alert',
        sourceRegion: missileEvent.sourceRegion,
        sourceLocation: missileEvent.sourceLocation,
        timestamp: new Date().toISOString(),
        orefTimeMs: missileEvent.orefTimeMs,
        receivedAtMs: missileEvent.receivedAtMs,
        telegramEarly: true,
      };
      appendFeedFromNewAlertPayload(payload);
      scheduleOrefClientSocketEmit(() => {
        io.emit('new_alert', payload);
      });
      scheduleOrefClientSocketEmit(() => {
        io.emit('real_time_missile', missileEvent);
      });
    }
  } finally {
    telegramMissilePollInFlight = false;
  }
}

/** כמה מקורות מערכת (לא ה-LLM) תואמים לציר — לפני קיבוע מוצא על המפה */
function countLaunchAxisCorroboration(axis, missile) {
  const ax = String(axis);
  let n = 0;
  try {
    const os = getOsintAxisHintSync();
    if (os && String(os.axis) === ax) n += 1;
  } catch (_) {
    /* */
  }
  try {
    if (state.gdeltCorroboration && String(state.gdeltCorroboration.axis) === ax) n += 1;
  } catch (_) {
    /* */
  }
  try {
    const stub = {
      orefTextBlob: missile?.alertContext?.orefTextBlob,
      title: missile?.alertContext?.title,
    };
    const ex = inferExplicitOrefThreatAxis(stub);
    if (ex && String(ex.axis) === ax) n += 1;
  } catch (_) {
    /* */
  }
  return n;
}

/** מנוע AI: קורפוס מכל מקורות האתר → הערכת מוצא שיגור לכל טיל פעיל; מעדכן מסלול ו־Socket בזמן אמת */
function tickLaunchAxisAi() {
  if (process.env.LAUNCH_AXIS_AI_ENABLED !== '1') return;
  if (!(process.env.OPENAI_API_KEY || '').trim()) return;
  if (launchAxisAiCycleInFlight) return;

  const pollMs = Math.max(8000, Number(process.env.LAUNCH_AXIS_AI_POLL_MS) || 14_000);
  const minGap = Math.max(6000, pollMs - 2000);

  const missiles = [...activeMissilesById.values()].filter((m) => {
    if (!m || m.threatType === 'uav') return false;
    if (!hasRenderableMissileTarget(m)) return false;
    const ph = String(m.alertPhase || '');
    if (ph === 'impact' || ph === 'intercepted') return false;
    const last = launchAxisAiLastCycleAt.get(m.id) || 0;
    if (Date.now() - last < minGap) return false;
    return true;
  });
  if (!missiles.length) return;

  launchAxisAiCycleInFlight = true;
  (async () => {
    try {
      const corpus = await launchAxisAiEngine.buildLaunchInvestigationCorpus({
        getNewsStoreWarRelatedBlob,
        getNewsThreatAxisHint: () => {
          try {
            if (process.env.OREF_NEWS_AXIS_HINT !== '1') return '';
            refreshNewsThreatAxisBlob({ force: false });
            return typeof newsThreatAxisBlob === 'string' ? newsThreatAxisBlob : '';
          } catch (_) {
            return '';
          }
        },
        getGdeltSample: () =>
          (state.gdeltEvents || [])
            .slice(0, 20)
            .map((e) => [e && e.title, e && e.domain].filter(Boolean).join(' @ '))
            .filter(Boolean)
            .join(' | '),
        getPredictionSnippet: () => {
          const mk = state.predictionMarketsSnapshot && state.predictionMarketsSnapshot.markets;
          if (!Array.isArray(mk) || !mk.length) return '';
          return mk
            .slice(0, 6)
            .map((x) => String((x && x.question) || '').slice(0, 160))
            .join(' | ');
        },
      });

      const results = await launchAxisAiEngine.inferLaunchAxesForMissiles(missiles, corpus);
      const minApply = Math.max(0.5, Number(process.env.LAUNCH_AXIS_AI_APPLY_MIN_CONFIDENCE) || 0.71);
      const minEv =
        Number(process.env.LAUNCH_AXIS_AI_MIN_EVIDENCE_LINES) >= 0
          ? Number(process.env.LAUNCH_AXIS_AI_MIN_EVIDENCE_LINES)
          : 1;
      const singleEvOk =
        Number(process.env.LAUNCH_AXIS_AI_SINGLE_EVIDENCE_OK_CONFIDENCE) >= 0.5
          ? Number(process.env.LAUNCH_AXIS_AI_SINGLE_EVIDENCE_OK_CONFIDENCE)
          : 0.86;
      const axisChangeMin = Math.max(0.55, Number(process.env.LAUNCH_AXIS_AI_AXIS_CHANGE_MIN) || 0.77);
      const commitTicks = Math.max(1, Math.min(6, Number(process.env.LAUNCH_AXIS_AI_COMMIT_TICKS) || 2));
      const instantCommit = Math.max(0.75, Number(process.env.LAUNCH_AXIS_AI_INSTANT_COMMIT_CONFIDENCE) || 0.91);
      const corMinRaw = Number(process.env.LAUNCH_AXIS_AI_CORROBORATION_SOURCES);
      const corMin = Number.isFinite(corMinRaw) && corMinRaw >= 0 ? Math.min(3, corMinRaw) : 1;
      const skipCorrobIfConf = Math.max(0.7, Number(process.env.LAUNCH_AXIS_AI_SKIP_CORROB_IF_CONFIDENCE) || 0.86);
      const streakAlone = Math.max(
        commitTicks + 1,
        Math.min(8, Number(process.env.LAUNCH_AXIS_AI_STREAK_ALONE_COMMITS) || 3)
      );
      const unlockTicks = Math.max(
        commitTicks + 1,
        Math.min(10, Number(process.env.LAUNCH_AXIS_AI_UNLOCK_TICKS) || 3)
      );
      const unlockConf = Math.max(0.8, Number(process.env.LAUNCH_AXIS_AI_UNLOCK_MIN_CONFIDENCE) || 0.88);

      for (const m of missiles) {
        launchAxisAiLastCycleAt.set(m.id, Date.now());
        const row = results.get(m.id);
        if (!row || row.launchAxis === 'unknown' || row.confidence < minApply) continue;
        const ev = Array.isArray(row.evidence) ? row.evidence : [];
        if (ev.length < minEv && row.confidence < singleEvOk) continue;

        const axis = row.launchAxis;
        if (String(m.launchAiStreakAxis) !== String(axis)) {
          m.launchAiStreakAxis = axis;
          m.launchAiStreakCount = 1;
        } else {
          m.launchAiStreakCount = (Number(m.launchAiStreakCount) || 0) + 1;
        }

        const corroboration = countLaunchAxisCorroboration(axis, m);
        const corrobOk =
          corroboration >= corMin ||
          row.confidence >= skipCorrobIfConf ||
          m.launchAiStreakCount >= streakAlone;

        const locked = m.launchOriginAxisLocked === true;
        const changingLockedAxis = locked && String(m.launchAiAxis) !== String(axis);

        if (
          locked &&
          !changingLockedAxis &&
          String(m.launchAiAxis) === String(axis) &&
          String(m.sourceRegion) === String(axis)
        ) {
          m.launchAiConfidence = Math.max(Number(m.launchAiConfidence) || 0, row.confidence);
          m.launchAiEvidence = ev;
          m.launchAiUpdatedAt = Date.now();
          continue;
        }

        let mayCommit = false;
        if (changingLockedAxis) {
          mayCommit =
            m.launchAiStreakCount >= unlockTicks && row.confidence >= unlockConf && corrobOk;
        } else if (!locked) {
          mayCommit =
            (m.launchAiStreakCount >= commitTicks || row.confidence >= instantCommit) && corrobOk;
        } else {
          mayCommit = String(m.launchAiAxis) === String(axis) && corrobOk;
        }

        if (!mayCommit) continue;

        const same = String(axis) === String(m.sourceRegion);
        if (changingLockedAxis) {
          if (row.confidence < unlockConf) continue;
        } else if (!same && row.confidence < axisChangeMin) continue;

        m.launchAiAxis = axis;
        m.launchAiConfidence = same
          ? Math.max(Number(m.launchAiConfidence) || 0, row.confidence)
          : row.confidence;
        m.launchAiEvidence = ev;
        m.launchAiUpdatedAt = Date.now();

        const alertStub = {
          cityName: m.cityName,
          title: m.alertContext && m.alertContext.title,
          threatType: m.threatType || 'missile',
          orefTextBlob: m.alertContext && m.alertContext.orefTextBlob,
          usedSettlementFallback: m.alertContext && m.alertContext.usedSettlementFallback,
          orefTimeMs: m.orefTimeMs,
          receivedAtMs: m.receivedAtMs,
          orefAlertGroupId: m.orefAlertGroupId,
        };
        const tp = m.targetPosition || m.target;
        if (!tp) continue;
        const geomPref = launchAiGeometryPreferred(launchGeometryAlert(alertStub, m));
        if (geomPref) {
          m.launchOriginAxisLocked = true;
          syncActiveMissileGeometryFromOrefAlert(alertStub, null, tp);
        } else {
          m.launchOriginAxisLocked = false;
        }
      }
    } catch (e) {
      console.warn('[LaunchAxisAI cycle]', e && e.message ? e.message : e);
    } finally {
      launchAxisAiCycleInFlight = false;
    }
  })();
}

function startExternalPolling() {
  runPoller('markets', updateMarkets);
  runPoller('flights', updateFlights);
  runPoller('seismic', updateSeismic);
  runPoller('fires', updateFires);
  runPoller('ships', updateShips);
  runPoller('osint_impacts', updateOsintImpacts);
  runPoller('oref', pollOrefMissileLayer);
  runPoller('gdelt', updateGdelt);
  runPoller('predictions', updatePredictionMarkets);
  runPoller('telegram_missiles', pollTelegramMissileLayer);
  runPoller('launch_axis_ai', tickLaunchAxisAi);
  refreshAiSummary();

  setInterval(() => runPoller('markets', updateMarkets), 60_000);
  setInterval(() => runPoller('flights', updateFlights), 30_000);
  setInterval(() => runPoller('seismic', updateSeismic), 60_000);
  setInterval(() => runPoller('fires', updateFires), 5 * 60 * 1000);
  setInterval(() => runPoller('ships', updateShips), 2 * 60 * 1000);
  setInterval(
    () => runPoller('osint_impacts', updateOsintImpacts),
    Math.max(60_000, Number(process.env.OSINT_IMPACT_POLL_MS) || 120_000)
  );
  setInterval(() => runPoller('oref', pollOrefMissileLayer), OREF_POLL_INTERVAL_MS);
  setInterval(() => runPoller('gdelt', updateGdelt), Math.max(60_000, Number(process.env.GDELT_POLL_MS) || 120_000));
  setInterval(
    () => runPoller('predictions', updatePredictionMarkets),
    Math.max(120_000, Number(process.env.PREDICTION_MARKETS_POLL_MS) || 300_000)
  );
  setInterval(
    () => runPoller('telegram_missiles', pollTelegramMissileLayer),
    Math.max(10_000, Number(process.env.TELEGRAM_MISSILE_POLL_MS) || 10_000)
  );
  setInterval(
    () => runPoller('launch_axis_ai', tickLaunchAxisAi),
    Math.max(6000, Number(process.env.LAUNCH_AXIS_AI_POLL_MS) || 14_000)
  );
  setInterval(() => refreshAiSummary(), 5 * 60 * 1000);
}

const CHAT_HISTORY_MAX = 500;
const CHAT_HISTORY_SEND = 200;
const CHAT_HISTORY_FILE = path.join(ROOT_DIR, 'data', 'chat-history.json');
const chatHistory = [];
const chatMsgBurst = new Map();

function savePersistedChatHistorySync() {
  try {
    const dir = path.dirname(CHAT_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory), 'utf8');
  } catch (e) {
    console.warn('[Chat] Could not save history file:', e.message);
  }
}

function flushPersistChatHistorySync() {
  savePersistedChatHistorySync();
}

function sanitizeChatName(name) {
  const s = String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 28);
  if (s.length < 2) return '';
  if (!/^[\u0590-\u05FFa-zA-Z0-9_\-\sֲ·]+$/.test(s)) return '';
  return s;
}

function sanitizeChatText(text) {
  let s = String(text || '')
    .trim()
    .replace(/[\r\n]+/g, ' ');
  if (s.length > 480) s = s.slice(0, 480);
  return s.length ? s : '';
}

function loadPersistedChatHistory() {
  try {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    const raw = fs.readFileSync(CHAT_HISTORY_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    chatHistory.length = 0;
    for (let i = 0; i < arr.length; i++) {
      const row = arr[i];
      if (!row || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' && row.id ? row.id : '';
      const name = sanitizeChatName(row.name);
      const text = sanitizeChatText(row.text);
      const ts = Number(row.ts);
      if (!id || !name || !text || !Number.isFinite(ts)) continue;
      chatHistory.push({ id, name, text, ts });
    }
    while (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
    if (chatHistory.length) console.log(`[Chat] Loaded ${chatHistory.length} message(s) from disk`);
  } catch (e) {
    console.warn('[Chat] Could not load history file:', e.message);
  }
}

function pushChatMessage(entry) {
  chatHistory.push(entry);
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MAX);
  /* שמירה מיידית לדיסק — השהייה של 400ms גרמה לאיבוד ההודעה האחרונה בכיבוי/פריסה מהירה (Render וכו׳) */
  flushPersistChatHistorySync();
}

loadPersistedChatHistory();

function broadcastOnlineViewerCount() {
  try {
    const count = io.sockets.sockets.size;
    io.emit('online_viewers', { count, ts: Date.now() });
  } catch (e) {
    console.warn('[Socket] online_viewers:', e.message);
  }
}

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);
  emitSnapshot(socket);
  broadcastOnlineViewerCount();
  try {
    socket.emit('chat_history', chatHistory.slice(-CHAT_HISTORY_SEND));
  } catch (e) {
    console.warn('[Socket] chat_history:', e.message);
  }

  socket.on('chat_join', (payload) => {
    const name = sanitizeChatName(payload && payload.name);
    if (!name) return;
    socket.chatDisplayName = name;
  });

  socket.on('chat_leave', () => {
    delete socket.chatDisplayName;
  });

  socket.on('chat_message', (payload) => {
    const name = socket.chatDisplayName || sanitizeChatName(payload && payload.name);
    const text = sanitizeChatText(payload && payload.text);
    if (!name || !text) return;
    const now = Date.now();
    let times = chatMsgBurst.get(socket.id) || [];
    times = times.filter((t) => now - t < 12_000);
    if (times.length >= 10) return;
    times.push(now);
    chatMsgBurst.set(socket.id, times);
    const msg = {
      id: `${now}-${socket.id.slice(-6)}`,
      name,
      text,
      ts: now,
    };
    pushChatMessage(msg);
    io.emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    chatMsgBurst.delete(socket.id);
    console.log('[Socket] Client disconnected:', socket.id);
    setImmediate(() => broadcastOnlineViewerCount());
  });
});

app.get('/health', (req, res) => {
  try {
    let newsCount = 0;
    try {
      newsCount = getNews(1_000).length;
    } catch (e) {
      console.warn('[HTTP] /health news count:', e.message);
    }
    const tgTok = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const openaiOk = Boolean(String(OPENAI_API_KEY || '').trim());
    const tgMissileFlag = process.env.TELEGRAM_MISSILE_AI === '1';
    res.json({
      status: 'healthy',
      startedAt: state.startedAt,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      /** בלי ערכים סודיים — לבדיקה מול מחשב מקומי (.env) לעומת Render Dashboard */
      deployment: {
        openaiKeyPresent: openaiOk,
        telegramBotTokenPresent: Boolean(tgTok),
        telegramMissileAiEnvOn: tgMissileFlag,
        telegramMissilePipelineReady: tgMissileFlag && openaiOk && Boolean(tgTok),
        launchAxisAiEnabled: process.env.LAUNCH_AXIS_AI_ENABLED === '1',
        activeMissilesCount: Array.isArray(state.activeMissiles) ? state.activeMissiles.length : 0,
        activeAlertsCount: Array.isArray(state.activeAlerts) ? state.activeAlerts.length : 0,
        hint:
          'טילים מפיקוד העורף תלויים ב־alerts.json בלבד. טילים מוקדמים מטלגרם+AI דורשים TELEGRAM_MISSILE_AI=1 + OPENAI_API_KEY + TELEGRAM_BOT_TOKEN בשרת (לא בגיט).',
      },
      oref: getUnifiedOrefStatus(),
      osint: getOsintDebugSnapshot(),
      tzofarBackup: tzofarBackupClient
        ? { ...tzofarBackupClient.getStatus(), filledFromBackupLastPoll: orefLastPollUsedTzofarBackup }
        : {
            enabled: false,
            connected: false,
            filledFromBackupLastPoll: orefLastPollUsedTzofarBackup,
            backupEnabledInEnv: TZOFAR_BACKUP_ENABLED,
          },
      telegramMissile: {
        pollInFlight: telegramMissilePollInFlight,
        lastRunAt: telegramMissileLastRunAt,
        envFlagOn: tgMissileFlag,
        openaiPresent: openaiOk,
        botTokenPresent: Boolean(tgTok),
      },
      pollers: {
        orefPollInFlight,
        orefPollLastStartedAt,
        orefPollSkippedOverlaps,
        orefPollPendingFollowUp,
        aiSummaryLastRefreshAt,
        orefBurstOsintLastAt,
      },
      counts: {
        flights: state.flights.length,
        seismic: state.seismic.length,
        fires: state.fires.length,
        ships: state.ships.length,
        news: newsCount,
      },
      memory: {
        heapUsed: process.memoryUsage().heapUsed,
        rss: process.memoryUsage().rss,
      },
    });
  } catch (err) {
    console.error('[HTTP] /health:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, status: 'error', error: 'health_failed' });
    }
  }
});

/** היסטוריית צ׳אט לקריאה ב-HTTP (גיבוי אם chat_history בסוקט התפספס; אותו מקור כמו בזיכרון/קובץ) */
app.get('/api/chat/history', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      messages: chatHistory.slice(-CHAT_HISTORY_SEND),
      total: chatHistory.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'chat_history_failed' });
  }
});

/** פיד אירועים (פיקוד) — אותו מקור כמו feed_bootstrap בסוקט + data/client-event-feed.json */
app.get('/api/feed/events', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const raw = Array.isArray(state.clientEventFeed) ? state.clientEventFeed : [];
    const lim = Math.min(2000, Math.max(1, Number.parseInt(String(req.query.limit || ''), 10) || raw.length));
    const slice = raw.slice(0, lim);
    res.json({
      ok: true,
      count: raw.length,
      returned: slice.length,
      events: slice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'feed_events_failed' });
  }
});

app.get('/api/dashboard', dashboardRateLimit, (req, res) => {
  try {
    const newsArticles = getNews(20);
    const unifiedOref = getUnifiedOrefStatus();
    const sanitizedFeed = sanitizeDashboardFeedRows(state.clientEventFeed || []).filter(
      (row) => String(row?.source || '') === 'oref'
    );
    const latestFeedByCity = getLatestFeedRowByCity(sanitizedFeed);
    let activeAlerts = filterActiveRowsByLatestFeed(
      (state.activeAlerts || []).filter((alert) => hasRenderableAlertCoordinates(alert)),
      latestFeedByCity
    );
    let activeMissiles = filterActiveRowsByLatestFeed(
      (state.activeMissiles || []).filter((missileEvent) => hasRenderableMissileTarget(missileEvent)),
      latestFeedByCity
    );
    if (activeAlerts.length === 0 && Array.isArray(unifiedOref.activeCities) && unifiedOref.activeCities.length > 0) {
      activeAlerts = unifiedOref.activeCities
        .map((cityName) => {
      const cityCoords = getReliableCityCoordinates(cityName);
          if (!cityCoords || !isPlausibleIsraelAlertTarget(cityCoords.lng, cityCoords.lat)) return null;
          const existing = activeAlertDetailsByCity.get(cityName);
          const targetPosition = [cityCoords.lng, cityCoords.lat];
          const pseudoForSource = {
            cityName,
            title: existing?.title || 'התראה פעילה',
            threatType: existing?.threatType || 'missile',
            orefTextBlob: existing?.orefTextBlob || '',
            orefTimeMs: existing?.orefTimeMs || Date.now(),
            receivedAtMs: existing?.receivedAtMs || Date.now(),
          };
          const sourcePosition =
            Array.isArray(existing?.sourcePosition) && existing.sourcePosition.length >= 2
              ? normalizeCoordPairToLngLat(existing.sourcePosition)
              : resolveSourcePosition(pseudoForSource, targetPosition);
          return {
            cityName,
            coordinates: targetPosition,
            targetPosition,
            sourcePosition,
            title: existing?.title || 'התראה פעילה',
            threatType: existing?.threatType || 'missile',
            alertPhase: isActiveAlertPhase(existing?.alertPhase) ? existing.alertPhase : 'hold_after_siren',
            sourceRegion: existing?.sourceRegion || null,
            sourceLocation: existing?.sourceLocation || '',
            sourceConfidence: existing?.sourceConfidence || 'estimated',
            sourceConfidenceScore:
              existing?.sourceConfidenceScore != null ? existing.sourceConfidenceScore : 0.3,
            orefTextBlob: existing?.orefTextBlob || '',
            orefTimeMs: existing?.orefTimeMs || Date.now(),
            receivedAtMs: existing?.receivedAtMs || Date.now(),
            updatedAt: existing?.updatedAt || Date.now(),
          };
        })
        .filter(Boolean);
    }
    // ללא שחזור סינתטי: מציגים רק טילים אמיתיים שקיימים במצב השרת.
    activeAlerts = activeAlerts.filter((alert) => {
      const row = latestFeedByCity.get(alert.cityName);
      return !row || String(row.source || '') === 'oref';
    });
    activeMissiles = activeMissiles.filter((missileEvent) => {
      const row = latestFeedByCity.get(missileEvent.cityName);
      return !row || String(row.source || '') === 'oref';
    });
    activeAlerts = activeAlerts
      .filter((alert) => hasRenderableAlertCoordinates(alert))
      .sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0));
    activeMissiles = activeMissiles
      .filter((missileEvent) => hasRenderableMissileTarget(missileEvent))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const dashboardFeed = buildClientFacingOrefFeedRows(state.clientEventFeed || []);
    const latestAttackByCity = getLatestFeedRowByCity(
      dashboardFeed.filter((row) => row && row.type === 'attack')
    );
    for (const alert of activeAlerts) {
      const cityName = String(alert?.cityName || '').trim();
      if (!cityName) continue;
      const existingAttack = latestAttackByCity.get(cityName);
      if (existingAttack && existingAttack.alertPhase !== 'released') continue;
      const phase = String(alert?.alertPhase || 'pre_alert');
      dashboardFeed.push(
        normalizeDashboardFeedRow({
          id: `dash-attack-${cityName}-${Number(alert?.receivedAtMs || alert?.orefTimeMs || Date.now())}`,
          timestampMs: Number(alert?.receivedAtMs || alert?.orefTimeMs || Date.now()),
          title: cityName,
          type: 'attack',
          tag: String(alert?.title || alert?.eventType || 'ירי רקטות וטילים'),
          severity: 3,
          zone: 'israel',
          source: 'oref',
          cityName,
          alertPhase: phase,
          liveState:
            phase === 'siren_active'
              ? 'אזעקה פעילה'
              : phase === 'hold_after_siren'
                ? 'במרחב מוגן'
                : 'התראה מוקדמת',
          threatType: String(alert?.threatType || 'missile'),
        })
      );
      latestAttackByCity.set(
        cityName,
        normalizeDashboardFeedRow({
          cityName,
          type: 'attack',
          tag: String(alert?.title || alert?.eventType || 'ירי רקטות וטילים'),
          source: 'oref',
          alertPhase: phase,
          timestampMs: Number(alert?.receivedAtMs || alert?.orefTimeMs || Date.now()),
        })
      );
    }
    dashboardFeed.sort((a, b) => feedRowSortKeyMs(b) - feedRowSortKeyMs(a));
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      markets: state.markets,
      flights: state.flights,
      seismic: state.seismic,
      fires: state.fires,
      ships: state.ships,
      osintImpacts: state.osintImpacts || [],
      news: {
        articles: newsArticles,
        count: newsArticles.length,
      },
      activeAlerts,
      activeMissiles,
      aiSummary: state.aiSummary || refreshAiSummary({ emit: false }),
      eventFeed: dashboardFeed,
      oref: unifiedOref,
      tzofarBackup: tzofarBackupClient
        ? { ...tzofarBackupClient.getStatus(), filledFromBackupLastPoll: orefLastPollUsedTzofarBackup }
        : { enabled: false, filledFromBackupLastPoll: false },
      onlineViewers: io.sockets.sockets.size,
      osint: getOsintDebugSnapshot(),
    });
  } catch (err) {
    console.error('[HTTP] /api/dashboard:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'dashboard_failed' });
    }
  }
});

app.get('/api/news', (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const articles = getNews(limit);
    res.json({
      ok: true,
      articles,
      count: articles.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[HTTP] /api/news:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'news_failed', articles: [], count: 0 });
    }
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  res.status(404).type('text').send('Not Found');
});

const indexHtmlPath = path.join(ROOT_DIR, 'monitor.html');
if (!fs.existsSync(indexHtmlPath)) {
  console.error(`[FATAL] monitor.html not found at: ${indexHtmlPath}`);
  console.error('        Make sure backend/server.js is under backend and monitor.html is at the project root.');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[FATAL] Port ${PORT} is already in use.\n` +
        `        Close the old server window or stop node.exe: taskkill /F /IM node.exe\n` +
        `        Or set another port in .env, for example: PORT=8090`
    );
  } else {
    console.error('[FATAL] HTTP server:', err.message);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.warn('[Process] unhandledRejection:', msg);
});

const LISTEN_HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, LISTEN_HOST, async () => {
  loadPersistedClientEventFeed();
  try {
    state.osintImpactRegistry = loadOsintImpactRegistryFromDisk(OSINT_IMPACT_REGISTRY_FILE);
    if (state.osintImpactRegistry && typeof state.osintImpactRegistry === 'object') {
      const n = Object.keys(state.osintImpactRegistry).length;
      if (n > 0) console.log(`[OSINT impacts] נטענו ${n} רשומות registry מדיסק`);
    }
  } catch (e) {
    console.warn('[OSINT impacts] טעינת registry:', e && e.message ? e.message : e);
    state.osintImpactRegistry = {};
  }
  console.log(`
========================================
  War Monitor - Unified Server
========================================
  URL: http://localhost:${PORT}/
  UI:  monitor.html
  Port: ${PORT}
========================================
  Active streams:
  - Pikud HaOref
  - OpenSky
  - USGS
  - Yahoo Finance
  - NASA FIRMS
  - Ship Tracking
  - News Aggregation
========================================
  `);

  try {
    const [m, f, sm] = await Promise.all([fetchYahooData(), fetchOpenSkyData(), fetchUSGSData()]);
    state.markets = m;
    state.flights = f;
    state.seismic = sm;
    console.log(
      `[Bootstrap] Initial data: markets ${Object.keys(m || {}).length}, flights ${(f || []).length}, seismic ${(sm || []).length}`
    );
  } catch (e) {
    console.warn('[Bootstrap] Initial polling load:', e && e.message ? e.message : e);
  }

  startNewsService(io);
  startExternalPolling();

  if (tzofarBackupClient) {
    tzofarBackupClient.start();
    console.log('[Tzofar backup] מופעל — יוזרם לתוך ה-poll רק כשהבקשה ל-alerts.json נכשלת או שאינה JSON תקין.');
  } else {
    const rawTz = process.env.TZOFAR_BACKUP_ENABLED;
    console.log(
      '[Tzofar backup] כבוי בשרת זה. להפעלה: TZOFAR_BACKUP_ENABLED=1 ב-.env (שורש הפרויקט או backend/) + הפעלה מחדש, או משתנה סביבה ב-Render.' +
        (rawTz != null && String(rawTz).trim() !== ''
          ? ` (קראתי מה-env: "${String(rawTz).trim()}" — אם זה אמור להיות מופעל, בדוק איות/רווחים)`
          : '')
    );
  }

  const osintMs =
    Number(process.env.OSINT_REFRESH_MS) >= 15_000 ? Number(process.env.OSINT_REFRESH_MS) : 60_000;
  runPoller('osint_hints', () => refreshOsintHints(getNewsStoreWarRelatedBlob));
  setInterval(
    () => runPoller('osint_hints', () => refreshOsintHints(getNewsStoreWarRelatedBlob)),
    osintMs
  );
});

module.exports = { app, server, io };
