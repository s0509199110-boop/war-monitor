/**
 * סימולציית טילים עצמאית — לא נטענת על ידי monitor.html ולא מפעילה את server.js.
 * מריץ:  cd backend && node missileSimulationHarness.cjs
 * או:    npm run sim:harness
 *
 * בודקות: עוגן זמן מסלול, כניסה מאוחרת, התאמת גלים (אותו טיל / טיל נפרד), מפתחות מיזוג לטווח ארוך.
 */

'use strict';

const { normalizeHebrewSettlementName } = require('./citiesMap');

const OREF_MISSILE_SAME_WAVE_MAX_MS = 50 * 1000;

function findMissileForOrefAlertUpdate(alert, activeMissilesById) {
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
        m.orefAlertGroupId != null &&
        String(m.orefAlertGroupId).length > 0 &&
        String(m.orefAlertGroupId) === alertGid
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

/** סימולציה של הלקוח: t לאורך המסלול הבליסטי (0..1) */
function clientBallisticT(nowMs, launchWallMs, physicsMs, phaseResolved) {
  if (phaseResolved) return 1;
  if (physicsMs == null || launchWallMs == null || !Number.isFinite(physicsMs) || !Number.isFinite(launchWallMs)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (nowMs - launchWallMs) / physicsMs));
}

function normCityHarness(name) {
  return normalizeHebrewSettlementName(String(name || '').trim()) || String(name || '').trim();
}

/** מראה ל-monitor.html ballisticMergeKeyFromData (טווח ארוך + id + orefTimeMs) */
function ballisticMergeKeyFromDataHarness(data) {
  const cityNorm = data && data.cityName ? normCityHarness(data.cityName) : '';
  if (data && data.waveId) {
    const idPart = data.id != null ? String(data.id) : '';
    return 'w:' + String(data.waveId) + ':' + (cityNorm || idPart || 'na');
  }
  const sr = data && data.sourceRegion ? String(data.sourceRegion) : '';
  const longRange = sr === 'iran' || sr === 'iraq' || sr === 'yemen';
  if (longRange) {
    var ot = Number(data && data.orefTimeMs);
    if (!Number.isFinite(ot)) ot = Date.now();
    var sid = data && data.id != null ? String(data.id) : '';
    if (cityNorm) return 'lr:' + sr + ':' + cityNorm + ':' + ot + ':' + sid;
    var tgt = data && (data.targetPosition || data.target);
    var cell = 'na';
    if (Array.isArray(tgt) && tgt.length >= 2) {
      var clng = Math.round(Number(tgt[0]) * 12) / 12;
      var clat = Math.round(Number(tgt[1]) * 12) / 12;
      cell = clng.toFixed(3) + ':' + clat.toFixed(3);
    }
    return 'lr:' + sr + ':' + ot + ':' + cell + ':' + sid;
  }
  var sid2 = data && data.id != null ? String(data.id) : '';
  var city = data && data.cityName ? normCityHarness(data.cityName) : '';
  return 'solo:' + sid2 + ':' + (city || 'na');
}

// --- נתוני סימולציה: אזורים ויעדים (lng, lat) ---
const SOURCE_REGION_LNG_LAT = {
  iran: [51.6, 32.1],
  iraq: [44.9, 32.3],
  yemen: [47.9, 15.7],
  lebanon: [35.45, 33.62],
  syria: [36.18, 33.35],
  gaza: [34.38, 31.42],
};

const ISRAEL_CITIES = [
  { name: 'תל אביב', lng: 34.7818, lat: 32.0853 },
  { name: 'חיפה', lng: 34.9881, lat: 32.794 },
  { name: 'ירושלים', lng: 35.2137, lat: 31.7683 },
  { name: 'באר שבע', lng: 34.7925, lat: 31.2518 },
  { name: 'אשדוד', lng: 34.6553, lat: 31.8044 },
  { name: 'נתניה', lng: 34.8532, lat: 32.3324 },
  { name: 'אילת', lng: 34.9519, lat: 29.5577 },
  { name: 'קריית שמונה', lng: 35.5731, lat: 33.2079 },
  { name: 'נצרת', lng: 35.3035, lat: 32.6996 },
  { name: 'רמת גן', lng: 34.8245, lat: 32.0684 },
  { name: 'הרצליה', lng: 34.8447, lat: 32.1624 },
  { name: 'כפר סבא', lng: 34.9071, lat: 32.1782 },
  { name: 'רחובות', lng: 34.8113, lat: 31.8928 },
  { name: 'לוד', lng: 34.8883, lat: 31.951 },
  { name: 'אשקלון', lng: 34.5715, lat: 31.6688 },
  { name: 'טבריה', lng: 35.5312, lat: 32.7959 },
  { name: 'עכו', lng: 35.0833, lat: 32.926 },
  { name: 'מודיעין', lng: 35.0104, lat: 31.8903 },
];

const REGION_NAMES = Object.keys(SOURCE_REGION_LNG_LAT);

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.error('FAIL:', msg);
}

function makeMissile(id, cityName, orefTimeMs, flightMs, extra = {}) {
  const m = {
    id,
    cityName,
    threatType: 'missile',
    orefTimeMs,
    flightMs,
    displayFlightMs: Math.min(240_000, flightMs),
    displayElapsedMs: Math.round(flightMs * 0.35),
    orefTrajectoryLeadFraction: 0.28,
    ...extra,
  };
  attachTrajectoryLaunchWallMs(m);
  return m;
}

