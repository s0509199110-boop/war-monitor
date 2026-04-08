const axios = require('axios');
const { getCityCoordinates, getDefaultCoordinates } = require('./citiesMap');

const CONFIG = {
  OREF_LATEST_URL: 'https://www.oref.org.il/WarningMessages/Alert/alerts.json',
  POLL_INTERVAL: 1500,
  REQUEST_HEADERS: {
    Referer: 'https://www.oref.org.il/',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
};

const state = {
  processedAlertIds: new Set(),
  activeCities: new Set(),
  activeAlerts: new Map(),
  isRunning: false,
  consecutiveErrors: 0,
  maxConsecutiveErrors: 10,
  lastAlertTime: null,
};

let pollIntervalId = null;

function determineSeverity(alert, cityName) {
  const majorCities = ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'];
  if (majorCities.some((city) => cityName.includes(city))) {
    return 'critical';
  }

  if (alert.threat && String(alert.threat).includes('טיל')) {
    return 'high';
  }

  if (alert.category === 1 || alert.isImmediate) {
    return 'high';
  }

  return 'medium';
}

function parseOrefAlerts(payload) {
  if (!payload) {
    return [];
  }

  let rawAlerts = [];
  if (Array.isArray(payload)) {
    rawAlerts = payload;
  } else if (Array.isArray(payload.alerts)) {
    rawAlerts = payload.alerts;
  } else if (payload.data && Array.isArray(payload.data) && !payload.title && !payload.id) {
    rawAlerts = [payload];
  } else if (typeof payload === 'object') {
    rawAlerts = [payload];
  }

  const parsed = [];

  for (const alert of rawAlerts) {
    const cities = Array.isArray(alert.data)
      ? alert.data
      : Array.isArray(alert.cities)
      ? alert.cities
      : Array.isArray(alert.locations)
      ? alert.locations
      : typeof alert.data === 'string'
      ? [alert.data]
      : [];

    if (cities.length === 0) {
      continue;
    }

    const baseId =
      alert.id ||
      `${alert.date || ''}-${alert.time || ''}-${alert.title || ''}-${cities.join('|')}`;

    if (state.processedAlertIds.has(baseId)) {
      continue;
    }

    state.processedAlertIds.add(baseId);
    if (state.processedAlertIds.size > 5000) {
      const ids = Array.from(state.processedAlertIds).slice(-2500);
      state.processedAlertIds = new Set(ids);
    }

    cities.forEach((cityName, index) => {
      const coords = getCityCoordinates(cityName) || getDefaultCoordinates();

      parsed.push({
        id: `${baseId}-${index}`,
        originalId: baseId,
        cityName,
        coordinates: [coords.lng, coords.lat],
        title: alert.title || 'התרעת צבע אדום',
        instructions: alert.instructions || alert.desc || 'היכנסו למרחב מוגן',
        threatType: alert.threat || 'טילים',
        severity: determineSeverity(alert, cityName),
        timestamp: new Date().toISOString(),
        originalTime: alert.time || alert.datetime || null,
        metadata: {
          area: alert.area || null,
          category: alert.category || null,
          date: alert.date || null,
        },
      });
    });
  }

  return parsed;
}

function calculateDistanceKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function estimateLaunchSource([targetLng, targetLat]) {
  if (targetLat > 32.8) {
    return {
      coordinates: [35.4, 33.3],
      confidence: 'high',
      source: 'דרום לבנון',
      threat: 'רקטות וטילים קצרי טווח',
    };
  }

  if (targetLat < 31.0) {
    if (targetLng > 35.0) {
      return {
        coordinates: [44.2, 15.4],
        confidence: 'medium',
        source: 'תימן / חות׳ים',
        threat: 'טילים בליסטיים וכטב״מים',
      };
    }

    return {
      coordinates: [34.3, 31.4],
      confidence: 'high',
      source: 'רצועת עזה',
      threat: 'רקטות קצרות טווח',
    };
  }

  return {
    coordinates: [51.7, 32.6],
    confidence: 'medium',
    source: 'איראן / עיראק',
    threat: 'טילים בליסטיים ארוכי טווח',
  };
}

function createMissileTrajectory(alert) {
  if (!alert.coordinates || alert.coordinates.length !== 2) {
    return null;
  }

  const targetPosition = alert.coordinates;
  const launchEstimate = estimateLaunchSource(targetPosition);
  const sourcePosition = launchEstimate.coordinates;
  const distance = calculateDistanceKm(sourcePosition, targetPosition);
  const estimatedDuration = Math.max(12, Math.round((distance / 5.5) * 60));

  return {
    id: alert.id || `missile-${Date.now()}`,
    alertId: alert.originalId,
    cityName: alert.cityName,
    sourcePosition,
    targetPosition,
    sourceCountry: launchEstimate.source,
    sourceLocation: launchEstimate.source,
    estimatedDuration,
    distance: Math.round(distance),
    confidence: launchEstimate.confidence,
    threatType: launchEstimate.threat,
    severity: alert.severity,
    status: 'in-flight',
    phase: 'launch',
    timestamp: new Date().toISOString(),
    launchTimestamp: new Date().toISOString(),
    impactEta: new Date(Date.now() + estimatedDuration * 1000).toISOString(),
    intercept: null,
    impact: {
      expected: true,
      coordinates: targetPosition,
    },
  };
}

function broadcastMissileLaunch(io, missileData) {
  if (!io || !missileData) {
    return;
  }

  io.emit('missile_launch', missileData);
  io.emit('missile_update', missileData);
}

async function fetchOrefAlerts() {
  try {
    const response = await axios.get(CONFIG.OREF_LATEST_URL, {
      headers: CONFIG.REQUEST_HEADERS,
      timeout: 5000,
      decompress: true,
    });

    state.consecutiveErrors = 0;
    return parseOrefAlerts(response.data);
  } catch (error) {
    state.consecutiveErrors += 1;
    console.error('[Oref] Error:', error.message);

    if (state.consecutiveErrors >= state.maxConsecutiveErrors) {
      console.error('[Oref] Too many consecutive errors, stopping service');
      stopOrefService();
    }

    return [];
  }
}

async function fetchAndBroadcast(io) {
  const alerts = await fetchOrefAlerts();
  const currentCities = new Set(alerts.map((alert) => alert.cityName));

  for (const city of state.activeCities) {
    if (!currentCities.has(city)) {
      io.emit('clear_city_alert', {
        city,
        timestamp: new Date().toISOString(),
        message: `ההתראה ב${city} שוחררה`,
      });
    }
  }

  if (state.activeCities.size > 0 && currentCities.size === 0) {
    io.emit('clear_all_threats', {
      timestamp: new Date().toISOString(),
      message: 'כל האיומים שוחררו - ניתן לצאת מהמרחב המוגן',
    });
  }

  state.activeCities = currentCities;

  if (alerts.length > 0) {
    alerts.forEach((alert) => {
      io.emit('new_alert', alert);

      const missile = createMissileTrajectory(alert);
      if (missile) {
        broadcastMissileLaunch(io, missile);
      }

      state.activeAlerts.set(alert.id, {
        ...alert,
        receivedAt: Date.now(),
      });
    });

    io.emit('alerts_batch', {
      alerts,
      count: alerts.length,
      timestamp: new Date().toISOString(),
    });

    state.lastAlertTime = new Date().toISOString();
    return;
  }

  if (state.activeAlerts.size > 0) {
    io.emit('alert_release', {
      message: 'פיקוד העורף שחרר את כל ההתראות - ניתן לצאת מהמרחב המוגן',
      timestamp: new Date().toISOString(),
      releasedAlerts: Array.from(state.activeAlerts.values()).map((alert) => ({
        cityName: alert.cityName,
        receivedAt: alert.receivedAt,
      })),
    });
    state.activeAlerts.clear();
  }
}

function startOrefService(io) {
  if (state.isRunning) {
    return;
  }

  state.isRunning = true;
  state.consecutiveErrors = 0;
  fetchAndBroadcast(io);
  pollIntervalId = setInterval(() => fetchAndBroadcast(io), CONFIG.POLL_INTERVAL);
  console.log(`[Oref] Service running (polling every ${CONFIG.POLL_INTERVAL}ms)`);
}

function stopOrefService() {
  if (!state.isRunning) {
    return;
  }

  state.isRunning = false;
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

function getServiceStatus() {
  return {
    isRunning: state.isRunning,
    lastAlertTime: state.lastAlertTime,
    processedAlertsCount: state.processedAlertIds.size,
    consecutiveErrors: state.consecutiveErrors,
    pollInterval: CONFIG.POLL_INTERVAL,
    activeCities: Array.from(state.activeCities),
  };
}

module.exports = {
  startOrefService,
  stopOrefService,
  getServiceStatus,
  fetchOrefAlerts,
};
