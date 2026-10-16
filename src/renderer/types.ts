export type CameraProtocol = 'demo' | 'rtsp' | 'hls' | 'http' | 'mjpeg' | 'webrtc';

export interface CameraDescriptor {
  id: string;
  name: string;
  protocol: CameraProtocol;
  url: string;
  il: string;
  ilce: string;
}

export interface StreamSession {
  sessionId: string;
  url: string;
  type: 'hls' | 'direct';
  protocol: CameraProtocol;
}

export type RegisteredProtocol = 'demo' | 'rtsp' | 'hls' | 'http' | 'mjpeg' | 'onvif' | 'unknown';

export interface RegisteredCamera {
  id: string;
  name: string;
  il: string;
  ilce: string;
  lat: number;
  lon: number;
  protocol: RegisteredProtocol;
  url: string;
  status: 'online' | 'offline' | 'unknown';
  source: 'scan' | 'onvif' | 'import' | 'manual' | 'seed' | 'intrusion';
  lastSeen: number | null;
  latencyMs: number | null;
  verified?: boolean;
}

export interface PrivateCameraInput {
  url: string;
  name?: string;
  il?: string;
  ilce?: string;
  lat?: number;
  lon?: number;
}

export interface RegistryStats {
  total: number;
  online: number;
  offline: number;
  unknown: number;
}

export interface DiscoverResult {
  onvif: number;
  scanned: number;
  added: number;
  cameras: RegisteredCamera[];
}

export interface SourceDef {
  id: string;
  name: string;
  url: string;
  kind: 'json' | 'csv';
  enabled: boolean;
}

