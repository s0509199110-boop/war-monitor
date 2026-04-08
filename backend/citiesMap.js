// ==========================================
// citiesMap.js - מיפוי ערים לקואורדינטות
// City to Coordinates Mapping
// ==========================================

const fs = require('fs');
const path = require('path');

/**
 * כינויים / שמות באנגלית כפי שמופיעים לעיתים ב-API (לפני חיפוש במפה)
 */
const CITY_NAME_ALIASES = {
  hurfeish: 'חורפיש',
  matat: 'מטאת',
  safed: 'צפת',
  tiberias: 'טבריה',
  haifa: 'חיפה',
  acre: 'עכו',
  akko: 'עכו',
  nahariya: 'נהריה',
  nahariyya: 'נהריה',
  kiryatshmona: 'קריית שמונה',
  'kiryat shmona': 'קריית שמונה',
  'qiryat shmona': 'קריית שמונה',
  dubai: 'דובאי',
  'abu dhabi': 'אבו דאבי',
  abudhabi: 'אבו דאבי',
  sharjah: 'שארג׳ה',
  sharejah: 'שארג׳ה',
  ajman: 'עג׳מאן',
  metulla: 'מטולה',
  metula: 'מטולה',
  'umm al quwain': 'אום אל-קיווין',
  ummalquwain: 'אום אל-קיווין',
  'ras al khaimah': 'ראס אל-ח׳יימה',
  rasalkhaimah: 'ראס אל-ח׳יימה',
  fujairah: 'פוג׳יירה',
  alain: 'אל עין',
  'al ain': 'אל עין',
  'אבו דאבי': { lat: 24.4539, lng: 54.3773 },
  'אבו-דאבי': { lat: 24.4539, lng: 54.3773 },
  'דובאי': { lat: 25.2048, lng: 55.2708 },
  'שארג׳ה': { lat: 25.3463, lng: 55.4209 },
  'שארג\'ה': { lat: 25.3463, lng: 55.4209 },
  'עג׳מאן': { lat: 25.4052, lng: 55.5136 },
  'עג\'מאן': { lat: 25.4052, lng: 55.5136 },
  'אום אל-קיווין': { lat: 25.5647, lng: 55.5552 },
  'אום אל קיווין': { lat: 25.5647, lng: 55.5552 },
  'ראס אל-ח׳יימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל-חיימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל ח׳יימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל חיימה': { lat: 25.7895, lng: 55.9432 },
  'פוג׳יירה': { lat: 25.1288, lng: 56.3265 },
  'פוג\'יירה': { lat: 25.1288, lng: 56.3265 },
  'אל עין': { lat: 24.1302, lng: 55.8023 },
  נהרייה: 'נהריה',
  מתולה: 'מטולה',
};

/**
 * תיקוני איות שמופיעים לעיתים ב־JSON של פיקוד העורף או בהיסטוריה.
 * יש לשמר התאמה עם OREF_COMMON_SPELLING_FIXES_CLIENT ב־monitor.html.
 */
const OREF_COMMON_SPELLING_FIXES = {
  נהרייה: 'נהריה',
  מתולה: 'מטולה',
};

