/**
 * עשן דפדפן אמיתי (Playwright): טוען את monitor דרך השרת המקומי.
 * דורש: npm install (root) && npx playwright install chromium
 * הרצה: node scripts/browser-smoke.mjs
 * או:     SMOKE_BASE_URL=http://127.0.0.1:8080 node scripts/browser-smoke.mjs
 */
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 20000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function waitForHealth(base, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpGet(`${base}/health`);
      if (r.status === 200 && r.body.includes('healthy')) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startTempServer(port) {
  const serverJs = path.join(ROOT, 'backend', 'server.js');
  return spawn(process.execPath, [serverJs], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runPlaywright(base) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.error('FAIL: לא ניתן לטעון playwright — הרץ: npm install && npx playwright install chromium');
    console.error(e.message || e);
    return false;
  }

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));

    const home = `${base.replace(/\/$/, '')}/`;
    const resp = await page.goto(home, { waitUntil: 'networkidle', timeout: 60000 });
    if (!resp || !resp.ok()) {
      console.error('FAIL: goto', home, resp?.status());
      return false;
    }

    const title = await page.title();
    if (!title || title.length < 2) {
      console.error('FAIL: כותרת ריקה');
      return false;
    }

    const hasMap = await page.locator('#map, [id="map"]').count();
    if (hasMap < 1) {
      console.error('FAIL: אין אלמנט מפה #map');
      return false;
    }

    const leaflet = await page.evaluate(() => typeof window.L !== 'undefined');
    if (!leaflet) {
      console.error('FAIL: Leaflet (window.L) לא נטען');
      return false;
    }

    await new Promise((r) => setTimeout(r, 3500));

    const ioReady = await page.evaluate(() => typeof window.io === 'function');
    if (!ioReady) {
      console.error('FAIL: socket.io client לא זמין על window.io');
      return false;
    }

    const missileApi = await page.evaluate(() => typeof window.warMonitorMissiles !== 'undefined');
    if (!missileApi) {
      console.error('FAIL: warMonitorMissiles לא מוגדר');
      return false;
    }

    if (pageErrors.length > 0) {
      console.error('FAIL: שגיאות עמוד:', pageErrors.slice(0, 5));
      return false;
    }
    const criticalConsole = consoleErrors.filter(
      (t) =>
        /failed|error|refused|uncaught|exception/i.test(t) &&
        !/favicon|net::ERR/i.test(t)
    );
    if (criticalConsole.length > 0) {
      console.error('FAIL: console error:', criticalConsole.slice(0, 5));
      return false;
    }

    console.log('OK  דפדפן: טעינת עמוד, מפה, Leaflet, socket.io, warMonitorMissiles');
    console.log('OK  כותרת:', title);
    return true;
  } finally {
    await browser.close();
  }
}

async function main() {
  let child = null;
  let base = process.env.SMOKE_BASE_URL?.replace(/\/$/, '');
  const ownServer = !base;
  const port = 18092;

  if (ownServer) {
    base = `http://127.0.0.1:${port}`;
    console.log('מעלה שרת זמני לבדיקת דפדפן:', base);
    child = startTempServer(port);
    const up = await waitForHealth(base);
    if (!up) {
      console.error('FAIL: השרת לא עלה בזמן');
      if (child) child.kill('SIGTERM');
      process.exit(1);
    }
  }

  console.log('=== בדיקת דפדפן (Playwright) ===\n');
  const ok = await runPlaywright(base);

  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!ok) process.exit(1);
  console.log('\nבדיקת דפדפן הסתיימה בהצלחה.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
