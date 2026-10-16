import { useState } from 'react';
import { Search, Minus, X, Radar, Activity } from 'lucide-react';
import { ILS, Il } from '../data/ils';

export interface Stats {
  total: number;
  online: number;
  offline: number;
  unknown: number;
  ilceCount: number;
}

interface Props {
  stats: Stats;
  onSelectIl: (il: Il) => void;
}

function StatPill({ label, value, tone }: { label: string; value: number; tone?: 'online' }) {
  return (
    <div className="stat-pill">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone === 'online' ? 'online' : ''}`}>{value}</span>
    </div>
  );
}

export default function HudBar({ stats, onSelectIl }: Props) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = q.trim()
    ? ILS.filter((i) => i.name.toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr'))).slice(0, 8)
    : [];

  return (
    <div className="hud">
      <div className="hud-left">
        <div className="hud-brand">
          <Radar size={18} />
          <span>OneView</span>
        </div>
        <div className="hud-stats">
          <StatPill label="İL" value={81} />
          <StatPill label="İLÇE" value={stats.ilceCount} />
          <StatPill label="KAMERA" value={stats.total} />
          <StatPill label="ONLINE" value={stats.online} tone="online" />
        </div>
      </div>

      <div className="hud-right">
        <div className="hud-search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder="İl ara…"
          />
          {focused && matches.length > 0 && (
            <div className="hud-search-drop">
              {matches.map((il) => (
                <button
                  key={il.plate}
                  className="hud-search-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectIl(il);
                    setQ('');
                  }}
                >
                  <Activity size={13} />
                  <span>{il.name}</span>
                  <span className="mono">{String(il.plate).padStart(2, '0')}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="hud-win">
          <button className="win-btn" onClick={() => window.onView.minimizeWindow()} aria-label="Küçült">
            <Minus size={16} />
          </button>
          <button className="win-btn close" onClick={() => window.onView.quitApp()} aria-label="Kapat">
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
