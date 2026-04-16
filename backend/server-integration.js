// ==========================================
// server-integration.js - Real-Time Missile Layer Integration
// War Monitor - REAL MISSILE TRAJECTORIES ONLY
// ==========================================

/**
 * Real-Time Missile Layer Integration
 * ׳׳¢׳¨׳›׳× ׳©׳™׳’׳•׳¨ ׳˜׳™׳׳™׳ ׳‘׳–׳׳ ׳׳׳× ׳׳‘׳•׳¡׳¡׳× ׳׳–׳¢׳§׳•׳× ׳׳׳× ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£
 */

const { startOrefService } = require('./OrefAlertService');

// ==========================================
// Geographic Missile Source Estimation
// ==========================================

/**
 * ׳׳—׳©׳‘ ׳׳× ׳׳§׳•׳¨ ׳”׳©׳™׳’׳•׳¨ ׳”׳׳©׳•׳¢׳¨ ׳׳₪׳™ ׳׳™׳§׳•׳ ׳”׳׳˜׳¨׳”
 * @param {number} targetLat - ׳§׳• ׳¨׳•׳—׳‘ ׳©׳ ׳”׳׳˜׳¨׳”
 * @param {number} targetLng - ׳§׳• ׳׳•׳¨׳ ׳©׳ ׳”׳׳˜׳¨׳”
 * @returns {Object} - ׳׳•׳‘׳™׳™׳§׳˜ ׳¢׳ sourceLat, sourceLng, sourceName
 */
// Bint Jbeil (בינת ג'בל) - South Lebanon, land-based only
const BINT_JBEIL_ANCHOR = { lat: 33.12, lng: 35.43 };

function estimateMissileSource(targetLat, targetLng) {
  // ALWAYS return Bint Jbeil (בינת ג'בל) - land-based, no sea launches
  return {
    sourceLat: BINT_JBEIL_ANCHOR.lat + (Math.random() - 0.5) * 0.05,
    sourceLng: BINT_JBEIL_ANCHOR.lng + (Math.random() - 0.5) * 0.05,
    sourceName: 'לבנון (בינת ג\'בל)',
    sourceCountry: 'LB',
    missileType: 'רקטה/טיל נ"ט'
  };
}

// ==========================================
// Missile Event Handler
// ==========================================

/**
 * ׳™׳•׳¦׳¨ ׳׳•׳‘׳™׳™׳§׳˜ ׳©׳™׳’׳•׳¨ ׳˜׳™׳ ׳׳׳
 * @param {Object} alert - ׳׳•׳‘׳™׳™׳§׳˜ ׳׳–׳¢׳§׳” ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£
 * @returns {Object} - ׳׳•׳‘׳™׳™׳§׳˜ ׳©׳™׳’׳•׳¨ ׳˜׳™׳ ׳׳׳
 */
function createMissileLaunchEvent(alert) {
  const targetLat = alert.lat || alert.latitude;
  const targetLng = alert.lng || alert.longitude;
  
  // ALWAYS use Bint Jbeil (בינת ג'בל) - land-based, no sea launches
  const source = estimateMissileSource(targetLat, targetLng);
  
  const now = Date.now();
  // Consistent flight duration for Lebanon (Bint Jbeil) - ~12 seconds
  const flightDuration = 12000;
  
  return {
    id: `missile-${now}-${Math.random().toString(36).substr(2, 9)}`,
    source: [source.sourceLng, source.sourceLat],
    target: [targetLng, targetLat],
    sourceName: source.sourceName,
    sourceCountry: source.sourceCountry,
    missileType: source.missileType,
    targetName: alert.name || alert.city || 'אזור לא ידוע',
    timestamp: now,
    duration: flightDuration,
    status: 'in_flight'
  };
}

// ==========================================
// server-integration.js - ׳©׳¨׳× ׳׳©׳•׳׳‘ ׳¢׳ ׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£
// ==========================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8080;

// ==========================================
// ׳§׳•׳ ׳₪׳™׳’׳•׳¨׳¦׳™׳”
// ==========================================
const OREF_URL = 'https://www.oref.org.il/warningMessages/alert/alerts.json';
const POLL_INTERVAL = 3000; // 3 ׳©׳ ׳™׳•׳×

