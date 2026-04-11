# Keep-Alive Setup Guide - הפיכת השרת לזמין תמיד

## 🎯 הבעיה
Render Free Tier מכבה שרתים אחרי 15 דקות של חוסר פעילות.
זמן ההתעוררות (cold start) יכול לקחת 30-60 שניות.

## ✅ הפתרונות שלנו

### 1. GitHub Actions (כבר פועל)
- רץ כל 5 דקות
- קובץ: `.github/workflows/keepalive.yml`

### 2. cron-job.org (הוסף ידנית) ⭐ מומלץ
- חינם לחלוטין
- מדויק לשניה
- פחות מ-5 דקות!

#### שלבי הגדרה:
1. היכנס ל: https://cron-job.org/en/
2. צור חשבון חינם
3. לחץ "Create cronjob"
4. הגדרות:
   - **Title**: War Monitor Keep Alive
   - **Address**: `https://war-monitor-d02.onrender.com/health`
   - **Schedule**: Every 4 minutes
   - **HTTP Method**: GET
   - **Timeout**: 30 seconds
5. לחץ "Create"

### 3. UptimeRobot (גיבוי)
- https://uptimerobot.com
- מסוג "Heartbeat"
- כל 5 דקות

### 4. Ping-Monitor (סקריפט לוקאלי)
```bash
# הרץ במחשב שלך:
node keep-alive.js
```

---

## 🚀 פתרון הקסם: Render Starter Plan

**עלות**: $7/חודש (כ-25 ש"ח)

**יתרונות**:
- ✅ השרת תמיד פעיל - אף פעם לא נכנס ל-sleep
- ✅ התעוררות מיידית - 0 שניות!
- ✅ יותר RAM ו-CPU
- ✅ תמיכה טובה יותר

**לשדרוג**:
1. היכנס: https://dashboard.render.com
2. בחר את השירות `war-monitor`
3. Settings → Change Plan
4. בחר Starter
5. Deploy

---

## 📊 השוואת זמנים

| פתרון | זמן התעוררות | עלות |
|-------|-------------|------|
| GitHub Actions בלבד | עד 5 דקות | חינם |
| + cron-job.org | עד 4 דקות | חינם |
| + UptimeRobot | עד 3 דקות | חינם |
| כל השירותים יחד | עד 2 דקות | חינם |
| **Render Starter** | **0 שניות** | **$7/חודש** |

---

## 🎯 המלצה מיידית

**לשדרוג מיידי של המהירות**:

1. **הכי מהיר**: שדרג ל-Starter ($7/חודש)
2. **חינם**: הוסף cron-job.org (פחות מ-5 דקות עבודה)
3. **מקסימום חינם**: השתמש בכל השירותים ביחד

**הגדרה מומלצת**:
- GitHub Actions: כל 5 דקות ✅ (כבר פועל)
- cron-job.org: כל 4 דקutes ⭐ (הוסף עכשיו)
- UptimeRobot: כל 5 דקות (גיבוי)

כך השרת יהיה פעיל תמיד או יתעורר תוך שניות ספורות!
