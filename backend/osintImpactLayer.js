/**
 * שכבת "פגיעות מדווחות" (OSINT)
 * - רק פגיעה/נפילה/נזק הקשורים לטיל/רקטה (לא יירוט; לא רעידת אדמה כפגיעה)
 * - חובה: 3 מקורות שונים, מתוכם לפחות 2 שאינם USGS (דיווחי טקסט)
 * - רק יישוב מזוהה במפה (ללא סימון אזור גס)
 */
const fs = require('fs');
const path = require('path');
const { CITIES_MAP, LOCALITIES, normalizeHebrewSettlementName } = require('./citiesMap');

const MUNITION_CONTEXT_RE =
  /טיל|רקט|רקטות|טילים|שיגור|שיגורים|מטח|מיסייל|כטב|כטב״ם|כטב"ם|מל"ט|מזל"ט|drone|uav|missile|rockets?\b|ballistic|airstrike|תקיפה\s*אווירית|ירי\s*רקטות|ירי\s*טילים|ירי\s*טיל|מירי\s*טילים|מירי\s*רקטות|iranian\s+rocket|רקטות\s+איראנ|ירי\s*איראנ|rocket\s+fire|missile\s+fire/i;

/** נפילה / פגיעה / פגיעה ישירה של טיל או רקטה */
const IMPACT_EXPLICIT_MUNITION_RE =
  /פגיעת\s*טיל|פגיעת\s*רקטה|פגיעה\s*ישירה|מקום\s*הנפילה|מקום\s*הפגיעה|מקום\s*נפילה|אזור\s*הנפילה|נפילת\s*טיל|נפילת\s*רקטה|נפילה\s+ב|נפילה\s+של|נפל\s*ב|נפלה\s*ב|נפלו\s*ב|טיל\s*נפל|טילים\s*שנפלו|רקטה\s*נפלה|רקטות\s*שנפלו|שרידי\s*טיל|שרידי\s*רקטה|כתוצאה\s*מנפילה|עקב\s*נפילה|עקב\s*נפילת|בעקבות\s*נפילת\s*טיל|התפוצצות\s+של\s*טיל|פיצוץ\s+של\s*רקטה|direct\s+hit|impact\s+site|crater|rocket\s+(?:hit|landed|strike)|missile\s+(?:hit|struck|landed)|struck\s+by\s+a\s+rocket|ballistic\s+missile\s+hit/i;

/** נזק מבני / רכוש יחד עם הקשר טיל בטקסט המלא (נבדק בנפרד) */
const IMPACT_DAMAGE_STRUCTURE_RE =
  /נזק\s*לרכוש|נזקים\s*לרכוש|נזק\s*נרחב|נזקים\s*ניכרים|נזק\s*כבד|נזק\s*בעקבות|מבנה\s*נפגע|בניין\s*נפגע|בתים\s*נפגעו|בית\s*נפגע|פגיעה\s+בעיר|פגיעה\s+ביישוב|פגיעה\s+במבנה|property\s+damage|damage\s+to\s+property|structural\s+damage|building\s+(?:hit|damaged)|struck\s+(?:a|the)\s+(?:building|house|home|school|hospital)/i;

/** נפגעים שמקושרים במפורש לירי/טיל/נפילה */
const IMPACT_CASUALTY_TIED_RE =
  /פצועים\s*מירי|נפצעו\s*מירי|פצועים\s*מטיל|נפצעו\s*מטיל|פצועים\s*מנפילה|נפצעו\s*מנפילה|נפגעו\s+מירי|נפגעו\s+מטיל|בעקבות\s*ירי\s*טילים|מירי\s*הטילים|מירי\s*רקטות|ילדים\s+נפצעו(?:\s+קל)?\s+ב(?:גלל|עקב)?\s*(?:טיל|רקט|ירי)|injured\s+(?:in|by|after)\s+(?:a\s+)?(?:rocket|missile|salvo|strike)|wounded\s+(?:in|by)\s+(?:a\s+)?(?:rocket|missile)|casualties\s+from\s+(?:rocket|missile)|after\s+(?:the\s+)?(?:rocket|missile)\s+(?:hit|attack|strike)|rocket\s+fire[^.]{0,80}injured|missile\s+[^.]{0,60}injured/i;