/** התאמות איות נפוצות מפיקוד העורף / ממשקים — יישור לשמות במפה המקומית */
function normalizeHebrewSettlementName(name) {
  let s = String(name).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  s = s.replace(/[\u0591-\u05C7]/g, '');
  s = s.replace(/[\u200f\u200e\u00a0]/g, '');
  s = s.replace(/["׳״`]/g, "'");
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const parts = s.split(/\s+/).map(function (p) {
    return p === 'קרית' ? 'קריית' : p;
  });
  s = parts.join(' ');
  s = s.replace(/^קרית(?=\s)/, 'קריית');
  if (OREF_COMMON_SPELLING_FIXES[s]) s = OREF_COMMON_SPELLING_FIXES[s];
  return s.trim();
}

const CITIES_MAP = {
  // תל אביב והמרכז
  'תל אביב': { lat: 32.0853, lng: 34.7818 },
  'תל אביב יפו': { lat: 32.0853, lng: 34.7818 },
  'רמת גן': { lat: 32.0684, lng: 34.8245 },
  'גבעתיים': { lat: 32.0611, lng: 34.8100 },
  'חולון': { lat: 32.0153, lng: 34.7874 },
  'בת ים': { lat: 32.0183, lng: 34.7540 },
  'ראשון לציון': { lat: 31.9591, lng: 34.8020 },
  'רחובות': { lat: 31.8928, lng: 34.8113 },
  'נס ציונה': { lat: 31.9271, lng: 34.8014 },
  'מודיעין': { lat: 31.8981, lng: 35.0104 },
  'מודיעין עילית': { lat: 31.9286, lng: 35.0359 },
  'לוד': { lat: 31.9468, lng: 34.8893 },
  'רמלה': { lat: 31.9279, lng: 34.8635 },
  
  // ירושלים
  'ירושלים': { lat: 31.7683, lng: 35.2137 },
  
  // חיפה והצפון
  'חיפה': { lat: 32.7940, lng: 34.9896 },
  'קריית אתא': { lat: 32.8050, lng: 35.1160 },
  'קריית ביאליק': { lat: 32.8191, lng: 35.0886 },
  'קריית מוצקין': { lat: 32.8395, lng: 35.0860 },
  'קריית ים': { lat: 32.8500, lng: 35.0620 },
  'קריית שמונה': { lat: 33.2079, lng: 35.5702 },
  'קרית שמונה': { lat: 33.2079, lng: 35.5702 },
  'נהריה': { lat: 33.0114, lng: 35.0986 },
  'שמרת': { lat: 32.9805, lng: 35.1296 },
  'שלומי': { lat: 33.0726, lng: 35.1445 },
  'מצובה': { lat: 33.0411, lng: 35.1098 },
  'עבדון': { lat: 33.0402, lng: 35.1564 },
  'אילון': { lat: 33.0638, lng: 35.2194 },
  'חניתה': { lat: 33.0452, lng: 35.1823 },
  'יערה': { lat: 33.0662, lng: 35.1697 },
  'גשר הזיו': { lat: 33.0406, lng: 35.1041 },
  'לימן': { lat: 33.0323, lng: 35.1113 },
  'חוף אכזיב': { lat: 33.0499, lng: 35.1024 },
  'שבי ציון': { lat: 32.9834, lng: 35.0947 },
  'נתיב השיירה': { lat: 32.9957, lng: 35.1232 },
  'נס עמים': { lat: 32.9827, lng: 35.1079 },
  'סער': { lat: 33.0262, lng: 35.1129 },
  'נווה זיו': { lat: 33.0157, lng: 35.1806 },
  'נווה אטי"ב': { lat: 33.262019, lng: 35.740576 },
  'נווה אטיב': { lat: 33.262019, lng: 35.740576 },
  'מזרעה': { lat: 32.9589, lng: 35.0975 },
  'עכו': { lat: 32.9282, lng: 35.0755 },
  'צפת': { lat: 32.9646, lng: 35.4960 },
  'טבריה': { lat: 32.7959, lng: 35.5300 },
  'עפולה': { lat: 32.6076, lng: 35.2891 },
  'נצרת': { lat: 32.6996, lng: 35.3035 },
  'נצרת עילית': { lat: 32.7192, lng: 35.3258 },
  
  // הדרום
  'באר שבע': { lat: 31.2518, lng: 34.7913 },
  'אשדוד': { lat: 31.8015, lng: 34.6435 },
  'אשקלון': { lat: 31.6658, lng: 34.5665 },
  'שדרות': { lat: 31.5265, lng: 34.5968 },
  'אילת': { lat: 29.5581, lng: 34.9482 },
  'אופקים': { lat: 31.3142, lng: 34.6206 },
  'נתיבות': { lat: 31.4228, lng: 34.5946 },
  'רהט': { lat: 31.3959, lng: 34.7560 },
  'אבו קרינאת': { lat: 31.1012, lng: 34.9518 },
  'אבו קורינאת': { lat: 31.1012, lng: 34.9518 },
  'אבו קורינת': { lat: 31.1012, lng: 34.9518 },
  'אבו תלול': { lat: 31.1423, lng: 34.9142 },
  'אבו טלול': { lat: 31.1423, lng: 34.9142 },
  'אום בטין': { lat: 31.2749, lng: 34.8842 },
  'אל סייד': { lat: 31.2844, lng: 34.9161 },
  'א-סייד': { lat: 31.2844, lng: 34.9161 },
  'ואדי אל נעם דרום': { lat: 31.1583, lng: 34.8222 },
  'ואדי אל-נעם דרום': { lat: 31.1583, lng: 34.8222 },
  'ואדי אל נעם': { lat: 31.1583, lng: 34.8222 },
  'ואדי אל-נעם': { lat: 31.1583, lng: 34.8222 },
  'קסר א-סר': { lat: 31.0763, lng: 34.9736 },
  'קסר א-סר': { lat: 31.0763, lng: 34.9736 },
  'קסר א-סיר': { lat: 31.0763, lng: 34.9736 },
  'כסייפה': { lat: 31.2453, lng: 35.0928 },
  'קסייפה': { lat: 31.2453, lng: 35.0928 },
  'סעווה': { lat: 31.2613, lng: 34.9755 },
  'מולדה': { lat: 31.2613, lng: 34.9755 },
  'אל פורעה': { lat: 31.2678, lng: 35.0822 },
  'אל-פורעה': { lat: 31.2678, lng: 35.0822 },
  
  // גליל
  'כרמיאל': { lat: 32.9141, lng: 35.2962 },
  'מעלות תרשיחא': { lat: 33.0169, lng: 35.2839 },
  'בית שאן': { lat: 32.4971, lng: 35.5004 },
  // צפון / גבול לבנון (חסרים כאן גרמו לברירת מחדל ירושלים = מסלול "לאיראן" ופגיעה בדרום)
  'חורפיש': { lat: 33.0181, lng: 35.3501 },
  'מטאת': { lat: 33.0425, lng: 35.4567 },
  'מטולה': { lat: 33.2778, lng: 35.5833 },
  'גוש חלב': { lat: 33.0244, lng: 35.4472 },
  'ג\'יש': { lat: 33.0244, lng: 35.4472 },
  'פקיעין': { lat: 33.0267, lng: 35.3264 },
  'עמיר': { lat: 33.0897, lng: 35.2347 },
  'ירכא': { lat: 32.9531, lng: 35.1889 },
  'בית הלל': { lat: 33.2186, lng: 35.6061 },
  'דפנה': { lat: 33.2418, lng: 35.6391 },
  'הגושרים': { lat: 33.2215, lng: 35.6215 },
  'שאר ישוב': { lat: 33.2257, lng: 35.6481 },
  'כפר גלעדי': { lat: 33.2330, lng: 35.5747 },
  'תל חי': { lat: 33.2358, lng: 35.5795 },
  'מעיין ברוך': { lat: 33.2398, lng: 35.6090 },
  'מנרה': { lat: 33.2456, lng: 35.5448 },
  'ע\'ג\'ר': { lat: 33.2749, lng: 35.6234 },
  'ע׳ג׳ר': { lat: 33.2749, lng: 35.6234 },
  'דובב': { lat: 33.0486, lng: 35.3647 },
  'זרעית': { lat: 33.0983, lng: 35.2847 },
  'שתולה': { lat: 33.0858, lng: 35.3158 },
  'תרשיחא': { lat: 33.0169, lng: 35.2839 },
  'מגדל העמק': { lat: 32.6776, lng: 35.2405 },
  'Hurfeish': { lat: 33.0181, lng: 35.3501 },
  'Matat': { lat: 33.0425, lng: 35.4567 },
  'Metula': { lat: 33.2778, lng: 35.5833 },
  
  // יהודה ושומרון
  'מודיעין עילית': { lat: 31.9286, lng: 35.0359 },
  'אריאל': { lat: 32.1054, lng: 35.1712 },
  'ביתר עילית': { lat: 31.7018, lng: 35.1215 },
  'מעלה אדומים': { lat: 31.7767, lng: 35.2982 }
};

/** מאגר יישובים (ערים, מועצות, קיבוצים וכו׳) — GeoJSON נקודות, עדיפות אחרי CITIES_MAP */
const LOCALITIES = Object.create(null);
const UAE_CITY_COORDINATES = {
  'אבו דאבי': { lat: 24.4539, lng: 54.3773 },
  'אבו-דאבי': { lat: 24.4539, lng: 54.3773 },
  'דובאי': { lat: 25.2048, lng: 55.2708 },
  'שארג׳ה': { lat: 25.3463, lng: 55.4209 },
  "שארג'ה": { lat: 25.3463, lng: 55.4209 },
  'עג׳מאן': { lat: 25.4052, lng: 55.5136 },
  "עג'מאן": { lat: 25.4052, lng: 55.5136 },
  'אום אל-קיווין': { lat: 25.5647, lng: 55.5552 },
  'אום אל קיווין': { lat: 25.5647, lng: 55.5552 },
  'ראס אל-ח׳יימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל-חיימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל ח׳יימה': { lat: 25.7895, lng: 55.9432 },
  'ראס אל חיימה': { lat: 25.7895, lng: 55.9432 },
  'פוג׳יירה': { lat: 25.1288, lng: 56.3265 },
  "פוג'יירה": { lat: 25.1288, lng: 56.3265 },
  'אל עין': { lat: 24.1302, lng: 55.8023 }
};

function loadIsraelLocalitiesGeoJson() {
  try {
    const p = path.join(__dirname, 'data', 'israel-localities.geojson');
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const feats = raw.features || [];
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const n = f && f.properties && f.properties.name;
      if (!n || typeof n !== 'string') continue;
      const c = f.geometry && f.geometry.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      const lng = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const coords = { lat, lng };
      const trimmed = n.trim();
      if (trimmed && !LOCALITIES[trimmed]) LOCALITIES[trimmed] = coords;
      const norm = normalizeHebrewSettlementName(trimmed);
      if (norm && norm !== trimmed && !LOCALITIES[norm]) LOCALITIES[norm] = coords;
    }
  } catch (e) {
    console.warn('[citiesMap] israel-localities.geojson:', e && e.message);
  }
}
loadIsraelLocalitiesGeoJson();

const COORD_ROUND = 10000;
function coordSig(lat, lng) {
  const la = Math.round(Number(lat) * COORD_ROUND) / COORD_ROUND;
  const ln = Math.round(Number(lng) * COORD_ROUND) / COORD_ROUND;
  return `${la},${ln}`;
}

function buildCanonicalCoordIndex() {
  const m = new Map();
  function add(coords, label) {
    if (!coords || !label || typeof label !== 'string') return;
    const lat = Number(coords.lat);
    const lng = Number(coords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const sig = coordSig(lat, lng);
    if (!m.has(sig)) m.set(sig, label);
  }
  Object.keys(CITIES_MAP).forEach(function (k) {
    add(CITIES_MAP[k], k);
  });
  Object.keys(UAE_CITY_COORDINATES).forEach(function (k) {
    add(UAE_CITY_COORDINATES[k], k);
  });
  Object.keys(LOCALITIES).forEach(function (k) {
    add(LOCALITIES[k], k);
  });
  return m;
}

const COORD_TO_CANONICAL_NAME = buildCanonicalCoordIndex();

function canonicalLabelForCoords(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return COORD_TO_CANONICAL_NAME.get(coordSig(lat, lng)) || null;
}

function buildPartialMatchEntries() {
  const seen = Object.create(null);
  const out = [];
  function add(name, coords) {
    if (!name || seen[name]) return;
    seen[name] = true;
    out.push([name, coords]);
  }
  Object.keys(CITIES_MAP).forEach(function (k) {
    add(k, CITIES_MAP[k]);
  });
  Object.keys(LOCALITIES).forEach(function (k) {
    if (!CITIES_MAP[k]) add(k, LOCALITIES[k]);
  });
  out.sort(function (a, b) {
    return b[0].length - a[0].length;
  });
  return out;
}

const PARTIAL_MATCH_ENTRIES = buildPartialMatchEntries();

/**
 * מחזיר קואורדינטות לעיר
 * @param {string} cityName - שם העיר
 * @returns {Object|null} - {lat, lng} או null
 */
function getCityCoordinates(cityName) {
  if (!cityName) return null;

  const cleanName = normalizeHebrewSettlementName(String(cityName));
  if (!cleanName) return null;

  const asciiKey = cleanName
    .replace(/['"׳״`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (asciiKey && CITY_NAME_ALIASES[asciiKey]) {
    const via = CITY_NAME_ALIASES[asciiKey];
    if (via && typeof via === 'object' && Number.isFinite(via.lat) && Number.isFinite(via.lng)) {
      return via;
    }
    if (CITIES_MAP[via]) return CITIES_MAP[via];
    if (UAE_CITY_COORDINATES[via]) return UAE_CITY_COORDINATES[via];
  }

  if (CITIES_MAP[cleanName]) {
    return CITIES_MAP[cleanName];
  }

  if (UAE_CITY_COORDINATES[cleanName]) {
    return UAE_CITY_COORDINATES[cleanName];
  }

  if (cleanName.includes('אילת') && !cleanName.includes('אילות')) {
    return CITIES_MAP['אילת'];
  }

  const collapsed = cleanName.replace(/\s+/g, '');
  if (collapsed !== cleanName && CITIES_MAP[collapsed]) {
    return CITIES_MAP[collapsed];
  }
  if (collapsed !== cleanName && UAE_CITY_COORDINATES[collapsed]) {
    return UAE_CITY_COORDINATES[collapsed];
  }

  if (LOCALITIES[cleanName]) {
    return LOCALITIES[cleanName];
  }
  if (collapsed !== cleanName && LOCALITIES[collapsed]) {
    return LOCALITIES[collapsed];
  }

  const minLen = 3;
  for (let i = 0; i < PARTIAL_MATCH_ENTRIES.length; i++) {
    const name = PARTIAL_MATCH_ENTRIES[i][0];
    const coords = PARTIAL_MATCH_ENTRIES[i][1];
    if (name.length < minLen || cleanName.length < minLen) continue;
    if (cleanName.includes(name) || name.includes(cleanName)) {
      return coords;
    }
  }

  const parentName = cleanName.replace(/\s*[-–—]\s*.+$/, '').trim();
  if (parentName && parentName !== cleanName && parentName.length >= 2) {
    const viaParent = getCityCoordinates(parentName);
    if (viaParent) return viaParent;
  }

  return null;
}

/**
 * שם יישוב קנוני לפי מפת הרגילים + GeoJSON — תואם את הרשומה הראשונה לאותן קואורדינטות.
 */
function resolveCanonicalOrefSettlementName(name) {
  const n = normalizeHebrewSettlementName(String(name || '').trim());
  if (!n) return '';
  const c = getCityCoordinates(n);
  if (!c) return n;
  const lbl = canonicalLabelForCoords(c.lat, c.lng);
  return lbl || n;
}

/** מפתח יציב לאיחוד התראות / שחרורים כשהאיות זהה אך הריווח/גרש שונים */
function settlementMatchKey(name) {
  const n = normalizeHebrewSettlementName(String(name || '').trim());
  if (!n) return '';
  return n.replace(/["'`׳״]/g, '').replace(/\s+/g, '');
}

/**
 * לאחר geocode: השם שמוצג ומוזן ללקוח הוא השם הקנוני מהמפה (כמו בפיקוד העורף הרשמי).
 */
function finalizeOrefAlertSettlementName(alert) {
  if (!alert || typeof alert !== 'object' || !alert.cityName) return;
  const c = alert.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      const lbl = canonicalLabelForCoords(lat, lng);
      if (lbl) {
        alert.cityName = lbl;
        return;
      }
    }
  }
  const r = resolveCanonicalOrefSettlementName(String(alert.cityName));
  if (r) alert.cityName = r;
}

/**
 * ברירת מחדל: צפון המטרופולין (חיפה) — כך getSourcePosition נופל לענף לבנון ולא לאיראן
 * כששם יישוב לא נמצא במפה (מוצא/עוגן גיאומטרי בלבד — לא יעד פגיעה).
 */
function getDefaultCoordinates() {
  return { lat: 32.85, lng: 34.9856 };
}

/** יעד חלופי כשאין קואורדינטות תקינות — מרכז גוש דן (לא חיפה), כדי שלא יופיעו ״שיגורים״ ספורים לצפון */
function getDefaultTargetFallbackCoordinates() {
  return { lat: 32.0853, lng: 34.7818 };
}

module.exports = {
  CITIES_MAP,
  LOCALITIES,
  CITY_NAME_ALIASES,
  normalizeHebrewSettlementName,
  getCityCoordinates,
  getDefaultCoordinates,
  getDefaultTargetFallbackCoordinates,
  canonicalLabelForCoords,
  resolveCanonicalOrefSettlementName,
  settlementMatchKey,
  finalizeOrefAlertSettlementName,
};
