/**
 * חילוץ מסלולי איום (טילים / כטב"ם) מטקסט טלגרם באמצעות LLM — תואם גישת IWM (מקור ראשי משלים ל-Oref).
 * דורש OPENAI_API_KEY. ללא מפתח — הפונקציה מחזירה מערך ריק.
 */
'use strict';

const crypto = require('crypto');
const axios = require('axios');

const processedHashes = new Map();
const CACHE_MAX = 600;

/** סינון מקדים לחיסכון בעלות API */
const MISSILE_PREFILTER =
  /(טיל|שיגור|בליסט|ירי|רקט|יירוט|איום|rocket|missile|ballistic|hyperson|drone|\buav\b|houthis|حرب|صاروخ|إيران|یمن|فلسطين|غزة)/i;

const ZONE_DEFAULT_CITY = {
  north: 'חיפה',
  center: 'תל אביב-יפו',
  south: 'באר שבע',
  jerusalem: 'ירושלים',
};

function hashText(t) {
  return crypto.createHash('sha256').update(String(t || '')).digest('hex');
}

function pruneCache() {
  while (processedHashes.size > CACHE_MAX) {
    const first = processedHashes.keys().next().value;
    processedHashes.delete(first);
  }
}

function normalizeAiSource(s) {
  const x = String(s || '')
    .toLowerCase()
    .trim();
  if (!x) return null;
  if (['iran', 'ir', 'persia', 'tehran'].includes(x)) return 'iran';
  if (['iraq', 'irq', 'baghdad'].includes(x)) return 'iraq';
  if (['yemen', 'houthis', 'houthi', 'sanaa'].includes(x)) return 'yemen';
  if (['lebanon', 'hezbollah', 'hizbullah', 'beirut'].includes(x)) return 'lebanon';
  if (['gaza', 'hamas'].includes(x)) return 'gaza';
  if (['syria', 'damascus'].includes(x)) return 'syria';
  return ['iran', 'iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(x) ? x : null;
}

function normalizeTargetZone(z) {
  const x = String(z || '')
    .toLowerCase()
    .trim();
  if (['north', 'galilee', 'galil', 'tzafon'].includes(x)) return 'north';
  if (['center', 'central', 'merkaz', 'telaviv', 'gushdan'].includes(x)) return 'center';
  if (['south', 'negev', 'darom', 'eilat'].includes(x)) return 'south';
  if (['jerusalem', 'alquds'].includes(x)) return 'jerusalem';
  return null;
}

/**
 * @param {string[]} chunks טקסטים מטלגרם / בוט
 * @param {{ apiKey?: string, model?: string, minConfidence?: number }} options
 * @returns {Promise<Array<{ sourceRegion: string, targetZone: string|null, cityName: string, missileType: string, confidence: number, interceptionStatus: string, messageHash: string, rawExcerpt: string }>>}
 */
async function extractMissileTracksFromChunks(chunks, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
  const model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const minConfidence =
    Number.isFinite(Number(options.minConfidence)) && Number(options.minConfidence) > 0
      ? Number(options.minConfidence)
      : Math.max(0.5, Number(process.env.TELEGRAM_AI_MIN_CONFIDENCE) || 0.7);

  if (!apiKey) return [];

  const uniqueTexts = [
    ...new Set(
      (chunks || [])
        .map((c) => String(c || '').trim())
        .filter((c) => c.length > 8 && MISSILE_PREFILTER.test(c))
    ),
  ];

  const toProcess = [];
  for (const text of uniqueTexts) {
    const h = hashText(text);
    if (processedHashes.has(h)) continue;
    toProcess.push({ text: text.slice(0, 2500), hash: h });
    if (toProcess.length >= 6) break;
  }
  if (!toProcess.length) return [];

  const payloadDesc = toProcess
    .map((row, i) => `INDEX ${i} (hash_prefix ${row.hash.slice(0, 12)}):\n${row.text}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You analyze military/OSINT Telegram-style messages about Israel and regional conflicts.
Return ONLY JSON: {"items":[{"index":0,"isMissile":false,"source":"iran|iraq|yemen|lebanon|gaza|syria|null","targetZone":"north|center|south|jerusalem|null","targetCitiesHebrew":[],"missileType":"ballistic|cruise|rocket|uav|unknown","count":1,"interceptionStatus":"unknown|intercepted|impact","confidence":0.0}]}
Rules:
- One item per input INDEX (same order as messages).
- isMissile true only for actual or reported launches / inbound threats toward Israel from regional actors (rockets, missiles, major UAV waves). Not pure political news.
- source must be one of the enum or null if truly unknown.
- targetCitiesHebrew: Hebrew city names in Israel if explicitly mentioned (max 3).
- confidence 0-1 be conservative; use <0.5 if doubtful.
- If not a missile event for that message, isMissile false and confidence 0.`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Messages:\n\n${payloadDesc}` },
        ],
        temperature: 0.15,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      },
      {
        timeout: 28000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      }
    );

    if (response.status !== 200 || !response.data?.choices?.[0]?.message?.content) {
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(response.data.choices[0].message.content);
    } catch {
      return [];
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const out = [];

    for (const item of items) {
      const idx = Number(item?.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= toProcess.length) continue;

      const row = toProcess[idx];
      processedHashes.set(row.hash, Date.now());
      pruneCache();

      if (!item?.isMissile) continue;
      const conf = Number(item.confidence);
      if (!Number.isFinite(conf) || conf < minConfidence) continue;

      let sourceRegion = normalizeAiSource(item.source);
      if (!sourceRegion && typeof item.source === 'string') {
        sourceRegion = normalizeAiSource(String(item.source).split(/[\s,/]+/)[0]);
      }

      const rawType = String(item.missileType || 'unknown').toLowerCase();
      const missileType = ['ballistic', 'cruise', 'rocket', 'uav', 'unknown'].includes(rawType) ? rawType : 'unknown';

      let targetZone = normalizeTargetZone(item.targetZone);
      const cities = Array.isArray(item.targetCitiesHebrew) ? item.targetCitiesHebrew.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 3) : [];

      let cityName = cities[0] || null;
      if (!cityName && targetZone && ZONE_DEFAULT_CITY[targetZone]) {
        cityName = ZONE_DEFAULT_CITY[targetZone];
      }
      if (!cityName) {
        cityName = ZONE_DEFAULT_CITY.center;
        targetZone = targetZone || 'center';
      }

      const interceptionRaw = String(item.interceptionStatus || 'unknown').toLowerCase();
      const interceptionStatus = ['intercepted', 'impact', 'unknown'].includes(interceptionRaw)
        ? interceptionRaw
        : 'unknown';

      out.push({
        sourceRegion: sourceRegion || 'iran',
        targetZone: targetZone || null,
        cityName,
        missileType,
        count: Math.max(1, Math.min(50, Number(item.count) || 1)),
        confidence: Math.min(1, conf),
        interceptionStatus,
        messageHash: row.hash,
        rawExcerpt: row.text.slice(0, 320),
      });
    }

    return out;
  } catch {
    return [];
  }
}

module.exports = {
  extractMissileTracksFromChunks,
  ZONE_DEFAULT_CITY,
  MISSILE_PREFILTER,
};
