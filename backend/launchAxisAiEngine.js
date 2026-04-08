/**
 * מנוע חקירת מוצא שיגור (AI) — בונה קורפוס ממקורות האתר ומחזיר הערכת ציר לכל יעד פעיל.
 * דורש OPENAI_API_KEY. לא מחליף פיקוד — משלים ומתקן מסלול כשהביטחון מספיק (בהתאם לסף ב-server).
 */
'use strict';

const axios = require('axios');
const { getNewsStoreWarRelatedBlob } = require('./NewsService');
const { refreshOsintHints, getOsintDebugSnapshot } = require('./osintHintService');

let lastOsintRefreshForAi = 0;
const OSINT_AI_MIN_GAP_MS = Math.max(15_000, Number(process.env.LAUNCH_AXIS_AI_OSINT_MIN_GAP_MS) || 25_000);

async function maybeRefreshOsintForLaunchAi() {
  const now = Date.now();
  if (now - lastOsintRefreshForAi < OSINT_AI_MIN_GAP_MS) return;
  lastOsintRefreshForAi = now;
  try {
    await refreshOsintHints(getNewsStoreWarRelatedBlob, { burst: false });
  } catch (_) {
    /* */
  }
}

function normalizeLaunchAxis(s) {
  const x = String(s || '')
    .toLowerCase()
    .trim();
  if (!x || x === 'unknown' || x === 'null') return 'unknown';
  if (['iran', 'ir', 'tehran', 'irgc', 'persia'].includes(x)) return 'iran';
  if (['iraq', 'irq', 'baghdad'].includes(x)) return 'iraq';
  if (['yemen', 'houthi', 'houthis', 'sanaa', 'ansarallah'].includes(x)) return 'yemen';
  if (['lebanon', 'hezbollah', 'hizbullah', 'beirut'].includes(x)) return 'lebanon';
  if (['gaza', 'hamas', 'gaza strip'].includes(x)) return 'gaza';
  if (['syria', 'damascus'].includes(x)) return 'syria';
  if (['iran', 'iraq', 'yemen', 'lebanon', 'gaza', 'syria'].includes(x)) return x;
  return 'unknown';
}

/**
 * @param {{
 *   getNewsStoreWarRelatedBlob?: function,
 *   getGdeltSample?: function,
 *   getPredictionSnippet?: function,
 *   getNewsThreatAxisHint?: function,
 * }} deps
 */
async function buildLaunchInvestigationCorpus(deps = {}) {
  await maybeRefreshOsintForLaunchAi();

  const parts = [];
  const newsFn = deps.getNewsStoreWarRelatedBlob || getNewsStoreWarRelatedBlob;
  const newsBlob = typeof newsFn === 'function' ? newsFn(160) : '';
  if (newsBlob && String(newsBlob).trim()) {
    parts.push('=== News store (war-related headlines) ===\n' + String(newsBlob).slice(0, 7000));
  }

  try {
    const os = getOsintDebugSnapshot();
    if (os.axis != null) {
      parts.push(`=== OSINT aggregate: axis=${os.axis} confidence=${os.confidence} chunks=${os.chunkCount} ===`);
    }
    if (Array.isArray(os.matchedHints) && os.matchedHints.length) {
      parts.push('=== OSINT directional hints ===\n' + JSON.stringify(os.matchedHints.slice(0, 16)));
    }
  } catch (_) {
    /* */
  }

  const gd = typeof deps.getGdeltSample === 'function' ? deps.getGdeltSample() : '';
  if (gd && String(gd).trim()) {
    parts.push('=== GDELT / doc sample titles ===\n' + String(gd).slice(0, 2800));
  }

  const pred = typeof deps.getPredictionSnippet === 'function' ? deps.getPredictionSnippet() : '';
  if (pred && String(pred).trim()) {
    parts.push('=== Prediction markets (context) ===\n' + String(pred).slice(0, 900));
  }

  const newsAxisHint = typeof deps.getNewsThreatAxisHint === 'function' ? deps.getNewsThreatAxisHint() : '';
  if (newsAxisHint && String(newsAxisHint).trim()) {
    parts.push(
      '=== Hebrew news widget (OREF_NEWS_AXIS_HINT) — headlines blob ===\n' + String(newsAxisHint).slice(0, 2200)
    );
  }

  return parts.join('\n\n').slice(0, 13000);
}

function parseJsonFromModelContent(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonStr = fence ? fence[1].trim() : s;
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    const i = jsonStr.indexOf('{');
    const j = jsonStr.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(jsonStr.slice(i, j + 1));
      } catch (_) {
        /* */
      }
    }
  }
  return null;
}

