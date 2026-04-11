// ==========================================
// App.jsx - אפליקציה ראשית מאוחדת
// War Monitor - Unified Frontend
// ==========================================

import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import MapWithIcons from './components/MapWithIcons';
import Widgets from './components/Widgets';
import './App.css';

// Use Render URL in production, localhost in development
const SERVER_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:8080' 
  : 'https://war-monitor-d02.onrender.com';

// ==========================================
// Main App Component
// ==========================================
function App() {
  const [socket, setSocket] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [alerts, setAlerts] = useState([]);
  const [stats, setStats] = useState({
    activeAlerts: 0,
    activeMissiles: 0,
    totalFlights: 0,
    lastUpdate: null
  });

  // Socket connection with better stability
  useEffect(() => {
    const newSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });

    newSocket.on('connect', () => {
      console.log('[App] Connected to server');
      setConnectionStatus('connected');
      setSocket(newSocket);
    });

    newSocket.on('disconnect', () => {
      console.log('[App] Disconnected from server');
      setConnectionStatus('disconnected');
    });

    newSocket.on('connect_error', (err) => {
      console.error('[App] Connection error:', err.message);
      setConnectionStatus('error');
    });

    newSocket.on('reconnect', (attemptNumber) => {
      console.log('[App] Reconnected after', attemptNumber, 'attempts');
      setConnectionStatus('connected');
    });

    newSocket.on('reconnect_attempt', (attemptNumber) => {
      console.log('[App] Reconnection attempt', attemptNumber);
    });

    // Listen for new alerts
    newSocket.on('new_alert', (data) => {
      console.log('[App] New alert:', data);
      setAlerts(prev => [data, ...prev].slice(0, 50));
      setStats(prev => ({
        ...prev,
        activeAlerts: prev.activeAlerts + 1,
        lastUpdate: new Date()
      }));
    });

    newSocket.on('real_time_missile', (data) => {
      setStats(prev => ({
        ...prev,
        activeMissiles: prev.activeMissiles + 1,
        lastUpdate: new Date()
      }));
    });

    newSocket.on('missile_update', (data) => {
      if (data.phase === 'intercepted' || data.phase === 'impact') {
        setStats(prev => ({
          ...prev,
          activeMissiles: Math.max(0, prev.activeMissiles - 1)
        }));
      }
    });

    newSocket.on('clear_all_threats', () => {
      setStats(prev => ({ ...prev, activeMissiles: 0, activeAlerts: 0 }));
    });

    newSocket.on('clear_city_alert', () => {
      setStats(prev => ({
        ...prev,
        activeAlerts: Math.max(0, prev.activeAlerts - 1)
      }));
    });

    // Listen for flights update
    newSocket.on('flights_update', (data) => {
      setStats(prev => ({
        ...prev,
        totalFlights: data?.length || 0
      }));
    });

    // Cleanup
    return () => {
      newSocket.close();
    };
  }, []);

  // Clock update
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Get connection status color
  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return '#00ff00';
      case 'connecting': return '#ffaa00';
      case 'disconnected': return '#ff0000';
      case 'error': return '#ff0000';
      default: return '#888';
    }
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">🛡️</span>
            <span className="logo-text">מוניטור מלחמה</span>
          </div>
          <div className="live-badge">
            <span 
              className="live-dot" 
              style={{ backgroundColor: getStatusColor() }}
            />
            <span className="live-text">
              {connectionStatus === 'connected' ? 'LIVE' : connectionStatus}
            </span>
          </div>
        </div>

        <div className="header-center">
          <div className="stat-box">
            <span className="stat-label">התראות פעילות</span>
            <span className="stat-value" style={{ color: '#ff4444' }}>
              {stats.activeAlerts}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">טילים באוויר</span>
            <span className="stat-value" style={{ color: '#ff8800' }}>
              {stats.activeMissiles}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">טיסות באזור</span>
            <span className="stat-value" style={{ color: '#00aaff' }}>
              {stats.totalFlights}
            </span>
          </div>
        </div>

        <div className="header-right">
          <span className="clock">
            {clock.toLocaleTimeString('he-IL')}
          </span>
        </div>
      </header>

      {/* Main Content - CSS Grid */}
      <main className="main-grid">
        {/* Left Panel - Alerts */}
        <aside className="left-panel">
          <div className="panel-header">
            <h3>🚨 התראות חי</h3>
            <span className="alert-count">{alerts.length}</span>
          </div>
          <div className="alerts-list">
            {alerts.length === 0 ? (
              <div className="no-alerts">ממתין להתרעות...</div>
            ) : (
              alerts.map((alert, index) => (
                <div 
                  key={alert.id || index} 
                  className={`alert-item ${index === 0 ? 'new' : ''}`}
                >
                  <div className="alert-time">
                    {new Date(alert.timestamp).toLocaleTimeString('he-IL')}
                  </div>
                  <div className="alert-city">{alert.cityName}</div>
                  <div className="alert-type">{alert.title}</div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Center - Map */}
        <section className="center-panel">
          <MapWithIcons socket={socket} />
        </section>

        {/* Right Panel - Widgets */}
        <aside className="right-panel">
          <Widgets socket={socket} />
        </aside>
      </main>

      {/* Footer */}
      <footer className="footer">
        <span>War Monitor v4.0 | נתונים בזמן אמת מפיקוד העורף</span>
        <span>עדכון אחרון: {stats.lastUpdate?.toLocaleTimeString('he-IL') || 'לא זמין'}</span>
      </footer>
    </div>
  );
}

export default App;
