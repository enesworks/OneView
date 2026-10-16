import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MlMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { Camera } from './data/cameras';
import type { RegisteredCamera, CameraProtocol } from './types';
import { buildClusterLayer, ClusterPoint } from './map/cluster';
import { DARK_STYLE } from './map/darkStyle';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import CameraListPanel from './components/CameraListPanel';
import DetailPanel, { MapApi } from './components/DetailPanel';
import StreamOverlay from './components/StreamOverlay';
import { Plus, Minus, Locate } from 'lucide-react';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function pointsToFC(points: ClusterPoint[]) {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, type: p.type, status: p.status, name: p.name, count: p.count },
    })),
  } as GeoJSON.FeatureCollection;
}

function labelsToFC(labels: { lat: number; lon: number; name: string }[]) {
  return {
    type: 'FeatureCollection',
    features: labels.map((l) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
      properties: { name: l.name },
    })),
  } as GeoJSON.FeatureCollection;
}

function cameraIconSvg(color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">` +
    `<rect x="1" y="1" width="22" height="22" rx="5" fill="rgba(10,14,20,0.9)"/>` +
    `<path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="${color}"/>` +
    `<circle cx="12" cy="12.5" r="3" fill="#0A0E14"/>` +
    `<circle cx="12" cy="12.5" r="1.2" fill="${color}"/>` +
    `</svg>`
  );
}

function addIcon(map: MlMap, id: string, color: string): void {
  const img = new Image();
  img.onload = () => {
    if (!map.hasImage(id)) map.addImage(id, img);
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cameraIconSvg(color));
}

