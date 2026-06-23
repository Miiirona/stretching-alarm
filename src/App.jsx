import { useState, useEffect } from 'react';
import Dashboard from './Dashboard.jsx';
import Settings  from './Settings.jsx';
import './App.css';

export default function App() {
  const [cfg,  setCfg]  = useState(null);
  const [view, setView] = useState('dashboard');

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then(setCfg);

    const handler = (updated) => setCfg(updated);
    window.electronAPI?.on('config:updated', handler);
    return () => window.electronAPI?.off('config:updated', handler);
  }, []);

  if (!cfg) return <div className="loading">불러오는 중...</div>;

  if (view === 'settings') {
    return (
      <Settings
        cfg={cfg}
        onBack={() => { window.electronAPI?.invoke('config:get').then(setCfg); setView('dashboard'); }}
        onCfgChange={setCfg}
      />
    );
  }

  return (
    <Dashboard
      cfg={cfg}
      onCfgChange={setCfg}
      onSettingsOpen={() => setView('settings')}
    />
  );
}
