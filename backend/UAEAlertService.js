const { getCityCoordinates } = require('./citiesMap');

const UAE_OFFICIAL_SOURCES = [
  {
    id: 'ncema',
    nameHe: 'NCEMA',
    kind: 'official',
    priority: 100,
    notes: 'המקור הרשמי להתראות הלאומיות של איחוד האמירויות',
  },
  {
    id: 'mod-uae',
    nameHe: 'משרד ההגנה של איחוד האמירויות',
    kind: 'official',
    priority: 96,
  },
  {
    id: 'moi-uae',
    nameHe: 'משרד הפנים של איחוד האמירויות',
    kind: 'official',
    priority: 92,
  },
];

const UAE_CORROBORATED_SOURCES = [
  {
    id: 'gulf-news',
    nameHe: 'Gulf News',
    kind: 'news',
    priority: 80,
  },
  {
    id: 'the-national',
    nameHe: 'The National',
    kind: 'news',
    priority: 78,
  },
  {
    id: 'khaleej-times',
    nameHe: 'Khaleej Times',
    kind: 'news',
    priority: 76,
  },
  {
    id: 'arn',
    nameHe: 'ARN',
    kind: 'news',
    priority: 72,
  },
  {
    id: 'wam',
    nameHe: 'WAM',
    kind: 'news',
    priority: 70,
  },
];

const UAE_TARGET_CITY_ALIASES = {
  'abu dhabi': 'אבו דאבי',
  abudhabi: 'אבו דאבי',
  dubai: 'דובאי',
  sharjah: 'שארג׳ה',
  ajman: 'עג׳מאן',
  'umm al quwain': 'אום אל קייווין',
  ummalquwain: 'אום אל קייווין',
  'ras al khaimah': 'ראס אל ח׳יימה',
  rasalkhaimah: 'ראס אל ח׳יימה',
  fujairah: 'פוג׳יירה',
  'al ain': 'אל עין',
  alain: 'אל עין',
  'abu dabi': 'אבו דאבי',
  'ras al-khaimah': 'ראס אל ח׳יימה',
  'umm al quwayn': 'אום אל קייווין',
  'אבו דאבי': 'אבו דאבי',
  'דובאי': 'דובאי',
  'שארג׳ה': 'שארג׳ה',
  "שארג'ה": 'שארג׳ה',
  'עג׳מאן': 'עג׳מאן',
  'עג׳מן': 'עג׳מאן',
  'אום אל קייווין': 'אום אל קייווין',
  'ראס אל ח׳יימה': 'ראס אל ח׳יימה',
  'ראס אל חיימה': 'ראס אל ח׳יימה',
  'פוג׳יירה': 'פוג׳יירה',
  'פוגירה': 'פוג׳יירה',
  'אל עין': 'אל עין',
};

const UAE_CANONICAL_CITY_LABELS = {
  'abu dhabi': '\u05d0\u05d1\u05d5 \u05d3\u05d0\u05d1\u05d9',
  dubai: '\u05d3\u05d5\u05d1\u05d0\u05d9',
  sharjah: '\u05e9\u05d0\u05e8\u05d2\u05d4',
  ajman: '\u05e2\u05d2\u05de\u05d0\u05df',
  'umm al quwain': '\u05d0\u05d5\u05dd \u05d0\u05dc \u05e7\u05d9\u05d5\u05d9\u05d9\u05df',
  'ras al khaimah': '\u05e8\u05d0\u05e1 \u05d0\u05dc \u05d7\u05d9\u05d9\u05de\u05d4',
  fujairah: '\u05e4\u05d5\u05d2\u05d9\u05d9\u05e8\u05d4',
  'al ain': '\u05d0\u05dc \u05e2\u05d9\u05df',
};

function toCanonicalUaeCity(alias) {
  const a = normalizeText(alias);
  if (a.includes('abu dhabi') || a.includes('\u05d0\u05d1\u05d5')) return 'abu dhabi';
  if (a.includes('dubai') || a.includes('\u05d3\u05d5\u05d1')) return 'dubai';
  if (a.includes('sharjah') || a.includes('\u05e9\u05d0\u05e8\u05d2')) return 'sharjah';
  if (a.includes('ajman') || a.includes('\u05e2\u05d2')) return 'ajman';
  if (a.includes('umm al quwain') || a.includes('ummalquwain')) return 'umm al quwain';
  if (a.includes('ras al khaimah') || a.includes('rasalkhaimah')) return 'ras al khaimah';
  if (a.includes('fujairah') || a.includes('\u05e4\u05d5\u05d2')) return 'fujairah';
  if (a.includes('al ain') || a.includes('alain') || a.includes('\u05e2\u05d9\u05df')) return 'al ain';
  return null;
}

