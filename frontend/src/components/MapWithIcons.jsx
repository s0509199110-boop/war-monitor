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
  // ==========================================
  // Mobile Detection
  // ==========================================
  const isMobile = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
  }, []);
  
  const [viewState, setViewState] = useState({
    longitude: 35.0,
    latitude: 32.5,
    zoom: isMobile ? 6.5 : 7,          // Slightly zoomed out on mobile
    pitch: isMobile ? 30 : 45,        // Less pitch on mobile for better view
    bearing: 0
  });

  const [mapEntities, setMapEntities] = useState([]);
  const [alertedCities, setAlertedCities] = useState([]);
  const [activeMissiles, setActiveMissiles] = useState([]);
  const [intercepts, setIntercepts] = useState([]);
  const [impacts, setImpacts] = useState([]);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [autoZoomEnabled, setAutoZoomEnabled] = useState(true); // Auto-zoom to new threats
  const [isDarkMode, setIsDarkMode] = useState(true); // Day/night mode
  const [alertHistory, setAlertHistory] = useState([]); // Alert history (last 24h)
  const [showHistory, setShowHistory] = useState(false); // Toggle history panel
  const [pushEnabled, setPushEnabled] = useState(false); // Push notifications
  
  // Track missile waves - group alerts within 10 seconds into one missile
  const [missileWaveId, setMissileWaveId] = useState(0);
  const [pendingTargets, setPendingTargets] = useState([]);
  const [lastMissileLaunchTime, setLastMissileLaunchTime] = useState(0);
  const pendingTimerRef = useRef(null);

  const socketRef = useRef(propSocket);
  useEffect(() => { socketRef.current = propSocket; }, [propSocket]);

  // ==========================================
  // Persistence: Save/Restore missile state
  // ==========================================
  const MISSILE_STORAGE_KEY = 'war-monitor-missiles';
  
  // Save missiles to localStorage before unload
  useEffect(() => {
    const saveMissiles = () => {
      const data = {
        missiles: activeMissiles,
        timestamp: Date.now(),
        waveId: missileWaveId
      };
      localStorage.setItem(MISSILE_STORAGE_KEY, JSON.stringify(data));
    };
    
    window.addEventListener('beforeunload', saveMissiles);
    return () => window.removeEventListener('beforeunload', saveMissiles);
  }, [activeMissiles, missileWaveId]);
  
  // Restore missiles from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(MISSILE_STORAGE_KEY);
    if (!saved) return;
    
    try {
      const data = JSON.parse(saved);
      const timeAway = Date.now() - data.timestamp;
      
      // Restore missiles that are still in flight
      if (data.missiles && data.missiles.length > 0) {
        const restoredMissiles = data.missiles
          .filter(m => m.progress < 1 && !m.fading)
          .map(m => ({
            ...m,
            // Adjust timestamps so missile continues from correct position
            clientStartTime: (m.clientStartTime || m.timestamp) + timeAway,
            timestamp: m.timestamp + timeAway
          }));
        
        if (restoredMissiles.length > 0) {
          setActiveMissiles(restoredMissiles);
          setMissileWaveId(data.waveId || 0);
          console.log('[Persistence] Restored', restoredMissiles.length, 'missiles after', timeAway, 'ms away');
        }
      }
      
      // Clear saved data after restore
      localStorage.removeItem(MISSILE_STORAGE_KEY);
    } catch (e) {
      console.error('[Persistence] Failed to restore missiles:', e);
    }
  }, []);

  // ==========================================
  // Day/Night Mode - Auto detect based on hour
  // ==========================================
  useEffect(() => {
    const checkDayNight = () => {
      const hour = new Date().getHours();
      // Night: 19:00 (7 PM) to 06:00 (6 AM)
      const isNight = hour >= 19 || hour < 6;
      setIsDarkMode(isNight);
    };
    
    checkDayNight();
    // Check every minute for day/night change
    const interval = setInterval(checkDayNight, 60000);
    return () => clearInterval(interval);
  }, []);

  // ==========================================
  // Alert History Cleanup - remove alerts older than 24 hours
  // ==========================================
  useEffect(() => {
    const cleanupOldAlerts = () => {
      const now = Date.now();
      const twentyFourHours = 24 * 60 * 60 * 1000;
      setAlertHistory(prev => prev.filter(alert => now - alert.timestamp < twentyFourHours));
    };
    
    // Clean up every 5 minutes
    const interval = setInterval(cleanupOldAlerts, 300000);
    return () => clearInterval(interval);
  }, []);

  // ==========================================
  // Push Notifications - Check if already subscribed
  // ==========================================
  useEffect(() => {
    const checkPushStatus = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[Push] Not supported');
        return;
      }
      
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        setPushEnabled(!!subscription);
        console.log('[Push] Subscription status:', subscription ? 'active' : 'none');
      } catch (err) {
        console.error('[Push] Error checking status:', err);
      }
    };
    
    checkPushStatus();
  }, []);

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
  // Cleanup: Remove Iran-origin missiles only (Lebanon→center/south Israel must stay visible)
  // ==========================================
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveMissiles((prev) => {
        const filtered = prev.filter((m) => {
          if (m.sourceRegion === 'iran') {
            console.log('[Cleanup] Removing Iran missile:', m.id, 'region:', m.sourceRegion);
            return false;
          }
          return true;
        });
        if (filtered.length !== prev.length) {
          console.log('[Cleanup] Removed', prev.length - filtered.length, 'invalid missiles');
        }
        return filtered;
      });
    }, 2000); // Check every 2 seconds
    
    return () => clearInterval(interval);
  }, []);

  // ==========================================
  // ==========================================
  // Push Notifications - Toggle subscription
  // ==========================================
  const togglePushNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('התראות Push אינן נתמכות בדפדפן זה');
      return;
    }
    
    try {
      const registration = await navigator.serviceWorker.ready;
      
      if (pushEnabled) {
        // Unsubscribe
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
          console.log('[Push] Unsubscribed');
          
          // Notify server to remove subscription
          if (socketRef.current) {
            socketRef.current.emit('push_unsubscribe', { endpoint: subscription.endpoint });
          }
        }
        setPushEnabled(false);
      } else {
        // Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          alert('יש לאשר הרשאות התראות כדי לקבל עדכונים');
          return;
        }
        
        // Subscribe - NOTE: In production, VAPID keys should come from server
        // For now we'll use a placeholder - real implementation needs server-side VAPID
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array('PLACEHOLDER_VAPID_KEY')
        });
        
        console.log('[Push] Subscribed:', subscription);
        
        // Send subscription to server
        if (socketRef.current) {
          socketRef.current.emit('push_subscribe', subscription);
        }
        
        setPushEnabled(true);
        
        // Test notification
        new Notification('🚨 War Monitor', {
          body: 'התראות Push הופעלו בהצלחה!',
          icon: '/icon-192x192.svg'
        });
      }
    } catch (err) {
      console.error('[Push] Error:', err);
      alert('שגיאה בהפעלת התראות: ' + err.message);
    }
  };
  
  // Helper for VAPID key conversion (needed for real implementation)
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }

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
      
      // Add to alert history
      setAlertHistory(prev => {
        const newAlert = {
          id: `alert-${Date.now()}-${data.cityName}`,
          cityName: data.cityName,
          timestamp: Date.now(),
          title: data.title || 'התראה',
          threatType: data.threatType || 'missile',
          sourceRegion: data.sourceRegion || 'unknown'
        };
        // Keep only last 100 alerts
        return [newAlert, ...prev].slice(0, 100);
      });
      
      // Add to pending targets for grouped missile launch
      const now = Date.now();
      const timeSinceLastLaunch = now - lastMissileLaunchTime;
      
      // If more than 1 minute since last launch, or no pending targets, start new wave
      if (timeSinceLastLaunch > 60000 || pendingTargets.length === 0) {
        setPendingTargets([{ cityName: data.cityName, position: coords, timestamp: now }]);
        setMissileWaveId((prev) => prev + 1);
        
        // Clear any existing timer
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
        
        // Launch missile after 3 seconds to collect all simultaneous alerts
        pendingTimerRef.current = setTimeout(() => {
          launchGroupedMissile();
        }, 3000);
      } else {
        // Add to current wave
        setPendingTargets((prev) => [...prev, { cityName: data.cityName, position: coords, timestamp: now }]);
      }
    };
    
    const launchGroupedMissile = () => {
      setPendingTargets((targets) => {
        if (targets.length === 0) return [];
        
        const now = Date.now();
        const waveId = `wave-${missileWaveId}-${now}`;
        const source = [35.43, 33.12]; // Bint Jbeil (בינת ג'בל), South Lebanon
        
        // Calculate split point - just before reaching targets (90% of the way)
        // This makes the split happen much closer to the cities
        const avgLng = targets.reduce((sum, t) => sum + t.position[0], 0) / targets.length;
        const avgLat = targets.reduce((sum, t) => sum + t.position[1], 0) / targets.length;
        const splitPoint = [
          source[0] + (avgLng - source[0]) * 0.90,
          source[1] + (avgLat - source[1]) * 0.90
        ];
        
        // Create main missile
        const mainMissile = {
          id: waveId,
          cityName: targets.length > 1 ? `${targets.length} ערים` : targets[0].cityName,
          source,
          target: splitPoint, // Main missile goes to split point
          splitPoint,
          targets: targets, // All targets for small missiles
          sourceRegion: 'lebanon',
          sourceLocation: 'לבנון',
          displayFlightMs: 15000, // 15 seconds to split point
          displayElapsedMs: 0,
          clientStartTime: now,
          estimatedDistanceKm: getDistanceKm(source, splitPoint),
          threatType: 'missile',
          phase: 'launch',
          status: 'inbound',
          timestamp: now,
          isMainMissile: true,
          hasSplit: targets.length > 1,
          opacity: 1,
          fading: false
        };
        
        setActiveMissiles((prev) => [...prev, mainMissile]);
        setLastMissileLaunchTime(now);
        
        console.log('[launchGroupedMissile] Launched missile for', targets.length, 'cities, wave:', waveId);
        return [];
      });
    };

    const onRealTimeMissile = (data) => {
      console.log('[onRealTimeMissile] Received:', data.id, 'source:', data.source, 'target:', data.target, 'sourceRegion:', data.sourceRegion);
      if (!data?.id) return;

      const region = data.sourceRegion || 'unknown';
      if (region === 'iran') {
        console.log('[onRealTimeMissile] BLOCKED - Iran missile rejected:', data.id, 'region:', region);
        return;
      }

      // Always use Bint Jbeil as the launch source for consistent display
      const BINT_JBEIL_SOURCE = [35.43, 33.12];
      const target = data.target || data.targetPosition;
      // Override source to always be Bint Jbeil for all missiles (single unified source)
      const source = BINT_JBEIL_SOURCE;
      if (!source || !target) {
        console.log('[onRealTimeMissile] Missing source or target, skipping');
        return;
      }

      // Auto-zoom to new missile if enabled
      if (autoZoomEnabled && target) {
        setViewState(prev => ({
          ...prev,
          longitude: target[0],
          latitude: target[1],
          zoom: isMobile ? 8.5 : 9,  // Zoom in closer to the threat
          transitionDuration: 1000  // Smooth animation
        }));
      }

      setActiveMissiles((prev) => {
        if (prev.some((m) => m.id === data.id)) {
          console.log('[onRealTimeMissile] Missile already exists:', data.id);
          return prev;
        }
        // Calculate accurate flight time based on distance
        const calculatedFlightMs = calculateFlightTimeMs(source, target);
        // Start missile from the beginning (progress = 0) at the source
        const clientStartTime = Date.now();
        const flightMs = calculatedFlightMs || data.displayFlightMs || data.flightMs || 30000;
        const distanceKm = getDistanceKm(source, target);
        console.log('[onRealTimeMissile] Adding missile:', data.id, 'distance:', distanceKm.toFixed(1), 'km', 'flightTime:', (flightMs/1000).toFixed(1), 'sec');
        return [...prev, {
          ...data,
          id: data.id,
          cityName: data.cityName || 'unknown',
          source,
          target,
          sourceRegion: data.sourceRegion || 'lebanon', // Default to Lebanon
          sourceLocation: data.sourceLocation || 'לבנון',
          displayFlightMs: flightMs,
          displayElapsedMs: 0, // Start from 0 to show missile from source
          clientStartTime, // Track when client first saw this missile
          estimatedDistanceKm: distanceKm,
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
        
        // For cluster missiles: keep visible until Oref sends clear event
        // For regular missiles: fade out after 3 seconds
        const isCluster = data.isCluster || false;
        const timeoutMs = isCluster ? 60000 : 3000; // Cluster: 60 sec, Regular: 3 sec
        
        setTimeout(() => {
          setImpacts((prev) => prev.filter((i) => i.id !== marker.id));
          if (!isCluster) {
            // Only remove regular missiles automatically
            setActiveMissiles((prev) => prev.filter((m) => m.id !== data.id));
          }
          // Cluster missiles will be removed by 'clear_city_alert' event from Oref
        }, timeoutMs);
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
      yemen: 'תימן', iraq: 'עיראק'
      // Iran disabled: iran: 'איראן'
    };
    return labels[region] || 'לבנון'; /* Default to Lebanon */
  }, []);

  const getSourcePalette = useCallback((region, phase) => {
    if (phase === 'intercepted') {
      return { primary: [166, 126, 255], secondary: [202, 178, 255], glow: [236, 226, 255] };
    }
    const palettes = {
      lebanon: { primary: [244, 203, 74], secondary: [255, 228, 125], glow: [255, 244, 214] },
      syria: { primary: [255, 160, 0], secondary: [255, 202, 96], glow: [255, 236, 199] },
      gaza: { primary: [255, 112, 99], secondary: [255, 169, 150], glow: [255, 225, 220] },
      yemen: { primary: [96, 205, 255], secondary: [154, 228, 255], glow: [224, 246, 255] },
      iraq: { primary: [255, 128, 191], secondary: [255, 190, 223], glow: [255, 232, 243] }
    };
    return palettes[region] || { primary: [255, 100, 100], secondary: [255, 170, 100], glow: [255, 230, 200] };
  }, []);

  // Calculate distance between two coordinates (Haversine formula) - result in km
  const getDistanceKm = useCallback((pos1, pos2) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371; // Earth's radius in km
    const lat1 = toRad(pos1[1]);
    const lat2 = toRad(pos2[1]);
    const deltaLat = toRad(pos2[1] - pos1[1]);
    const deltaLng = toRad(pos2[0] - pos1[0]);
    
    const a = Math.sin(deltaLat / 2) ** 2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c;
  }, []);

  // Calculate flight time in ms based on distance from Lebanon
  // Kiryat Shmona (closest): 10 seconds
  // Tel Aviv (farthest): 90 seconds (1.5 minutes)
  const calculateFlightTimeMs = useCallback((source, target) => {
    const distanceKm = getDistanceKm(source, target);
    
    // Base times for Lebanon
    // ~5km to Kiryat Shmona = 10 seconds
    // ~130km to Tel Aviv = 90 seconds
    // Formula: time increases with distance
    const minTime = 10000; // 10 seconds minimum
    const maxTime = 90000; // 90 seconds maximum
    const minDist = 5;    // 5km (Kiryat Shmona area)
    const maxDist = 140;  // 140km (Tel Aviv area)
    
    // Linear interpolation between min and max time based on distance
    if (distanceKm <= minDist) return minTime;
    if (distanceKm >= maxDist) return maxTime;
    
    const ratio = (distanceKm - minDist) / (maxDist - minDist);
    return Math.round(minTime + ratio * (maxTime - minTime));
  }, [getDistanceKm]);

  // ==========================================
  // Compute animated missile positions
  // ==========================================
  const animatedMissiles = useMemo(() => {
    const result = [];
    
    activeMissiles.forEach((missile) => {
      // Use client start time if available (for missiles just added), otherwise use timestamp
      const startTime = missile.clientStartTime || missile.timestamp;
      const elapsed = currentTime - startTime;
      const flightMs = missile.displayFlightMs || 30000;
      
      // Calculate progress from 0 to 1 based on elapsed time since client saw the missile
      const progress = Math.min(1, Math.max(0, elapsed / flightMs));

      const currentPosition = getGreatCirclePoint(missile.source, missile.target, progress);

      // Main missile - show only until it reaches split point
      if (missile.isMainMissile && !missile.hasSplit) {
        if (progress < 1) {
          result.push({
            ...missile,
            progress,
            currentPosition,
            opacity: missile.fading ? 0 : (missile.opacity ?? 1)
          });
        }
        // When main missile reaches split point, create small missiles for each target
        else if (missile.targets && missile.targets.length > 0 && !missile.splitTriggered) {
          missile.splitTriggered = true;
          missile.fading = true;
          
          // Create small missiles from split point to each city
          missile.targets.forEach((target, idx) => {
            const smallMissileId = `${missile.id}-small-${idx}`;
            const distanceToTarget = getDistanceKm(missile.splitPoint, target.position);
            const timeToTarget = calculateFlightTimeMs(missile.splitPoint, target.position);
            
            result.push({
              id: smallMissileId,
              cityName: target.cityName,
              source: missile.splitPoint,
              target: target.position,
              sourceRegion: 'lebanon',
              displayFlightMs: timeToTarget,
              displayElapsedMs: 0,
              clientStartTime: currentTime,
              estimatedDistanceKm: distanceToTarget,
              threatType: 'missile',
              phase: 'split',
              status: 'inbound',
              timestamp: currentTime,
              isSmallMissile: true,
              parentWaveId: missile.id,
              opacity: 1,
              fading: false,
              progress: 0,
              currentPosition: missile.splitPoint
            });
          });
        }
      }
      // Small missiles (after split) - animate from split point to target
      else if (missile.isSmallMissile) {
        const smallElapsed = currentTime - (missile.clientStartTime || missile.timestamp);
        const smallProgress = Math.min(1, Math.max(0, smallElapsed / (missile.displayFlightMs || 10000)));
        const smallPosition = getGreatCirclePoint(missile.source, missile.target, smallProgress);
        
        if (smallProgress < 1) {
          result.push({
            ...missile,
            progress: smallProgress,
            currentPosition: smallPosition,
            opacity: missile.fading ? 0 : (missile.opacity ?? 1)
          });
        }
      }
      // Regular missiles (not grouped)
      else {
        result.push({
          ...missile,
          progress,
          currentPosition,
          opacity: missile.fading ? 0 : (missile.opacity ?? 1)
        });
      }
    });
    
    return result;
  }, [activeMissiles, currentTime, getGreatCirclePoint, getDistanceKm, calculateFlightTimeMs]);

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
    // DEBUG: Log missile details
    const activeMissiles = animatedMissiles.filter(m => m.progress < 1);
    console.log('[Missile Layer] Total:', animatedMissiles.length, 'Active:', activeMissiles.length);
    if (animatedMissiles.length > 0) {
      console.log('[Missile Sample]', animatedMissiles[0].id, 'progress:', animatedMissiles[0].progress, 'source:', animatedMissiles[0].source, 'target:', animatedMissiles[0].target);
    }
    // For debugging: show all missiles, not just progress < 1
    const dataToShow = activeMissiles.length > 0 ? activeMissiles : animatedMissiles;
    return new ArcLayer({
      id: 'missile-arc-layer',
      data: dataToShow,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).primary;
        // Bright yellow/orange color like Iran War Monitor
        return [255, 200, 50, Math.round((d.opacity ?? 1) * 255)];
      },
      getTargetColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).secondary;
        // Bright red/orange at target
        return [255, 100, 50, Math.round((d.opacity ?? 1) * 255)];
      },
      getWidth: 4,
      widthMinPixels: 3,
      widthMaxPixels: 6,
      greatCircle: true,
      getHeight: 0.2,
      pickable: true,
      autoHighlight: true,
      transitions: { opacity: 2000 },
      opacity: 1,
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

  // Calculate angle for missile based on trajectory
  const getMissileAngle = useCallback((missile) => {
    const [sx, sy] = missile.source;
    const [tx, ty] = missile.target;
    // Calculate bearing from source to target
    const dx = tx - sx;
    const dy = ty - sy;
    const angleRad = Math.atan2(dy, dx);
    const angleDeg = (angleRad * 180) / Math.PI;
    // Adjust for emoji orientation (pointing right = 0 degrees)
    return angleDeg;
  }, []);

  // Layer 2b: Glow effect for missile trajectory
  const missileGlowLayer = useMemo(() => {
    const dataToShow = activeMissiles.length > 0 ? activeMissiles : animatedMissiles;
    return new ArcLayer({
      id: 'missile-glow-layer',
      data: dataToShow,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: [255, 200, 50, 80],
      getTargetColor: [255, 100, 50, 80],
      getWidth: 12,
      widthMinPixels: 8,
      widthMaxPixels: 20,
      greatCircle: true,
      getHeight: 0.2,
      pickable: false,
      opacity: 0.6
    });
  }, [animatedMissiles, activeMissiles]);

  // Layer 3: Main missile head (shows grouped missiles AND regular backend missiles)
  const mainMissileLayer = useMemo(() => {
    const missileData = animatedMissiles.filter((m) => {
      // Show all missiles that are: 1) in progress, 2) not small/cluster missiles
      const inProgress = m.progress >= 0 && m.progress < 1;
      const isNotSmall = !m.isSmallMissile;
      return inProgress && isNotSmall;
    });
    console.log('[mainMissileLayer] Showing', missileData.length, 'missiles');
    return new IconLayer({
      id: 'main-missile-layer',
      data: missileData,
      getPosition: (d) => d.currentPosition,
      getIcon: (d) => {
        // Different icons for missiles vs UAVs
        const isUAV = d.threatType === 'uav';
        // ✈️ = airplane for UAV, 🚀 = rocket for missiles
        const icon = isUAV ? '✈️' : '🚀';
        return {
          url: 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><text x="16" y="24" font-size="20" text-anchor="middle">${icon}</text></svg>`),
          width: 32,
          height: 32,
          anchorY: 16
        };
      },
      getSize: (d) => isMobile 
        ? (d.isMainMissile ? 85 : 75)  // Larger icons on mobile for touch
        : (d.isMainMissile ? 65 : 55),
      sizeUnits: 'pixels',
      getAngle: (d) => getMissileAngle(d),
      billboard: false,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        const remainingMs = Math.max(0,
          info.object.displayFlightMs - (currentTime - (info.object.clientStartTime || info.object.timestamp)));
        const etaLabel = remainingMs >= 60000
          ? `${Math.ceil(remainingMs / 60000)} דק'`
          : `${Math.ceil(remainingMs / 1000)} שנ'`;
        const pal = getSourcePalette(info.object.sourceRegion, info.object.phase);
        const isUAV = info.object.threatType === 'uav';
        const typeLabel = isUAV ? '🛸 כלי טייס בלתי מאויש' : '🚀 טיל בליסטי';
        const speedLabel = isUAV ? 'מהירות: 130 קמ"ש' : 'מהירות: בליסטית';
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(${pal.primary.join(',')},0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(${pal.primary.join(',')});margin-bottom:6px;">${typeLabel}</div>
              <div>מקור: ${formatSourceRegion(info.object.sourceRegion)}</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
              <div>${speedLabel}</div>
              <div>זמן הגעה: ${etaLabel}</div>
              <div>התקדמות: ${Math.round(info.object.progress * 100)}%</div>
              ${info.object.isCluster ? '<div style="color:#ff8800;">⚠️ טיל מצרר</div>' : ''}
            </div>
          `
        };
      }
    });
  }, [animatedMissiles, currentTime, formatSourceRegion, getSourcePalette, getMissileAngle, isMobile]);

  // Layer 3b: Small missiles (cluster munition bomblets after split)
  const smallMissileLayer = useMemo(() => {
    return new IconLayer({
      id: 'small-missile-layer',
      data: animatedMissiles.filter((m) => m.progress < 1 && m.progress >= 0 && m.isSmallMissile),
      getPosition: (d) => d.currentPosition,
      getIcon: (d) => {
        // Random scatter effect based on missile ID
        const seed = d.id ? d.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0) : 0;
        const scatterX = (seed % 7) - 3;
        const scatterY = (seed % 5) - 2;
        const rotation = (seed % 30) - 15;
        
        return {
          url: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="30" height="20">
              <defs>
                <linearGradient id="bombGrad${d.id}" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style="stop-color:#444;stop-opacity:1" />
                  <stop offset="50%" style="stop-color:#222;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#111;stop-opacity:1" />
                </linearGradient>
                <filter id="bombGlow${d.id}" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="1.5" result="blur"/>
                  <feMerge>
                    <feMergeNode in="blur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>
              <g transform="rotate(${rotation} 15 10) translate(${scatterX} ${scatterY})">
                <!-- Smoke trail -->
                <ellipse cx="5" cy="10" rx="8" ry="3" fill="#666" opacity="0.4">
                  <animate attributeName="rx" values="8;10;8" dur="0.2s" repeatCount="indefinite"/>
                  <animate attributeName="opacity" values="0.4;0.2;0.4" dur="0.3s" repeatCount="indefinite"/>
                </ellipse>
                <!-- Bomblet body - cylindrical with fins -->
                <rect x="8" y="7" width="14" height="6" rx="2" fill="url(#bombGrad${d.id})" stroke="#111" stroke-width="0.5" filter="url(#bombGlow${d.id})"/>
                <!-- Front cone -->
                <path d="M 22 7 L 27 10 L 22 13 Z" fill="#333" stroke="#111" stroke-width="0.5"/>
                <!-- Stabilizer fins -->
                <path d="M 12 7 L 10 4 L 16 7 Z" fill="#555"/>
                <path d="M 12 13 L 10 16 L 16 13 Z" fill="#555"/>
                <!-- Small spark/fire at back -->
                <circle cx="8" cy="10" r="2" fill="#ff6600" opacity="0.7">
                  <animate attributeName="r" values="2;3;2" dur="0.1s" repeatCount="indefinite"/>
                </circle>
              </g>
            </svg>
          `),
          width: 30,
          height: 20,
          anchorY: 10
        };
      },
      getSize: (d) => 28 + ((d.id ? d.id.length : 0) % 8), // Vary size slightly for visual variety
      sizeUnits: 'pixels',
      getAngle: (d) => getMissileAngle(d),
      billboard: false,
      pickable: true,
      onHover: (info) => {
        if (!info.object) return null;
        const remainingMs = Math.max(0,
          info.object.displayFlightMs - (currentTime - (info.object.clientStartTime || info.object.timestamp)));
        const etaLabel = remainingMs >= 60000
          ? `${Math.ceil(remainingMs / 60000)} דק'`
          : `${Math.ceil(remainingMs / 1000)} שנ'`;
        return {
          html: `
            <div style="background:rgba(6,10,16,0.94);border:1px solid rgba(255,68,68,0.65);padding:10px 12px;border-radius:6px;color:white;font-size:12px;min-width:180px;">
              <div style="font-weight:700;color:rgb(255,68,68);margin-bottom:6px;">🚀 טיל מפוצל</div>
              <div>יעד: ${info.object.cityName || 'לא ידוע'}</div>
              <div>זמן הגעה: ${etaLabel}</div>
              <div>התקדמות: ${Math.round(info.object.progress * 100)}%</div>
            </div>
          `
        };
      }
    });
  }, [animatedMissiles, currentTime, getMissileAngle]);

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

  // Generate cluster sub-missiles for visualization
  const clusterMissiles = useMemo(() => {
    const clusters = [];
    animatedMissiles.forEach((missile) => {
      if (missile.isCluster && missile.progress < 0.95) {
        // Create 3-5 sub-missiles around the main missile
        const subCount = 4;
        for (let i = 0; i < subCount; i++) {
          const angle = (i / subCount) * 2 * Math.PI;
          const radius = 0.003; // Small offset from main missile
          const [mainLng, mainLat] = missile.currentPosition;
          const offsetLng = mainLng + Math.cos(angle) * radius;
          const offsetLat = mainLat + Math.sin(angle) * radius;
          clusters.push({
            id: `${missile.id}-sub-${i}`,
            position: [offsetLng, offsetLat],
            parentId: missile.id,
            sourceRegion: missile.sourceRegion,
            phase: missile.phase,
            opacity: 0.7
          });
        }
      }
    });
    return clusters;
  }, [animatedMissiles]);

  // Layer 4b: Cluster sub-missiles (small bombs)
  const clusterLayer = useMemo(() => {
    return new IconLayer({
      id: 'cluster-layer',
      data: clusterMissiles,
      getPosition: (d) => d.position,
      getIcon: () => ({
        url: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
            <text x="12" y="18" font-size="14" text-anchor="middle">💣</text>
          </svg>
        `),
        width: 24,
        height: 24,
        anchorY: 12
      }),
      getSize: () => 20,
      sizeUnits: 'pixels',
      getAngle: () => Math.random() * 360, // Random rotation for scattered effect
      billboard: false,
      pickable: false
    });
  }, [clusterMissiles]);

  // Generate small missile arcs (from split point to each city)
  const smallMissileArcs = useMemo(() => {
    const smallArcs = [];
    animatedMissiles.forEach((missile) => {
      // Show arc for small missiles from their source (split point) to target
      if (missile.isSmallMissile && missile.progress < 1) {
        smallArcs.push({
          id: `${missile.id}-arc`,
          source: missile.source,
          target: missile.target,
          cityName: missile.cityName,
          sourceRegion: 'lebanon',
          opacity: 0.8
        });
      }
    });
    return smallArcs;
  }, [animatedMissiles]);

  // Layer 4b: Small missile arcs
  const smallMissileArcLayer = useMemo(() => {
    return new ArcLayer({
      id: 'small-missile-arc-layer',
      data: smallMissileArcs,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: [255, 150, 50, 200],
      getTargetColor: [255, 80, 50, 200],
      getWidth: 2,
      widthMinPixels: 2,
      widthMaxPixels: 3,
      greatCircle: true,
      getHeight: 0.1,
      pickable: false,
      opacity: 0.8
    });
  }, [smallMissileArcs]);

  // Generate split explosion effects at split points
  const splitExplosions = useMemo(() => {
    const explosions = [];
    activeMissiles.forEach((missile) => {
      // Show explosion when main missile has just split
      if (missile.isMainMissile && missile.splitTriggered && !missile.explosionShown) {
        missile.explosionShown = true;
        explosions.push({
          id: `${missile.id}-split-explosion`,
          position: missile.splitPoint,
          timestamp: Date.now(),
          sourceRegion: missile.sourceRegion
        });
      }
    });
    return explosions;
  }, [activeMissiles]);

  // Layer 4c: Split explosion effect
  const splitExplosionLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'split-explosion-layer',
      data: splitExplosions,
      getPosition: (d) => d.position,
      getFillColor: [255, 200, 50, 200],
      getLineColor: [255, 100, 50, 255],
      getRadius: 3500,
      radiusMinPixels: 8,
      radiusMaxPixels: 25,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 2,
      pickable: false,
      opacity: 0.9
    });
  }, [splitExplosions]);

  // Generate branching arcs for multi-city targets
  const branchArcs = useMemo(() => {
    const branches = [];
    animatedMissiles.forEach((missile) => {
      if (missile.branchTargets && missile.branchTargets.length > 1 && missile.progress < 0.9) {
        // Show branches from main missile to each target
        missile.branchTargets.forEach((target, idx) => {
          if (idx === 0) return; // Skip first as it's the main target
          branches.push({
            id: `${missile.id}-branch-${idx}`,
            source: missile.currentPosition,
            target: target.position,
            sourceRegion: missile.sourceRegion,
            phase: missile.phase,
            opacity: 0.6,
            branchIndex: idx
          });
        });
      }
    });
    return branches;
  }, [animatedMissiles]);

  // Layer 4c: Branching missile arcs
  const branchArcLayer = useMemo(() => {
    return new ArcLayer({
      id: 'branch-arc-layer',
      data: branchArcs,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).secondary;
        return [base[0], base[1], base[2], Math.round(d.opacity * 150)];
      },
      getTargetColor: (d) => {
        const base = getSourcePalette(d.sourceRegion, d.phase).glow;
        return [base[0], base[1], base[2], Math.round(d.opacity * 100)];
      },
      getWidth: () => 2,
      widthMinPixels: 1,
      widthMaxPixels: 3,
      greatCircle: false,
      pickable: false
    });
  }, [branchArcs, getSourcePalette]);

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
      radiusMinPixels: isMobile ? 8 : 4,
      radiusMaxPixels: isMobile ? 20 : 14,
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
  }, [intercepts, currentTime, formatSourceRegion, isMobile]);

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
      radiusMinPixels: isMobile ? 10 : 5,
      radiusMaxPixels: isMobile ? 24 : 18,
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
  }, [impacts, currentTime, formatSourceRegion, isMobile]);

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
    missileGlowLayer,       // Glow effect behind trajectory
    missileArcLayer,        // Main trajectory line
    smallMissileArcLayer,   // Arcs for small missiles after split
    branchArcLayer,         // Branching missiles to multiple cities
    waveLabelLayer,
    iconLayer,
    mainMissileLayer,       // Main missile (before split)
    smallMissileLayer,      // Small missiles (after split to each city)
    clusterLayer,           // Cluster bomb sub-missiles
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
        {leadThreat ? (
          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #333' }}>
            <div style={{ color: '#f4cb4a' }}>מקור: {leadThreat.sourceRegion}</div>
            <div>זמן הגעה: {leadThreat.etaLabel}</div>
            <div>יעד: {leadThreat.cityName}</div>
            {leadThreat.distanceKm && <div>טווח: {leadThreat.distanceKm} ק"מ</div>}
            <div>גל: {leadThreat.waveLabel}</div>
          </div>
        ) : (
          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #333', color: '#666' }}>
            <div>ממתין למקור האיום...</div>
          </div>
        )}
        
        {/* Auto-zoom toggle */}
        <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #333' }}>
          <button
            onClick={() => setAutoZoomEnabled(!autoZoomEnabled)}
            style={{
              background: autoZoomEnabled ? 'rgba(244,203,74,0.2)' : 'rgba(100,100,100,0.2)',
              border: `1px solid ${autoZoomEnabled ? '#f4cb4a' : '#666'}`,
              color: autoZoomEnabled ? '#f4cb4a' : '#999',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              marginBottom: '6px'
            }}
          >
            <span>{autoZoomEnabled ? '🎯' : '📍'}</span>
            <span>זום אוטומטי {autoZoomEnabled ? 'מופעל' : 'כבוי'}</span>
          </button>
          
          {/* Day/Night toggle */}
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            style={{
              background: isDarkMode ? 'rgba(100,100,150,0.2)' : 'rgba(255,200,100,0.2)',
              border: `1px solid ${isDarkMode ? '#8899cc' : '#cc9900'}`,
              color: isDarkMode ? '#aaccff' : '#cc8800',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              marginBottom: '6px'
            }}
          >
            <span>{isDarkMode ? '🌙' : '☀️'}</span>
            <span>{isDarkMode ? 'מצב לילה' : 'מצב יום'}</span>
          </button>
          
          {/* History toggle */}
          <button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              background: showHistory ? 'rgba(100,200,100,0.2)' : 'rgba(100,100,100,0.2)',
              border: `1px solid ${showHistory ? '#66cc66' : '#666'}`,
              color: showHistory ? '#88ff88' : '#999',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              marginBottom: '6px'
            }}
          >
            <span>📋</span>
            <span>היסטוריה ({alertHistory.length})</span>
          </button>
          
          {/* Push notifications toggle */}
          <button
            onClick={togglePushNotifications}
            disabled={!('serviceWorker' in navigator)}
            style={{
              background: pushEnabled ? 'rgba(255,100,100,0.2)' : 'rgba(100,100,100,0.2)',
              border: `1px solid ${pushEnabled ? '#ff6666' : '#666'}`,
              color: pushEnabled ? '#ff8888' : '#999',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: ('serviceWorker' in navigator) ? 'pointer' : 'not-allowed',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              opacity: ('serviceWorker' in navigator) ? 1 : 0.5
            }}
          >
            <span>{pushEnabled ? '🔔' : '🔕'}</span>
            <span>התראות {pushEnabled ? 'פעילות' : 'כבויות'}</span>
          </button>
        </div>
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
          mapStyle={isDarkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11"}
          style={{ width: '100%', height: '100%' }}
        />
      </DeckGL>

      {/* Alert History Panel */}
      {showHistory && (
        <div style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          width: '320px',
          maxHeight: '60%',
          background: isDarkMode ? 'rgba(20,20,30,0.95)' : 'rgba(245,245,250,0.95)',
          border: `1px solid ${isDarkMode ? '#444' : '#ccc'}`,
          borderRadius: '8px',
          zIndex: 20,
          overflow: 'auto',
          padding: '15px',
          color: isDarkMode ? '#fff' : '#333',
          fontSize: '13px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
            paddingBottom: '8px',
            borderBottom: `1px solid ${isDarkMode ? '#444' : '#ddd'}`
          }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>📋 היסטוריית התראות</h3>
            <button
              onClick={() => setShowHistory(false)}
              style={{
                background: 'none',
                border: 'none',
                color: isDarkMode ? '#999' : '#666',
                cursor: 'pointer',
                fontSize: '18px'
              }}
            >
              ✕
            </button>
          </div>
          
          {alertHistory.length === 0 ? (
            <div style={{ color: isDarkMode ? '#888' : '#999', textAlign: 'center', padding: '20px 0' }}>
              אין התראות ב-24 השעות האחרונות
            </div>
          ) : (
            <div>
              {alertHistory.map((alert) => {
                const age = Date.now() - alert.timestamp;
                const hours = Math.floor(age / (1000 * 60 * 60));
                const minutes = Math.floor((age % (1000 * 60 * 60)) / (1000 * 60));
                const timeLabel = hours > 0 
                  ? `לפני ${hours} שעות` 
                  : `לפני ${minutes} דקות`;
                
                return (
                  <div
                    key={alert.id}
                    style={{
                      padding: '10px',
                      marginBottom: '8px',
                      background: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                      borderRadius: '6px',
                      borderRight: `3px solid ${alert.threatType === 'uav' ? '#66ccff' : '#ff6666'}`
                    }}
                  >
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                      {alert.cityName}
                    </div>
                    <div style={{ fontSize: '11px', color: isDarkMode ? '#aaa' : '#666', marginBottom: '3px' }}>
                      {timeLabel} • {alert.title}
                    </div>
                    <div style={{ fontSize: '11px' }}>
                      <span style={{ 
                        color: alert.threatType === 'uav' ? '#66ccff' : '#ff6666',
                        fontWeight: 'bold'
                      }}>
                        {alert.threatType === 'uav' ? '🛸 כטב"מ' : '🚀 טיל'}
                      </span>
                      {alert.sourceRegion && alert.sourceRegion !== 'unknown' && (
                        <span style={{ color: isDarkMode ? '#888' : '#666', marginRight: '8px' }}>
                          {' '}מאת: {alert.sourceRegion}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MapWithIcons;
