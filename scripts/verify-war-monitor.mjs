/**
 * אימות War Monitor: קבצים סטטיים + שרת HTTP + נקודת Socket.IO
 * הרצה: node scripts/verify-war-monitor.mjs
 * או עם פורט קיים: VERIFY_BASE_URL=http://127.0.0.1:8080 node scripts/verify-war-monitor.mjs
 */
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const REQUIRED_MONITOR_SNIPPETS = [
  'warMonitorMissiles',
  'real_time_missile',
  'uav_track_update',
  'normalizeUavRoutePoints',
  'buildArcLatLngs',
  'ARC_BIAS',
  'getMonitorApiBase',
  'registerMissileSocketHandlers',
  '/api/dashboard',
];

const REQUIRED_SERVER_SNIPPETS = [
  'pollOrefMissileLayer',
  'clusterAlertsIntoSalvos',
  'detectThreatType',
  'getUavTrackKey',
  'orefAlertGroupId',
  'real_time_missile',
  'uav_track_update',
  'emitSnapshot',
  'enrichOrefAlertsGeocode',
  'getOsintAxisHintSync',
  'refreshOsintHints',
  'getOsintDebugSnapshot',
  'getNewsStoreWarRelatedBlob',
  'orefPollContextAlerts',
  '{ burst: true }',
];

/** דרישות מהשיחה: איום חי, שווקים/טיסות, קשת, מוצא שיגור, אתחול פידים */
const CONVERSATION_MONITOR_SNIPPETS = [
  'updateLiveThreatAssessment',
  'scheduleThreatUiRefresh',
  '__liveThreatMap',
  'launcher-origin-summary',
  'map-launcher-hint',
  'country-threats',
  'pts[pts.length - 1] = L.latLng(tgt[1], tgt[0])',
  'pts[0] = L.latLng(src[1], src[0])',
  '3.28084',
  'fetchDashboard',
  'updateMarkets(data.markets',
];

const CONVERSATION_SERVER_SNIPPETS = [
  'syncMissileSourceFromGeometry',
  'Promise.all([fetchYahooData(), fetchOpenSkyData(), fetchUSGSData()])',
  'state.markets = m',
  'state.flights = f',
  'markets: state.markets',
  'resolveSourceRegionFromAlert',
  'threatAxisFromOref',
  'computeThreatFusionResult',
  'trajectoryLocked',
  'finalizeAllActiveOrefTrajectories',
];

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log('OK ', msg);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: 'application/json,*/*' },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function staticFileChecks() {
  const monitorPath = path.join(ROOT, 'monitor.html');
  const serverPath = path.join(ROOT, 'backend', 'server.js');
  const geocodePath = path.join(ROOT, 'backend', 'settlementGeocode.js');
  const threatAxisPath = path.join(ROOT, 'backend', 'threatAxisPatterns.js');
  const osintPath = path.join(ROOT, 'backend', 'osintHintService.js');
  if (!fs.existsSync(monitorPath)) {
    fail('monitor.html חסר בשורש');
    return false;
  }
  if (!fs.existsSync(serverPath)) {
    fail('backend/server.js חסר');
    return false;
  }
  if (!fs.existsSync(geocodePath)) {
    fail('backend/settlementGeocode.js חסר');
    return false;
  }
  if (!fs.existsSync(threatAxisPath)) {
    fail('backend/threatAxisPatterns.js חסר');
    return false;
  }
  if (!fs.existsSync(osintPath)) {
    fail('backend/osintHintService.js חסר');
    return false;
  }
  const mon = fs.readFileSync(monitorPath, 'utf8');
  const srv = fs.readFileSync(serverPath, 'utf8');
  const tax = fs.readFileSync(threatAxisPath, 'utf8');
  const osi = fs.readFileSync(osintPath, 'utf8');
  let good = true;
  if (!tax.includes('matchThreatAxisInBlob')) {
    fail('threatAxisPatterns.js חסר matchThreatAxisInBlob');
    good = false;
  }
  if (!osi.includes('refreshOsintHints')) {
    fail('osintHintService.js חסר refreshOsintHints');
    good = false;
  }
  for (const s of REQUIRED_MONITOR_SNIPPETS) {
    if (!mon.includes(s)) {
      fail(`monitor.html חסר מחרוזת נדרשת: ${s}`);
      good = false;
    }
  }
  for (const s of REQUIRED_SERVER_SNIPPETS) {
    if (!srv.includes(s)) {
      fail(`server.js חסר מחרוזת נדרשת: ${s}`);
      good = false;
    }
  }
  for (const s of CONVERSATION_MONITOR_SNIPPETS) {
    if (!mon.includes(s)) {
      fail(`monitor.html חסר יישום משיחה: ${s}`);
      good = false;
    }
  }
  for (const s of CONVERSATION_SERVER_SNIPPETS) {
    if (!srv.includes(s)) {
      fail(`server.js חסר יישום משיחה: ${s}`);
      good = false;
    }
  }
  const clearAllIdx = mon.indexOf("socket.on('clear_all_threats'");
  if (clearAllIdx < 0) {
    fail('monitor.html חסר handler clear_all_threats');
    good = false;
  } else {
    const handlerSlice = mon.slice(clearAllIdx, clearAllIdx + 900);
    if (!handlerSlice.includes('scheduleThreatUiRefresh')) {
      fail('clear_all_threats חייב לקרוא scheduleThreatUiRefresh');
      good = false;
    }
  }
  if (good) ok('קבצי monitor.html + server.js מכילים את הוקטורים הלוגיים');
  if (good) ok('בדיקות משיחה (איום חי, פידים, קשת, שחרור כללי) עברו');
  return good;
}

