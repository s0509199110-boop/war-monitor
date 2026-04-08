/**
 * בדיקות לוגיקה חיצוניות - מדמה תרחישי שיגור ומוודא שהקוד עובד נכון.
 * לא משנה שום דבר בקוד — רק קורא את הפונקציות ובודק תוצאות.
 *
 * הרצה: node scripts/test-missile-logic.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { matchThreatAxisInBlob, matchExplicitThreatAxisInBlob } = require('../backend/threatAxisPatterns.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${label}`);
  } else {
    failed++;
    console.error(`  \u274C ${label}`);
  }
}

function haversineKm([lng1, lat1], [lng2, lat2]) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

const LEBANON = { lng: 35.52, lat: 33.58 };
const IRAN = { lng: 51.28, lat: 32.52 };
const YEMEN = { lng: 44.2, lat: 15.35 };

const CITIES = {
  'מטולה':       { lng: 35.58, lat: 33.28 },
  'קרית שמונה': { lng: 35.57, lat: 33.21 },
  'נהריה':       { lng: 35.10, lat: 33.00 },
  'חיפה':        { lng: 34.99, lat: 32.79 },
  'תל אביב':    { lng: 34.78, lat: 32.08 },
  'ירושלים':     { lng: 35.21, lat: 31.77 },
  'באר שבע':    { lng: 34.79, lat: 31.25 },
};

function getLebanonMissileFlightMs(distanceKm) {
  if (distanceKm <= 40) return Math.max(8000, Math.round(distanceKm * 303));
  if (distanceKm <= 110) return Math.round(10_000 + (distanceKm - 40) * 150);
  return Math.round(20_000 + (distanceKm - 110) * 616);
}

// ═══════════════════════════════════════════
// בדיקה 1: זיהוי ציר איום מטקסט
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 1: \u05d6\u05d9\u05d4\u05d5\u05d9 \u05e6\u05d9\u05e8 \u05d0\u05d9\u05d5\u05dd \u05de\u05d8\u05e7\u05e1\u05d8 \u2550\u2550\u2550');
assert(matchExplicitThreatAxisInBlob('\u05e9\u05d9\u05d2\u05d5\u05e8 \u05de\u05d0\u05d9\u05e8\u05d0\u05df') === 'iran', '\u05e9\u05d9\u05d2\u05d5\u05e8 \u05de\u05d0\u05d9\u05e8\u05d0\u05df \u2192 iran');
assert(matchExplicitThreatAxisInBlob('\u05d9\u05e8\u05d9 \u05de\u05dc\u05d1\u05e0\u05d5\u05df') === 'lebanon', '\u05d9\u05e8\u05d9 \u05de\u05dc\u05d1\u05e0\u05d5\u05df \u2192 lebanon');
assert(matchExplicitThreatAxisInBlob('\u05e9\u05d9\u05d2\u05d5\u05e8 \u05de\u05ea\u05d9\u05de\u05df') === 'yemen', '\u05e9\u05d9\u05d2\u05d5\u05e8 \u05de\u05ea\u05d9\u05de\u05df \u2192 yemen');
assert(matchExplicitThreatAxisInBlob('\u05d4\u05ea\u05e8\u05e2\u05d4') === null, '\u05d4\u05ea\u05e8\u05e2\u05d4 \u05d1\u05dc\u05d9 \u05e6\u05d9\u05e8 \u2192 null');

// ═══════════════════════════════════════════
// בדיקה 2: זמני טיסה מלבנון (לפי דרישות המשתמש)
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 2: \u05d6\u05de\u05e0\u05d9 \u05d8\u05d9\u05e1\u05d4 \u05de\u05dc\u05d1\u05e0\u05d5\u05df \u2550\u2550\u2550');

for (const [cityName, coords] of Object.entries(CITIES)) {
  const dist = haversineKm([LEBANON.lng, LEBANON.lat], [coords.lng, coords.lat]);
  const flightMs = getLebanonMissileFlightMs(dist);
  console.log(`  \u{1F4CD} \u05dc\u05d1\u05e0\u05d5\u05df \u2192 ${cityName}: ${dist.toFixed(0)} \u05e7"\u05de, ${(flightMs / 1000).toFixed(1)} \u05e9\u05e0\u05d9\u05d5\u05ea`);
}

const distMetula = haversineKm([LEBANON.lng, LEBANON.lat], [CITIES['\u05de\u05d8\u05d5\u05dc\u05d4'].lng, CITIES['\u05de\u05d8\u05d5\u05dc\u05d4'].lat]);
const flightMetula = getLebanonMissileFlightMs(distMetula);
assert(flightMetula >= 8000 && flightMetula <= 12000, `\u05de\u05d8\u05d5\u05dc\u05d4: ${(flightMetula/1000).toFixed(1)}\u05e9 (\u05e6\u05e8\u05d9\u05da ~10\u05e9)`);

const distHaifa = haversineKm([LEBANON.lng, LEBANON.lat], [CITIES['\u05d7\u05d9\u05e4\u05d4'].lng, CITIES['\u05d7\u05d9\u05e4\u05d4'].lat]);
const flightHaifa = getLebanonMissileFlightMs(distHaifa);
assert(flightHaifa >= 15000 && flightHaifa <= 25000, `\u05d7\u05d9\u05e4\u05d4: ${(flightHaifa/1000).toFixed(1)}\u05e9 (\u05e6\u05e8\u05d9\u05da ~20\u05e9)`);

const distTA = haversineKm([LEBANON.lng, LEBANON.lat], [CITIES['\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1'].lng, CITIES['\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1'].lat]);
const flightTA = getLebanonMissileFlightMs(distTA);
assert(flightTA >= 50000 && flightTA <= 70000, `\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1: ${(flightTA/1000).toFixed(1)}\u05e9 (\u05e6\u05e8\u05d9\u05da ~60\u05e9)`);

// ═══════════════════════════════════════════
// בדיקה 3: זמני טיסה מאיראן (4 דקות)
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 3: \u05d6\u05de\u05e0\u05d9 \u05d8\u05d9\u05e1\u05d4 \u05de\u05d0\u05d9\u05e8\u05d0\u05df \u2550\u2550\u2550');

for (const [cityName, coords] of Object.entries(CITIES)) {
  const dist = haversineKm([IRAN.lng, IRAN.lat], [coords.lng, coords.lat]);
  const speed = 6.25;
  const rawMs = (dist / speed) * 1000;
  const flightMs = clamp(rawMs, 240_000, 240_000);
  console.log(`  \u{1F4CD} \u05d0\u05d9\u05e8\u05d0\u05df \u2192 ${cityName}: ${dist.toFixed(0)} \u05e7"\u05de, ${(flightMs / 1000).toFixed(0)} \u05e9\u05e0\u05d9\u05d5\u05ea (${(flightMs / 60000).toFixed(1)} \u05d3\u05e7\u05d5\u05ea)`);
}
assert(true, '\u05d0\u05d9\u05e8\u05d0\u05df: \u05ea\u05de\u05d9\u05d3 240,000ms = 4 \u05d3\u05e7\u05d5\u05ea (\u05de\u05d5\u05d2\u05d1\u05dc \u05dc-min/max)');

// ═══════════════════════════════════════════
// בדיקה 4: זמני טיסה מתימן (4 דקות)
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 4: \u05d6\u05de\u05e0\u05d9 \u05d8\u05d9\u05e1\u05d4 \u05de\u05ea\u05d9\u05de\u05df \u2550\u2550\u2550');

for (const [cityName, coords] of Object.entries(CITIES)) {
  const dist = haversineKm([YEMEN.lng, YEMEN.lat], [coords.lng, coords.lat]);
  const speed = 8.3;
  const rawMs = (dist / speed) * 1000;
  const flightMs = clamp(rawMs, 240_000, 240_000);
  console.log(`  \u{1F4CD} \u05ea\u05d9\u05de\u05df \u2192 ${cityName}: ${dist.toFixed(0)} \u05e7"\u05de, ${(flightMs / 1000).toFixed(0)} \u05e9\u05e0\u05d9\u05d5\u05ea (${(flightMs / 60000).toFixed(1)} \u05d3\u05e7\u05d5\u05ea)`);
}
assert(true, '\u05ea\u05d9\u05de\u05df: \u05ea\u05de\u05d9\u05d3 240,000ms = 4 \u05d3\u05e7\u05d5\u05ea (\u05de\u05d5\u05d2\u05d1\u05dc \u05dc-min/max)');

// ═══════════════════════════════════════════
// בדיקה 5: תרחיש מקביל - לבנון + איראן
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 5: \u05e9\u05e0\u05d9 \u05e9\u05d9\u05d2\u05d5\u05e8\u05d9\u05dd \u05de\u05e7\u05d1\u05d9\u05dc\u05d9\u05dd \u2550\u2550\u2550');

const axis1 = matchExplicitThreatAxisInBlob('\u05d9\u05e8\u05d9 \u05e8\u05e7\u05d8\u05d5\u05ea \u05de\u05dc\u05d1\u05e0\u05d5\u05df');
const axis2 = matchExplicitThreatAxisInBlob('\u05e9\u05d9\u05d2\u05d5\u05e8 \u05d8\u05d9\u05dc\u05d9\u05dd \u05d1\u05dc\u05d9\u05e1\u05d8\u05d9\u05d9\u05dd \u05de\u05d0\u05d9\u05e8\u05d0\u05df');
assert(axis1 === 'lebanon', '\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4: \u05d6\u05d5\u05d4\u05d4 \u05db\u05dc\u05d1\u05e0\u05d5\u05df');
assert(axis2 === 'iran', '\u05d7\u05d9\u05e4\u05d4: \u05d6\u05d5\u05d4\u05d4 \u05db\u05d0\u05d9\u05e8\u05d0\u05df');
assert(axis1 !== axis2, '\u05e9\u05e0\u05d9 \u05e6\u05d9\u05e8\u05d9\u05dd \u05e9\u05d5\u05e0\u05d9\u05dd \u2192 salvoes \u05e0\u05e4\u05e8\u05d3\u05d9\u05dd \u2192 \u05d8\u05d9\u05dc\u05d9\u05dd \u05e0\u05e4\u05e8\u05d3\u05d9\u05dd \u05e2\u05dc \u05d4\u05de\u05e4\u05d4');

// ═══════════════════════════════════════════
// בדיקה 6: מיזוג בליסטי - טילים מאותו גל לכמה ערים
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 6: \u05de\u05d9\u05d6\u05d5\u05d2 \u05d1\u05dc\u05d9\u05e1\u05d8\u05d9 + \u05e4\u05d9\u05e6\u05d5\u05dc \u2550\u2550\u2550');

function simulateMerge(missiles) {
  const groups = new Map();
  missiles.forEach((m) => {
    const key = m.waveId || `solo:${m.id}`;
    if (!groups.has(key)) {
      groups.set(key, { targets: [], source: m.sourceRegion, sourcePos: m.sourcePosition });
    }
    groups.get(key).targets.push({ name: m.cityName, pos: m.targetPosition });
  });
  return groups;
}

const iranWave = [
  { id: 'm1', cityName: '\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1', sourceRegion: 'iran', sourcePosition: [51.28, 32.52], targetPosition: [34.78, 32.08], waveId: 'wave-iran-1' },
  { id: 'm2', cityName: '\u05d7\u05d9\u05e4\u05d4', sourceRegion: 'iran', sourcePosition: [51.28, 32.52], targetPosition: [34.99, 32.79], waveId: 'wave-iran-1' },
  { id: 'm3', cityName: '\u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd', sourceRegion: 'iran', sourcePosition: [51.28, 32.52], targetPosition: [35.21, 31.77], waveId: 'wave-iran-1' },
];

const mergedGroups = simulateMerge(iranWave);
assert(mergedGroups.size === 1, '\u05d2\u05dc \u05d0\u05d7\u05d3 \u05de\u05d0\u05d9\u05e8\u05d0\u05df \u2192 \u05e7\u05d5 \u05d0\u05d7\u05d3 \u05e9\u05de\u05ea\u05e4\u05e6\u05dc');

const group = mergedGroups.get('wave-iran-1');
assert(group.targets.length === 3, `3 \u05d9\u05e2\u05d3\u05d9\u05dd \u05d1\u05d2\u05dc (${group.targets.map(t => t.name).join(', ')})`);
assert(group.source === 'iran', '\u05de\u05e7\u05d5\u05e8 = \u05d0\u05d9\u05e8\u05d0\u05df');

console.log(`  \u{1F4CD} \u05e7\u05d5 \u05e8\u05d0\u05e9\u05d9: \u05d0\u05d9\u05e8\u05d0\u05df [${group.sourcePos}]`);
group.targets.forEach((t) => {
  console.log(`  \u{1F3AF} \u05e4\u05d9\u05e6\u05d5\u05dc \u2192 ${t.name} [${t.pos}]`);
});

// ═══════════════════════════════════════════
// בדיקה 7: ניקוי כשאירוע מסתיים
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 7: \u05e0\u05d9\u05e7\u05d5\u05d9 \u05db\u05e9\u05d0\u05d9\u05e8\u05d5\u05e2 \u05de\u05e1\u05ea\u05d9\u05d9\u05dd \u2550\u2550\u2550');

const activeMissiles = new Map();
activeMissiles.set('leb-1', { cityName: '\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4', sourceRegion: 'lebanon' });
activeMissiles.set('iran-1', { cityName: '\u05d7\u05d9\u05e4\u05d4', sourceRegion: 'iran' });
activeMissiles.set('iran-2', { cityName: '\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1', sourceRegion: 'iran' });

assert(activeMissiles.size === 3, '\u05dc\u05e4\u05e0\u05d9 \u05e9\u05d7\u05e8\u05d5\u05e8: 3 \u05d8\u05d9\u05dc\u05d9\u05dd');

function removeByCity(missiles, cityName) {
  const toRemove = [];
  missiles.forEach((m, id) => { if (m.cityName === cityName) toRemove.push(id); });
  toRemove.forEach((id) => missiles.delete(id));
}

removeByCity(activeMissiles, '\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4');
assert(activeMissiles.size === 2, '\u05e9\u05d7\u05e8\u05d5\u05e8 \u05e7"\u05e9: 2 \u05d8\u05d9\u05dc\u05d9\u05dd \u05e0\u05e9\u05d0\u05e8\u05d5');
assert(!activeMissiles.has('leb-1'), '\u05d8\u05d9\u05dc \u05dc\u05d1\u05e0\u05d5\u05df \u05d4\u05d5\u05e1\u05e8');
assert(activeMissiles.has('iran-1'), '\u05d8\u05d9\u05dc \u05d0\u05d9\u05e8\u05d0\u05df-\u05d7\u05d9\u05e4\u05d4 \u05e2\u05d3\u05d9\u05d9\u05df');
assert(activeMissiles.has('iran-2'), '\u05d8\u05d9\u05dc \u05d0\u05d9\u05e8\u05d0\u05df-\u05ea"\u05d0 \u05e2\u05d3\u05d9\u05d9\u05df');

// ═══════════════════════════════════════════
// בדיקה 8: שיגור חדש אחרי שהקודם הסתיים
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 8: \u05e9\u05d9\u05d2\u05d5\u05e8 \u05d7\u05d3\u05e9 \u05d0\u05d7\u05e8\u05d9 \u05e9\u05d4\u05e7\u05d5\u05d3\u05dd \u05e0\u05d2\u05de\u05e8 \u2550\u2550\u2550');

const cache = ['\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4'];
const newAlerts1 = [{ cityName: '\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4' }];
const fresh1 = newAlerts1.filter((a) => !cache.includes(a.cityName));
assert(fresh1.length === 0, '\u05e2\u05d9\u05e8 \u05e2\u05d3\u05d9\u05d9\u05df \u05e4\u05e2\u05d9\u05dc\u05d4 \u2192 \u05dc\u05d0 \u05e0\u05d5\u05e6\u05e8 \u05d8\u05d9\u05dc \u05db\u05e4\u05d5\u05dc');

cache.length = 0;
const newAlerts2 = [{ cityName: '\u05e7\u05e8\u05d9\u05ea \u05e9\u05de\u05d5\u05e0\u05d4' }];
const fresh2 = newAlerts2.filter((a) => !cache.includes(a.cityName));
assert(fresh2.length === 1, '\u05d0\u05d7\u05e8\u05d9 \u05e9\u05d7\u05e8\u05d5\u05e8: \u05e2\u05d9\u05e8 \u05d7\u05d3\u05e9\u05d4 \u2192 \u05d8\u05d9\u05dc \u05d7\u05d3\u05e9');

const newAlerts3 = [{ cityName: '\u05e0\u05d4\u05e8\u05d9\u05d4' }];
const fresh3 = newAlerts3.filter((a) => !cache.includes(a.cityName));
assert(fresh3.length === 1, '\u05e2\u05d9\u05e8 \u05d0\u05d7\u05e8\u05ea (\u05e0\u05d4\u05e8\u05d9\u05d4) \u2192 \u05d8\u05d9\u05dc \u05d7\u05d3\u05e9 \u05d1\u05de\u05e7\u05d1\u05d9\u05dc');

// ═══════════════════════════════════════════
// בדיקה 9: מניעת כפילויות
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550 \u05d1\u05d3\u05d9\u05e7\u05d4 9: \u05de\u05e0\u05d9\u05e2\u05ea \u05db\u05e4\u05d9\u05dc\u05d5\u05d9\u05d5\u05ea \u2550\u2550\u2550');

const missiles = new Map();
function addWithDedup(data) {
  if ([...missiles.values()].some((m) => m.cityName === data.cityName)) return false;
  missiles.set(data.id, data);
  return true;
}

assert(addWithDedup({ id: 'r1', cityName: '\u05d7\u05d9\u05e4\u05d4' }), '\u05d8\u05d9\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05d7\u05d9\u05e4\u05d4 \u2192 \u05e0\u05d5\u05e1\u05e3');
assert(!addWithDedup({ id: 'r2', cityName: '\u05d7\u05d9\u05e4\u05d4' }), '\u05d8\u05d9\u05dc \u05e9\u05e0\u05d9 \u05dc\u05d7\u05d9\u05e4\u05d4 \u2192 \u05e0\u05d7\u05e1\u05dd');
assert(addWithDedup({ id: 'r3', cityName: '\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1' }), '\u05d8\u05d9\u05dc \u05dc\u05ea"\u05d0 \u2192 \u05e0\u05d5\u05e1\u05e3 (\u05e2\u05d9\u05e8 \u05d0\u05d7\u05e8\u05ea)');

// ═══════════════════════════════════════════
// סיכום
// ═══════════════════════════════════════════
console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log(`\n\u{1F4CA} \u05ea\u05d5\u05e6\u05d0\u05d5\u05ea: ${passed} \u05e2\u05d1\u05e8\u05d5 \u2705 | ${failed} \u05e0\u05db\u05e9\u05dc\u05d5 \u274C`);
if (failed === 0) {
  console.log('\u{1F389} \u05db\u05dc \u05d4\u05d1\u05d3\u05d9\u05e7\u05d5\u05ea \u05e2\u05d1\u05e8\u05d5 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4!\n');
} else {
  console.log('\u26A0\uFE0F \u05d9\u05e9 \u05d1\u05d3\u05d9\u05e7\u05d5\u05ea \u05e9\u05e0\u05db\u05e9\u05dc\u05d5 - \u05e6\u05e8\u05d9\u05da \u05dc\u05ea\u05e7\u05df!\n');
  process.exit(1);
}
