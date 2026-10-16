import { Maximize2 } from 'lucide-react';
import type { Camera } from '../data/cameras';
import { useStream } from '../hooks/useStream';

interface Props {
  camera: Camera | null;
  onFullscreen?: (camera: Camera) => void;
}

export default function LivePreview({ camera, onFullscreen }: Props) {
  const { videoRef, phase, mjpegUrl, errorMsg } = useStream(camera);

  return (
    <div className="live-preview">
      {mjpegUrl ? (
        <img src={mjpegUrl} className="live-media" alt="canlı" />
      ) : (
        <video ref={videoRef} className="live-media" muted autoPlay playsInline />
      )}

      {phase === 'idle' && (
        <div className="live-overlay">
          <span className="live-text">KAMERA SEÇİLMEDİ</span>
        </div>
      )}
      {phase === 'loading' && (
        <div className="live-overlay">
          <div className="ov-spinner" />
          <span className="live-text">BAĞLANIYOR</span>
        </div>
      )}
      {phase === 'offline' && (
        <div className="live-overlay">
          <span className="live-text offline">KAMERA ÇEVRİMDIŞI</span>
        </div>
      )}
      {phase === 'error' && (
        <div className="live-overlay">
          <span className="live-text offline">{errorMsg || 'AKIŞ HATASI'}</span>
        </div>
      )}

      {phase === 'playing' && <div className="live-badge">CANLI</div>}

      {camera && onFullscreen && (
        <button className="live-full" onClick={() => onFullscreen(camera)} title="Tam ekran">
          <Maximize2 size={14} />
        </button>
      )}
    </div>
  );
}
