/**
 * בדיקות יחידה למנוע חקירת מוצא שיגור (ללא קריאת OpenAI).
 * מטרות: נירמול ציר, פענוח JSON מהמודל, התאמת שורה לטיל לפי i / עיר / סדר.
 */
import assert from 'assert';
import module from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const req = module.createRequire(import.meta.url);
const engine = req(path.join(root, 'backend', 'launchAxisAiEngine.js'));

const { normalizeLaunchAxis, parseLaunchAxisAiResponseContent } = engine;

function testNormalize() {
  assert.strictEqual(normalizeLaunchAxis('iran'), 'iran');
  assert.strictEqual(normalizeLaunchAxis('IRGC'), 'iran');
  assert.strictEqual(normalizeLaunchAxis('tehran'), 'iran');
  assert.strictEqual(normalizeLaunchAxis('Hezbollah'), 'lebanon');
  assert.strictEqual(normalizeLaunchAxis('houthis'), 'yemen');
  assert.strictEqual(normalizeLaunchAxis(''), 'unknown');
  assert.strictEqual(normalizeLaunchAxis('unknown'), 'unknown');
}

function testParseResponse() {
  const raw1 = '{"items":[{"i":0,"launchAxis":"iran","confidence":0.85,"evidence":["מאיראן"]}]}';
  let items = parseLaunchAxisAiResponseContent(raw1);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].launchAxis, 'iran');

  const raw2 = '```json\n{"items":[{"i":1,"launchAxis":"lebanon","confidence":0.7,"evidence":[]}]}\n```';
  items = parseLaunchAxisAiResponseContent(raw2);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(Number(items[0].i), 1);

  const raw3 = 'Here is JSON:\n{"items":[{"i":0,"launchAxis":"yemen","confidence":0.9,"evidence":["houthi"]}]}\ntrailing';
  items = parseLaunchAxisAiResponseContent(raw3);
  assert.strictEqual(items.length, 1);
}

/** שחזור לוגיקת resolve + inference (כפול קצר לרגרסיה) */
function simulateMapFromItems(items, missiles) {
  const out = new Map();
  const normalizeCityKey = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const inferenceFromRowForMissile = (row, m) => {
    if (!row || !m?.id) return null;
    const axis = normalizeLaunchAxis(row.launchAxis);
    let conf = Math.max(0, Math.min(1, Number(row.confidence) || 0));
    const evidence = Array.isArray(row.evidence)
      ? row.evidence.map((e) => String(e).trim()).filter(Boolean).slice(0, 4)
      : [];
    const lockSuggested = row.lockSuggested === true;
    if (lockSuggested && conf >= 0.74) conf = Math.max(conf, 0.755);
    return { missileId: m.id, launchAxis: axis, confidence: conf, evidence, lockSuggested };
  };
  const resolveMissileForRow = (row, ord, msl) => {
    const idx = Number(row && row.i);
    if (Number.isFinite(idx) && idx >= 0 && idx < msl.length) return msl[idx];
    const want = normalizeCityKey(row && (row.city || row.cityName || row.targetCity));
    if (want) {
      const hit = msl.find((mm) => normalizeCityKey(mm.cityName) === want);
      if (hit) return hit;
    }
    if (ord >= 0 && ord < msl.length) return msl[ord];
    return null;
  };
  const seen = new Set();
  for (let ord = 0; ord < items.length; ord++) {
    const row = items[ord];
    const m = resolveMissileForRow(row, ord, missiles);
    const inf = inferenceFromRowForMissile(row, m);
    if (!inf || inf.launchAxis === 'unknown') continue;
    if (seen.has(inf.missileId)) continue;
    seen.add(inf.missileId);
    out.set(inf.missileId, inf);
  }
  for (const m of missiles) {
    if (out.has(m.id)) continue;
    const want = normalizeCityKey(m.cityName);
    if (!want) continue;
    for (const row of items) {
      const c = normalizeCityKey(row.city || row.cityName || row.targetCity);
      if (c !== want) continue;
      const inf = inferenceFromRowForMissile(row, m);
      if (!inf || inf.launchAxis === 'unknown') continue;
      out.set(inf.missileId, inf);
      break;
    }
  }
  return out;
}

function testResolveMissileMapping() {
  const missiles = [
    { id: 'a', cityName: 'חיפה', sourceRegion: 'lebanon' },
    { id: 'b', cityName: 'באר שבע', sourceRegion: 'gaza' },
  ];
  let items = [{ i: 0, launchAxis: 'iran', confidence: 0.9, evidence: ['x'] }];
  let map = simulateMapFromItems(items, missiles);
  assert.strictEqual(map.get('a').launchAxis, 'iran');

  items = [{ launchAxis: 'yemen', confidence: 0.88, evidence: ['h'], city: 'באר שבע' }];
  map = simulateMapFromItems(items, missiles);
  assert.strictEqual(map.get('b').launchAxis, 'yemen');

  items = [{ launchAxis: 'iraq', confidence: 0.8, evidence: ['q'] }];
  map = simulateMapFromItems(items, missiles);
  assert.strictEqual(map.get('a').launchAxis, 'iraq');
}

testNormalize();
testParseResponse();
testResolveMissileMapping();

console.log('OK  מנוע Launch-Axis-AI (נירמול, פענוח JSON, שיוך טיל)');
