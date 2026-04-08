/**
 * בדיקה חיצונית (Playwright): סימולציית מצרר — שני "תתי־טילים" לא מציירים מסלול,
 * רק "אם" אחד עם mergedTargetPositions וענפים לשלוש ערים.
 * הרצה: node scripts/cluster-munition-simulation.mjs
 * או: CLUSTER_SMOKE_BASE_URL=http://127.0.0.1:8080 node scripts/cluster-munition-simulation.mjs
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

async function runClusterPlaywright(base) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.error('FAIL: playwright — npm install && npx playwright install chromium');
    console.error(e.message || e);
    return false;
  }

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));

    const home = `${base.replace(/\/$/, '')}/`;
    const resp = await page.goto(home, { waitUntil: 'networkidle', timeout: 60000 });
    if (!resp || !resp.ok()) {
      console.error('FAIL: goto', home, resp?.status());
      return false;
    }

    await new Promise((r) => setTimeout(r, 2500));

    const result = await page.evaluate(() => {
      const W = window.warMonitorMissiles;
      if (!W || typeof W.addMissile !== 'function') {
        return { ok: false, err: 'warMonitorMissiles.addMissile missing' };
      }
      if (typeof W.clearAllThreatVisuals === 'function') W.clearAllThreatVisuals();
      else if (typeof W.removeAllMissiles === 'function') W.removeAllMissiles();

      const src = [35.2, 33.35];
      const sisters = [
        { name: 'חיפה', lng: 34.99, lat: 32.794 },
        { name: 'תל אביב', lng: 34.7818, lat: 32.0853 },
        { name: 'ירושלים', lng: 35.2137, lat: 31.7683 },
      ];
      const centroid = [
        (sisters[0].lng + sisters[1].lng + sisters[2].lng) / 3,
        (sisters[0].lat + sisters[1].lat + sisters[2].lat) / 3,
      ];
      const cm = (isMother) => ({
        centroid: centroid.slice(),
        sisters: sisters.map((s) => ({ name: s.name, lng: s.lng, lat: s.lat })),
        isMother,
      });
      const waveId = 'pw-cluster-munition-1';
      const basePayload = {
        sourceRegion: 'lebanon',
        sourceLocation: 'לבנון',
        sourcePosition: src,
        source: src,
        threatType: 'missile',
        waveId,
        salvoCountEstimate: 3,
        orefTimeMs: Date.now(),
        flightMs: 120000,
        displayFlightMs: 90000,
        displayElapsedMs: 5000,
      };

      W.addMissile(
        Object.assign({}, basePayload, {
          id: 'pw-cluster-sub-tlv',
          cityName: 'תל אביב',
          targetPosition: [sisters[1].lng, sisters[1].lat],
          target: [sisters[1].lng, sisters[1].lat],
          salvoIndex: 2,
          clusterMunition: cm(false),
        })
      );
      W.addMissile(
        Object.assign({}, basePayload, {
          id: 'pw-cluster-sub-jer',
          cityName: 'ירושלים',
          targetPosition: [sisters[2].lng, sisters[2].lat],
          target: [sisters[2].lng, sisters[2].lat],
          salvoIndex: 3,
          clusterMunition: cm(false),
        })
      );

      const afterSubs = W.getActiveMissileCount ? W.getActiveMissileCount() : -1;

      W.addMissile(
        Object.assign({}, basePayload, {
          id: 'pw-cluster-mother-haifa',
          cityName: 'חיפה',
          targetPosition: [sisters[0].lng, sisters[0].lat],
          target: [sisters[0].lng, sisters[0].lat],
          salvoIndex: 1,
          clusterMunition: cm(true),
        })
      );

      const afterMother = W.getActiveMissileCount ? W.getActiveMissileCount() : -1;
      const branches = W.getMaxBranchTargetListLength ? W.getMaxBranchTargetListLength() : -1;

      return { ok: true, afterSubs, afterMother, branches };
    });

    if (pageErrors.length > 0) {
      console.error('FAIL: page errors:', pageErrors.slice(0, 5));
      return false;
    }

    if (!result || !result.ok) {
      console.error('FAIL:', result && result.err);
      return false;
    }

    if (result.afterSubs !== 0) {
      console.error('FAIL: אחרי תתי־מצרר צפוי 0 מסלולים פעילים, קיבלנו', result.afterSubs);
      return false;
    }
    if (result.afterMother !== 1) {
      console.error('FAIL: אחרי "אם" צפוי מסלול יחיד, קיבלנו', result.afterMother);
      return false;
    }
    if (result.branches < 3) {
      console.error('FAIL: צפוי לפחות 3 יעדי ענף (שלוש ערים), קיבלנו', result.branches);
      return false;
    }

    console.log('OK  cluster munition: subs→0 active, mother→1, branch targets≥3');
    return true;
  } finally {
    await browser.close();
  }
}

async function main() {
  let child = null;
  let base = process.env.CLUSTER_SMOKE_BASE_URL?.replace(/\/$/, '');
  const ownServer = !base;
  const port = 18094;

  if (ownServer) {
    base = `http://127.0.0.1:${port}`;
    console.log('מעלה שרת זמני:', base);
    child = startTempServer(port);
    const up = await waitForHealth(base);
    if (!up) {
      console.error('FAIL: health timeout');
      if (child) child.kill('SIGTERM');
      process.exit(1);
    }
  }

  console.log('=== בדיקת מצרר (Playwright) ===\n');
  const ok = await runClusterPlaywright(base);

  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!ok) process.exit(1);
  console.log('\nבדיקת מצרר הסתיימה בהצלחה.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
