import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, Signal } from 'lucide-react';
import type { Camera } from '../data/cameras';
import type { StreamSession } from '../types';
import StatusBadge from './StatusBadge';

type Phase = 'loading' | 'playing' | 'error' | 'offline';

interface Props {
  camera: Camera;
  onClose: () => void;
}

export default function StreamOverlay({ camera, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<StreamSession | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Bir kamera BİR KEZ açıldıysa canlıdır → hata aldığında ölmemeli.
    // Bayat/bozuk HLS oturumu (silinmiş segment, yeniden başlayan ffmpeg)
    // en sık hata sebebi; çözüm: oturumu bırakıp TAZE oturum açmak.
    function retrySession(): void {
      if (cancelled) return;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (sessionRef.current) {
        window.onView.streamRelease(sessionRef.current.sessionId);
        sessionRef.current = null;
      }
      attempt += 1;
      if (attempt > 3) {
        setPhase('error');
        setErrorMsg('Akış çözümlenemedi (3 deneme)');
        return;
      }
      setPhase('loading');
      retryTimer = setTimeout(() => void start(), 1200);
    }

    async function start() {
      if (camera.status === 'offline') {
        setPhase('offline');
        return;
      }
      try {
        setPhase('loading');
        const session = await window.onView.streamAcquire(camera);
        if (cancelled) {
          window.onView.streamRelease(session.sessionId);
          return;
        }
        sessionRef.current = session;

        if (session.type === 'direct' && session.protocol === 'mjpeg') {
          setMjpegUrl(session.url);
          setPhase('playing');
          return;
        }

        const video = videoRef.current;
        if (!video) return;

        if (session.type === 'hls' || session.protocol === 'hls') {
          if (Hls.isSupported()) {
            // lowLatencyMode KAPALI: LL-HLS (PART) beklemiyoruz, açıkken oynatıcı
            // canlı kenara fazla yaklaşıp silinmiş segmenti isteyip 404 alıyordu.
            const hls = new Hls({
              liveSyncDurationCount: 3,
              maxBufferLength: 12,
              liveDurationInfinity: true,
              manifestLoadingTimeOut: 15000,
              levelLoadingTimeOut: 15000,
              fragLoadingTimeOut: 25000,
              manifestLoadingMaxRetry: 6,
              levelLoadingMaxRetry: 6,
              fragLoadingMaxRetry: 8,
            });
            hlsRef.current = hls;
            hls.loadSource(session.url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (!data.fatal) return;
              // GEÇİCİ hatalarda ölme — otomatik toparlan (oynatma sürsün).
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad();
                return;
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
                return;
              }
              // FATAL ve toparlanamadı → kamera CANLI, biz açamadık. Taze oturumla
              // yeniden bağlan (bayat playlist/segment en sık hata sebebi).
              retrySession();
            });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = session.url;
          } else {
            setPhase('error');
            setErrorMsg('HLS oynatma desteklenmiyor');
            return;
          }
        } else {
          video.src = session.url;
        }

        video
          .play()
          .then(() => setPhase('playing'))
          .catch(() => retrySession());
      } catch {
        // 'yayın açılamadı' gibi GEÇİCİ hatada da yeniden dene (kamera canlı olabilir).
        retrySession();
      }
    }

    start();

    const keepAlive = setInterval(() => {
      if (sessionRef.current && sessionRef.current.type === 'hls') {
        window.onView.streamTouch(sessionRef.current.sessionId);
      }
    }, 30_000);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(keepAlive);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (sessionRef.current) {
        window.onView.streamRelease(sessionRef.current.sessionId);
        sessionRef.current = null;
      }
    };
  }, [camera.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ov-backdrop" onClick={onClose}>
      <div className="ov-panel" onClick={(e) => e.stopPropagation()}>
        <header className="ov-header">
          <div className="ov-header-titles">
            <div className="ov-title">{camera.name}</div>
            <div className="ov-sub">
              {camera.il} · {camera.ilce}
            </div>
          </div>
          <button className="ov-close" onClick={onClose} aria-label="Kapat">
            <X size={18} />
          </button>
        </header>

        <div className="ov-video-wrap">
          {mjpegUrl ? (
            <img src={mjpegUrl} className="ov-video" alt={camera.name} />
          ) : (
            <video ref={videoRef} className="ov-video" muted autoPlay playsInline />
          )}

          {phase === 'loading' && (
            <div className="ov-state">
              <div className="ov-spinner" />
              <span className="ov-state-text">BAĞLANIYOR</span>
            </div>
          )}
          {phase === 'offline' && (
            <div className="ov-state">
              <Signal size={28} className="ov-state-icon offline" />
              <span className="ov-state-text">KAMERA ÇEVRİMDIŞI</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="ov-state">
              <Signal size={28} className="ov-state-icon error" />
              <span className="ov-state-text">{errorMsg || 'AKIŞ HATASI'}</span>
            </div>
          )}
        </div>

        <footer className="ov-footer">
          <StatusBadge status={camera.status} />
          <span className="ov-meta">PROTOKOL · {camera.protocol.toUpperCase()}</span>
          <span className="ov-meta mono">{camera.id}</span>
          <span className="ov-meta mono">
            {camera.lat.toFixed(4)}, {camera.lon.toFixed(4)}
          </span>
        </footer>
      </div>
    </div>
  );
}
