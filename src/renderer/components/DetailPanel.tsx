import {
  ZoomIn,
  ZoomOut,
  Crosshair,
  Camera as CameraIcon,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { Camera } from '../data/cameras';
import StatusBadge from './StatusBadge';
import LivePreview from './LivePreview';

export interface MapApi {
  zoomIn: () => void;
  zoomOut: () => void;
  pan: (dx: number, dy: number) => void;
}

interface Props {
  camera: Camera | null;
  mapApi: MapApi;
  onFullscreen: (camera: Camera) => void;
}

function codeOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `TR-${String(h % 1000).padStart(3, '0')}`;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || '—';
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}

export default function DetailPanel({ camera, mapApi, onFullscreen }: Props) {
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div className="detail-head-titles">
          <div className="detail-title">
            {camera ? `${codeOf(camera.id)} · ${camera.il}` : 'KAMERA BİLGİSİ'}
          </div>
          <div className="detail-sub">{camera ? `${camera.il} / ${camera.ilce}` : 'Seçim bekleniyor'}</div>
        </div>
        {camera && <StatusBadge status={camera.status} />}
      </div>

      <LivePreview camera={camera} onFullscreen={onFullscreen} />

      {camera ? (
        <>
          <div className="detail-section">
            <div className="detail-section-title">KAMERA BİLGİLERİ</div>
            <div className="detail-rows">
              <Row label="ID" value={codeOf(camera.id)} />
              <Row label="Konum" value={`${camera.il} / ${camera.ilce}`} />
              <Row label="Koordinat" value={`${camera.lat.toFixed(4)}°N, ${camera.lon.toFixed(4)}°E`} />
              <Row label="Protokol" value={camera.protocol.toUpperCase()} />
              <Row label="Kaynak" value={sourceHost(camera.url)} />
              <Row label="Konum (tam)" value={`${camera.lat.toFixed(6)}, ${camera.lon.toFixed(6)}`} />
              <Row label="Durum" value={camera.status} />
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-title">KAMERA KONTROL</div>
            <div className="ptz">
              <div className="ptz-dpad">
                <button onClick={() => mapApi.pan(0, 90)} title="Yukarı">
                  <ChevronUp size={16} />
                </button>
                <div className="ptz-mid">
                  <button onClick={() => mapApi.pan(-90, 0)} title="Sol">
                    <ChevronLeft size={16} />
                  </button>
                  <button onClick={() => mapApi.pan(0, 0)} title="Merkez">
                    <Crosshair size={16} />
                  </button>
                  <button onClick={() => mapApi.pan(90, 0)} title="Sağ">
                    <ChevronRight size={16} />
                  </button>
                </div>
                <button onClick={() => mapApi.pan(0, -90)} title="Aşağı">
                  <ChevronDown size={16} />
                </button>
              </div>
              <div className="ptz-zoom">
                <button onClick={mapApi.zoomIn}>
                  <ZoomIn size={15} /> Zoom +
                </button>
                <button onClick={mapApi.zoomOut}>
                  <ZoomOut size={15} /> Zoom −
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="detail-empty">
          <CameraIcon size={30} />
          <span>Kamera seçilmedi</span>
          <span className="detail-hint">Listeden veya haritadan bir kamera seç</span>
        </div>
      )}
    </aside>
  );
}