function registeredToCamera(rc: RegisteredCamera): Camera {
  return {
    id: rc.id,
    ilId: 0,
    il: rc.il,
    ilce: rc.ilce,
    name: rc.name,
    lat: rc.lat,
    lon: rc.lon,
    status: rc.status,
    protocol: rc.protocol as CameraProtocol,
    url: rc.url,
    verified: rc.verified,
  };
}

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const clusterPointsRef = useRef<ClusterPoint[]>([]);
  const camerasRef = useRef<Camera[]>([]);
  const updateClustersRef = useRef<(zoom: number) => void>(() => {});

  const [allCameras, setAllCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [fullscreenCam, setFullscreenCam] = useState<Camera | null>(null);
  const [nav, setNav] = useState('list');
  const [clock, setClock] = useState(() => new Date().toLocaleString('tr-TR'));
  const [scanned, setScanned] = useState(0);
  const [openFound, setOpenFound] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleString('tr-TR')), 1000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    const total = allCameras.length;
    const online = allCameras.filter((c) => c.status === 'online').length;
    const offline = allCameras.filter((c) => c.status === 'offline').length;
    return { total, online, offline, scanned, openFound };
  }, [allCameras, scanned, openFound]);

  useEffect(() => {
    let cancelled = false;
    window.onView
      .registryList()
      .then((list) => {
        if (cancelled) return;
        const mapped = list.filter((c) => c.protocol !== 'demo').map(registeredToCamera);
        if (mapped.length > 0) setAllCameras(mapped);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      window.onView
        .registryList()
        .then((list) => {
          const mapped = list.filter((c) => c.protocol !== 'demo').map(registeredToCamera);
          if (mapped.length > 0) {
            setAllCameras((prev) => (prev.length !== mapped.length ? mapped : prev));
          }
        })
        .catch(() => {});
      window.onView
        .storeScan()
        .then((s) => {
          setScanned(s.scanned);
          setOpenFound(s.open);
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    camerasRef.current = allCameras;
    updateClustersRef.current(mapRef.current?.getZoom() ?? 6);
  }, [allCameras]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: DARK_STYLE,
      center: [35.0, 39.0],
      zoom: 6,
      minZoom: 5,
      maxZoom: 15,
      attributionControl: false,
    });
    mapRef.current = map;

    const updateClusters = (zoom: number) => {
      const { points, labels } = buildClusterLayer(camerasRef.current, zoom);
      clusterPointsRef.current = points;
      (map.getSource('clusters') as GeoJSONSource | undefined)?.setData(pointsToFC(points));
      (map.getSource('il-labels') as GeoJSONSource | undefined)?.setData(labelsToFC(labels));
    };
    updateClustersRef.current = updateClusters;

    const handleClick = (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const id = feature.properties?.id as string;
      const point = clusterPointsRef.current.find((p) => p.id === id);
      if (!point) return;
      if (point.type === 'camera' && point.camera) {
        setSelected(point.camera);
      } else {
        const zoom = point.type === 'il' ? 9 : 12;
        map.flyTo({ center: [point.lon, point.lat], zoom: zoom + 0.4, duration: 800 });
      }
    };

    map.on('load', () => {
      addIcon(map, 'cam-online', '#22C55E');
      addIcon(map, 'cam-offline', '#EF4444');
      addIcon(map, 'cam-unknown', '#6B7280');

      map.addSource('clusters', { type: 'geojson', data: EMPTY_FC });
      map.addSource('il-labels', { type: 'geojson', data: EMPTY_FC });

      map.addLayer({
        id: 'cluster-glow',
        type: 'circle',
        source: 'clusters',
        filter: ['!=', ['get', 'type'], 'camera'],
        paint: {
          'circle-radius': ['match', ['get', 'type'], 'il', 26, 'ilce', 18, 10],
          'circle-color': ['match', ['get', 'status'], 'online', '#22C55E', 'offline', '#EF4444', '#6B7280'],
          'circle-opacity': 0.16,
          'circle-blur': 0.4,
        },
      });

      map.addLayer({
        id: 'cluster-circles',
        type: 'circle',
        source: 'clusters',
        filter: ['!=', ['get', 'type'], 'camera'],
        paint: {
          'circle-radius': ['match', ['get', 'type'], 'il', 16, 'ilce', 11, 6],
          'circle-color': ['match', ['get', 'status'], 'online', '#22C55E', 'offline', '#EF4444', '#6B7280'],
          'circle-stroke-color': '#0A0E14',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.95,
        },
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'clusters',
        layout: {
          'text-field': ['case', ['>', ['get', 'count'], 1], ['get', 'count'], ''],
          'text-size': ['match', ['get', 'type'], 'il', 12, 'ilce', 10, 0],
          'text-font': ['Noto Sans Bold'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#0A0E14' },
      });

      map.addLayer({
        id: 'camera-icons',
        type: 'symbol',
        source: 'clusters',
        filter: ['==', ['get', 'type'], 'camera'],
        layout: {
          'icon-image': ['match', ['get', 'status'], 'online', 'cam-online', 'offline', 'cam-offline', 'cam-unknown'],
          'icon-size': 0.85,
          'icon-allow-overlap': true,
          'icon-anchor': 'bottom',
        },
      });

      map.addLayer({
        id: 'il-labels',
        type: 'symbol',
        source: 'il-labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-letter-spacing': 0.04,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#94A3B8',
          'text-halo-color': 'rgba(10,14,20,0.9)',
          'text-halo-width': 2,
        },
        maxzoom: 8,
      });

      map.addSource('selected', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'selected-glow',
        type: 'circle',
        source: 'selected',
        paint: { 'circle-radius': 22, 'circle-color': 'rgba(56,189,248,0.18)', 'circle-blur': 0.6 },
      });
      map.addLayer({
        id: 'selected-ring',
        type: 'circle',
        source: 'selected',
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#38BDF8',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'selected-dot',
        type: 'circle',
        source: 'selected',
        paint: { 'circle-radius': 3.5, 'circle-color': '#38BDF8' },
      });

      updateClusters(map.getZoom());
    });

    map.on('moveend', () => updateClusters(map.getZoom()));
    map.on('click', 'cluster-circles', handleClick);
    map.on('click', 'camera-icons', handleClick);
    map.on('mouseenter', 'cluster-circles', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseenter', 'camera-icons', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'cluster-circles', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('mouseleave', 'camera-icons', () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    const src = map.getSource('selected') as GeoJSONSource | undefined;
    if (src && selected.lat && selected.lon) {
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [selected.lon, selected.lat] },
            properties: {},
          },
        ],
      } as GeoJSON.FeatureCollection);
      map.flyTo({ center: [selected.lon, selected.lat], zoom: 15, duration: 700 });
    }
  }, [selected?.id]);

  const selectCamera = (c: Camera) => {
    setSelected(c);
  };

  const mapApi: MapApi = useMemo(
    () => ({
      zoomIn: () => mapRef.current?.zoomIn(),
      zoomOut: () => mapRef.current?.zoomOut(),
      pan: (dx: number, dy: number) => mapRef.current?.panBy([dx, dy], { duration: 300 }),
    }),
    [],
  );

  const showList = nav !== 'map';

  return (
    <div className="app-shell">
      <TopBar
        stats={stats}
        clock={clock}
        onMinimize={() => window.onView.minimizeWindow()}
        onClose={() => window.onView.quitApp()}
      />

      <div className="app-body">
        <Sidebar
          active={nav}
          onSelect={(id) => setNav(id)}
        />

        {showList && (
          <CameraListPanel
            cameras={allCameras}
            selectedId={selected?.id ?? null}
            onSelect={selectCamera}
          />
        )}

        <main className="map-area">
          <div ref={mapContainerRef} className="map-container" />
          <div className="map-controls">
            <button onClick={() => mapRef.current?.zoomIn()} title="Yakınlaş">
              <Plus size={18} />
            </button>
            <button onClick={() => mapRef.current?.zoomOut()} title="Uzaklaş">
              <Minus size={18} />
            </button>
            <button
              onClick={() => mapRef.current?.flyTo({ center: [35, 39], zoom: 6, duration: 700 })}
              title="Türkiye geneli"
            >
              <Locate size={18} />
            </button>
          </div>
        </main>

        <DetailPanel camera={selected} mapApi={mapApi} onFullscreen={setFullscreenCam} />
      </div>

      {fullscreenCam && (
        <StreamOverlay camera={fullscreenCam} onClose={() => setFullscreenCam(null)} />
      )}
    </div>
  );
}