function hasMissileRelatedGroundImpact(fullBlob) {
  const impactBlob = blobForImpactMatch(fullBlob);
  if (IMPACT_EXPLICIT_MUNITION_RE.test(impactBlob)) return true;
  if (IMPACT_DAMAGE_STRUCTURE_RE.test(impactBlob) && MUNITION_CONTEXT_RE.test(fullBlob)) return true;
  if (IMPACT_CASUALTY_TIED_RE.test(impactBlob)) return true;
  const casualRe =
    /(?:נפגעו|נפצעו|פצועים|הרוגים|הרוג|חללים|חלל)\s*(?:\d+|שלושה|שניים|שני|ארבעה|חמישה|מספר)/;
  const m = casualRe.exec(impactBlob);
  if (m) {
    const idx = m.index;
    const win = fullBlob.slice(Math.max(0, idx - 160), Math.min(fullBlob.length, idx + m[0].length + 160));
    if (/טיל|רקט|שיגור|מטח|מירי|ירי\s*טיל|ירי\s*רקט|missile|rocket|drone|ballistic|salvo|Iranian|איראנ/i.test(win)) {
      return true;
    }
  }
  return false;
}

const INTERCEPTION_FOCUS_RE =
  /יירוט\s*מוצלח|יורטו\s*(כל|את|הרקטות|הטילים|במלואם)|כל\s*הטילים\s*יורטו|כל\s*הרקטות\s*יורטו|יורטו\s*בשמיים|יירט\s*הכיפה|יירוט\s*מעל|מערכת\s*יירוט|intercepted\s*(?:over|in\s*the\s*air|successfully)|successful\s*interception|iron\s*dome|כיפת\s*ברזל|patriot\s*battery|arrow\s*defense/i;

let sortedSettlementNamesCache = null;

function getSortedSettlementNames() {
  if (sortedSettlementNamesCache) return sortedSettlementNamesCache;
  const set = new Set();
  for (const k of Object.keys(CITIES_MAP)) {
    if (k && String(k).trim().length >= 2) set.add(String(k).trim());
  }
  for (const k of Object.keys(LOCALITIES)) {
    if (k && String(k).trim().length >= 2) set.add(String(k).trim());
  }
  sortedSettlementNamesCache = [...set].sort((a, b) => b.length - a.length);
  return sortedSettlementNamesCache;
}

function articleTextBlob(a) {
  if (!a || typeof a !== 'object') return '';
  const tHe = a.titleHe != null ? String(a.titleHe) : '';
  const t = a.title != null ? String(a.title) : '';
  const d = a.description != null ? String(a.description) : '';
  return `${tHe} ${t} ${d}`.replace(/\s+/g, ' ').trim();
}

function blobForImpactMatch(blob) {
  return String(blob || '')
    .replace(/ללא\s+נפגעים/gi, ' ')
    .replace(/ללא\s+פצועים/gi, ' ')
    .replace(/ללא\s+נזק/gi, ' ')
    .replace(/בלי\s+נפגעים/gi, ' ')
    .replace(/no\s+casualties/gi, ' ')
    .replace(/no\s+injuries/gi, ' ')
    .replace(/no\s+one\s+was\s+injured/gi, ' ');
}

/** תו לפני שם יישוב בעברית — לרוב ב/ל/מ/כ (בבאר שבע, לחיפה, מירושלים) */
const HEBREW_LOC_PREFIX = /^[בלהמכשוהו]$/;

function forEachPhraseBoundaryIndex(text, phrase, fn) {
  const p = String(phrase);
  if (!p || !text) return;
  let idx = 0;
  const isWordChar = /[\u0590-\u05FFa-zA-Z0-9]/;
  const len = p.length;
  while ((idx = text.indexOf(p, idx)) !== -1) {
    const before = idx === 0 ? ' ' : text[idx - 1];
    const after = idx + len >= text.length ? ' ' : text[idx + len];
    if (!isWordChar.test(after)) {
      if (!isWordChar.test(before)) {
        fn(idx);
      } else if (HEBREW_LOC_PREFIX.test(before)) {
        const prev = idx >= 2 ? text[idx - 2] : ' ';
        if (idx === 1 || !isWordChar.test(prev)) {
          fn(idx);
        }
      }
    }
    idx += 1;
  }
}