function normalizeCityKey(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function inferenceFromRowForMissile(row, m) {
  if (!row || typeof row !== 'object' || !m?.id) return null;
  const axis = normalizeLaunchAxis(row.launchAxis);
  let conf = Math.max(0, Math.min(1, Number(row.confidence) || 0));
  const evidence = Array.isArray(row.evidence)
    ? row.evidence.map((e) => String(e).trim()).filter(Boolean).slice(0, 4)
    : [];
  const lockSuggested = row.lockSuggested === true;
  if (lockSuggested && conf >= 0.74) conf = Math.max(conf, 0.755);
  return {
    missileId: m.id,
    launchAxis: axis,
    confidence: conf,
    evidence,
    lockSuggested,
  };
}

function resolveMissileForRow(row, ord, missiles) {
  const idx = Number(row && row.i);
  if (Number.isFinite(idx) && idx >= 0 && idx < missiles.length) {
    return missiles[idx];
  }
  const want = normalizeCityKey(row && (row.city || row.cityName || row.targetCity));
  if (want) {
    const hit = missiles.find((mm) => normalizeCityKey(mm.cityName) === want);
    if (hit) return hit;
  }
  if (Number.isFinite(ord) && ord >= 0 && ord < missiles.length) return missiles[ord];
  return null;
}

/**
 * קריאת API אחת לכל הטילים הפעילים (אותו קורפוס).
 * @returns {Promise<Map<string, { launchAxis: string, confidence: number, evidence: string[], lockSuggested: boolean }>>}
 */
async function inferLaunchAxesForMissiles(missiles, corpus) {
  const out = new Map();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey || !Array.isArray(missiles) || missiles.length === 0) return out;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxTok = Math.min(1200, Math.max(400, Number(process.env.LAUNCH_AXIS_AI_MAX_TOKENS) || 700));

  const targets = missiles.map((m, i) => {
    const textParts = [
      m.alertContext && m.alertContext.title,
      m.alertContext && m.alertContext.orefTextBlob,
      m.title,
      m.orefTextBlob,
    ].filter(Boolean);
    const orefExcerpt = textParts.join(' | ').slice(0, 560);
    return {
      i,
      id: m.id,
      city: String(m.cityName || '').trim() || 'unknown',
      currentAxis: m.sourceRegion || 'unknown',
      orefExcerpt: orefExcerpt || '(no Oref text on missile)',
    };
  });

  const n = targets.length;
  let corpusBody = String(corpus || '').trim();
  if (corpusBody.length < 40) {
    corpusBody =
      '(No aggregated corpus yet — use each target’s Oref/text block below plus your knowledge; prefer unknown if unsupported.)';
  }

  const userPrompt =
    'You are a military/OSINT analyst. Given the corpus (mixed Hebrew, English, Arabic) and per-target excerpts from Pikud HaOref-style alerts, estimate the **geographic launch origin** of projectiles (rockets/missiles) toward Israel for the CURRENT wave.\n\n' +
    'Corpus:\n' +
    corpusBody.slice(0, 11000) +
    '\n\nTargets — you MUST return exactly ' +
    n +
    ' objects in items[], one per index 0..' +
    (n > 0 ? n - 1 : 0) +
    ':\n' +
    targets.map((t) => `[${t.i}] city="${t.city}" current_map_axis=${t.currentAxis}\nOref/text: ${t.orefExcerpt}`).join('\n\n') +
    '\n\nReturn ONLY valid JSON: {"items":[{"i":0,"launchAxis":"iran|iraq|yemen|lebanon|gaza|syria|unknown","confidence":0.0,"lockSuggested":false,"evidence":["max 3 short reasons citing corpus or excerpt"]}]}\n' +
    'Rules:\n' +
    '- launchAxis = country/area of launch toward Israel (not impact).\n' +
    '- unknown + low confidence if corpus does not support a specific origin.\n' +
    '- lockSuggested true only if confidence >= 0.74 and evidence is specific.\n' +
    '- Each items[] element MUST include "i" matching the target index. Optional: also include "city" with the same Hebrew city name for verification.';

  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        temperature: 0.15,
        max_tokens: maxTok,
        messages: [
          {
            role: 'system',
            content:
              'Answer with JSON only. No markdown outside JSON. Be conservative when evidence is weak.',
          },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: Math.max(20_000, Number(process.env.LAUNCH_AXIS_AI_TIMEOUT_MS) || 55_000),
        validateStatus: (s) => s >= 200 && s < 500,
      }
    );
    if (r.status !== 200 || !r.data?.choices?.[0]?.message?.content) {
      console.warn('[LaunchAxisAI] API status', r.status);
      return out;
    }
    const parsed = parseJsonFromModelContent(r.data.choices[0].message.content);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
    const seenMissileIds = new Set();

    for (let ord = 0; ord < items.length; ord++) {
      const row = items[ord];
      if (!row || typeof row !== 'object') continue;
      const m = resolveMissileForRow(row, ord, missiles);
      const inf = inferenceFromRowForMissile(row, m);
      if (!inf || inf.launchAxis === 'unknown') continue;
      if (seenMissileIds.has(inf.missileId)) continue;
      seenMissileIds.add(inf.missileId);
      out.set(inf.missileId, {
        launchAxis: inf.launchAxis,
        confidence: inf.confidence,
        evidence: inf.evidence,
        lockSuggested: inf.lockSuggested,
      });
    }

    for (const m of missiles) {
      if (out.has(m.id)) continue;
      const want = normalizeCityKey(m.cityName);
      if (!want) continue;
      for (const row of items) {
        if (!row || typeof row !== 'object') continue;
        const c = normalizeCityKey(row.city || row.cityName || row.targetCity);
        if (!c || c !== want) continue;
        const inf = inferenceFromRowForMissile(row, m);
        if (!inf || inf.launchAxis === 'unknown') continue;
        out.set(inf.missileId, {
          launchAxis: inf.launchAxis,
          confidence: inf.confidence,
          evidence: inf.evidence,
          lockSuggested: inf.lockSuggested,
        });
        break;
      }
    }
  } catch (e) {
    console.warn('[LaunchAxisAI]', e.message || e);
  }
  return out;
}

/** לבדיקות: פענוח תשובת מודל */
function parseLaunchAxisAiResponseContent(content) {
  const p = parseJsonFromModelContent(content);
  return p && Array.isArray(p.items) ? p.items : [];
}

module.exports = {
  buildLaunchInvestigationCorpus,
  inferLaunchAxesForMissiles,
  normalizeLaunchAxis,
  parseLaunchAxisAiResponseContent,
};
