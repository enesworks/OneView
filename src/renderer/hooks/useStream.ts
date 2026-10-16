import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { Camera } from '../data/cameras';
import type { StreamSession } from '../types';

export type StreamPhase = 'idle' | 'loading' | 'playing' | 'error' | 'offline';

export function useStream(camera: Camera | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<StreamSession | null>(null);
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;

    const cleanup = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (sessionRef.current) {
        window.onView.streamRelease(sessionRef.current.sessionId);
        sessionRef.current = null;
      }
    };

    if (!camera) {
      setPhase('idle');
      setMjpegUrl(null);
      return cleanup;
    }
    if (camera.status === 'offline') {
      setPhase('offline');
      setMjpegUrl(null);
      return cleanup;
    }

    const cam = camera;

    async function start() {
      try {
        setPhase('loading');
        setMjpegUrl(null);
        const session = await window.onView.streamAcquire(cam);
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
          let recoverAttempts = 0;
          if (Hls.isSupported()) {
            const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3 });
            hlsRef.current = hls;
            hls.loadSource(session.url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (!data.fatal) return;
              if (recoverAttempts < 3) {
                recoverAttempts += 1;
                setTimeout(() => {
                  try {
                    hls.startLoad();
                  } catch {
                    /* noop */
                  }
                }, 1500);
                return;
              }
              setPhase('error');
              setErrorMsg('Akış çözümlenemedi');
            });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = session.url;
          } else {
            setPhase('error');
            setErrorMsg('HLS desteklenmiyor');
            return;
          }
        } else {
          video.src = session.url;
        }

        video
          .play()
          .then(() => {
            if (!cancelled) setPhase('playing');
          })
          .catch(() => {
            if (!cancelled) {
              setPhase('error');
              setErrorMsg('Oynatma başlatılamadı');
            }
          });
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setErrorMsg(e instanceof Error ? e.message : 'Bağlantı hatası');
        }
      }
    }

    void start();

    const keepAlive = setInterval(() => {
      if (sessionRef.current && sessionRef.current.type === 'hls') {
        window.onView.streamTouch(sessionRef.current.sessionId);
      }
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(keepAlive);
      cleanup();
    };
  }, [camera?.id]);

  return { videoRef, phase, mjpegUrl, errorMsg };
}