function hasPhraseBoundary(text, phrase) {
  let found = false;
  forEachPhraseBoundaryIndex(text, phrase, () => {
    found = true;
  });
  return found;
}

/** שמות באנגלית נפוצים → שם עברי במפת היישובים */
const ENGLISH_SETTLEMENT_PATTERNS = [
  { re: /\bbeer[-\s]?sheva\b|\bbeersheba\b|\bbeer\s+sheba\b/i, he: 'באר שבע' },
  { re: /\bnegev\b.*\b(beer|beersheba|sheva)\b|\b(beer|beersheba|sheva)\b.*\bnegev\b|\bsouthern\s+israel\b.*\b(beer|beersheba|sheva)\b/i, he: 'באר שבע' },
  /** לפני תל אביב ולפני netanya — מונע בלבול עם קישורים/מטא שמכילים "netanya" */
  { re: /\btel[-\s]?sheva\b|\btel\s+sheva\b/i, he: 'תל שבע' },
  { re: /\btel[-\s]?aviv\b|\btel\s+aviv[-\s]?yafo\b/i, he: 'תל אביב' },
  { re: /\bwest\s+jerusalem\b|\bjerusalem\b|\bal[-\s]?quds\b/i, he: 'ירושלים' },
  { re: /\bhaifa\b|\bhefa\b/i, he: 'חיפה' },
  { re: /\bashdod\b/i, he: 'אשדוד' },
  { re: /\bashkelon\b|\bashqelon\b/i, he: 'אשקלון' },
  { re: /\bsderot\b/i, he: 'שדרות' },
  { re: /\bofakim\b|\bofaqim\b/i, he: 'אופקים' },
  { re: /\bnetivot\b/i, he: 'נתיבות' },
  { re: /\bramat\s+gan\b/i, he: 'רמת גן' },
  { re: /\bholon\b/i, he: 'חולון' },
  { re: /\bbat\s+yam\b/i, he: 'בת ים' },
  { re: /\bpetah\s*tikva\b|\bpetah\s*tikwa\b/i, he: 'פתח תקווה' },
  { re: /\bnetanya\b/i, he: 'נתניה' },
  { re: /\bherzliya\b|\bherzliyya\b/i, he: 'הרצליה' },
  { re: /\brehovot\b|\brehovoth\b/i, he: 'רחובות' },
  { re: /\bmodiin\b/i, he: 'מודיעין' },
  { re: /\bkiryat\s*shmona\b|\bqiryat\s*shemona\b/i, he: 'קריית שמונה' },
  { re: /\bnahariya\b|\bnahariyya\b/i, he: 'נהריה' },
  { re: /\bacre\b|\bako\b|\bakko\b/i, he: 'עכו' },
  { re: /\btiberias\b|\btverya\b/i, he: 'טבריה' },
  { re: /\bsafed\b|\bzefat\b|\btzfat\b/i, he: 'צפת' },
  { re: /\bkarmiel\b|\bkarmi\'?el\b/i, he: 'כרמיאל' },
  { re: /\bmetulla\b|\bmetula\b/i, he: 'מטולה' },
  { re: /\beilat\b|\belat\b/i, he: 'אילת' },
  { re: /\bdimona\b/i, he: 'דימונה' },
  { re: /\byeruham\b/i, he: 'ירוחם' },
  { re: /\bgedera\b/i, he: 'גדרה' },
  { re: /\bkiryat\s*gat\b/i, he: 'קריית גת' },
];

function normalizeHayForSettlements(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u05BE]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** כתובות URL מטעות לעיתים את זיהוי היישוב (למשל netanya בנתיב) */
function stripUrlsForGeo(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/\bwww\.[^\s<>"']+/gi, ' ');
}

/** איות צמוד נפוץ בכותרות — בלי רווח המחרוזת לא נכנסת לרשימת היישובים */
function expandKnownCollapsedSettlements(hay) {
  return String(hay || '')
    .replace(/תלשבע/g, 'תל שבע')
    .replace(/בארשבע/g, 'באר שבע');
}

/** עוגנים לפגיעה/נפילה — לבחירת היישוב הקרוב ביותר כשיש כמה התאמות בטקסט */
function impactAnchorPositions(hay) {
  const out = [];
  const re =
    /נפל[הו]?|נפילה|נפילת|פגיעה|פגיעת|נזק\s*ל|נפגע|נפגעו|נפצעו|פצועים|התפוצצות|טיל\s*נפל|רקטה\s*נפלה|direct\s+hit|rocket\s+hit|missile\s+hit|struck\s+by|impact\s+site|landed\s+in/gi;
  let m;
  while ((m = re.exec(hay)) !== null) {
    out.push({ i: m.index, end: m.index + m[0].length });
  }
  return out;
}

function minDistanceSpanToAnchors(spanStart, spanEnd, anchors) {
  let minD = Infinity;
  for (let a = 0; a < anchors.length; a++) {
    const ai = anchors[a].i;
    const ae = anchors[a].end;
    let d;
    if (ae <= spanStart) d = spanStart - ae;
    else if (ai >= spanEnd) d = ai - spanEnd;
    else d = 0;
    if (d < minD) minD = d;
  }
  return minD;
}

function bestMinDistanceForPhrase(hay, phrase, anchors) {
  let minD = Infinity;
  forEachPhraseBoundaryIndex(hay, phrase, (idx) => {
    const d = minDistanceSpanToAnchors(idx, idx + phrase.length, anchors);
    if (d < minD) minD = d;
  });
  return minD;
}

function pickBestHebrewSettlement(hay, sortedNames, anchors) {
  const candidates = [];
  for (let i = 0; i < sortedNames.length; i++) {
    const name = sortedNames[i];
    if (!name || name.length < 2) continue;
    if (!hay.includes(name)) continue;
    if (!hasPhraseBoundary(hay, name)) continue;
    candidates.push(name);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (anchors.length) {
    let best = candidates[0];
    let bestD = Infinity;
    for (let j = 0; j < candidates.length; j++) {
      const name = candidates[j];
      const d = bestMinDistanceForPhrase(hay, name, anchors);
      if (d < bestD || (d === bestD && name.length > best.length)) {
        bestD = d;
        best = name;
      }
    }
    return best;
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function findEnglishSettlementHebrewName(blob) {
  const b = String(blob || '');
  for (let i = 0; i < ENGLISH_SETTLEMENT_PATTERNS.length; i++) {
    const row = ENGLISH_SETTLEMENT_PATTERNS[i];
    if (row.re.test(b)) return row.he;
  }
  return null;
}

function resolveSettlementFromBlob(blob) {
  let hay = normalizeHayForSettlements(blob);
  hay = stripUrlsForGeo(hay);
  hay = expandKnownCollapsedSettlements(hay);
  hay = hay.replace(/\s+/g, ' ').trim();

  const sortedNames = getSortedSettlementNames();
  const anchors = impactAnchorPositions(hay);
  const he = pickBestHebrewSettlement(hay, sortedNames, anchors);
  if (he) return he;
  return findEnglishSettlementHebrewName(hay);
}

function pubTimeMs(a) {
  if (!a || a.pubDate == null) return 0;
  const d = a.pubDate instanceof Date ? a.pubDate : new Date(a.pubDate);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

function isInterceptionOnlyReport(blob) {
  if (!INTERCEPTION_FOCUS_RE.test(blob)) return false;
  return !hasMissileRelatedGroundImpact(blob);
}

function sourceFeedId(outletKey) {
  const raw = String(outletKey || '').trim();
  if (raw === 'usgs_seismic') return 'src_usgs_seismic';
  const k = raw.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  if (k.startsWith('telegram') || k.startsWith('tg_')) return `src_${k.replace(/^telegram_?/, 'tg_')}`;
  return `src_rss_${k || 'unknown'}`;
}

function munitionContextOk(blob, impactBlob) {
  if (MUNITION_CONTEXT_RE.test(blob)) return true;
  return /מירי\s*טילים|ירי\s*טילים|ירי\s*רקטות|מירי\s*רקטות|rocket\s+fire|missile\s+fire|iranian\s+rocket/i.test(impactBlob);
}

function distinctOutletCount(sources) {
  const set = new Set();
  for (let i = 0; i < (sources || []).length; i++) {
    const o = sources[i] && sources[i].outlet;
    if (o != null && String(o).trim()) set.add(String(o).trim());
  }
  return set.size;
}

/** מקורות דיווח טקסט (לא USGS) — חובה מינימום לצד שלושה מקורות כולל */
function distinctNonSeismicOutletCount(sources) {
  const set = new Set();
  for (let i = 0; i < (sources || []).length; i++) {
    const o = sources[i] && sources[i].outlet;
    if (o == null || !String(o).trim()) continue;
    if (String(o).trim() === 'usgs_seismic') continue;
    set.add(String(o).trim());
  }
  return set.size;
}

/**
 * בודק אם טקסט עומד בתנאי פגיעה (ללא אגרגציה)
 */
function textMatchesImpactSignal(blob) {
  if (!blob) return false;
  const impactBlob = blobForImpactMatch(blob);
  if (!hasMissileRelatedGroundImpact(blob)) return false;
  if (isInterceptionOnlyReport(blob)) return false;
  if (!munitionContextOk(blob, impactBlob)) return false;
  return true;
}

/**
 * מחזיר היט אחד או null: { locKey, displayName, lat, lng, locKind, outlet, link, title, pubMs, snippet }
 */
function hitFromText(blob, meta) {
  const outlet = String(meta.outlet || 'unknown');
  const link = String(meta.link || '');
  const title = String(meta.title || '').slice(0, 240);
  const pubMs = Number(meta.pubMs) || Date.now();
  const isIsraeliSource = !!meta.isIsraeliSource;
  const sourceLabel = String(meta.sourceLabel || outlet);

  if (!textMatchesImpactSignal(blob)) return null;

  const settlement = resolveSettlementFromBlob(blob);
  if (settlement) {
    const norm = normalizeHebrewSettlementName(settlement);
    const cityKey = norm || settlement;
    return {
      locKey: `city:${cityKey}`,
      displayName: cityKey,
      lat: null,
      lng: null,
      locKind: 'city',
      settlementRaw: settlement,
      norm,
      outlet,
      link,
      title,
      pubMs,
      snippet: title.slice(0, 160),
      isIsraeliSource,
      sourceLabel,
    };
  }

  return null;
}

function collectHitsFromNews(newsStore, opts) {
  const getReliableCityCoordinates = opts.getReliableCityCoordinates;
  const isPlausibleMapTarget = opts.isPlausibleMapTarget;
  const maxAgeMs = Math.max(60 * 60 * 1000, Number(opts.maxAgeMs) || 48 * 60 * 60 * 1000);
  const maxArticlesScan = Math.min(1200, Math.max(60, Number(opts.maxArticlesScan) || 500));
  const now = opts.now != null ? Number(opts.now) : Date.now();

  const articles = Array.isArray(newsStore.articles) ? newsStore.articles : [];
  const recent = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const t = pubTimeMs(a);
    if (!t || now - t > maxAgeMs) continue;
    recent.push(a);
  }
  recent.sort((x, y) => pubTimeMs(y) - pubTimeMs(x));
  const slice = recent.slice(0, maxArticlesScan);

  const hits = [];
  for (let i = 0; i < slice.length; i++) {
    const a = slice[i];
    const blob = articleTextBlob(a);
    const titleLine = (a.titleHe && String(a.titleHe).trim()) || (a.title && String(a.title).trim()) || 'כתבה';
    const h = hitFromText(blob, {
      outlet: String(a.source || ''),
      link: String(a.link || ''),
      title: titleLine,
      pubMs: pubTimeMs(a),
      isIsraeliSource: !!a.isIsraeliSource,
      sourceLabel: String(a.sourceLabel || a.source || ''),
    });
    if (!h) continue;
    if (h.locKind === 'city') {
      const coords =
        getReliableCityCoordinates(h.settlementRaw) ||
        (h.norm && h.norm !== h.settlementRaw ? getReliableCityCoordinates(h.norm) : null);
      if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) continue;
      if (!isPlausibleMapTarget(coords.lng, coords.lat)) continue;
      h.lat = coords.lat;
      h.lng = coords.lng;
      delete h.settlementRaw;
    }
    hits.push(h);
  }
  return hits;
}

/**
 * רעידות אדמה USGS באזור המפה — כמקור נוסף לאימות/הקשר בשכבת הפגיעות (src_usgs_seismic).
 * אם שדה place מזהה יישוב — ממוזג עם אותו locKey כמו כתבות.
 */
function collectHitsFromSeismic(seismicList, opts) {
  const getReliableCityCoordinates = opts.getReliableCityCoordinates;
  const isPlausibleMapTarget = opts.isPlausibleMapTarget;
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const maxAgeMs = Math.max(
    60 * 60 * 1000,
    Number.isFinite(Number(opts.seismicMaxAgeMs)) && Number(opts.seismicMaxAgeMs) > 0
      ? Number(opts.seismicMaxAgeMs)
      : 48 * 60 * 60 * 1000
  );
  const minMag = Number.isFinite(Number(opts.seismicMinMagnitude)) ? Number(opts.seismicMinMagnitude) : 2.4;

  const hits = [];
  const list = Array.isArray(seismicList) ? seismicList : [];
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (!ev || typeof ev !== 'object') continue;
    const lat = Number(ev.lat);
    const lng = Number(ev.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!isPlausibleMapTarget(lng, lat)) continue;
    const mag = Number(ev.magnitude);
    if (!Number.isFinite(mag) || mag < minMag) continue;
    const t = Number(ev.time);
    if (!Number.isFinite(t) || t <= 0 || now - t > maxAgeMs) continue;

    const place = String(ev.place || '').trim();
    const rawId = ev.id != null ? String(ev.id) : '';
    const link = /^https?:\/\//i.test(rawId)
      ? rawId
      : rawId
        ? `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(rawId)}`
        : 'https://earthquake.usgs.gov/earthquakes/map/';

    const settlement = place ? resolveSettlementFromBlob(place) : null;
    const norm = settlement ? normalizeHebrewSettlementName(settlement) : null;
    const cityKey = norm || settlement;

    let locKey;
    let displayName;
    let outLat = lat;
    let outLng = lng;
    let locKind;

    if (cityKey) {
      const coords =
        getReliableCityCoordinates(settlement) ||
        (norm && norm !== settlement ? getReliableCityCoordinates(norm) : null) ||
        getReliableCityCoordinates(cityKey);
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
        locKey = `city:${cityKey}`;
        displayName = cityKey;
        outLat = coords.lat;
        outLng = coords.lng;
        locKind = 'city';
      }
    }

    if (!locKey) continue;

    const title = `USGS M${mag.toFixed(1)} — ${place || 'אירוע סייסמי'}`.slice(0, 220);
    hits.push({
      locKey,
      displayName,
      lat: outLat,
      lng: outLng,
      locKind,
      outlet: 'usgs_seismic',
      link,
      title,
      pubMs: t,
      snippet: title.slice(0, 160),
      isIsraeliSource: false,
      sourceLabel: 'USGS',
    });
  }
  return hits;
}

function collectHitsFromTelegram(messages, opts) {
  const isPlausibleMapTarget = opts.isPlausibleMapTarget;
  const hits = [];
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m.text !== 'string') continue;
    const blob = String(m.text).replace(/\s+/g, ' ').trim();
    const h = hitFromText(blob, {
      outlet: String(m.outlet || 'telegram'),
      link: String(m.link || ''),
      title: blob.slice(0, 200),
      pubMs: Number.isFinite(Number(m.pubMs)) ? Number(m.pubMs) : now,
      isIsraeliSource: false,
      sourceLabel: String(m.sourceLabel || m.outlet || 'טלגרם'),
    });
    if (!h) continue;
    if (h.locKind === 'city') {
      const getReliableCityCoordinates = opts.getReliableCityCoordinates;
      const coords =
        getReliableCityCoordinates(h.settlementRaw) ||
        (h.norm && h.norm !== h.settlementRaw ? getReliableCityCoordinates(h.norm) : null);
      if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) continue;
      if (!isPlausibleMapTarget(coords.lng, coords.lat)) continue;
      h.lat = coords.lat;
      h.lng = coords.lng;
      delete h.settlementRaw;
    }
    hits.push(h);
  }
  return hits;
}

