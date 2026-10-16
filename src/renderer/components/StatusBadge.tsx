import type { CameraStatus } from '../data/cameras';

const LABELS: Record<CameraStatus, string> = {
  online: 'ÇEVRİMİÇİ',
  offline: 'ÇEVRİMDIŞI',
  unknown: 'BİLİNMİYOR',
};

export default function StatusBadge({ status }: { status: CameraStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      <span className="status-dot" />
      {LABELS[status]}
    </span>
  );
}