function extractTargetCityKeys(text) {
  const blob = normalizeText(text);
  if (!blob) return [];
  const canonicalMatches = [];
  Object.keys(UAE_TARGET_CITY_ALIASES).forEach((alias) => {
    if (blob.includes(normalizeText(alias))) {
      const canonical = toCanonicalUaeCity(alias);
      if (canonical && !canonicalMatches.includes(canonical)) canonicalMatches.push(canonical);
    }
  });
  if (canonicalMatches.length === 0 && UAE_NATIONAL_KEYWORDS.some((term) => blob.includes(normalizeText(term)))) {
    canonicalMatches.push('abu dhabi');
  }
  return canonicalMatches;
}

const AXIS_KEYWORDS = {
  iran: ['iran', 'iranian', 'איראן', 'איראני'],
  iraq: ['iraq', 'iraqi', 'עיראק', 'עיראקי'],
  yemen: ['yemen', 'houthi', 'houti', 'תימן', 'חות׳י', 'חותי'],
};

const UAV_KEYWORDS = ['uav', 'drone', 'drones', 'כטב', 'כלי טיס', 'חדירת כלי טיס'];
const MISSILE_KEYWORDS = ['missile', 'missiles', 'rocket', 'rockets', 'טיל', 'טילים', 'רקטה', 'רקטות'];
const UAE_NATIONAL_KEYWORDS = ['uae', 'emirates', 'united arab emirates', 'איחוד האמירויות', 'האמירויות'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectThreatType(text) {
  const blob = normalizeText(text);
  if (!blob) return 'missile';
  if (UAV_KEYWORDS.some((term) => blob.includes(term))) return 'uav';
  if (MISSILE_KEYWORDS.some((term) => blob.includes(term))) return 'missile';
  return 'missile';
}

function detectAxis(text) {
  const blob = normalizeText(text);
  if (!blob) return null;
  for (const [axis, words] of Object.entries(AXIS_KEYWORDS)) {
    if (words.some((term) => blob.includes(normalizeText(term)))) {
      return axis;
    }
  }
  return null;
}

function extractTargetCities(text) {
  return extractTargetCityKeys(text).map((canonical) => UAE_CANONICAL_CITY_LABELS[canonical] || canonical);
}

function inferConfidence(sourceKind, axis, cities) {
  if (sourceKind === 'official') return 'official';
  if (axis || (cities && cities.length > 0)) return 'corroborated';
  return 'estimated';
}

function normalizeUaeCandidate(raw, sourceMeta = {}) {
  const textBlob = [raw?.title, raw?.headline, raw?.summary, raw?.description, raw?.text]
    .filter(Boolean)
    .join(' | ');
  const targetCityKeys = extractTargetCityKeys(textBlob);
  const targetCities = targetCityKeys.map((canonical) => UAE_CANONICAL_CITY_LABELS[canonical] || canonical);
  const cityName = targetCities[0] || null;
  const cityCoords = targetCityKeys[0] ? getCityCoordinates(targetCityKeys[0]) : null;
  const sourceRegion = detectAxis(textBlob);
  const threatType = detectThreatType(textBlob);
  const sourceConfidence = inferConfidence(sourceMeta.kind, sourceRegion, targetCities);

  return {
    theater: 'uae',
    sourceKind: sourceMeta.kind || 'estimated',
    sourceName: sourceMeta.nameHe || sourceMeta.id || null,
    title: raw?.title || raw?.headline || 'התראת איחוד האמירויות',
    summary: raw?.summary || raw?.description || '',
    textBlob,
    targetCountry: 'uae',
    cityName,
    targetCities,
    coordinates: cityCoords ? [cityCoords.lng, cityCoords.lat] : null,
    targetPosition: cityCoords ? [cityCoords.lng, cityCoords.lat] : null,
    sourceRegion,
    threatType,
    sourceConfidence,
    publishedAt: raw?.publishedAt || raw?.timestamp || null,
  };
}

function getUaeSourceCatalog() {
  return {
    official: UAE_OFFICIAL_SOURCES.slice(),
    corroborated: UAE_CORROBORATED_SOURCES.slice(),
  };
}

module.exports = {
  UAE_OFFICIAL_SOURCES,
  UAE_CORROBORATED_SOURCES,
  UAE_TARGET_CITY_ALIASES,
  detectThreatType,
  detectAxis,
  extractTargetCities,
  normalizeUaeCandidate,
  getUaeSourceCatalog,
};