function sourceRowFromHit(h) {
  const outlet = h.outlet;
  return {
    outlet,
    source: outlet,
    sourceId: sourceFeedId(outlet),
    sourceLabel: h.sourceLabel || outlet,
    title: h.title,
    link: h.link,
    publishedAt: new Date(h.pubMs).toISOString(),
  };
}

function mergeHitIntoRecord(rec, h) {
  const row = sourceRowFromHit(h);
  const dup = rec.sources.some((s) => s.link && row.link && s.link === row.link && s.outlet === row.outlet);
  if (!dup) rec.sources.push(row);
  rec.lastEvidenceMs = Math.max(rec.lastEvidenceMs || 0, h.pubMs);
  if (h.pubMs >= (rec._latestTitleMs || 0)) {
    rec._latestTitleMs = h.pubMs;
    rec.snippet = h.snippet || rec.snippet;
  }
}

/**
 * מיזוג registry קיים + היטים חדשים, ניקוי TTL
 * @returns {Record<string, object>}
 */
function reconcileOsintImpactRegistry(prevRegistry, opts) {
  const getReliableCityCoordinates = opts.getReliableCityCoordinates;
  const isPlausibleMapTarget = opts.isPlausibleMapTarget;
  const newsStore = opts.newsStore;
  const telegramMessages = opts.telegramMessages;
  const seismicEvents = opts.seismicEvents;
  const now = Number(opts.now) || Date.now();
  const ttlMs = Math.max(60 * 60 * 1000, Number(opts.ttlMs) || 12 * 60 * 60 * 1000);

  const registry =
    prevRegistry && typeof prevRegistry === 'object' && !Array.isArray(prevRegistry)
      ? JSON.parse(JSON.stringify(prevRegistry))
      : {};

  for (const k of Object.keys(registry)) {
    const rec = registry[k];
    const last = Number(rec.lastEvidenceMs) || 0;
    if (!last || now - last > ttlMs) delete registry[k];
    else if (Array.isArray(rec.sources)) {
      rec.sources = rec.sources.map((s) => {
        const o = { ...s };
        if (!o.outlet && o.source) o.outlet = o.source;
        return o;
      });
    }
  }

  const scanOpts = {
    getReliableCityCoordinates,
    isPlausibleMapTarget,
    maxAgeMs: opts.maxAgeMs,
    maxArticlesScan: opts.maxArticlesScan,
    now,
  };
  const hitsNews = newsStore ? collectHitsFromNews(newsStore, scanOpts) : [];
  const hitsTg = collectHitsFromTelegram(telegramMessages || [], { ...scanOpts, getReliableCityCoordinates });
  const hitsSeismic = collectHitsFromSeismic(seismicEvents || [], {
    ...scanOpts,
    getReliableCityCoordinates,
    seismicMaxAgeMs: opts.seismicMaxAgeMs,
    seismicMinMagnitude: opts.seismicMinMagnitude,
  });
  const allHits = hitsNews.concat(hitsTg).concat(hitsSeismic);

  for (let i = 0; i < allHits.length; i++) {
    const h = allHits[i];
    const key = h.locKey;
    if (!key) continue;
    let rec = registry[key];
    if (!rec) {
      rec = {
        id: `osint-impact-${key.replace(/[^a-zA-Z0-9\u0590-\u05FF_-]/g, '-').slice(0, 96)}`,
        locKey: key,
        cityName: h.displayName,
        locKind: h.locKind,
        lat: h.lat,
        lng: h.lng,
        sources: [],
        lastEvidenceMs: 0,
        snippet: h.snippet,
        israeliSourceCount: 0,
        _latestTitleMs: 0,
      };
      registry[key] = rec;
    }
    mergeHitIntoRecord(rec, h);
  }

  /* ניקוי כפילויות ישראל — פשטנו: נספור לפי sources עם sourceLabel ישראלי */
  for (const k of Object.keys(registry)) {
    const rec = registry[k];
    if (!rec || !Array.isArray(rec.sources)) continue;
    let isr = 0;
    for (let j = 0; j < rec.sources.length; j++) {
      const lab = String(rec.sources[j].sourceLabel || '');
      if (/וויינט|וואלה|מעריב|הארץ|ישראל היום|ערוץ 7|סרוגים|טיימס|ג׳רוזלם|אלגמיינר|ג׳ואיש/i.test(lab)) isr++;
    }
    rec.israeliSourceCount = isr;
  }

  return registry;
}

