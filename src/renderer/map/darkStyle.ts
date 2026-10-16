import type { StyleSpecification } from 'maplibre-gl';

export const DARK_STYLE: StyleSpecification = {
  version: 8,
  name: 'OneView',
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: {
        'raster-saturation': -0.85,
        'raster-contrast': 0.12,
        'raster-brightness-min': 0.02,
        'raster-brightness-max': 0.4,
      },
    },
  ],
};

export const CAMERA_COLORS: Record<string, string> = {
  online: '#22C55E',
  offline: '#EF4444',
  unknown: '#6B7280',
};