// ׳§׳•׳׳•׳¨׳“׳™׳ ׳˜׳•׳× ׳™׳“׳•׳¢׳•׳× ׳©׳ ׳¢׳¨׳™׳ ׳‘׳™׳©׳¨׳׳
const CITY_COORDINATES = {
  '׳×׳ ׳׳‘׳™׳‘': { lat: 32.0853, lng: 34.7818 },
  '׳™׳¨׳•׳©׳׳™׳': { lat: 31.7683, lng: 35.2137 },
  '׳—׳™׳₪׳”': { lat: 32.794, lng: 34.9896 },
  '׳‘׳׳¨ ׳©׳‘׳¢': { lat: 31.252, lng: 34.7915 },
  '׳׳©׳“׳•׳“': { lat: 31.8015, lng: 34.6431 },
  '׳׳©׳§׳׳•׳': { lat: 31.6695, lng: 34.5715 },
  '׳¨׳׳× ׳’׳': { lat: 32.0823, lng: 34.8106 },
  '׳’׳‘׳¢׳×׳™׳™׳': { lat: 32.0722, lng: 34.8089 },
  '׳¨׳׳©׳•׳ ׳׳¦׳™׳•׳': { lat: 31.9734, lng: 34.7925 },
  '׳₪׳×׳— ׳×׳§׳•׳•׳”': { lat: 32.0872, lng: 34.8878 },
  '׳ ׳×׳ ׳™׳”': { lat: 32.3329, lng: 34.8578 },
  '׳”׳¨׳¦׳׳™׳”': { lat: 32.1628, lng: 34.8446 },
  '׳—׳“׳¨׳”': { lat: 32.4362, lng: 34.9199 },
  '׳ ׳”׳¨׳™׳”': { lat: 33.0075, lng: 35.0981 },
  '׳¢׳›׳•': { lat: 32.9281, lng: 35.0769 },
  '׳¦׳₪׳×': { lat: 32.9646, lng: 35.496 },
  '׳˜׳‘׳¨׳™׳”': { lat: 32.792, lng: 35.539 },
  '׳›׳¨׳׳™׳׳': { lat: 32.9175, lng: 35.304 },
  '׳׳•׳“׳™׳¢׳™׳': { lat: 31.898, lng: 35.0104 },
  '׳¨׳¢׳ ׳ ׳”': { lat: 32.1931, lng: 34.882 },
  '׳›׳₪׳¨ ׳¡׳‘׳': { lat: 32.1777, lng: 34.9085 },
  '׳™׳‘׳ ׳”': { lat: 31.8784, lng: 34.745 },
  '׳¨׳—׳•׳‘׳•׳×': { lat: 31.8974, lng: 34.8097 },
  '׳ ׳¡ ׳¦׳™׳•׳ ׳”': { lat: 31.9293, lng: 34.7987 },
  '׳׳•׳“': { lat: 31.9514, lng: 34.8912 },
  '׳¨׳׳׳”': { lat: 31.9296, lng: 34.873 },
  '׳¢׳₪׳•׳׳”': { lat: 32.6101, lng: 35.2892 },
  '׳‘׳™׳× ׳©׳׳': { lat: 32.4988, lng: 35.5023 },
  '׳˜׳™׳™׳‘׳”': { lat: 32.2672, lng: 35.0089 },
  '׳©׳“׳¨׳•׳×': { lat: 31.5264, lng: 34.5969 },
  '׳׳™׳׳×': { lat: 29.5581, lng: 34.9482 }
};

// ׳׳™׳§׳•׳׳™ ׳׳§׳•׳¨׳•׳× ׳©׳™׳’׳•׳¨
const SOURCE_COORDINATES = {
  '׳׳‘׳ ׳•׳': { lat: 33.8547, lng: 35.8623 },
  '׳¢׳–׳”': { lat: 31.3547, lng: 34.3088 },
  '׳×׳™׳׳': { lat: 15.3694, lng: 44.191 },
  '׳׳™׳¨׳׳': { lat: 32.4279, lng: 53.688 },
  '׳¢׳™׳¨׳׳§': { lat: 33.2232, lng: 43.6793 }
};

// ׳׳©׳×׳ ׳™ ׳׳¦׳‘
let activeAlertsCache = new Set();
let isPolling = false;
let pollingInterval = null;

// ==========================================
// ׳₪׳•׳ ׳§׳¦׳™׳•׳× ׳¢׳–׳¨
// ==========================================

function getCityCoordinates(cityName) {
  if (CITY_COORDINATES[cityName]) {
    return CITY_COORDINATES[cityName];
  }
  
  for (const [name, coords] of Object.entries(CITY_COORDINATES)) {
    if (cityName.includes(name) || name.includes(cityName)) {
      return coords;
    }
  }
  
  console.log(`[WARN] ׳׳ ׳ ׳׳¦׳׳• ׳§׳•׳׳•׳¨׳“׳™׳ ׳˜׳•׳× ׳׳¢׳™׳¨: ${cityName}`);
  return { lat: 32.0853, lng: 34.7818 };
}

function estimateMissileSource(targetLat, targetLng) {
  if (targetLat > 32.8) {
    return { country: '׳׳‘׳ ׳•׳', coords: SOURCE_COORDINATES['׳׳‘׳ ׳•׳'] };
  } else if (targetLat < 31.2) {
    return { country: '׳¢׳–׳”', coords: SOURCE_COORDINATES['׳¢׳–׳”'] };
  } else {
    return { country: '׳׳™׳¨׳׳', coords: SOURCE_COORDINATES['׳׳™׳¨׳׳'] };
  }
}