function registryToClientList(registry, opts) {
  const now = Number(opts.now) || Date.now();
  const ttlMs = Math.max(60 * 60 * 1000, Number(opts.ttlMs) || 12 * 60 * 60 * 1000);
  const minDistinctOutlets = Math.max(3, Number(opts.minDistinctOutlets) || 3);
  const minNonSeismicOutlets = Math.max(2, Number(opts.minNonSeismicOutlets) || 2);
  const maxPoints = Math.min(100, Math.max(5, Number(opts.maxPoints) || 50));

  const rows = [];
  for (const k of Object.keys(registry)) {
    const rec = registry[k];
    const last = Number(rec.lastEvidenceMs) || 0;
    if (!last || now - last > ttlMs) continue;
    const nOut = distinctOutletCount(rec.sources);
    if (nOut < minDistinctOutlets) continue;
    if (distinctNonSeismicOutletCount(rec.sources) < minNonSeismicOutlets) continue;

    const n = rec.sources.length;
    let conf = 0.28 + 0.09 * (nOut - 3) + 0.08 * Math.max(0, n - nOut) + Math.min(0.2, (rec.israeliSourceCount || 0) * 0.04);
    conf = Math.min(0.92, conf);

    rows.push({
      id: rec.id,
      cityName: rec.cityName,
      locKind: rec.locKind || 'city',
      lat: rec.lat,
      lng: rec.lng,
      sourceCount: n,
      distinctOutletCount: nOut,
      confidence: Math.round(conf * 100) / 100,
      confidencePercent: Math.round(conf * 100),
      sources: (rec.sources || []).slice(0, 14).map((s) => ({
        source: s.outlet || s.source,
        sourceId: s.sourceId || sourceFeedId(s.outlet || s.source),
        sourceLabel: s.sourceLabel || s.source,
        title: s.title,
        link: s.link,
        publishedAt: s.publishedAt,
      })),
      snippet: rec.snippet || '',
      updatedAt: new Date(last).toISOString(),
      disclaimer:
        'לפחות שלושה מקורות שונים, מתוכם לפחות שניים שאינם USGS · דיווח OSINT בלבד — לא מאומת רשמית',
    });
  }

  rows.sort((a, b) => {
    if (b.distinctOutletCount !== a.distinctOutletCount) return b.distinctOutletCount - a.distinctOutletCount;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return rows.slice(0, maxPoints);
}

const DEFAULT_REGISTRY_FILE = path.join(__dirname, '..', 'data', 'osint-impact-registry.json');

function loadOsintImpactRegistryFromDisk(filePath) {
  const fp = filePath || DEFAULT_REGISTRY_FILE;
  try {
    if (!fs.existsSync(fp)) return {};
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    console.warn('[OSINT impacts] load registry:', e.message);
    return {};
  }
}

function saveOsintImpactRegistryToDisk(registry, filePath) {
  const fp = filePath || DEFAULT_REGISTRY_FILE;
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const clean = {};
    for (const k of Object.keys(registry || {})) {
      const rec = registry[k];
      if (!rec || typeof rec !== 'object') continue;
      const copy = { ...rec };
      delete copy._latestTitleMs;
      delete copy._countedIsraeliForLink;
      clean[k] = copy;
    }
    fs.writeFileSync(fp, JSON.stringify(clean), 'utf8');
  } catch (e) {
    console.warn('[OSINT impacts] save registry:', e.message);
  }
}

/** תאימות לאחור — בונה רשימה בלי registry (בדיקות) */
function buildOsintImpactPoints(opts) {
  const empty = {};
  const reg = reconcileOsintImpactRegistry(empty, {
    ...opts,
    telegramMessages: opts.telegramMessages || [],
    seismicEvents: opts.seismicEvents || [],
    ttlMs: Number(opts.ttlMs) || 12 * 60 * 60 * 1000,
    minDistinctOutlets: Number(opts.minDistinctOutlets) || 3,
  });
  return registryToClientList(reg, {
    now: opts.now || Date.now(),
    ttlMs: opts.ttlMs || 12 * 60 * 60 * 1000,
    minDistinctOutlets: opts.minDistinctOutlets || 3,
    minNonSeismicOutlets: opts.minNonSeismicOutlets || 2,
    maxPoints: opts.maxPoints,
  });
}

module.exports = {
  reconcileOsintImpactRegistry,
  registryToClientList,
  loadOsintImpactRegistryFromDisk,
  saveOsintImpactRegistryToDisk,
  buildOsintImpactPoints,
  sourceFeedId,
  textMatchesImpactSignal,
};
