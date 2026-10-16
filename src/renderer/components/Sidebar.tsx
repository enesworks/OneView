import { Camera, Map as MapIcon } from 'lucide-react';

const ITEMS = [
  { id: 'list', icon: Camera, label: 'Kameralar' },
  { id: 'map', icon: MapIcon, label: 'Harita' },
];

interface Props {
  active: string;
  onSelect: (id: string) => void;
}

export default function Sidebar({ active, onSelect }: Props) {
  return (
    <nav className="sidebar">
      {ITEMS.map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            className={`side-item ${active === it.id ? 'active' : ''}`}
            onClick={() => onSelect(it.id)}
            title={it.label}
          >
            <Icon size={18} />
          </button>
        );
      })}
    </nav>
  );
}
