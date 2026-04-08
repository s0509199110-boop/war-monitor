/**
 * רמזי OSINT משלימים לציר איום — לא מחליפים את פיקוד העורף.
 * משמשים רק כשבטקסט ה-JSON של Oref אין זיהוי ציר (matchThreatAxisInBlob מחזיר null).
 *
 * כיבוי: OSINT_AXIS_HINTS=0
 * מקורות (ברירת מחדל): חנות חדשות מהשרת, RSS ציר־איום, טלגרם ציבורי (t.me/s) + בוט אם הוגדר.
 * OSINT_AXIS_DEFAULT_CHANNELS=0 / OSINT_INCLUDE_RSS=0 / OSINT_INCLUDE_NEWS_STORE=0 — לצמצום עומס.
 * OSINT נועד לחיזוק ציר שיגור בלבד, ולא מחליף את פיקוד העורף או מפעיל אירוע בעצמו.
 */
const axios = require('axios');
const xml2js = require('xml2js');
const { matchExplicitThreatAxisInBlob } = require('./threatAxisPatterns');

const parser = new xml2js.Parser({ explicitArray: false, trim: true, mergeAttrs: true });

let lastTelegramUpdateId = 0;
/** מרווח מינימלי בין ריענוני burst בזמן התראות (מילישניות) */
let lastBurstRefreshAt = 0;

const state = {
  axis: null,
  confidence: 0,
  sourcesTouched: [],
  updatedAt: null,
  chunkCount: 0,
  error: null,
  matchedHints: [],
};