function createMissileData(alert) {
  const cityName = alert.data || alert.city || alert.name || '׳׳ ׳™׳“׳•׳¢';
  const targetCoords = getCityCoordinates(cityName);
  const source = estimateMissileSource(targetCoords.lat, targetCoords.lng);
  
  return {
    id: `missile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    city: cityName,
    source: [source.coords.lng, source.coords.lat],
    target: [targetCoords.lng, targetCoords.lat],
    sourceCountry: source.country,
    timestamp: Date.now(),
    flightMs: 20000,
    threat: alert.threat || 1,
    isTest: alert.isTest || false
  };
}

// ==========================================
// ׳₪׳•׳׳™׳ ׳’ ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£
// ==========================================

async function fetchOrefAlerts() {
  try {
    const response = await axios.get(OREF_URL, {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000
    });
    
    if (response.data && response.data.data) {
      return response.data.data;
    }
    return [];
  } catch (error) {
    console.error('[OREF] ׳©׳’׳™׳׳” ׳‘׳§׳‘׳׳× ׳”׳×׳¨׳׳•׳×:', error.message);
    return [];
  }
}

async function processAlerts() {
  const alerts = await fetchOrefAlerts();
  const currentCities = new Set();
  
  for (const alert of alerts) {
    const cityName = alert.data || alert.city || alert.name;
    if (!cityName) continue;
    
    currentCities.add(cityName);
    
    if (!activeAlertsCache.has(cityName)) {
      console.log(`[ALERT] ׳”׳×׳¨׳׳” ׳—׳“׳©׳”: ${cityName}`);
      
      const missileData = createMissileData(alert);
      
      io.emit('real_time_missile', missileData);
      console.log(`[MISSILE] ׳©׳™׳’׳•׳¨ ׳${missileData.sourceCountry} ׳${cityName}`);
    }
  }
  
  for (const city of activeAlertsCache) {
    if (!currentCities.has(city)) {
      console.log(`[CLEAR] ׳”׳×׳¨׳׳” ׳”׳¡׳×׳™׳™׳׳”: ${city}`);
      io.emit('clear_city_alert', { city });
    }
  }
  
  if (activeAlertsCache.size > 0 && currentCities.size === 0) {
    console.log('[CLEAR ALL] ׳›׳ ׳”׳׳–׳¢׳§׳•׳× ׳”׳¡׳×׳™׳™׳׳•');
    io.emit('clear_all_threats', { timestamp: Date.now() });
  }
  
  activeAlertsCache = currentCities;
}

function startPolling() {
  if (isPolling) return;
  
  isPolling = true;
  console.log('[OREF] ׳׳×׳—׳™׳ ׳₪׳•׳׳™׳ ׳’ ׳׳₪׳™׳§׳•׳“ ׳”׳¢׳•׳¨׳£...');
  
  processAlerts();
  
  pollingInterval = setInterval(processAlerts, POLL_INTERVAL);
}

function stopPolling() {
  if (!isPolling) return;
  
  isPolling = false;
  clearInterval(pollingInterval);
  console.log('[OREF] ׳”׳₪׳•׳׳™׳ ׳’ ׳ ׳¢׳¦׳¨');
}

// ==========================================
// Socket.IO Events
// ==========================================

io.on('connection', (socket) => {
  console.log('[SOCKET] ׳׳§׳•׳— ׳”׳×׳—׳‘׳¨:', socket.id);
  
  if (activeAlertsCache.size > 0) {
    socket.emit('active_threats', {
      cities: Array.from(activeAlertsCache),
      count: activeAlertsCache.size,
      timestamp: Date.now()
    });
  }
  
  socket.on('disconnect', () => {
    console.log('[SOCKET] ׳׳§׳•׳— ׳”׳×׳ ׳×׳§:', socket.id);
  });
});

// ==========================================
// Express Static Files
// ==========================================

app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'monitor.html'));
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeAlerts: Array.from(activeAlertsCache),
    polling: isPolling
  });
});

// ==========================================
// Start Server
// ==========================================

server.listen(PORT, () => {
  console.log(`[SERVER] ׳©׳¨׳× ׳¨׳¥ ׳¢׳ ׳₪׳•׳¨׳˜ ${PORT}`);
  console.log(`[SERVER] URL: http://localhost:${PORT}`);
  
  startPolling();
});

process.on('SIGINT', () => {
  console.log('\n[SERVER] ׳׳›׳‘׳” ׳©׳¨׳×...');
  stopPolling();
  server.close(() => {
    console.log('[SERVER] ׳”׳©׳¨׳× ׳›׳•׳‘׳” ׳‘׳”׳¦׳׳—׳”');
    process.exit(0);
  });
});

// ׳׳•׳“׳•׳ exports ׳׳×׳׳™׳׳•׳× ׳׳׳—׳•׳¨
module.exports = {
  estimateMissileSource,
  createMissileLaunchEvent: createMissileData,
  integrateRealTimeMissiles: (io, server) => {
    console.log('[MissileLayer] Integration function called (legacy)');
  }
};



