// ==========================================
// MapWithIcons.jsx - מפה חיה עם שיגורי טילים
// Deck.gl Map with Live Missile Visualization
// ==========================================

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { Map as MapboxMap } from 'react-map-gl';
import { ArcLayer, ScatterplotLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const MapWithIcons = ({ socket: propSocket }) => {
  const [viewState, setViewState] = useState({
    longitude: 35.0,
    latitude: 32.5,
    zoom: 7,
    pitch: 45,
    bearing: 0
  });

  const [mapEntities, setMapEntities] = useState([]);
  const [alertedCities, setAlertedCities] = useState([]);
  const [activeMissiles, setActiveMissiles] = useState([]);
  const [intercepts, setIntercepts] = useState([]);
  const [impacts, setImpacts] = useState([]);
  const [currentTime, setCurrentTime] = useState(Date.now());

  const socketRef = useRef(propSocket);
  useEffect(() => { socketRef.current = propSocket; }, [propSocket]);

  // ==========================================
  // Animation Loop - single RAF for currentTime
  // ==========================================
  useEffect(() => {
    let rafId = null;
    let lastUpdate = 0;

    const tick = (now) => {
      if (now - lastUpdate >= 33) {
        setCurrentTime(Date.now());
        lastUpdate = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
  }, []);

  // ==========================================
  // Socket Listeners
  // ==========================================
  useEffect(() => {
    const socket = propSocket;
    if (!socket) return;

    const onMapEntities = (data) => {
      setMapEntities(data.entities || []);
    };

    const onNewAlert = (data) => {
      if (!data?.cityName) return;
      const coords = data.coordinates || data.targetPosition;
      if (!coords || !Array.isArray(coords) || coords.length < 2) return;

      setAlertedCities((prev) => {
        if (prev.some((c) => c.cityName === data.cityName)) return prev;
        return [...prev, {
          cityName: data.cityName,
          position: coords,
          timestamp: Date.now(),
          title: data.title || 'התראה',
          threatType: data.threatType || 'missile'
        }];
      });
    };

    const onRealTimeMissile = (data) => {
      if (!data?.id) return;
      const source = data.source || data.sourcePosition;
      const target = data.target || data.targetPosition;
      if (!source || !target) return;

      setActiveMissiles((prev) => {
        if (prev.some((m) => m.id === data.id)) return prev;
        return [...prev, {
          ...data,
          id: data.id,
          cityName: data.cityName || 'unknown',
          source,
          target,
          sourceRegion: data.sourceRegion || null,
          sourceLocation: data.sourceLocation || 'מקור משוער',
          displayFlightMs: data.displayFlightMs || data.flightMs || 30000,
          displayElapsedMs: data.displayElapsedMs || 0,
          estimatedDistanceKm: data.estimatedDistanceKm || null,
          threatType: data.threatType || 'missile',
          phase: data.phase || 'launch',
          status: data.status || 'inbound',
          outcome: data.outcome || null,
          timestamp: data.timestamp || Date.now(),
          salvoCountEstimate: data.salvoCountEstimate || 1,
          salvoIndex: data.salvoIndex || 1,
          waveId: data.waveId || null,
          opacity: 1,
          fading: false
        }];
      });
    };

    const onMissileUpdate = (data) => {
      if (!data?.id) return;

      setActiveMissiles((prev) =>
        prev.map((m) =>
          m.id === data.id
            ? {
                ...m,
                ...data,
                fading: data.phase === 'intercepted' || data.phase === 'impact',
                opacity: (data.phase === 'intercepted' || data.phase === 'impact') ? 0 : (m.opacity ?? 1)
              }
            : m
        )
      );

      if (data.phase === 'intercepted' && data.interceptPoint) {
        const marker = {
          id: `intercept-${data.id}`,
          position: data.interceptPoint,
          timestamp: Date.now(),
          sourceRegion: data.sourceRegion,
          cityName: data.cityName,
          salvoCountEstimate: data.salvoCountEstimate,
          salvoIndex: data.salvoIndex
        };
        setIntercepts((prev) => [...prev, marker]);
        setTimeout(() => {
          setIntercepts((prev) => prev.filter((i) => i.id !== marker.id));
          setActiveMissiles((prev) => prev.filter((m) => m.id !== data.id));
        }, 2200);
      }

      if (data.phase === 'impact' && data.impactPoint) {
        const marker = {
          id: `impact-${data.id}`,
          position: data.impactPoint,
          timestamp: Date.now(),
          sourceRegion: data.sourceRegion,
          cityName: data.cityName,
          salvoCountEstimate: data.salvoCountEstimate,
          salvoIndex: data.salvoIndex
        };
        setImpacts((prev) => [...prev, marker]);
        setTimeout(() => {
          setImpacts((prev) => prev.filter((i) => i.id !== marker.id));
          setActiveMissiles((prev) => prev.filter((m) => m.id !== data.id));
        }, 3000);
      }
    };

    const onClearCityAlert = (data) => {
      const cityName = typeof data === 'string' ? data : data?.city || data?.cityName;
      if (!cityName) return;

      setActiveMissiles((prev) =>
        prev.map((m) =>
          m.cityName === cityName ? { ...m, fading: true, opacity: 0 } : m
        )
      );

      setTimeout(() => {
        setActiveMissiles((prev) => prev.filter((m) => m.cityName !== cityName));
        setAlertedCities((prev) => prev.filter((c) => c.cityName !== cityName));
      }, 2000);
    };

    const onClearAllThreats = () => {
      setActiveMissiles([]);
      setIntercepts([]);
      setImpacts([]);
      setTimeout(() => { setAlertedCities([]); }, 2000);
    };

    socket.on('map_entities_update', onMapEntities);
    socket.on('new_alert', onNewAlert);
    socket.on('real_time_missile', onRealTimeMissile);
    socket.on('missile_update', onMissileUpdate);
    socket.on('clear_city_alert', onClearCityAlert);
    socket.on('clear_all_threats', onClearAllThreats);

    return () => {
      socket.off('map_entities_update', onMapEntities);
      socket.off('new_alert', onNewAlert);
      socket.off('real_time_missile', onRealTimeMissile);
      socket.off('missile_update', onMissileUpdate);
      socket.off('clear_city_alert', onClearCityAlert);
      socket.off('clear_all_threats', onClearAllThreats);
    };
  }, [propSocket]);

  // ==========================================
  // Helpers
  // ==========================================
  const getGreatCirclePoint = useCallback((source, target, progress) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const lat1 = toRad(source[1]);
    const lng1 = toRad(source[0]);
    const lat2 = toRad(target[1]);
    const lng2 = toRad(target[0]);

    const d = 2 * Math.asin(Math.sqrt(
      Math.sin((lat2 - lat1) / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
    ));

    if (d < 1e-10) return [...source];

    const a = Math.sin((1 - progress) * d) / Math.sin(d);
    const b = Math.sin(progress * d) / Math.sin(d);

    const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
    const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);

    return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))];
  }, []);

  const formatSourceRegion = useCallback((region) => {
    const labels = {
      lebanon: 'לבנון', syria: 'סוריה', gaza: 'עזה',
      yemen: 'תימן', iraq: 'עיראק', iran: 'איראן'
    };
    return labels[region] || 'מקור משוער';
  }, []);

  const getSourcePalette = useCallback((region, phase) => {
    if (phase === 'intercepted') {
      return { primary: [166, 126, 255], secondary: [202, 178, 255], glow: [236, 226, 255] };
    }
    const palettes = {
      lebanon: { primary: [244, 203, 74], secondary: [255, 228, 125], glow: [255, 244, 214] },
      syria: { primary: [255, 166, 77], secondary: [255, 204, 138], glow: [255, 234, 214] },
      gaza: { primary: [255, 112, 99], secondary: [255, 169, 150], glow: [255, 225, 220] },
      yemen: { primary: [96, 205, 255], secondary: [154, 228, 255], glow: [224, 246, 255] },
      iraq: { primary: [255, 128, 191], secondary: [255, 190, 223], glow: [255, 232, 243] },
      iran: { primary: [255, 72, 72], secondary: [255, 148, 148], glow: [255, 226, 226] }
    };
    return palettes[region] || { primary: [255, 100, 100], secondary: [255, 170, 100], glow: [255, 230, 200] };
  }, []);

  // ==========================================
  // Compute animated missile positions
  // ==========================================
  const animatedMissiles = useMemo(() => {
    return activeMissiles.map((missile) => {
      const elapsed = currentTime - missile.timestamp;
      const totalRemaining = missile.displayFlightMs - missile.displayElapsedMs;
      const progress = totalRemaining > 0
        ? Math.min(1, Math.max(0, missile.displayElapsedMs + elapsed) / missile.displayFlightMs)
        : Math.min(1, Math.max(0, elapsed / (missile.displayFlightMs || 30000)));

      const currentPosition = getGreatCirclePoint(missile.source, missile.target, progress);

      return {
        ...missile,
        progress,
        currentPosition,
        opacity: missile.fading ? 0 : (missile.opacity ?? 1)
      };
    });
  }, [activeMissiles, currentTime, getGreatCirclePoint]);

  const leadThreat = useMemo(() => {
    const active = animatedMissiles.filter((m) => m.progress < 1 && !m.fading);
    if (active.length === 0) return null;

    const ranked = [...active].sort((a, b) => {
      const aRem = Math.max(0, a.displayFlightMs - a.displayElapsedMs - (currentTime - a.timestamp));
      const bRem = Math.max(0, b.displayFlightMs - b.displayElapsedMs - (currentTime - b.timestamp));
      return aRem - bRem;
    });

    const first = ranked[0];
    const remainingMs = Math.max(0, first.displayFlightMs - first.displayElapsedMs - (currentTime - first.timestamp));

    return {
      cityName: first.cityName,
      sourceRegion: formatSourceRegion(first.sourceRegion),
      etaLabel: remainingMs >= 60000
        ? `${Math.ceil(remainingMs / 60000)} דק'`
        : `${Math.ceil(remainingMs / 1000)} שנ'`,
      distanceKm: first.estimatedDistanceKm || null,
      waveLabel: `${first.salvoIndex || 1}/${first.salvoCountEstimate || 1}`
    };
  }, [animatedMissiles, currentTime, formatSourceRegion]);

  const waveLabels = useMemo(() => {
    const groups = new Map();
    animatedMissiles.filter((m) => m.progress < 1 && !m.fading).forEach((missile) => {
      const key = missile.waveId || `${missile.sourceRegion}-${missile.salvoCountEstimate || 1}`;
      if (!groups.has(key)) {
        groups.set(key, {
          waveId: key,
          sourceRegion: missile.sourceRegion,
          count: missile.salvoCountEstimate || 1,
          source: missile.source,
          target: missile.target,
          phase: missile.phase
        });
      }
    });

    return Array.from(groups.values()).map((wave) => ({
      ...wave,
      position: getGreatCirclePoint(wave.source, wave.target, 0.34),
      label: `גל ${formatSourceRegion(wave.sourceRegion)} x${wave.count}`
    }));
  }, [animatedMissiles, formatSourceRegion, getGreatCirclePoint]);

  // ==========================================
  // Layers
  // ==========================================

  // Layer 1: City alert markers (pulsing red dots on target cities)
  const cityAlertLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'city-alert-layer',
      data: alertedCities,
      getPosition: (d) => d.position,
      getFillColor: (d) => {
        const age = (currentTime - d.timestamp) / 1000;
        const pulse = Math.sin(age * 4) * 40 + 215;
        return [255, pulse * 0.3, pulse * 0.15, 200];
      },
      getLineColor: [255, 60, 60, 180],
      getRadius: (d) => {
        const age = (currentTime - d.timestamp) / 1000;
        const pulse = Math.sin(age * 3) * 1500 + 5500;
        return pulse;
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 22,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 2,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(255,60,60,0.7);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:140px;">
              <div style="font-weight:700;color:#ff4444;margin-bottom:4px;">🚨 התראה פעילה</div>
              <div>עיר: ${info.object.cityName}</div>
              <div>סוג: ${info.object.threatType === 'uav' ? 'כטב"מ' : 'טיל'}</div>
            </div>
          `
        };
      }
    });
  }, [alertedCities, currentTime]);

  // Layer 2: Missile trajectory arcs (source → target)
  const missileArcLayer = useMemo(() => {
    return new ArcLayer({
      id: 'missile-arc-layer',
      data: animatedMissiles.filter((m) => m.progress < 1),
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).primary;
        return [base[0], base[1], base[2], Math.round((d.opacity ?? 1) * 210)];
      },
      getTargetColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).secondary;
        return [base[0], base[1], base[2], Math.round((d.opacity ?? 1) * 235)];
      },
      getWidth: 2.5,
      widthMinPixels: 1,
      widthMaxPixels: 4,
      greatCircle: true,
      getHeight: 0.15,
      pickable: true,
      autoHighlight: true,
      transitions: { opacity: 2000 },
      opacity: 0.92,
      onHover: (info) => {
        if (!info.object) return null;
        const remainingMs = Math.max(0,
          info.object.displayFlightMs - info.object.displayElapsedMs - (currentTime - info.object.timestamp));
        const etaLabel = remainingMs >= 60000
          ? `${Math.ceil(remainingMs / 60000)} דק'`
          : `${Math.ceil(remainingMs / 1000)} שנ'`;
        const pal = getSourcePalette(info.object.sourceRegion, info.object.phase);
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(${pal.primary.join(',')},0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(${pal.primary.join(',')});margin-bottom:6px;">איום נכנס חי</div>
              <div>מקור: ${formatSourceRegion(info.object.sourceRegion)}</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
              <div>זמן הגעה: ${etaLabel}</div>
              <div>טווח: ${info.object.estimatedDistanceKm || '?'} ק"מ</div>
              <div>גל: ${info.object.salvoIndex || 1}/${info.object.salvoCountEstimate || 1}</div>
            </div>
          `
        };
      }
    });
  }, [animatedMissiles, currentTime, formatSourceRegion, getSourcePalette]);

  // Layer 3: Animated missile head (moving dot)
  const missileHeadLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'missile-head-layer',
      data: animatedMissiles.filter((m) => m.progress < 1 && m.progress > 0),
      getPosition: (d) => d.currentPosition,
      getFillColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).primary;
        const pulse = Math.sin(currentTime / 120) * 30;
        return [
          Math.min(255, base[0] + pulse),
          Math.min(255, base[1] + pulse),
          base[2],
          Math.round((d.opacity ?? 1) * 245)
        ];
      },
      getLineColor: (d) => {
        const glow = getSourcePalette(d.sourceRegion, d.phase).glow;
        return [glow[0], glow[1], glow[2], Math.round((d.opacity ?? 1) * 160)];
      },
      getRadius: 4000,
      radiusMinPixels: 3,
      radiusMaxPixels: 9,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 1,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        const remainingMs = Math.max(0,
          info.object.displayFlightMs - info.object.displayElapsedMs - (currentTime - info.object.timestamp));
        const etaLabel = remainingMs >= 60000
          ? `${Math.ceil(remainingMs / 60000)} דק'`
          : `${Math.ceil(remainingMs / 1000)} שנ'`;
        const pal = getSourcePalette(info.object.sourceRegion, info.object.phase);
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(${pal.primary.join(',')},0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(${pal.primary.join(',')});margin-bottom:6px;">טיל בתנועה</div>
              <div>מקור: ${formatSourceRegion(info.object.sourceRegion)}</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
              <div>זמן הגעה: ${etaLabel}</div>
              <div>התקדמות: ${Math.round(info.object.progress * 100)}%</div>
            </div>
          `
        };
      }
    });
  }, [animatedMissiles, currentTime, formatSourceRegion, getSourcePalette]);

  // Layer 4: Wave labels
  const waveLabelLayer = useMemo(() => {
    return new TextLayer({
      id: 'wave-label-layer',
      data: waveLabels,
      getPosition: (d) => d.position,
      getText: (d) => d.label,
      getColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).primary;
        return [base[0], base[1], base[2], 230];
      },
      getSize: 14,
      sizeUnits: 'pixels',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      getPixelOffset: [0, -12],
      background: true,
      getBackgroundColor: [6, 10, 16, 180],
      getBorderColor: [255, 255, 255, 18],
      getBorderWidth: 1,
      billboard: true,
      pickable: false
    });
  }, [waveLabels, getSourcePalette]);

  // Layer 5: Intercept markers
  const interceptLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'intercept-layer',
      data: intercepts,
      getPosition: (d) => d.position,
      getFillColor: (d) => {
        const age = (currentTime - d.timestamp) / 1000;
        const alpha = Math.max(0, 1 - age / 2.2) * 255;
        return [166, 126, 255, alpha];
      },
      getLineColor: [225, 210, 255, 180],
      getRadius: (d) => 2800 + ((currentTime - d.timestamp) / 1000) * 1800,
      radiusMinPixels: 4,
      radiusMaxPixels: 14,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 2,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(166,126,255,0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(166,126,255);margin-bottom:6px;">יירוט</div>
              <div>מקור: ${formatSourceRegion(info.object.sourceRegion)}</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
            </div>
          `
        };
      }
    });
  }, [intercepts, currentTime, formatSourceRegion]);

  // Layer 6: Impact markers
  const impactPulseLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'impact-pulse-layer',
      data: impacts,
      getPosition: (d) => d.position,
      getFillColor: (d) => {
        const age = (currentTime - d.timestamp) / 1000;
        const alpha = Math.max(0, 1 - age / 3) * 255;
        return [244, 203, 74, alpha];
      },
      getLineColor: [255, 232, 170, 170],
      getRadius: (d) => 3200 + ((currentTime - d.timestamp) / 1000) * 2800,
      radiusMinPixels: 5,
      radiusMaxPixels: 18,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 2,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(244,203,74,0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(244,203,74);margin-bottom:6px;">פגיעה</div>
              <div>מקור: ${formatSourceRegion(info.object.sourceRegion)}</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
            </div>
          `
        };
      }
    });
  }, [impacts, currentTime, formatSourceRegion]);

  // Layer 7: Map entities (flights, etc.)
  const iconLayer = useMemo(() => {
    return new IconLayer({
      id: 'icon-layer',
      data: mapEntities,
      getPosition: (d) => d.coordinates,
      getIcon: (d) => ({
        url: `data:image/svg+xml;base64,${btoa(`
          <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10"
              fill="${d.type === 'alert' ? '#ff4444' : d.type === 'flight' ? '#00aaff' : '#888'}"
              stroke="white" stroke-width="2"/>
          </svg>
        `)}`,
        width: 24,
        height: 24,
        mask: false
      }),
      getSize: 24,
      pickable: true
    });
  }, [mapEntities]);

  const layers = [
    cityAlertLayer,
    missileArcLayer,
    waveLabelLayer,
    iconLayer,
    missileHeadLayer,
    interceptLayer,
    impactPulseLayer
  ];

  const onViewStateChange = useCallback(({ viewState: vs }) => {
    setViewState(vs);
  }, []);

  const activeMissileCount = animatedMissiles.filter((m) => m.progress < 1 && !m.fading).length;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={{
        position: 'absolute',
        top: '10px',
        left: '10px',
        background: 'rgba(0,0,0,0.8)',
        padding: '10px 15px',
        borderRadius: '4px',
        border: '1px solid #333',
        zIndex: 10,
        color: 'white',
        fontSize: '12px'
      }}>
        <div>🚨 ערים בהתרעה: {alertedCities.length}</div>
        <div>🚀 טילים באוויר: {activeMissileCount}</div>
        <div>🛡️ יירוטים: {intercepts.length}</div>
        <div>💥 פגיעות: {impacts.length}</div>
        <div>📡 ישויות: {mapEntities.length}</div>
        {leadThreat && (
          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #333' }}>
            <div style={{ color: '#f4cb4a' }}>מקור: {leadThreat.sourceRegion}</div>
            <div>זמן הגעה: {leadThreat.etaLabel}</div>
            <div>יעד: {leadThreat.cityName}</div>
            {leadThreat.distanceKm && <div>טווח: {leadThreat.distanceKm} ק"מ</div>}
            <div>גל: {leadThreat.waveLabel}</div>
          </div>
        )}
      </div>

      <DeckGL
        initialViewState={viewState}
        onViewStateChange={onViewStateChange}
        controller={true}
        layers={layers}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <MapboxMap
          mapboxAccessToken={MAPBOX_TOKEN}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          style={{ width: '100%', height: '100%' }}
        />
      </DeckGL>
    </div>
  );
};

export default MapWithIcons;
