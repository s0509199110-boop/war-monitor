'use strict';

/**
 * ניסוחים שמופיעים בלוג / בהתרעות הרשמיות של פיקוד העורף (אתר, alerts.json).
 * בלי ביטויים גנריים (למשל "אזעקה" לבד) שלא מזהים סוג התרעה ומבלבלים סיווג.
 * סדר בדיקה: שחרור → שהייה במרחב מוגן → התרעה מוקדמת (בדקות הקרובות) → ירי/חדירה.
 * בכל קבוצה הארוכים קודם.
 */

const RELEASE_PHRASES = [
  'האירוע הסתיים באזור',
  'האירוע הסתיים ביישוב',
  'האירוע הסתיים בעיר',
  'האירוע הסתיים עבור',
  'האירוע הסתיים',
  'ניתן לצאת מהמרחב המוגן',
  'ניתן לצאת מן הממ"ד',
  'ניתן לצאת מהממ"ד',
  'ניתן לצאת מן המרחב המוגן',
  'יכולים לצאת מהמרחב המוגן',
  'יכולים לצאת מן המרחב המוגן',
  'ההתרעה הסתיימה',
  'התרעה הסתיימה',
  'שוחררה ההתרעה',
  'התרעות שוחררו',
  'כל האירועים הסתיימו',
];

const HOLD_PHRASES = [
  'המשיכו להישאר במרחב המוגן',
  'הישארו במרחב המוגן',
  'הישארו בביתכם',
  'הישארו בבית',
  'הישארו במקלט',
];

const PRE_ALERT_PHRASES = [
  'בדקות הקרובות צפויות להתקבל התרעות באזורך',
  'בדקות הקרובות צפויות',
  'בדקות הקרובות',
];

const SIREN_PHRASES = [
  'חדירת כלי טיס עוין',
  'ירי רקטות וטילים',
  'חדירת כלי טיס',
  'ירי רקטות',
  'ירי טילים',
  'חדירת כטב"ם',
  'חדירת מלט"ם',
  'צבע אדום',
  'ירי בליסטי',
];

function sortPhrasesLongestFirst(phrases) {
  return [...phrases].sort((a, b) => String(b).length - String(a).length);
}

const RELEASE_ORDERED = sortPhrasesLongestFirst(RELEASE_PHRASES);
const HOLD_ORDERED = sortPhrasesLongestFirst(HOLD_PHRASES);
const PRE_ALERT_ORDERED = sortPhrasesLongestFirst(PRE_ALERT_PHRASES);
const SIREN_ORDERED = sortPhrasesLongestFirst(SIREN_PHRASES);

function normalizeGuidelineText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatchingPhrase(normalizedHaystack, phrases) {
  for (const phrase of phrases) {
    const n = normalizeGuidelineText(phrase);
    if (n && normalizedHaystack.includes(n)) {
      return phrase;
    }
  }
  return null;
}

function buildOrefGuidelineFullText(alert) {
  if (!alert || typeof alert !== 'object') {
    return '';
  }
  return [alert.title, alert.desc, alert.description, alert.msg, alert.message, alert.orefTextBlob]
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * @returns {{ phase: string, matchedPhrase: string|null }}
 * phase: 'released' | 'hold_after_siren' | 'pre_alert' | 'siren_active' | ''
 */
function classifyOrefGuidelinePhase(rawText) {
  const t = normalizeGuidelineText(rawText);
  if (!t) {
    return { phase: '', matchedPhrase: null };
  }

  let m = firstMatchingPhrase(t, RELEASE_ORDERED);
  if (m) {
    return { phase: 'released', matchedPhrase: m };
  }
  m = firstMatchingPhrase(t, HOLD_ORDERED);
  if (m) {
    return { phase: 'hold_after_siren', matchedPhrase: m };
  }
  m = firstMatchingPhrase(t, PRE_ALERT_ORDERED);
  if (m) {
    return { phase: 'pre_alert', matchedPhrase: m };
  }
  m = firstMatchingPhrase(t, SIREN_ORDERED);
  if (m) {
    return { phase: 'siren_active', matchedPhrase: m };
  }

  return { phase: '', matchedPhrase: null };
}

/**
 * כותרות מערך ההתרעות באתר (למשל alerts-history):
 * - "בדקות הקרובות צפויות להתקבל התרעות באזורך" (התרעה מוקדמת)
 * - "ירי רקטות וטילים" או ניסוח מפורש מה-JSON (חדירת כלי טיס עוין, כטב"ם, צבע אדום, וכו')
 * - "האירוע הסתיים"
 * בתוך אותו סיווג "ירי/חדירה" האתר מציג לעיתים כותרת משנה לפי הניסוח המדויק — resolveOfficialOrefFeedTag משחזר אותה מטקסט ההתרעה.
 */
const OFFICIAL_OREF_FEED_TAG = {
  released: 'האירוע הסתיים',
  pre_alert: 'בדקות הקרובות צפויות להתקבל התרעות באזורך',
  siren_active: 'ירי רקטות וטילים',
  hold_after_siren: 'הישארו במרחב המוגן',
};

/**
 * תג לפיד אירועים תואם לאתר: שלושת הסיווגים המרכזיים + שהייה במרחב מוגן.
 * לטקסט ירי/חדירה ספציפי (כטב"ם, צבע אדום) משתמשים בניסוח שזוהה מפיקוד העורף.
 */
function resolveOfficialOrefFeedTag(phase, rawAlertOrPayload) {
  const ph = String(phase || '').trim();
  if (ph === 'released') return OFFICIAL_OREF_FEED_TAG.released;
  if (ph === 'pre_alert') return OFFICIAL_OREF_FEED_TAG.pre_alert;
  if (ph === 'hold_after_siren') return OFFICIAL_OREF_FEED_TAG.hold_after_siren;
  if (ph === 'siren_active') {
    const blob = buildOrefGuidelineFullText(rawAlertOrPayload);
    const g = classifyOrefGuidelinePhase(blob);
    if (g.phase === 'siren_active' && g.matchedPhrase) {
      return g.matchedPhrase;
    }
    return OFFICIAL_OREF_FEED_TAG.siren_active;
  }
  return OFFICIAL_OREF_FEED_TAG.siren_active;
}

module.exports = {
  buildOrefGuidelineFullText,
  classifyOrefGuidelinePhase,
  normalizeGuidelineText,
  resolveOfficialOrefFeedTag,
  OFFICIAL_OREF_FEED_TAG,
};