function runGeneratedRegionalScenarios() {
  let idx = 0;
  const baseTime = 1_700_000_000_000;
  for (const region of REGION_NAMES) {
    for (const city of ISRAEL_CITIES) {
      idx++;
      const oref = baseTime + idx * 37_000;
      const flightMs = 120_000 + (idx % 7) * 15_000;
      const m = makeMissile(`sim-${region}-${idx}`, city.name, oref, flightMs, { sourceRegion: region });
      assert(Number.isFinite(m.trajectoryLaunchWallMs), `traj wall #${idx} ${region} ${city.name}`);
      /* כניסה "באמצע" יחסית לקשת הפיזיקלית — לא oref+flightMs שכבר אחרי פגיעה */
      const join = m.trajectoryLaunchWallMs + 0.42 * m.flightMs;
      const t = clientBallisticT(join, m.trajectoryLaunchWallMs, m.flightMs, false);
      assert(t > 0.35 && t < 0.5, `mid-flight join ~0.42 #${idx}: ${t}`);
      assert(t === Math.min(1, (join - m.trajectoryLaunchWallMs) / m.flightMs), `t formula #${idx}`);
    }
  }
}

function runWaveAndParallelTests() {
  const map = new Map();
  const WBASE = 1_800_000_000_000;

  const m1 = makeMissile('w1', 'תל אביב', WBASE, 200_000, { orefAlertGroupId: 'g-wave-a' });
  map.set(m1.id, m1);

  let alertSameWave = { cityName: 'תל אביב', orefTimeMs: WBASE + 5_000, orefAlertGroupId: 'g-wave-a' };
  assert(findMissileForOrefAlertUpdate(alertSameWave, map)?.id === 'w1', 'same GID → same missile');

  let alertNewWave = {
    cityName: 'תל אביב',
    orefTimeMs: WBASE + 70_000,
    orefAlertGroupId: 'g-wave-b',
  };
  assert(findMissileForOrefAlertUpdate(alertNewWave, map) == null, 'new GID + far time → no match');

  const alertSecondSalvo = { cityName: 'תל אביב', orefTimeMs: WBASE + 160_000 };
  assert(findMissileForOrefAlertUpdate(alertSecondSalvo, map) == null, '160s gap → no attach to m1');

  const m2oref = WBASE + 160_000;
  const m2 = makeMissile('w2', 'תל אביב', m2oref, 200_000, { orefAlertGroupId: 'g-wave-b' });
  map.set(m2.id, m2);
  assert(findMissileForOrefAlertUpdate(alertSecondSalvo, map)?.id === 'w2', 'attach to second missile');

  /* 8 יעדים שונים במקביל — לא משתמשים באינדקס 0 (תל אביב) כדי לא לבלבל עם w1/w2 */
  for (let i = 0; i < 8; i++) {
    const city = ISRAEL_CITIES[1 + i];
    const mm = makeMissile(`par-${i}`, city.name, 1_810_000_000_000 + i * 2_000, 180_000, {
      sourceRegion: REGION_NAMES[i % REGION_NAMES.length],
    });
    map.set(mm.id, mm);
  }
  assert([...map.values()].filter((x) => x.cityName === 'תל אביב').length === 2, 'two TLV missiles coexist');

  const keys = new Set();
  for (let i = 0; i < 12; i++) {
    const c = ISRAEL_CITIES[i % ISRAEL_CITIES.length];
    const reg = REGION_NAMES[i % REGION_NAMES.length];
    const payload = {
      id: `merge-test-${i}`,
      cityName: c.name,
      sourceRegion: reg,
      orefTimeMs: 1_820_000_000_000 + i * 60_000,
      targetPosition: [c.lng, c.lat],
      waveId: i % 3 === 0 ? 'shared-wave' : null,
    };
    keys.add(ballisticMergeKeyFromDataHarness(payload));
  }
  assert(keys.size === 12, 'long-range keys stay distinct per launch id/time');
}

function runEdgeCases() {
  const m = makeMissile('edge1', 'חיפה', 1_900_000_000_000, 90_000, { phase: 'impact', status: 'resolved' });
  const tEnd = clientBallisticT(1_900_000_200_000, m.trajectoryLaunchWallMs, m.flightMs, true);
  assert(tEnd === 1, 'resolved phase → t=1');

  const uav = { id: 'u1', threatType: 'uav', orefTimeMs: 1, flightMs: 60_000 };
  attachTrajectoryLaunchWallMs(uav);
  assert(uav.trajectoryLaunchWallMs === undefined, 'uav skips trajectory wall');

  const k1 = ballisticMergeKeyFromDataHarness({
    id: 'a',
    cityName: 'אילת',
    sourceRegion: 'iran',
    orefTimeMs: 100,
    targetPosition: [34.95, 29.55],
  });
  const k2 = ballisticMergeKeyFromDataHarness({
    id: 'b',
    cityName: 'אילת',
    sourceRegion: 'iran',
    orefTimeMs: 100 + 70_000,
    targetPosition: [34.95, 29.55],
  });
  assert(k1 !== k2, 'Iran→same city different oref+id → merge keys differ');
}

function main() {
  console.log('מסלול סימולציה (ללא server.js / ללא monitor.html)\n');
  runGeneratedRegionalScenarios();
  runWaveAndParallelTests();
  runEdgeCases();

  const minExpectedAssertions = 50;
  assert(passed >= minExpectedAssertions, `לפחות ${minExpectedAssertions} בדיקות עברו (ספירה פנימית)`);

  console.log('\n--- סיכום ---');
  console.log('עברו (assertים):', passed);
  console.log('נכשלו:', failed);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('כל הבדיקות עברו.');
  }
}

main();
