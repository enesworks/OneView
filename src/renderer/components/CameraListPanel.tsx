import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Camera } from '../data/cameras';

const STATUS_LABEL: Record<string, string> = {
  online: 'Aktif',
  offline: 'Çevrimdışı',
  unknown: 'Bilinmiyor',
};

interface Props {
  cameras: Camera[];
  selectedId: string | null;
  onSelect: (camera: Camera) => void;
}

export default function CameraListPanel({ cameras, selectedId, onSelect }: Props) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(60);

  const filtered = useMemo(() => {
    const query = q.trim().toLocaleLowerCase('tr');
    if (!query) return cameras;
    return cameras.filter(
      (c) =>
        c.il.toLocaleLowerCase('tr').includes(query) ||
        c.ilce.toLocaleLowerCase('tr').includes(query) ||
        c.name.toLocaleLowerCase('tr').includes(query) ||
        c.id.includes(query),
    );
  }, [cameras, q]);

  const counts = useMemo(
    () => ({
      total: filtered.length,
      online: filtered.filter((c) => c.status === 'online').length,
      offline: filtered.filter((c) => c.status === 'offline').length,
    }),
    [filtered],
  );

  const visible = filtered.slice(0, limit);

  return (
    <aside className="cam-panel">
      <div className="cam-panel-head">KAMERA LİSTESİ</div>

      <div className="cam-search">
        <Search size={14} />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLimit(60);
          }}
          placeholder="İl, ilçe veya kamera adı ara..."
        />
      </div>

      <div className="cam-counts">
        <div>
          <span>Toplam</span>
          <b>{counts.total.toLocaleString('tr-TR')}</b>
        </div>
        <div>
          <span>Aktif</span>
          <b className="online">{counts.online.toLocaleString('tr-TR')}</b>
        </div>
        <div>
          <span>Çevrimdışı</span>
          <b className="offline">{counts.offline.toLocaleString('tr-TR')}</b>
        </div>
      </div>

      <div className="cam-list">
        {visible.map((c, i) => (
          <button
            key={c.id}
            className={`cam-row ${selectedId === c.id ? 'active' : ''}`}
            onClick={() => onSelect(c)}
          >
            <div className="cam-row-main">
              <div className="cam-row-title">
                {c.il} / {c.ilce}
              </div>
              <div className="cam-row-id mono">TR-{String(i + 1).padStart(3, '0')}</div>
            </div>
            {c.status === 'online' && <span className="cam-live">LIVE</span>}
            <span className={`cam-status ${c.status}`}>
              <span className="dot" />
              {STATUS_LABEL[c.status]}
            </span>
          </button>
        ))}

        {filtered.length === 0 && (
          <div className="cam-empty">
            Gerçek kamera aranıyor… Sistem ağı, webcam'leri ve kaynakları tarıyor.
          </div>
        )}

        {limit < filtered.length && (
          <button className="cam-more" onClick={() => setLimit((l) => l + 60)}>
            Daha fazla kamera göster
          </button>
        )}
      </div>
    </aside>
  );
}