async function liveChecks(base) {
  const healthUrl = `${base}/health`;
  const dashUrl = `${base}/api/dashboard`;
  const homeUrl = `${base}/`;
  const sockUrl = `${base}/socket.io/?EIO=4&transport=polling`;

  let r = await httpGet(healthUrl);
  if (r.status !== 200) {
    fail(`/health סטטוס ${r.status}`);
    return false;
  }
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    fail('/health לא JSON תקין');
    return false;
  }
  if (j.status !== 'healthy') {
    fail('/health.status לא healthy');
    return false;
  }
  if (!j.oref || typeof j.oref !== 'object') {
    fail('/health חסר oref');
    return false;
  }
  if (!j.osint || typeof j.osint !== 'object') {
    fail('/health חסר osint');
    return false;
  }
  ok('/health תקין (כולל oref, osint)');

  r = await httpGet(dashUrl);
  if (r.status !== 200) {
    fail(`/api/dashboard סטטוס ${r.status}`);
    return false;
  }
  try {
    j = JSON.parse(r.body);
  } catch {
    fail('/api/dashboard לא JSON');
    return false;
  }
  if (!j.ok) {
    fail('/api/dashboard ok=false');
    return false;
  }
  const need = [
    'activeMissiles',
    'activeAlerts',
    'flights',
    'markets',
    'eventFeed',
    'oref',
    'osint',
    'ships',
    'fires',
    'seismic',
    'osintImpacts',
  ];
  for (const k of need) {
    if (!(k in j)) {
      fail(`/api/dashboard חסר שדה: ${k}`);
      return false;
    }
  }
  if (!Array.isArray(j.activeMissiles)) {
    fail('activeMissiles לא מערך');
    return false;
  }
  if (j.markets == null || typeof j.markets !== 'object' || Array.isArray(j.markets)) {
    fail('/api/dashboard.markets חייב להיות אובייקט');
    return false;
  }
  if (!Array.isArray(j.flights)) {
    fail('/api/dashboard.flights חייב להיות מערך');
    return false;
  }
  if (!Array.isArray(j.ships)) {
    fail('/api/dashboard.ships חייב להיות מערך');
    return false;
  }
  if (!Array.isArray(j.fires)) {
    fail('/api/dashboard.fires חייב להיות מערך');
    return false;
  }
  if (!Array.isArray(j.seismic)) {
    fail('/api/dashboard.seismic חייב להיות מערך');
    return false;
  }
  if (!Array.isArray(j.osintImpacts)) {
    fail('/api/dashboard.osintImpacts חייב להיות מערך');
    return false;
  }
  ok(
    `/api/dashboard תקין (כולל ships=${j.ships.length}, fires=${j.fires.length}, seismic=${j.seismic.length})`
  );

  r = await httpGet(`${base}/api/feed/events?limit=5`);
  if (r.status !== 200) {
    fail(`/api/feed/events סטטוס ${r.status}`);
    return false;
  }
  try {
    j = JSON.parse(r.body);
  } catch {
    fail('/api/feed/events לא JSON תקין');
    return false;
  }
  if (!j.ok) {
    fail('/api/feed/events ok=false');
    return false;
  }
  if (!Array.isArray(j.events)) {
    fail('/api/feed/events.events חייב להיות מערך');
    return false;
  }
  if (typeof j.count !== 'number' || !Number.isFinite(j.count)) {
    fail('/api/feed/events.count חסר או לא מספר');
    return false;
  }
  ok(`/api/feed/events תקין (פיד שמור בשרת, count=${j.count})`);

  r = await httpGet(homeUrl);
  if (r.status !== 200) {
    fail(`דף הבית סטטוס ${r.status}`);
    return false;
  }
  if (!r.body.includes('warMonitorMissiles') || !r.body.includes('socket.io')) {
    fail('דף הבית לא מכיל warMonitorMissiles / socket.io');
    return false;
  }
  const pageNeed = ['map-launcher-hint', 'launcher-origin-summary', 'id="country-threats"', 'updateLiveThreatAssessment'];
  for (const s of pageNeed) {
    if (!r.body.includes(s)) {
      fail(`דף הבית חסר מקטע UI נדרש: ${s}`);
      return false;
    }
  }
  ok('GET / מחזיר monitor.html עם לוגיקת מפה, איום חי וסוקט');

  r = await httpGet(sockUrl);
  if (r.status !== 200) {
    fail(`Socket.IO polling סטטוס ${r.status}`);
    return false;
  }
  if (!r.body.includes('sid')) {
    fail('תשובת Socket.IO ללא sid');
    return false;
  }
  ok('Socket.IO (EIO4 polling) מגיב — אפשר חיבור מהדפדפן');

  return true;
}

function startTempServer(port) {
  const serverJs = path.join(ROOT, 'backend', 'server.js');
  const child = spawn(process.execPath, [serverJs], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForHealth(base, maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpGet(`${base}/health`);
      if (r.status === 200 && r.body.includes('healthy')) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  console.log('=== War Monitor verification ===\n');
  if (!staticFileChecks()) process.exit(1);

  const existing = process.env.VERIFY_BASE_URL;
  if (existing) {
    const base = existing.replace(/\/$/, '');
    console.log('\nבודק שרת קיים:', base);
    const okLive = await liveChecks(base);
    process.exit(okLive ? 0 : 1);
  }

  const port = Number(process.env.VERIFY_PORT) || 18091;
  const base = `http://127.0.0.1:${port}`;
  console.log('\nמרים שרת זמני על', base);
  const child = startTempServer(port);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    const up = await waitForHealth(base);
    if (!up) {
      fail('השרת לא עלה בזמן — ' + stderr.slice(-500));
      process.exit(1);
    }
    const okLive = await liveChecks(base);
    process.exitCode = okLive ? 0 : 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
