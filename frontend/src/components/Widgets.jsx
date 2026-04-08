// ==========================================
// Widgets.jsx - כל הווידג'טים במקום אחד
// Unified Widgets Panel
// ==========================================

import React, { useState, useEffect } from 'react';
import './Widgets.css';

const Widgets = ({ socket }) => {
  const [activeTab, setActiveTab] = useState('flights');
  const [flights, setFlights] = useState([]);
  const [seismic, setSeismic] = useState([]);
  const [markets, setMarkets] = useState({});

  useEffect(() => {
    if (!socket) return;

    socket.on('flights_update', (data) => {
      setFlights(data || []);
    });

    socket.on('seismic_update', (data) => {
      setSeismic(data || []);
    });

    socket.on('markets_update', (data) => {
      setMarkets(data || {});
    });

    return () => {
      socket.off('flights_update');
      socket.off('seismic_update');
      socket.off('markets_update');
    };
  }, [socket]);

  return (
    <div className="widgets-container">
      {/* Tabs */}
      <div className="widget-tabs">
        <button 
          className={`tab-btn ${activeTab === 'flights' ? 'active' : ''}`}
          onClick={() => setActiveTab('flights')}
        >
          ✈️ טיסות
        </button>
        <button 
          className={`tab-btn ${activeTab === 'seismic' ? 'active' : ''}`}
          onClick={() => setActiveTab('seismic')}
        >
          🌍 רעידות
        </button>
        <button 
          className={`tab-btn ${activeTab === 'markets' ? 'active' : ''}`}
          onClick={() => setActiveTab('markets')}
        >
          📈 שווקים
        </button>
      </div>

      {/* Content */}
      <div className="widget-content">
        {activeTab === 'flights' && (
          <div className="flights-widget">
            <h4>טיסות באזור ({flights.length})</h4>
            <div className="flights-list">
              {flights.slice(0, 10).map((flight, idx) => (
                <div key={idx} className="flight-item">
                  <span className="flight-callsign">{flight.callsign || 'N/A'}</span>
                  <span className="flight-country">{flight.origin_country}</span>
                  <span className="flight-alt">
                    {flight.baro_altitude ? Math.round(flight.baro_altitude) : '?'} מ'
                  </span>
                </div>
              ))}
              {flights.length === 0 && (
                <div className="no-data">טוען נתוני טיסות...</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'seismic' && (
          <div className="seismic-widget">
            <h4>רעידות אדמה ({seismic.length})</h4>
            <div className="seismic-list">
              {seismic.slice(0, 10).map((event, idx) => (
                <div key={idx} className="seismic-item">
                  <span 
                    className="magnitude"
                    style={{ 
                      color: event.magnitude > 5 ? '#ff4444' : 
                             event.magnitude > 4 ? '#ff8800' : '#00ff88'
                    }}
                  >
                    M{event.magnitude}
                  </span>
                  <span className="location">{event.place}</span>
                  <span className="depth">{event.depth} ק"מ</span>
                </div>
              ))}
              {seismic.length === 0 && (
                <div className="no-data">טוען נתוני סייסמי...</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'markets' && (
          <div className="markets-widget">
            <h4>מדדי שווקים</h4>
            <div className="markets-list">
              {markets.vix && (
                <div className="market-item">
                  <span className="market-name">VIX</span>
                  <span className="market-value">{markets.vix.value}</span>
                </div>
              )}
              {markets.sp500 && (
                <div className="market-item">
                  <span className="market-name">S&P 500</span>
                  <span className="market-value">{markets.sp500.value}</span>
                </div>
              )}
              {!markets.vix && !markets.sp500 && (
                <div className="no-data">ממתין לנתוני שווקים...</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Widgets;
