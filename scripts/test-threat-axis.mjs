/**
 * בדיקות עשן ללוגיקת מסלול דרום (אילת) — ללא הרמת שרת.
 * הרצה: node scripts/test-threat-axis.mjs
 */
function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK ', msg);
}

// מפרטי גאומטריה ב-server.js: מסדרון עזה → יעד דרומי
function matchesGazaCorridorToSouth(sourceLng, sourceLat, targetLng, targetLat) {
  return (
    sourceLng >= 33.5 &&
    sourceLng <= 35.35 &&
    sourceLat >= 30.45 &&
    sourceLat <= 32.35 &&
    targetLat >= 29.4 &&
    targetLat <= 33.85 &&
    targetLng > sourceLng - 2
  );
}

// יעד דרום (אילת) — לא לסווג אוטומטית ל"תימן" רק בגלל lat נמוך
function southIsraelCorridorTargetLngLat(targetLng, targetLat) {
  return targetLat < 31.2 && targetLng >= 34.4 && targetLng <= 35.95;
}

const gazaSrc = [34.35, 31.35];
const eilatTgt = [34.9482, 29.5581];
if (!matchesGazaCorridorToSouth(gazaSrc[0], gazaSrc[1], eilatTgt[0], eilatTgt[1])) {
  fail('מסלול עזה→אילת אמור להתאים למסדרון עזה');
}
ok('מסדרון עזה → אילת מזוהה כמסלול ממוצא עזה');

if (!southIsraelCorridorTargetLngLat(eilatTgt[0], eilatTgt[1])) {
  fail('אילת אמורה להיחשב כיעד דרום במסדרון ישראל');
}
ok('אילת בטווח יעד דרום (אין הסקת תימן לבד מ-lat)');
