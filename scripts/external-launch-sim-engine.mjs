/**
 * External missile simulation engine (standalone, no website coupling).
 * Run:
 *   node scripts/external-launch-sim-engine.mjs
 */

const CITY_COORDS = {
  'קרית שמונה': [35.5702, 33.2079],
  חיפה: [34.9896, 32.794],
  'תל אביב': [34.7818, 32.0853],
  ירושלים: [35.2137, 31.7683],
  'באר שבע': [34.7913, 31.252],
  אשדוד: [34.643, 31.8044],
  אילת: [34.9519, 29.5577],
};

const SOURCE_ANCHORS = {
  lebanon: [35.52, 33.58],
  iran: [51.6, 32.1],
  yemen: [47.9, 15.7],
  iraq: [44.9, 32.3],
  syria: [36.18, 33.35],
};

const FIXED_ETA_MS = {
  iran: 5 * 60 * 1000,
  yemen: 5 * 60 * 1000,
};

function toRad(v) {
  return (v * Math.PI) / 180;
}

function haversineKm(a, b) {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function calcLebanonEtaMs(targetCity) {
  const src = SOURCE_ANCHORS.lebanon;
  const ks = CITY_COORDS['קרית שמונה'];
  const tgt = CITY_COORDS[targetCity];
  if (!tgt) throw new Error(`Missing city coords: ${targetCity}`);
  const baseDist = Math.max(1, haversineKm(src, ks));
  const secPerKm = 10 / baseDist; // calibration requested by user
  return Math.round(clamp(haversineKm(src, tgt) * secPerKm * 1000, 8000, 8 * 60 * 1000));
}

function calcEtaMs(sourceCountry, targetCity) {
  if (!CITY_COORDS[targetCity]) throw new Error(`Unknown city: ${targetCity}`);
  if (FIXED_ETA_MS[sourceCountry] != null) return FIXED_ETA_MS[sourceCountry];
  if (sourceCountry === 'lebanon') return calcLebanonEtaMs(targetCity);
  const src = SOURCE_ANCHORS[sourceCountry] || SOURCE_ANCHORS.syria;
  const km = haversineKm(src, CITY_COORDS[targetCity]);
  return Math.round(clamp((km / 3.8) * 1000, 12000, 7 * 60 * 1000));
}

function buildScenarioDefinitions() {
  return [
    { id: 'S1', source: 'lebanon', cities: ['קרית שמונה'], cluster: true, parallelWith: [] },
    { id: 'S2', source: 'lebanon', cities: ['חיפה', 'תל אביב', 'ירושלים'], cluster: true, parallelWith: ['S3'] },
    { id: 'S3', source: 'iran', cities: ['תל אביב', 'באר שבע'], cluster: true, parallelWith: ['S2'] },
    { id: 'S4', source: 'yemen', cities: ['אשדוד'], cluster: false, parallelWith: [] },
    { id: 'S5', source: 'iraq', cities: ['ירושלים', 'חיפה'], cluster: true, parallelWith: [] },
    { id: 'S6', source: 'syria', cities: ['חיפה'], cluster: false, parallelWith: [] },
    { id: 'S7', source: 'iran', cities: ['אילת', 'ירושלים', 'תל אביב'], cluster: true, parallelWith: ['S8'] },
    { id: 'S8', source: 'yemen', cities: ['באר שבע', 'אשדוד'], cluster: true, parallelWith: ['S7'] },
  ];
}

function createLaunches() {
  const now = Date.now();
  return buildScenarioDefinitions().map((s, i) => {
    const etaByCity = Object.fromEntries(s.cities.map((c) => [c, calcEtaMs(s.source, c)]));
    const impactAt = now + Math.max(...Object.values(etaByCity));
    const splitAt = s.cluster ? impactAt - 8000 : null;
    return { ...s, launchAt: now + i * 100, etaByCity, splitAt, impactAt };
  });
}

async function runRealtimeSimulation(launches) {
  const simScale = 0.01; // 5 minutes simulated => ~3 seconds wall-clock
  const started = Date.now();
  const simStart = Date.now();
  const events = [];
  const pending = new Set(launches.map((l) => l.id));
  while (pending.size > 0) {
    const wallElapsed = Date.now() - started;
    const t = simStart + Math.round(wallElapsed / simScale);
    for (const l of launches) {
      if (!pending.has(l.id)) continue;
      if (!l._launched && t >= l.launchAt) {
        l._launched = true;
        events.push({ id: l.id, type: 'launch', at: t });
      }
      if (l.cluster && !l._split && l.splitAt && t >= l.splitAt) {
        l._split = true;
        events.push({ id: l.id, type: 'split', at: t, branches: l.cities.length });
      }
      if (!l._impacted && t >= l.impactAt) {
        l._impacted = true;
        const cityHits = l.cities.map((c) => ({ city: c, etaMs: l.etaByCity[c], hitAt: t }));
        events.push({ id: l.id, type: 'impact', at: t, cityHits });
        pending.delete(l.id);
      }
    }
    await new Promise((r) => setTimeout(r, 20));
    if (Date.now() - started > 25_000) throw new Error('Simulation timeout');
  }
  return events;
}

function validate(launches, events) {
  const byId = Object.fromEntries(launches.map((l) => [l.id, l]));
  const grouped = new Map();
  for (const ev of events) {
    if (!grouped.has(ev.id)) grouped.set(ev.id, []);
    grouped.get(ev.id).push(ev);
  }
  const checks = [];
  for (const [id, evs] of grouped.entries()) {
    const l = byId[id];
    const hasLaunch = evs.some((e) => e.type === 'launch');
    const hasImpact = evs.some((e) => e.type === 'impact');
    const splitEvent = evs.find((e) => e.type === 'split');
    checks.push({ id, ok: hasLaunch && hasImpact, msg: 'launch/impact lifecycle' });
    if (l.cluster) {
      checks.push({
        id,
        ok: Boolean(splitEvent) && splitEvent.branches === l.cities.length,
        msg: 'cluster split branches match targets',
      });
    }
    if (l.source === 'iran' || l.source === 'yemen') {
      const fixed = Object.values(l.etaByCity).every((v) => v === 300000);
      checks.push({ id, ok: fixed, msg: `${l.source} fixed ETA 5 minutes` });
    }
    if (l.source === 'lebanon' && l.cities.includes('קרית שמונה')) {
      checks.push({
        id,
        ok: Math.abs(l.etaByCity['קרית שמונה'] - 10000) <= 1500,
        msg: 'Lebanon→Kiryat Shmona calibrated ~10s',
      });
    }
  }
  const passed = checks.filter((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return { checks, passed, failed };
}

async function main() {
  const launches = createLaunches();
  const events = await runRealtimeSimulation(launches);
  const result = validate(launches, events);

  console.log('=== External Launch Simulation Report ===');
  console.log('Scenarios:', launches.length);
  console.log('Checks:', result.checks.length, '| Passed:', result.passed.length, '| Failed:', result.failed.length);
  console.log('');

  for (const l of launches) {
    console.log(
      `[${l.id}] ${l.source} -> ${l.cities.join(', ')} | cluster=${l.cluster} | ETA(ms)=${JSON.stringify(l.etaByCity)}`
    );
  }

  console.log('\n--- Check Results ---');
  for (const c of result.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} [${c.id}] ${c.msg}`);
  }

  if (result.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});

