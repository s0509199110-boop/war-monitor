/**
 * Keep-Alive Script for Render Free Tier
 * רץ כל 5 דקות כדי לשמור את השירות באוויר
 * 
 * אפשרויות להרצה:
 * 1. Local: node keep-alive.js
 * 2. GitHub Actions (cron)
 * 3. cron-job.org (חינם)
 * 4. UptimeRobot (חינם)
 */

const https = require('https');
const http = require('http');

const RENDER_URL = 'https://war-monitor-d02.onrender.com';
const PING_INTERVAL_MS = 4 * 60 * 1000; // כל 4 דקות (לפני ה-15 דקות timeout)

function pingService() {
  const url = new URL(RENDER_URL);
  const client = url.protocol === 'https:' ? https : http;
  
  const startTime = Date.now();
  
  const req = client.get(url, (res) => {
    const duration = Date.now() - startTime;
    const timestamp = new Date().toISOString();
    
    if (res.statusCode === 200) {
      console.log(`[${timestamp}] ✅ Ping successful (${duration}ms) - Service is alive`);
    } else if (res.statusCode === 503 || res.statusCode === 502) {
      console.log(`[${timestamp}] ⏳ Service waking up (${duration}ms) - Status: ${res.statusCode}`);
    } else {
      console.log(`[${timestamp}] ⚠️ Unexpected status: ${res.statusCode}`);
    }
  });
  
  req.on('error', (err) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ Ping failed: ${err.message}`);
  });
  
  req.setTimeout(30000, () => {
    req.destroy();
    console.log(`[${new Date().toISOString()}] ⏱️ Request timeout`);
  });
}

// Ping immediately on start
console.log('🚀 Keep-Alive service started');
console.log(`📡 Pinging: ${RENDER_URL}`);
console.log(`⏰ Interval: ${PING_INTERVAL_MS / 1000 / 60} minutes`);
console.log('');

pingService();

// Schedule regular pings
setInterval(pingService, PING_INTERVAL_MS);

// Keep process alive
console.log('💡 Tip: Run this in background with: node keep-alive.js &');
console.log('💡 Or use PM2: pm2 start keep-alive.js --name "render-keepalive"');
