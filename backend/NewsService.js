const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const xml2js = require('xml2js');

const NEWS_STORE_FILE = path.join(__dirname, '..', 'data', 'news-articles.json');
let newsStoreSaveTimer = null;

const parser = new xml2js.Parser({
  explicitArray: false,
  trim: true,
  mergeAttrs: true,
});

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const TRANSLATION_CACHE = new Map();
const CACHE_MAX_SIZE = 500;

const STATIC_NEWS_SOURCES = [
  { name: 'ynet', url: 'https://www.ynet.co.il/Integration/StoryRss1854.xml', category: 'israel' },
  { name: 'ynet_flash', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', category: 'israel' },
  { name: 'ynet_defense', url: 'https://www.ynet.co.il/Integration/StoryRss5363.xml', category: 'israel' },
  { name: 'walla', url: 'https://rss.walla.co.il/feed/22', category: 'israel' },
  { name: 'walla_news', url: 'https://rss.walla.co.il/feed/1', category: 'israel' },
  { name: 'maariv', url: 'https://www.maariv.co.il/Rss/RssChadashot', category: 'israel' },
  { name: 'n12', url: 'https://www.mako.co.il/rss/News-military.xml', category: 'israel' },
  { name: 'israelhayom', url: 'https://www.israelhayom.co.il/rss.xml', category: 'israel' },
  { name: 'haaretz', url: 'https://www.haaretz.co.il/srv/rss---feedly', category: 'israel' },
  { name: 'inn', url: 'https://www.inn.co.il/Rss.aspx', category: 'israel', allowInsecure: true },
  { name: 'srugim', url: 'https://www.srugim.co.il/feed', category: 'israel' },
  { name: 'timesofisrael', url: 'https://www.timesofisrael.com/feed/', category: 'israel' },
  { name: 'algemeiner', url: 'https://www.algemeiner.com/feed/', category: 'israel' },
  { name: 'jewishpress', url: 'https://www.jewishpress.com/feed/', category: 'israel' },
  { name: 'jpost_me', url: 'https://www.jpost.com/rss/rssfeedsmiddleeastnews.aspx', category: 'world' },
  { name: 'bbc', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
  { name: 'cnn', url: 'http://rss.cnn.com/rss/edition_world.rss', category: 'world' },
  { name: 'foxnews', url: 'https://feeds.foxnews.com/foxnews/world', category: 'world' },
  { name: 'skynews', url: 'https://feeds.skynews.com/feeds/rss/world.xml', category: 'world' },
  { name: 'france24', url: 'https://www.france24.com/en/rss', category: 'world' },
  { name: 'dw', url: 'https://rss.dw.com/rdf/rss-en-all', category: 'world' },
  { name: 'defensenews', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', category: 'military' },
  { name: 'theaviationist', url: 'https://theaviationist.com/feed/', category: 'military' },
  { name: 'defenceblog', url: 'https://defence-blog.com/feed/', category: 'military' },
  { name: 'breakingdefense', url: 'https://breakingdefense.com/feed/', category: 'military' },
  { name: 'defenseone', url: 'https://www.defenseone.com/rss/all', category: 'military' },
  { name: 'alquds', url: 'https://www.alquds.com/feed', category: 'regional' },
  { name: 'guardian_world', url: 'https://www.theguardian.com/world/rss', category: 'world' },
  { name: 'aljazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' },
  { name: 'bbc_me', url: 'http://feeds.bbci.co.uk/news/world/middle_east/rss.xml', category: 'world' },
  { name: 'jpost_front', url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx', category: 'israel' },
  { name: 'arabnews_me', url: 'https://www.arabnews.com/cat/4/rss.xml', category: 'regional' },
  { name: 'middleeasteye', url: 'https://www.middleeasteye.net/news/rss', category: 'regional' },
  { name: 'thenational_ae', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', category: 'regional' },
  { name: 'rt_news', url: 'https://www.rt.com/rss/news/', category: 'world' },
  { name: 'newsweek', url: 'https://www.newsweek.com/rss', category: 'world' },
  { name: 'euronews_world', url: 'https://www.euronews.com/rss?level=theme&name=news', category: 'world' },
  { name: 'independent_world', url: 'https://www.independent.co.uk/news/world/rss', category: 'world' },
  { name: 'scmp_world', url: 'https://www.scmp.com/rss/5/feed', category: 'world' },
  { name: 'asharq', url: 'https://english.aawsat.com/feed', category: 'regional' },
  { name: 'newarab', url: 'https://www.thenewarab.com/rss', category: 'regional' },
  { name: 'tasnim_en', url: 'https://www.tasnimnews.com/en/rss', category: 'regional' },
  { name: 'mehr_en', url: 'https://en.mehrnews.com/rss', category: 'regional' },
  { name: 'hurriyet_world', url: 'https://www.hurriyetdailynews.com/rss/world', category: 'world' },
  { name: 'ansamed', url: 'https://www.ansa.it/english/world/rss.xml', category: 'world' },
  { name: 'jpost_iran', url: 'https://www.jpost.com/rss/rssfeedsiran', category: 'world' },
  {
    name: 'jpost_arab_israel',
    url: 'https://www.jpost.com/rss/rssfeedsarabisraeliconflict.aspx',
    category: 'world',
  },
  { name: 'reuters_world', url: 'https://feeds.reuters.com/Reuters/worldNews', category: 'world' },
  { name: 'nyt_world', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world' },
  {
    name: 'dod_press',
    url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=15',
    category: 'military',
  },
  {
    name: 'military_times',
    url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml',
    category: 'military',
  },
  { name: 'missile_threat_csis', url: 'https://missilethreat.csis.org/feed/', category: 'military' },
];

function normalizeFeedUrlKey(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    return u.href.toLowerCase();
  } catch (_) {
    return String(url).trim().toLowerCase();
  }
}

function buildExtraNewsSourcesFromEnv() {
  const used = new Set(STATIC_NEWS_SOURCES.map((s) => s.name));
  const usedUrls = new Set(STATIC_NEWS_SOURCES.map((s) => normalizeFeedUrlKey(s.url)));
  const out = [];
  const pushUnique = (row) => {
    if (!row || !row.url || !/^https?:\/\//i.test(String(row.url))) return;
    const urlKey = normalizeFeedUrlKey(row.url);
    if (usedUrls.has(urlKey)) return;
    usedUrls.add(urlKey);
    let name = String(row.name || 'rss_extra').replace(/\s+/g, '_').slice(0, 48);
    let n = 0;
    while (used.has(name)) {
      n += 1;
      name = `${String(row.name || 'rss').replace(/\s+/g, '_').slice(0, 40)}_${n}`;
    }
    used.add(name);
    out.push({
      name,
      url: String(row.url),
      category: row.category || 'world',
      allowInsecure: !!row.allowInsecure,
    });
  };

  const csv = process.env.NEWS_RSS_URLS || '';
  csv
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((url, i) => {
      if (!/^https?:\/\//i.test(url)) return;
      let host = 'rss';
      try {
        host = new URL(url).hostname.replace(/\./g, '_').slice(0, 28);
      } catch (_) {
        /* */
      }
      pushUnique({ name: `rss_${host}_${i}`, url, category: 'world' });
    });

  try {
    const raw = process.env.NEWS_EXTRA_SOURCES_JSON;
    if (raw && String(raw).trim()) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((row, i) => {
          if (!row || typeof row !== 'object') return;
          pushUnique({
            name: row.name != null ? String(row.name) : `extra_${i}`,
            url: row.url,
            category: row.category,
            allowInsecure: row.allowInsecure,
          });
        });
      }
    }
  } catch (e) {
    console.warn('[News] NEWS_EXTRA_SOURCES_JSON parse error:', e.message);
  }

  return out;
}

const NEWS_SOURCES = STATIC_NEWS_SOURCES.concat(buildExtraNewsSourcesFromEnv());

const ALL_NEWS_SOURCE_NAMES = new Set(NEWS_SOURCES.map((s) => s.name));

const SOURCE_LABELS = {
  ynet: 'וויינט',
  ynet_flash: 'וויינט מבזקים',
  ynet_defense: 'וויינט ביטחון',
  walla: 'וואלה',
  walla_news: 'וואלה חדשות',
  maariv: 'מעריב',
  n12: 'חדשות 12',
  israelhayom: 'ישראל היום',
  haaretz: 'הארץ',
  inn: 'ערוץ 7',
  srugim: 'סרוגים',
  jpost_me: 'ג׳רוזלם פוסט',
  timesofisrael: 'טיימס אוף ישראל',
  algemeiner: 'אלגמיינר',
  jewishpress: 'ג׳ואיש פרס',
  bbc: 'BBC',
  cnn: 'CNN',
  foxnews: 'פוקס ניוז',
  skynews: 'סקיי ניוז',
  france24: 'פראנס 24',
  dw: 'דויטשה ולה',
  defensenews: 'דיפנס ניוז',
  theaviationist: 'דה אוויאיישניסט',
  defenceblog: 'דיפנס בלוג',
  breakingdefense: 'ברייקינג דיפנס',
  defenseone: 'דיפנס וואן',
  alquds: 'אל-קודס',
  guardian_world: 'הגרדיאן',
  aljazeera: 'אל-ג׳זירה',
  bbc_me: 'BBC מזה״ת',
  jpost_front: 'ג׳רוזלם פוסט (ראשי)',
  arabnews_me: 'Arab News',
  middleeasteye: 'Middle East Eye',
  thenational_ae: 'The National',
  rt_news: 'RT',
  newsweek: 'ניוזוויק',
  euronews_world: 'יורוניוז',
  independent_world: 'אינדיפנדנט',
  scmp_world: 'South China Morning Post',
  asharq: 'الشرق الأوسط',
  newarab: 'The New Arab',
  tasnim_en: 'Tasnim',
  mehr_en: 'Mehr',
  hurriyet_world: 'Hürriyet',
  ansamed: 'ANSA',
  jpost_iran: 'ג׳רוזלם פוסט — איראן',
  jpost_arab_israel: 'ג׳רוזלם פוסט — ערב־ישראל',
  reuters_world: 'רויטרס (עולם)',
  nyt_world: 'ניו יורק טיימס (עולם)',
  dod_press: 'משרד ההגנה האמריקאי',
  military_times: 'Military Times',
  missile_threat_csis: 'Missile Threat (CSIS)',
};

const ISRAELI_SOURCE_NAMES = new Set([
  'ynet',
  'ynet_flash',
  'ynet_defense',
  'walla',
  'walla_news',
  'maariv',
  'n12',
  'israelhayom',
  'haaretz',
  'inn',
  'srugim',
  'timesofisrael',
  'algemeiner',
  'jewishpress',
]);

/** מקורות שמוזרמים לווידג׳ט החדשות: עברית + נשמר בדיסק (ללא אתרים שכותרותיהם באנגלית בלבד) */
const HEBREW_PANEL_SOURCES = new Set([
  'ynet',
  'ynet_flash',
  'ynet_defense',
  'walla',
  'walla_news',
  'maariv',
  'n12',
  'israelhayom',
  'haaretz',
  'inn',
  'srugim',
]);

/** מילות מפתח לחזית העימות מול איראן והפרוקסי — בנוסף ל־isWarRelated */
const IRAN_FRONT_REGEX =
  /איראן|טהראן|טחרן|גרעין|כור|בושהר|חיזבאללה|נסראללה|חות|חות׳ים|חותי|תימן|מפרץ|הובים|עיראק|סוריה|לבנון|חמאס|עזה|עזת|טבאס|יריחו|איום איר|מתקפה|מתקיפ|כטב|כטב״ם|כטב"ם|יירוט|שיגור|רקט|טיל|תקיפ|צה"ל|חיל האוויר|פיקוד|אזעקה|מלחמה|מזל"ט|מלט|iran|tehran|hezbollah|houthis|hamas|gaza|lebanon|syria|iraq|yemen|gulf|missile|drone|strike|nuclear/i;

const WAR_KEYWORDS = [
  'מלחמה', 'טיל', 'טילים', 'רקטה', 'רקטות', 'שיגור', 'שיגורים', 'תקיפה', 'פגיעה', 'יירוט',
  'אזעקה', 'התרעה', 'פיקוד העורף', 'חיל האוויר', 'צה"ל', 'חיזבאללה', 'חמאס', 'חות׳ים',
  'עזה', 'לבנון', 'איראן', 'סוריה', 'עיראק', 'תימן', 'ירדן', 'סעודיה', 'כטב"ם', 'כטבמ',
  'ביטחון', 'הגנה', 'כוננות', 'מל"ט', 'כטמ"ם', 'war', 'missile', 'missiles', 'rocket',
  'rockets', 'launch', 'strike', 'attack', 'drone', 'intercept', 'alert', 'defense', 'security',
  'idf', 'israel', 'iran', 'lebanon', 'syria', 'iraq', 'yemen', 'gaza', 'houthis', 'hezbollah',
  'hamas', 'home front command',
];

const newsStore = {
  articles: [],
  maxAge: 48 * 60 * 60 * 1000,
  maxCount: 1500,
};

function isIranFrontWarNews(text) {
  const s = String(text || '');
  if (!isWarRelated(s)) return false;
  return IRAN_FRONT_REGEX.test(s);
}

function shouldPersistForHebrewPanel(article) {
  if (!article || !article.link) return false;
  if (!HEBREW_PANEL_SOURCES.has(article.source)) return false;
  const merged = `${article.title || ''} ${article.description || ''}`;
  if (!isIranFrontWarNews(merged)) return false;
  return containsHebrew(article.title || '');
}

/** שמירה לחנות גם ממקורות בינ״ל (אנגלית) — לשכבת OSINT / פגיעות */
function shouldPersistArticle(article) {
  if (!article || !article.link) return false;
  if (shouldPersistForHebrewPanel(article)) return true;
  const merged = `${article.title || ''} ${article.description || ''}`;
  if (!isIranFrontWarNews(merged)) return false;
  return ALL_NEWS_SOURCE_NAMES.has(article.source);
}

function articleToJSON(article) {
  const pub =
    article.pubDate instanceof Date
      ? article.pubDate.toISOString()
      : new Date(article.pubDate || Date.now()).toISOString();
  const ing = Number(article.ingestedAtMs);
  const row = {
    title: article.title,
    titleHe: article.titleHe || '',
    link: article.link,
    description: article.description || '',
    pubDate: pub,
    source: article.source,
    category: article.category,
    isWarRelated: !!article.isWarRelated,
    isIranFrontWar: !!article.isIranFrontWar,
  };
  if (Number.isFinite(ing) && ing > 0) row.ingestedAtMs = ing;
  return row;
}

function articleFromJSON(row) {
  if (!row || typeof row !== 'object') return null;
  const pubDate = normalizePubDate(row.pubDate);
  const ing = Number(row.ingestedAtMs);
  return normalizeArticle({
    title: row.title,
    titleHe: row.titleHe,
    link: row.link,
    description: row.description,
    pubDate,
    source: row.source,
    category: row.category || 'israel',
    isWarRelated: row.isWarRelated !== false,
    isIranFrontWar: !!row.isIranFrontWar,
    ingestedAtMs: Number.isFinite(ing) && ing > 0 ? ing : undefined,
  });
}

function loadNewsStoreFromDisk() {
  try {
    if (!fs.existsSync(NEWS_STORE_FILE)) return;
    const raw = fs.readFileSync(NEWS_STORE_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    const out = [];
    for (let i = 0; i < arr.length && out.length < newsStore.maxCount; i++) {
      const a = articleFromJSON(arr[i]);
      if (!a) continue;
      const t = a.pubDate instanceof Date ? a.pubDate.getTime() : 0;
      if (!Number.isFinite(t) || now - t > newsStore.maxAge) continue;
      out.push(a);
    }
    out.sort(sortByPublishedDesc);
    newsStore.articles = out;
    if (out.length) console.log(`[News] Loaded ${out.length} article(s) from disk`);
  } catch (e) {
    console.warn('[News] Could not load news-articles.json:', e.message);
  }
}

function saveNewsStoreToDiskSync() {
  try {
    const dir = path.dirname(NEWS_STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = newsStore.articles.slice(0, newsStore.maxCount).map(articleToJSON);
    fs.writeFileSync(NEWS_STORE_FILE, JSON.stringify(payload), 'utf8');
  } catch (e) {
    console.warn('[News] Could not save news-articles.json:', e.message);
  }
}

function scheduleSaveNewsStore() {
  if (newsStoreSaveTimer) clearTimeout(newsStoreSaveTimer);
  newsStoreSaveTimer = setTimeout(() => {
    newsStoreSaveTimer = null;
    saveNewsStoreToDiskSync();
  }, 600);
}

loadNewsStoreFromDisk();

function containsHebrew(text) {
  return /[\u0590-\u05FF]/.test(text || '');
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(text) {
  return decodeHtmlEntities(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePubDate(rawPubDate) {
  const date = new Date(rawPubDate || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function getItemText(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (!value) continue;
    if (typeof value === 'string') return stripHtml(value);
    if (typeof value._ === 'string') return stripHtml(value._);
    if (typeof value.__cdata === 'string') return stripHtml(value.__cdata);
    if (typeof value.href === 'string') return value.href;
    if (Array.isArray(value) && typeof value[0] === 'string') return stripHtml(value[0]);
  }
  return '';
}

async function translateToHebrew(text) {
  if (!text || containsHebrew(text)) return text;
  const normalizedText = text.length > 500 ? text.slice(0, 500) : text;

  if (TRANSLATION_CACHE.has(normalizedText)) {
    return TRANSLATION_CACHE.get(normalizedText);
  }

  try {
    const response = await axios.post(
      'https://libretranslate.de/translate',
      {
        q: normalizedText,
        source: 'auto',
        target: 'he',
        format: 'text',
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const translated = response.data?.translatedText || normalizedText;
    if (TRANSLATION_CACHE.size >= CACHE_MAX_SIZE) {
      const firstKey = TRANSLATION_CACHE.keys().next().value;
      TRANSLATION_CACHE.delete(firstKey);
    }
    TRANSLATION_CACHE.set(normalizedText, translated);
    return translated;
  } catch (error) {
    console.log('[Translation] Failed:', error.message);
    return normalizedText;
  }
}

function isWarRelated(text) {
  const lowerText = String(text || '').toLowerCase();
  return WAR_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()));
}

function isIsraeliSource(article) {
  return ISRAELI_SOURCE_NAMES.has(article?.source);
}

function normalizeArticle(article) {
  const pubDate = normalizePubDate(article.pubDate);
  const title = stripHtml(article.title || '');
  const titleHe = containsHebrew(article.titleHe || '') ? stripHtml(article.titleHe) : '';
  const description = stripHtml(article.description || '');
  const merged = `${title} ${description}`;
  const iranFront =
    typeof article.isIranFrontWar === 'boolean'
      ? article.isIranFrontWar
      : isIranFrontWarNews(merged);

  const ingestedRaw = Number(article.ingestedAtMs);
  const ingestedAtMs = Number.isFinite(ingestedRaw) && ingestedRaw > 0 ? ingestedRaw : undefined;

  return {
    ...article,
    title,
    titleHe,
    description,
    pubDate,
    publishedAt: pubDate.toISOString(),
    sourceLabel: SOURCE_LABELS[article.source] || article.source,
    isIsraeliSource: isIsraeliSource(article),
    isIranFrontWar: iranFront,
    ingestedAtMs,
  };
}

function sortByPublishedDesc(a, b) {
  return b.pubDate - a.pubDate;
}

function prioritizeArticles(articles, limit = 50) {
  const normalized = articles
    .filter(Boolean)
    .map(normalizeArticle)
    .sort(sortByPublishedDesc);

  const israeliWar = normalized.filter((article) => article.isWarRelated && article.isIsraeliSource);
  const globalWar = normalized.filter((article) => article.isWarRelated && !article.isIsraeliSource);
  const israeliRecent = normalized.filter((article) => !article.isWarRelated && article.isIsraeliSource);
  const remaining = normalized.filter((article) => !article.isWarRelated && !article.isIsraeliSource);

  return [...israeliWar, ...globalWar, ...israeliRecent, ...remaining].slice(0, limit);
}

async function parseRSSFeed(source) {
  try {
    const response = await axios.get(source.url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      httpsAgent: source.allowInsecure ? insecureHttpsAgent : undefined,
      validateStatus: (status) => status >= 200 && status < 400,
      responseType: 'text',
    });

    const xmlPayload = String(response.data || '')
      .replace(/&(?!#?\w+;)/g, '&amp;')
      .replace(
        /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/gi,
        (_, content) => `<content:encoded>${content}</content:encoded>`
      );

    const result = await parser.parseStringPromise(xmlPayload);
    const items = result.rss?.channel?.item || result.feed?.entry || [];
    const itemArray = Array.isArray(items) ? items : [items];

    return itemArray
      .filter(Boolean)
      .map((item) => {
        const rawTitle = getItemText(item, ['title']) || 'ללא כותרת';
        const rawLink = getItemText(item, ['link']) || item.id || '#';
        const rawDescription =
          getItemText(item, ['description', 'summary', 'content:encoded', 'content']) || '';
        const rawPubDate = normalizePubDate(
          item.pubDate || item.published || item.updated || item.created || item.date
        );
        const mergedText = `${rawTitle} ${rawDescription}`;

        return normalizeArticle({
          title: rawTitle,
          link: rawLink,
          description: rawDescription,
          pubDate: rawPubDate,
          source: source.name,
          category: source.category,
          isWarRelated: isWarRelated(mergedText),
          isIranFrontWar: isIranFrontWarNews(mergedText),
        });
      })
      .filter((article) => article.title && article.link);
  } catch (error) {
    console.error(`[News] Error parsing ${source.name}:`, error.message);
    return [];
  }
}

function addToStore(newArticles) {
  const now = Date.now();
  newsStore.articles = newsStore.articles.filter(
    (article) => now - article.pubDate.getTime() < newsStore.maxAge
  );

  for (const article of newArticles) {
    const normalized = normalizeArticle(article);
    if (!shouldPersistArticle(normalized)) continue;
    const exists = newsStore.articles.some(
      (current) =>
        current.link === normalized.link ||
        (current.title === normalized.title && current.source === normalized.source)
    );
    if (!exists) {
      normalized.ingestedAtMs = Date.now();
      newsStore.articles.push(normalized);
    }
  }

  newsStore.articles.sort(sortByPublishedDesc);
  if (newsStore.articles.length > newsStore.maxCount) {
    newsStore.articles = newsStore.articles.slice(0, newsStore.maxCount);
  }

  console.log(`[News] Store updated: ${newsStore.articles.length} articles`);
  scheduleSaveNewsStore();
}

async function fetchAllNews() {
  console.log('[News] Starting fetch from', NEWS_SOURCES.length, 'sources...');
  const allArticles = [];

  await Promise.all(
    NEWS_SOURCES.map(async (source) => {
      const articles = await parseRSSFeed(source);
      allArticles.push(...articles);
      console.log(`[News] ${source.name}: ${articles.length} articles`);
    })
  );

  const prioritizedArticles = prioritizeArticles(allArticles, 720);
  addToStore(prioritizedArticles);
  const stored = getNews(80);
  console.log(`[News] Panel (Hebrew / Iran front): ${stored.length} articles in store`);
  return stored;
}

/**
 * טקסט מאוחד מכתבות מלחמה בחנות (לשכבת OSINT) — לא מסנן עברית כמו פאנל הווידג׳ט.
 */
function getNewsStoreWarRelatedBlob(maxItems = 100) {
  try {
    const now = Date.now();
    const parts = [];
    for (const a of newsStore.articles) {
      if (!a || a.pubDate == null) continue;
      const d = a.pubDate instanceof Date ? a.pubDate : new Date(a.pubDate);
      const t = d.getTime();
      if (!Number.isFinite(t) || now - t > newsStore.maxAge) continue;
      const blob = `${a.titleHe || ''} ${a.title || ''} ${a.description || ''}`;
      if (!isWarRelated(blob)) continue;
      const s = blob.trim();
      if (s.length > 4) parts.push(s);
      if (parts.length >= maxItems) break;
    }
    return parts.join(' | ');
  } catch (e) {
    console.warn('[News] getNewsStoreWarRelatedBlob:', e.message);
    return '';
  }
}

function getNews(limit = 50) {
  try {
    const now = Date.now();
    newsStore.articles = newsStore.articles.filter((article) => {
      if (!article || article.pubDate == null) return false;
      const d = article.pubDate instanceof Date ? article.pubDate : new Date(article.pubDate);
      const t = d.getTime();
      return Number.isFinite(t) && now - t < newsStore.maxAge;
    });
    const panel = newsStore.articles.filter((a) => {
      const head = `${a.titleHe || ''}${a.title || ''}`;
      if (!containsHebrew(head)) return false;
      const blob = `${a.titleHe || ''} ${a.title} ${a.description || ''}`;
      return isIranFrontWarNews(blob);
    });
    return prioritizeArticles(panel, limit);
  } catch (e) {
    console.warn('[News] getNews:', e.message);
    return [];
  }
}

let fetchInterval = null;

function startNewsService(io) {
  console.log('[News] Starting news aggregation service...');

  fetchAllNews()
    .then((articles) => {
      if (io) {
        io.emit('news_update', { articles, count: articles.length });
      }
    })
    .catch((error) => {
      console.log('[News] Initial fetch failed:', error.message);
    });

  fetchInterval = setInterval(async () => {
    try {
      const articles = await fetchAllNews();
      if (io) {
        io.emit('news_update', { articles: articles.slice(0, 20), count: articles.length });
      }
    } catch (error) {
      console.log('[News] Scheduled fetch failed:', error.message);
    }
  }, Number(process.env.NEWS_FETCH_INTERVAL_MS) > 5000 ? Number(process.env.NEWS_FETCH_INTERVAL_MS) : 90_000);

  console.log('[News] Service running (RSS polling + Socket push to clients)');
}

function stopNewsService() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
  if (newsStoreSaveTimer) {
    clearTimeout(newsStoreSaveTimer);
    newsStoreSaveTimer = null;
  }
  saveNewsStoreToDiskSync();
  console.log('[News] Service stopped');
}

module.exports = {
  startNewsService,
  stopNewsService,
  fetchAllNews,
  getNews,
  getNewsStoreWarRelatedBlob,
  newsStore,
};
