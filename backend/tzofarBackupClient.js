/**
 * גיבוי כש-pikud.gov JSON (alerts.json) לא נגיש: WebSocket של צופר / צבע אדום.
 * פרוטוקול הודעות מבוסס על אינטגרציות קהילתיות (לדוגמה homebridge-red-alert, MIT).
 * אינו מחליף את פיקוד העורף — מופעל רק כשהבקשה הרשמית נכשלת או שהתשובה אינה JSON תקין.
 *
 * נתוני id→שם יישוב: tzofar-cities.json (מקור: yalihart/homebridge-red-alert, MIT).
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CITIES_PATH = path.join(__dirname, 'data', 'tzofar-cities.json');

const THREAT_TITLE = {
  0: 'התרעת צבע אדום',
  2: 'חשש לחדירת מחבלים',
  5: 'חדירת מטוסים עוינים',
  7: 'איום טילים לא קונבנציונליים',
};

let idToHe = null;

function loadCityIdMap() {
  if (idToHe) return;
  idToHe = new Map();
  try {
    const raw = fs.readFileSync(CITIES_PATH, 'utf8');
    const j = JSON.parse(raw);
    const cities = j.cities || {};
    for (const [, info] of Object.entries(cities)) {
      if (!info || typeof info.id !== 'number') continue;
      const he = info.he || info.name;
      if (he) idToHe.set(info.id, String(he));
    }
  } catch (e) {
    console.warn('[Tzofar backup] לא נטען tzofar-cities.json:', e.message);
  }
}

function tzofarHeaderToken() {
  return crypto.randomBytes(16).toString('hex');
}

class TzofarBackupClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || process.env.TZOFAR_WS_URL || 'wss://ws.tzevaadom.co.il/socket?platform=ANDROID';
    this.enabled = options.enabled !== false;
    this.log = options.log || console;
    this.ws = null;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.shouldRun = false;
    /** city name (Hebrew as sent) -> { threat: number, ts: number } */
    this.activeCities = new Map();
    this.lastMessageAt = 0;
    this.connected = false;
    this.reconnectMs = Math.max(3000, Number(process.env.TZOFAR_BACKUP_RECONNECT_MS) || 12000);
  }

  start() {
    if (!this.enabled) {
      this.log.warn('[Tzofar backup] Cannot start: not enabled');
      return;
    }
    loadCityIdMap();
    this.shouldRun = true;
    this.log.info('[Tzofar backup] Starting WebSocket connection...');
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }

  resetShadowState() {
    this.activeCities.clear();
  }

  connect() {
    if (!this.shouldRun || !this.enabled) {
      this.log.warn('[Tzofar backup] Cannot connect: not running or not enabled');
      return;
    }
    loadCityIdMap();
    this.log.info(`[Tzofar backup] Attempting connection to: ${this.wsUrl}`);
    try {
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'User-Agent':
            process.env.TZOFAR_BACKUP_UA ||
            'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 WarMonitorBackup/1.0',
          Referer: 'https://www.tzevaadom.co.il',
          Origin: 'https://www.tzevaadom.co.il',
          tzofar: tzofarHeaderToken(),
        },
      });
    } catch (e) {
      this.log.warn('[Tzofar backup] WebSocket:', e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.log.info('[Tzofar backup] מחובר ל-WebSocket successfully');
      this.log.info(`[Tzofar backup] WebSocket URL: ${this.wsUrl}`);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.ping();
          } catch (_) {}
        }
      }, 60000);
    });

    this.ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (_) {}
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.log.warn(`[Tzofar backup] WebSocket closed: code=${code}, reason=${reason}`);
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      if (this.shouldRun) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log.error('[Tzofar backup] WebSocket error:', err.message);
      this.log.error('[Tzofar backup] Error details:', err);
    });
  }

  scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer) return;
    this.log.info(`[Tzofar backup] Scheduling reconnect in ${this.reconnectMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch (_) {}
        this.ws = null;
      }
      this.connect();
    }, this.reconnectMs);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.log.info(`[Tzofar backup] Received message type: ${msg.type}`);
    if (msg.type === 'ALERT' && msg.data) {
      this.log.info(`[Tzofar backup] ALERT received: ${msg.data.cities?.length || 0} cities`);
      this.handleAlert(msg.data);
      return;
    }
    if (msg.type === 'SYSTEM_MESSAGE' && msg.data) {
      this.handleSystemMessage(msg.data);
    }
  }

  handleAlert(data) {
    if (!data || data.isDrill) {
      this.log.info('[Tzofar backup] Alert ignored: drill or no data');
      return;
    }
    if (!Array.isArray(data.cities) || data.cities.length === 0) {
      this.log.info('[Tzofar backup] Alert ignored: no cities');
      return;
    }
    const threat = Number.isFinite(Number(data.threat)) ? Number(data.threat) : 0;
    const ts = Date.now();
    this.log.info(`[Tzofar backup] Processing ${data.cities.length} cities, threat=${threat}`);
    for (const c of data.cities) {
      if (typeof c !== 'string' || !c.trim()) continue;
      if (c === 'רחבי הארץ') {
        this.log.warn('[Tzofar backup] התרעה ארצית — אין הרחבה ליישובים ספציפיים בגיבוי');
        continue;
      }
      this.activeCities.set(c.trim(), { threat, ts });
      this.log.info(`[Tzofar backup] Added city: ${c.trim()}`);
    }
    this.log.info(`[Tzofar backup] Total active cities: ${this.activeCities.size}`);
  }

  handleSystemMessage(data) {
    if (!data || typeof data !== 'object') return;
    const title = String(data.titleHe || '');
    const body = String(data.bodyHe || '');
    const exitKw = ['האירוע הסתיים', 'הסתיים באזורים', 'האירוע הסתיים באזורים'];
    const isExit = title.includes('עדכון פיקוד העורף') && exitKw.some((k) => body.includes(k));
    if (!isExit) return;
    const ids = Array.isArray(data.citiesIds) ? data.citiesIds : [];
    loadCityIdMap();
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) continue;
      const name = idToHe && idToHe.get(id);
      if (name) this.activeCities.delete(name);
    }
  }

  /**
   * מבנה דמוי-alerts.json עבור normalizeOrefAlerts
   */
  buildOrefLikePayload() {
    this.log.info(`[Tzofar backup] buildOrefLikePayload called, activeCities.size=${this.activeCities.size}`);
    if (this.activeCities.size === 0) return [];
    const grouped = new Map();
    for (const [cityName, info] of this.activeCities.entries()) {
      const t = info.threat;
      if (!grouped.has(t)) grouped.set(t, []);
      grouped.get(t).push(cityName);
    }
    const out = [];
    let idx = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [threat, cities] of grouped.entries()) {
      const titleBase = THREAT_TITLE[threat] || 'התרעת צבע אדום';
      const cat = threat === 5 ? 2 : 1;
      const threatType = threat === 5 ? 'uav' : 'missile';
      out.push({
        id: `tzofar-backup-${threat}-${nowSec}-${idx++}`,
        title: `${titleBase} · גיבוי צופר`,
        data: cities,
        time: nowSec,
        cat,
        category: cat,
        threatType,
        _tzofarBackup: true,
      });
    }
    return out;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      lastMessageAt: this.lastMessageAt,
      activeCityCount: this.activeCities.size,
      wsUrl: this.wsUrl,
    };
  }
}

module.exports = { TzofarBackupClient, loadCityIdMap };
