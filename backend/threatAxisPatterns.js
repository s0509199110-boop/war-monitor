/**
 * דפוסי טקסט לזיהוי ציר איום (מדינה/אזור משוער) — משותף לשרת ולשכבת OSINT.
 */

function matchThreatAxisInBlob(blob) {
  if (!blob || typeof blob !== 'string' || !blob.trim()) return null;
  const lower = blob.toLowerCase();

  if (
    /איראן|אירן|ایران|טהראן|tehran|\biran\b|irgc|התקפה מאיראן|שיגור.*איראן|בליסטי|איום.*איראן|אספהאן|איספהאן|שיראז|khamenei|qods force|sepah|شاهب|shahab|fateh-?110|خميني|الحرس الثوري/i.test(blob) ||
    /iran|ballistic|revolutionary guard/i.test(lower)
  ) {
    return 'iran';
  }
  if (/עיראק|בגדאד|iraq|\biraq\b|מוסול|בסרא|ארביל|mosul|basra|erbil|بغداد/i.test(blob)) return 'iraq';
  if (
    /תימן|חותי|חות'|הות'|ימן|yemen|houthi|ח\'ותי|צנעא|סנעא|עדן|aden|sanaa|ansarallah/i.test(blob)
  ) {
    return 'yemen';
  }
  if (
    /עזה|רצועת עזה|חמאס|hamas|גאפ|gaza strip|רפיח|רפח|חאן יונס|דיר אל בלח|צפון הרצועה|מחנה פליטים|ג׳באליה|גבאליה|north gaza|\brafah\b/i.test(
      blob
    )
  ) {
    return 'gaza';
  }
  if (
    /סוריה|דמשק|syria|\bsyria\b|חלב|חומס|אידליב|תדמור|קמישלי|aleppo|idlib|latakia|homs/i.test(blob)
  ) {
    return 'lebanon';
  }
  if (
    /לבנון|חיזבאללה|hezb|hezbollah|lebanon|דרום לבנון|ביירות|beirut|טריפולי|צפון לבנון|jbeil|bint jbeil|marjayoun|נבטיה|\btyr\b|\bsidon\b/i.test(
      blob
    )
  ) {
    return 'lebanon';
  }

  return null;
}

function matchExplicitThreatAxisInBlob(blob) {
  if (!blob || typeof blob !== 'string' || !blob.trim()) return null;
  const text = String(blob);

  if (/(מאיראן|מ\s*איראן|שוגר\s+מאיראן|שיגור\s+מאיראן|ירי\s+מאיראן|שיגורים\s+מאיראן|יציאה\s+מאיראן|יציאות\s+מאיראן|\bfrom iran\b|\biran launched\b)/i.test(text)) {
    return 'iran';
  }
  if (/(מעיראק|מ\s*עיראק|שוגר\s+מעיראק|שיגור\s+מעיראק|ירי\s+מעיראק|שיגורים\s+מעיראק|יציאה\s+מעיראק|יציאות\s+מעיראק|\bfrom iraq\b|\biraq launched\b)/i.test(text)) {
    return 'iraq';
  }
  if (/(מתימן|מ\s*תימן|שוגר\s+מתימן|שיגור\s+מתימן|ירי\s+מתימן|שיגורים\s+מתימן|יציאה\s+מתימן|יציאות\s+מתימן|מהחותים|מחותים|\bfrom yemen\b|\bfrom houthi\b)/i.test(text)) {
    return 'yemen';
  }
  if (/(מלבנון|מ\s*לבנון|ממרחב\s+צור|ממרחב\s+צידון|ממרחב\s+נבטיה|שוגר\s+מלבנון|שיגור\s+מלבנון|ירי\s+מלבנון|שיגורים\s+מלבנון|יציאה\s+מלבנון|יציאות\s+מלבנון|\bfrom lebanon\b|\bfrom tyre\b|\bfrom sidon\b)/i.test(text)) {
    return 'lebanon';
  }
  if (/(מעזה|מ\s*עזה|מרצועת\s+עזה|ממרחב\s+חאן\s+יונס|ממרחב\s+רפיח|ממרחב\s+ג'באליה|ממרחב\s+ג׳באליה|שוגר\s+מעזה|שיגור\s+מעזה|ירי\s+מעזה|שיגורים\s+מעזה|יציאה\s+מעזה|יציאות\s+מעזה|\bfrom gaza\b|\bfrom khan yunis\b|\bfrom rafah\b)/i.test(text)) {
    return 'gaza';
  }
  if (/(מסוריה|מ\s*סוריה|ממרחב\s+דמשק|ממרחב\s+חומס|ממרחב\s+דרעא|שוגר\s+מסוריה|שיגור\s+מסוריה|ירי\s+מסוריה|שיגורים\s+מסוריה|יציאה\s+מסוריה|יציאות\s+מסוריה|\bfrom syria\b|\bfrom damascus\b)/i.test(text)) {
    return 'lebanon';
  }

  return null;
}

module.exports = { matchThreatAxisInBlob, matchExplicitThreatAxisInBlob };
