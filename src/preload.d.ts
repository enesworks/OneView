import type {
  CameraDescriptor,
  StreamSession,
  RegisteredCamera,
  RegistryStats,
} from './renderer/types';

export interface OnViewAPI {
  streamAcquire(camera: CameraDescriptor): Promise<StreamSession>;
  streamRelease(sessionId: string): void;
  streamProbe(url: string): Promise<boolean>;
  streamTouch(sessionId: string): void;
  registryList(): Promise<RegisteredCamera[]>;
  registryStats(): Promise<RegistryStats>;
  storeScan(): Promise<{ scanned: number; devices: number; live: number; open: number }>;
  livenessCheck(): Promise<RegistryStats>;
  minimizeWindow(): void;
  hideWindow(): void;
  quitApp(): void;
}

declare global {
  interface Window {
    onView: OnViewAPI;
  }
}

export {};