const TELEGRAM_SOURCE_REGION_PATTERNS = [
  { region: 'iran', re: /(מאיראן|ממרחב\s+איראן|מטהראן|מטבריז|מכרמאנשאה|מאיספהאן)/i },
  { region: 'iraq', re: /(מעיראק|ממרחב\s+עיראק|מבגדד|מכרכוכ|ממוסול)/i },
  { region: 'yemen', re: /(מתימן|ממרחב\s+תימן|מצנעא|מסעדה|מחודיידה)/i },
  { region: 'lebanon', re: /(מלבנון|ממרחב\s+לבנון|ממרחב\s+צור|ממרחב\s+צידון|ממרחב\s+נבטיה|ממרחב\s+בינת\s*ג[׳']בייל|מצור|מצידון|מנבטיה)/i },
  { region: 'gaza', re: /(מעזה|ממרחב\s+עזה|ממרחב\s+חאן\s*יונס|ממרחב\s+רפיח|ממרחב\s+דיר\s*אל\s*בלח|מחאן\s*יונס|מרפיח)/i },
  { region: 'syria', re: /(מסוריה|ממרחב\s+סוריה|מדמשק|מחומס|מדרעא|מקוניטרה)/i },
  { region: 'iran', re: /(\bfrom iran\b|\blaunched from iran\b|\biran fired\b|\biranian (?:missile|rockets?|strike|attack|launch)\b)/i },
  { region: 'iraq', re: /(\bfrom iraq\b|\blaunched from iraq\b|\biraqi (?:missile|rocket|strike)\b)/i },
  { region: 'yemen', re: /(\bfrom yemen\b|\bhouthi (?:missile|rocket|drone|strike)\b|\bhouthis (?:fire|launch)\b)/i },
  { region: 'lebanon', re: /(\bfrom lebanon\b|\bhezbollah (?:fire|launch|rocket|missile)\b|\bfrom southern lebanon\b)/i },
  { region: 'gaza', re: /(\bfrom gaza\b|\bhamas (?:fire|launch|rocket|missile)\b|\bfrom the gaza strip\b)/i },
  { region: 'syria', re: /(\bfrom syria\b|\bfrom damascus\b|\bsyrian (?:missile|rocket|strike)\b)/i },
];

const TELEGRAM_TARGET_ZONE_PATTERNS = [
  { zone: 'north', re: /(לצפון|לעבר\s+הצפון|לגליל|לגליל העליון|לקריות|לנהריה|למטולה)/i },
  { zone: 'center', re: /(למרכז|לעבר\s+המרכז|לגוש\s*דן|לתל אביב|לשרון|לשפלה)/i },
  { zone: 'south', re: /(לדרום|לעבר\s+הדרום|לנגב|לבאר שבע|לאילת|לערבה)/i },
  { zone: 'jerusalem', re: /(לירושלים|להרי ירושלים|לשפלת ירושלים)/i },
];

function normalizeHintText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[“”״]/g, '"')
    .replace(/[’‘']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDirectionalHint(text) {
  const normalized = normalizeHintText(text);
  if (!normalized) return null;
  if (
    /(לא\s+זוהה\s+שיגור|לא\s+זוהו\s+שיגורים|בניגוד\s+לדיווחים|דיווחי?\s+שווא|פייק|הוסר\s+החשד|אין\s+שיגור|לא\s+היה\s+שיגור|אין\s+איומים\s+נוספים|אין\s+איומים|הסתיים\s+האירוע|השוהים\s+במרחב\s+המוגן\s+יכולים\s+לצאת)/i.test(
      normalized
    )
  ) {
    return null;
  }

  let sourceRegion = null;
  let sourcePattern = '';
  for (const row of TELEGRAM_SOURCE_REGION_PATTERNS) {
    const match = normalized.match(row.re);
    if (match) {
      sourceRegion = row.region;
      sourcePattern = match[0];
      break;
    }
  }

  let targetZone = null;
  let targetPattern = '';
  for (const row of TELEGRAM_TARGET_ZONE_PATTERNS) {
    const match = normalized.match(row.re);
    if (match) {
      targetZone = row.zone;
      targetPattern = match[0];
      break;
    }
  }

  const launchVerb = /(זוהה\s+שיגור|זוהו\s+שיגורים|יציאה|יציאות|שיגור(?:ים)?|ירי|נצפה\s+ירי|זוהתה\s+יציאה)/i.test(normalized);
  const impactVerb = /(נפילה|פגיעה|התפזר|התפצל|נפל\s+בשטח|נפילה\s+בשטח)/i.test(normalized);
  if (!sourceRegion && !targetZone) return null;

  return {
    sourceRegion,
    targetZone,
    sourcePattern,
    targetPattern,
    launchVerb,
    impactVerb,
    text: normalized.slice(0, 240),
  };
}

function isOsintAxisHintsEnabled() {
  const v = process.env.OSINT_AXIS_HINTS;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

function parseEnvUrls(raw, maxUrls = 28) {
  if (!raw || typeof raw !== 'string') return [];
  const cap = Math.min(40, Math.max(1, Number(maxUrls) || 28));
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, cap);
}

function parseTelegramPublicSources(raw, maxChannels = 12) {
  if (!raw || typeof raw !== 'string') return [];
  const cap = Math.min(40, Math.max(1, Number(maxChannels) || 12));
  const out = [];
  const seen = new Set();
  for (const part of raw.split(/[,;\n]/)) {
    const s = String(part || '').trim();
    if (!s) continue;
    let username = '';
    if (/^https?:\/\/t\.me\//i.test(s)) {
      const m = s.match(/^https?:\/\/t\.me\/(?:s\/)?([^/?#]+)/i);
      if (m) username = m[1];
    } else if (s.startsWith('@')) {
      username = s.slice(1);
    } else {
      username = s;
    }
    username = username.trim();
    if (!username) continue;
    const normalized = username.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      username,
      url: `https://t.me/s/${encodeURIComponent(username)}`,
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** ערוצי t.me/s/ ציבוריים — מתמזגים עם TELEGRAM_PUBLIC_CHANNELS (כיבוי: TELEGRAM_AXIS_DEFAULT_CHANNELS=0) */
const DEFAULT_TELEGRAM_AXIS_CHANNELS_RAW =
  'idfonline,kann_news,News12web,GLZRadio,wallanews,TheIntelFrog,geoconfirmed,haaretzonline';

function mergeTelegramCsvUnique(a, b) {
  const seen = new Set();
  const parts = [];
  for (const chunk of [a, b]) {
    for (const part of String(chunk || '').split(/[,;\n]/)) {
      const s = part.trim();
      if (!s) continue;
      const key = s.replace(/^@/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(s);
    }
  }
  return parts.join(',');
}

function getTelegramChannelsRawForAxis() {
  const env = String(process.env.TELEGRAM_PUBLIC_CHANNELS || process.env.TELEGRAM_CHANNELS || '').trim();
  if (process.env.TELEGRAM_AXIS_DEFAULT_CHANNELS === '0') return env;
  if (!env) return DEFAULT_TELEGRAM_AXIS_CHANNELS_RAW;
  return mergeTelegramCsvUnique(DEFAULT_TELEGRAM_AXIS_CHANNELS_RAW, env);
}

function telegramAxisMaxChannels() {
  return Math.min(40, Math.max(6, Number(process.env.TELEGRAM_AXIS_MAX_CHANNELS) || 28));
}

/** כותרות RSS משלימות לזיהוי ציר (בנוסף לחנות החדשות בשרת) */
const DEFAULT_AXIS_RSS_URLS = [
  'https://feeds.reuters.com/Reuters/worldNews',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=15',
  'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml',
  'https://missilethreat.csis.org/feed/',
  'https://www.jpost.com/rss/rssfeedsiran',
  'https://www.jpost.com/rss/rssfeedsarabisraeliconflict.aspx',
];

function buildOsintRssUrlList() {
  if (process.env.OSINT_INCLUDE_RSS === '0') return [];
  const fromEnv = parseEnvUrls(process.env.OSINT_RSS_URLS || '', 28);
  if (process.env.OSINT_AXIS_DEFAULT_RSS === '0') return fromEnv.slice(0, 28);
  const merged = [...fromEnv];
  for (const u of DEFAULT_AXIS_RSS_URLS) {
    merged.push(u);
  }
  const seen = new Set();
  const out = [];
  for (const u of merged) {
    const k = String(u).trim().toLowerCase();
    if (!/^https?:\/\//i.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(String(u).trim());
    if (out.length >= 28) break;
  }
  return out;
}

function getItemText(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (!value) continue;
    if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (typeof value._ === 'string') return value._.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function fetchRssTitles(url) {
  const r = await axios.get(url, {
    timeout: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WarMonitorOSINT/1.0)' },
    validateStatus: (s) => s >= 200 && s < 400,
    responseType: 'text',
  });
  const xml = String(r.data || '').replace(/&(?!#?\w+;)/g, '&amp;');
  const result = await parser.parseStringPromise(xml);
  const items = result.rss?.channel?.item || result.feed?.entry || [];
  const itemArray = Array.isArray(items) ? items : [items];
  const titles = [];
  for (const item of itemArray.slice(0, 40)) {
    const t = getItemText(item, ['title', 'summary', 'description']);
    if (t && t.length > 2) titles.push(t.slice(0, 500));
  }
  return titles;
}

async function fetchJsonFeedHint(url) {
  const r = await axios.get(url, {
    timeout: 12_000,
    headers: { Accept: 'application/json', 'User-Agent': 'WarMonitorOSINT/1.0' },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const data = r.data;
  const chunks = [];
  if (Array.isArray(data)) {
    for (const row of data.slice(0, 50)) {
      if (typeof row === 'string') chunks.push(row.slice(0, 600));
      else if (row && typeof row.text === 'string') chunks.push(row.text.slice(0, 600));
      else if (row && typeof row.message === 'string') chunks.push(row.message.slice(0, 600));
      else if (row && typeof row.title === 'string') chunks.push(row.title.slice(0, 600));
    }
    return chunks;
  }
  if (data && Array.isArray(data.items)) {
    for (const row of data.items.slice(0, 50)) {
      if (typeof row === 'string') chunks.push(row.slice(0, 600));
      else if (row && typeof row.text === 'string') chunks.push(row.text.slice(0, 600));
      else if (row && typeof row.message === 'string') chunks.push(row.message.slice(0, 600));
    }
  }
  return chunks;
}

async function fetchTelegramChunks(token) {
  const chunks = [];
  const offset = lastTelegramUpdateId ? lastTelegramUpdateId + 1 : undefined;
  const params = new URLSearchParams({ timeout: '0', limit: '100' });
  if (offset != null) params.set('offset', String(offset));
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?${params}`;
  const r = await axios.get(url, { timeout: 15_000, validateStatus: () => true });
  if (r.status !== 200 || !r.data?.ok || !Array.isArray(r.data.result)) return chunks;

  for (const u of r.data.result) {
    const id = u.update_id;
    if (Number.isFinite(id) && id > lastTelegramUpdateId) lastTelegramUpdateId = id;
    const msg = u.message || u.channel_post || u.edited_message || u.edited_channel_post;
    const text = msg && (msg.text || msg.caption);
    if (typeof text === 'string' && text.trim()) chunks.push(text.trim().slice(0, 1200));
  }
  return chunks;
}

async function fetchTelegramPublicChannelChunks(channel) {
  const url = channel?.url;
  if (!url) return [];
  const r = await axios.get(url, {
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WarMonitorOSINT/1.0)' },
    validateStatus: (s) => s >= 200 && s < 500,
    responseType: 'text',
  });
  if (r.status >= 400) return [];
  const html = String(r.data || '');
  const chunks = [];
  const seen = new Set();
  const re = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = String(match[1] || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCharCode(code) : '';
      })
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text.length < 3) continue;
    const dedupeKey = text.slice(0, 240);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    chunks.push(text.slice(0, 1200));
    if (chunks.length >= 40) break;
  }
  return chunks;
}

/**
 * מחשב ציר ורמת ביטחון מקטעי טקסט (כל קטע מזוהה בנפרד).
 */
function voteAxisFromChunks(chunks) {
  const valid = chunks.map((c) => String(c || '').trim()).filter((c) => c.length > 3);
  if (!valid.length) return { axis: null, confidence: 0, chunkCount: 0 };

  const votes = Object.create(null);
  let matched = 0;
  const matchedHints = [];
  for (const c of valid) {
    const directional = extractDirectionalHint(c);
    let ax = directional?.sourceRegion || null;
    const weight = directional?.launchVerb ? 1.6 : directional?.sourceRegion ? 1.3 : 1;
    if (!ax) ax = matchExplicitThreatAxisInBlob(c);
    if (!ax) continue;
    matched += 1;
    votes[ax] = (votes[ax] || 0) + weight;
    if (directional?.sourceRegion) {
      matchedHints.push({
        axis: directional.sourceRegion,
        targetZone: directional.targetZone || null,
        sourcePattern: directional.sourcePattern || '',
        targetPattern: directional.targetPattern || '',
        text: directional.text,
      });
    }
  }
  if (!matched) return { axis: null, confidence: 0, chunkCount: valid.length, matchedHints: [] };

  let bestAxis = null;
  let bestN = 0;
  for (const k of Object.keys(votes)) {
    if (votes[k] > bestN) {
      bestN = votes[k];
      bestAxis = k;
    }
  }

  const maxConf = Number(process.env.OSINT_MAX_CONFIDENCE);
  const cap = Number.isFinite(maxConf) && maxConf > 0 && maxConf <= 1 ? maxConf : 0.48;
  const minConf = Number(process.env.OSINT_MIN_CONFIDENCE);
  const floor = Number.isFinite(minConf) && minConf >= 0 && minConf < 1 ? minConf : 0.22;

  let confidence = 0.16 + 0.11 * bestN + 0.04 * Math.min(matched, 6);
  confidence *= Math.min(1, bestN / Math.max(1, matched));
  confidence = Math.min(cap, confidence);
  if (confidence < floor && bestN >= 2) confidence = floor;
  if (bestN === 1 && matched === 1) confidence = Math.min(cap, 0.26);

  return { axis: bestAxis, confidence, chunkCount: valid.length, matchedHints: matchedHints.slice(0, 12) };
}

/**
 * משיכת טקסטים מטלגרם בלבד (בוט + ערוצים ציבוריים) — לשימוש ב־pollTelegramMissileLayer / LLM.
 * לא מעדכן את state.axis הגלובלי.
 */
async function fetchTelegramOnlyChunks() {
  const sourcesTouched = [];
  const chunks = [];
  try {
    const tg = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (tg) {
      try {
        const tc = await fetchTelegramChunks(tg);
        if (tc.length) {
          sourcesTouched.push('telegram');
          chunks.push(...tc);
        }
      } catch {
        /* */
      }
    }
    const publicTelegramChannels = parseTelegramPublicSources(
      getTelegramChannelsRawForAxis(),
      telegramAxisMaxChannels()
    );
    for (const channel of publicTelegramChannels) {
      try {
        const tc = await fetchTelegramPublicChannelChunks(channel);
        if (tc.length) {
          sourcesTouched.push(`telegram_public:${channel.username}`);
          chunks.push(...tc);
        }
      } catch {
        /* continue */
      }
    }
  } catch {
    /* */
  }
  return { chunks, sourcesTouched };
}

/**
 * הודעות טלגרם עם ייחוס outlet — לשכבת פגיעות OSINT (מקור שני/שלישי).
 * ערוצים: OSINT_IMPACT_TELEGRAM_CHANNELS או TELEGRAM_PUBLIC_CHANNELS / TELEGRAM_CHANNELS
 */
async function fetchTelegramPublicMessagesForOsint() {
  const out = [];
  const now = Date.now();
  const tg = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (tg) {
    try {
      const tc = await fetchTelegramChunks(tg);
      for (let i = 0; i < tc.length; i++) {
        out.push({
          text: tc[i],
          outlet: 'telegram_bot',
          link: 'https://t.me/',
          sourceLabel: 'טלגרם (בוט)',
          pubMs: now,
        });
      }
    } catch {
      /* */
    }
  }
  const rawChannels =
    process.env.OSINT_IMPACT_TELEGRAM_CHANNELS || getTelegramChannelsRawForAxis();
  const tgCap = Math.min(40, Math.max(4, Number(process.env.OSINT_IMPACT_TELEGRAM_MAX_CHANNELS) || 24));
  const publicTelegramChannels = parseTelegramPublicSources(rawChannels, tgCap);
  for (let c = 0; c < publicTelegramChannels.length; c++) {
    const channel = publicTelegramChannels[c];
    try {
      const tc = await fetchTelegramPublicChannelChunks(channel);
      const uname = channel.username || 'channel';
      for (let i = 0; i < tc.length; i++) {
        out.push({
          text: tc[i],
          outlet: `telegram:${uname}`,
          link: channel.url || `https://t.me/${uname}`,
          sourceLabel: `טלגרם @${uname}`,
          pubMs: now,
        });
      }
    } catch {
      /* */
    }
  }
  return out;
}

async function refreshOsintHints(getNewsStoreWarRelatedBlob, options = {}) {
  const burst = options.burst === true;
  if (!isOsintAxisHintsEnabled()) {
    state.axis = null;
    state.confidence = 0;
    state.sourcesTouched = [];
    state.updatedAt = new Date().toISOString();
    state.chunkCount = 0;
    state.error = null;
    return;
  }

  if (burst) {
    const minGap =
      Number(process.env.OSINT_ALERT_REFRESH_MS) >= 4000
        ? Number(process.env.OSINT_ALERT_REFRESH_MS)
        : 10_000;
    if (Date.now() - lastBurstRefreshAt < minGap) return;
    lastBurstRefreshAt = Date.now();
  }

  const sourcesTouched = [];
  const chunks = [];

  try {
    const includeNewsStore = process.env.OSINT_INCLUDE_NEWS_STORE !== '0';
    if (includeNewsStore && typeof getNewsStoreWarRelatedBlob === 'function') {
      const blob = getNewsStoreWarRelatedBlob(120);
      if (blob && blob.trim()) {
        sourcesTouched.push('news_store');
        for (const part of blob.split(/\s*\|\s*/).filter(Boolean)) {
          if (part.trim().length > 4) chunks.push(part.trim());
        }
      }
    }

    const rssList = buildOsintRssUrlList();
    for (const u of rssList) {
      try {
        const titles = await fetchRssTitles(u);
        if (titles.length) {
          sourcesTouched.push(`rss:${u.slice(0, 48)}`);
          chunks.push(...titles);
        }
      } catch {
        /* רשת/פיד בודד — ממשיכים */
      }
    }

    const includeJsonFeed = process.env.OSINT_INCLUDE_JSON_FEED === '1';
    const jsonUrl = includeJsonFeed ? (process.env.OSINT_JSON_FEED_URL || '').trim() : '';
    if (/^https?:\/\//i.test(jsonUrl)) {
      try {
        const jc = await fetchJsonFeedHint(jsonUrl);
        if (jc.length) {
          sourcesTouched.push('json_feed');
          chunks.push(...jc);
        }
      } catch {
        /* */
      }
    }

    const tg = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (tg) {
      try {
        const tc = await fetchTelegramChunks(tg);
        if (tc.length) {
          sourcesTouched.push('telegram');
          chunks.push(...tc);
        }
      } catch {
        /* */
      }
    }

    const publicTelegramChannels = parseTelegramPublicSources(
      getTelegramChannelsRawForAxis(),
      telegramAxisMaxChannels()
    );
    for (const channel of publicTelegramChannels) {
      try {
        const tc = await fetchTelegramPublicChannelChunks(channel);
        if (tc.length) {
          sourcesTouched.push(`telegram_public:${channel.username}`);
          chunks.push(...tc);
        }
      } catch {
        /* continue */
      }
    }

    const { axis, confidence, chunkCount, matchedHints } = voteAxisFromChunks(chunks);
    state.axis = axis;
    state.confidence = confidence;
    state.sourcesTouched = sourcesTouched;
    state.chunkCount = chunkCount;
    state.matchedHints = matchedHints;
    state.updatedAt = new Date().toISOString();
    state.error = null;
  } catch (e) {
    state.error = e && e.message ? String(e.message) : 'osint_refresh_failed';
    state.matchedHints = [];
    state.updatedAt = new Date().toISOString();
  }
}

function getOsintAxisHintSync() {
  if (!isOsintAxisHintsEnabled()) return null;
  const minConf = Number(process.env.OSINT_MIN_CONFIDENCE);
  const floor = Number.isFinite(minConf) && minConf >= 0 && minConf < 1 ? minConf : 0.22;
  if (!state.axis || state.confidence < floor) return null;
  return {
    axis: state.axis,
    confidence: state.confidence,
    sourcesTouched: [...state.sourcesTouched],
    updatedAt: state.updatedAt,
    chunkCount: state.chunkCount,
    matchedHints: Array.isArray(state.matchedHints) ? [...state.matchedHints] : [],
    disclaimer: 'רמז OSINT בלבד — לא מאומת רשמית; פיקוד העורף הוא המקור להתראה',
  };
}

function getOsintDebugSnapshot() {
  return {
    enabled: isOsintAxisHintsEnabled(),
    axis: state.axis,
    confidence: state.confidence,
    sourcesTouched: [...state.sourcesTouched],
    updatedAt: state.updatedAt,
    chunkCount: state.chunkCount,
    matchedHints: Array.isArray(state.matchedHints) ? [...state.matchedHints] : [],
    error: state.error,
  };
}

module.exports = {
  refreshOsintHints,
  fetchTelegramOnlyChunks,
  fetchTelegramPublicMessagesForOsint,
  getOsintAxisHintSync,
  getOsintDebugSnapshot,
  isOsintAxisHintsEnabled,
};
