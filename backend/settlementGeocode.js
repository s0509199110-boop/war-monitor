/**
 * גיאוקוד יישובים בישראל כשהם לא נמצאים ב-citiesMap / GeoJSON מקומי.
 * מקור 1: Open-Meteo Geocoding (ללא מפתח, מתאים לשימוש קל).
 * מקור 2 (אופציונלי): Nominatim — דורש User-Agent תקני וקצב נמוך (מדיניות OSM).
 *
 * כיבוי: OREF_GEOCODE_FALLBACK=0
 * Nominatim: OREF_GEOCODE_NOMINATIM=1
 */
const axios = require('axios');

const OPEN_METEO_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const memoryCache = new Map();
let lastNominatimAt = 0;

function isGeocodeFallbackEnabled() {
  const v = process.env.OREF_GEOCODE_FALLBACK;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

function isNominatimEnabled() {
  const v = process.env.OREF_GEOCODE_NOMINATIM;
  return v === '1' || v === 'true' || v === 'on';
}

async function openMeteoSearch(name, isPlausibleTarget) {
  const url = `${OPEN_METEO_GEO}?${new URLSearchParams({
    name,
    count: '10',
    country: 'IL',
    language: 'he',
    format: 'json',
  })}`;
  const r = await axios.get(url, { timeout: 9000, validateStatus: () => true });
  if (r.status !== 200 || !r.data) return null;
  const results = r.data.results;
  if (!Array.isArray(results)) return null;
  let best = null;
  let bestPop = -1;
  for (const row of results) {
    const lat = row.latitude;
    const lng = row.longitude;
    if (!isPlausibleTarget(lng, lat)) continue;
    if (!best) best = { lat, lng, source: 'open-meteo' };
    const pop = Number(row.population) || 0;
    if (pop > bestPop) {
      bestPop = pop;
      best = { lat, lng, source: 'open-meteo' };
    }
  }
  return best;
}

async function nominatimSearch(name, isPlausibleTarget) {
  const gap = 1150 - (Date.now() - lastNominatimAt);
  if (gap > 0) await new Promise((res) => setTimeout(res, gap));
  lastNominatimAt = Date.now();
  const url = `${NOMINATIM}?${new URLSearchParams({
    q: `${name}, Israel`,
    format: 'json',
    limit: '5',
    'accept-language': 'he,en',
  })}`;
  const r = await axios.get(url, {
    timeout: 14000,
    headers: {
      'User-Agent':
        process.env.OREF_NOMINATIM_UA ||
        'WarMonitorOref/1.0 (local settlement lookup; +https://github.com/)',
    },
    validateStatus: () => true,
  });
  if (r.status !== 200 || !Array.isArray(r.data)) return null;
  for (const row of r.data) {
    const lat = parseFloat(row.lat);
    const lng = parseFloat(row.lon);
    if (isPlausibleTarget(lng, lat)) return { lat, lng, source: 'nominatim' };
  }
  return null;
}

/**
 * @param {string} cityName
 * @param {(lng:number,lat:number)=>boolean} isPlausibleTarget
 * @param {(s:string)=>string} normalizeHebrewSettlementName
 */
async function resolveSettlementExternal(cityName, isPlausibleTarget, normalizeHebrewSettlementName) {
  const raw = String(cityName || '').trim();
  if (!raw) return null;
  const key = normalizeHebrewSettlementName(raw).toLowerCase();
  if (!key || key.length < 2) return null;
  if (memoryCache.has(key)) return memoryCache.get(key);

  let loc = null;
  try {
    loc = await openMeteoSearch(raw, isPlausibleTarget);
  } catch {
    loc = null;
  }
  if (!loc && isNominatimEnabled()) {
    try {
      loc = await nominatimSearch(raw, isPlausibleTarget);
    } catch {
      loc = null;
    }
  }

  memoryCache.set(key, loc);
  return loc;
}

/**
 * מעדכן alert.coordinates [lng,lat] ליישובים שסומנו ב-usedSettlementFallback.
 */
async function enrichOrefAlertsGeocode(alerts, { normalizeHebrewSettlementName, isPlausibleTarget }) {
  if (!isGeocodeFallbackEnabled() || !Array.isArray(alerts)) return;

  const groups = new Map();
  for (const a of alerts) {
    if (!a || !a.cityName) continue;
    const missingCoords =
      !Array.isArray(a.coordinates) ||
      a.coordinates.length < 2 ||
      !Number.isFinite(Number(a.coordinates[0])) ||
      !Number.isFinite(Number(a.coordinates[1]));
    if (!a.usedSettlementFallback && !missingCoords) continue;
    const k = normalizeHebrewSettlementName(String(a.cityName)).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }

  for (const [, list] of groups) {
    const sample = list[0];
    const loc = await resolveSettlementExternal(sample.cityName, isPlausibleTarget, normalizeHebrewSettlementName);
    if (!loc) continue;
    for (const a of list) {
      a.coordinates = [loc.lng, loc.lat];
      a.geocodeSource = loc.source;
    }
  }
}

module.exports = {
  enrichOrefAlertsGeocode,
  resolveSettlementExternal,
  isGeocodeFallbackEnabled,
};
