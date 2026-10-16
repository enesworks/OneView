import { ShieldCheck, Minus, X } from 'lucide-react';

interface Props {
  stats: { total: number; online: number; offline: number; scanned: number; openFound: number };
  clock: string;
  onMinimize: () => void;
  onClose: () => void;
}

export default function TopBar({ stats, clock, onMinimize, onClose }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="topbar-shield">
          <ShieldCheck size={24} />
        </div>
        <div>
          <div className="topbar-title">TÜRKİYE KAMERA İZLEME SİSTEMİ</div>
          <div className="topbar-sub">ULUSAL GÖZETİM &amp; İZLEME AĞI</div>
        </div>
      </div>

      <div className="topbar-stats">
        <div className="tstat">
          <span>TOPLAM KAMERA</span>
          <b>{stats.total.toLocaleString('tr-TR')}</b>
        </div>
        <div className="tstat">
          <span>AKTİF</span>
          <b className="online">{stats.online.toLocaleString('tr-TR')}</b>
        </div>
        <div className="tstat">
          <span>ÇEVRİMDIŞI</span>
          <b className="offline">{stats.offline.toLocaleString('tr-TR')}</b>
        </div>
        <div className="tstat">
          <span>TARANAN IP</span>
          <b className="mono">{stats.scanned.toLocaleString('tr-TR')}</b>
        </div>
        <div className="tstat">
          <span>AÇIK RTSP</span>
          <b className="mono">{stats.openFound.toLocaleString('tr-TR')}</b>
        </div>
      </div>

      <div className="topbar-right">
        <div className="topbar-clock mono">{clock}</div>
        <div className="topbar-sys">
          <span className="sys-dot" />
          SİSTEM AKTİF
        </div>
        <div className="hud-win">
          <button className="win-btn" onClick={onMinimize} aria-label="Küçült">
            <Minus size={16} />
          </button>
          <button className="win-btn close" onClick={onClose} aria-label="Kapat">
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
