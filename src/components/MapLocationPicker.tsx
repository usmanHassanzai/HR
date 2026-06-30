import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Loader2, MapPin, Navigation } from 'lucide-react';
import { requestCurrentPosition } from '../utils/geoAttendance';
import 'leaflet/dist/leaflet.css';

const DEFAULT_LAT = 24.8607;
const DEFAULT_LNG = 67.0011;

interface MapLocationPickerProps {
  latitude: string;
  longitude: string;
  radiusMeters: number;
  onLocationChange: (lat: string, lng: string) => void;
}

function parseCoord(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export default function MapLocationPicker({
  latitude,
  longitude,
  radiusMeters,
  onLocationChange,
}: MapLocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const onChangeRef = useRef(onLocationChange);
  const [locating, setLocating] = useState(false);
  const [mapError, setMapError] = useState('');

  onChangeRef.current = onLocationChange;

  const pinIcon = L.divIcon({
    className: 'map-pin-marker',
    html: '<span class="map-pin-marker__dot"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  const placeMarker = useCallback((map: L.Map, lat: number, lng: number, fly = false) => {
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      const marker = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(map);
      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onChangeRef.current(pos.lat.toFixed(6), pos.lng.toFixed(6));
      });
      markerRef.current = marker;
    }

    if (circleRef.current) {
      circleRef.current.setLatLng([lat, lng]);
    } else {
      circleRef.current = L.circle([lat, lng], {
        radius: radiusMeters,
        color: '#6366f1',
        fillColor: '#6366f1',
        fillOpacity: 0.12,
        weight: 2,
      }).addTo(map);
    }

    if (fly) map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.5 });
  }, [pinIcon, radiusMeters]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const lat = parseCoord(latitude, DEFAULT_LAT);
    const lng = parseCoord(longitude, DEFAULT_LNG);
    const hasCoords = latitude !== '' && longitude !== '';

    const map = L.map(containerRef.current, {
      center: [lat, lng],
      zoom: hasCoords ? 16 : 12,
      scrollWheelZoom: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e) => {
      placeMarker(map, e.latlng.lat, e.latlng.lng);
      onChangeRef.current(e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6));
    });

    mapRef.current = map;
    if (hasCoords) placeMarker(map, lat, lng);

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- map init once
  }, [placeMarker]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || latitude === '' || longitude === '') return;
    placeMarker(map, parseCoord(latitude, DEFAULT_LAT), parseCoord(longitude, DEFAULT_LNG), true);
  }, [latitude, longitude, placeMarker]);

  useEffect(() => {
    if (circleRef.current) circleRef.current.setRadius(radiusMeters);
  }, [radiusMeters]);

  const useLiveLocation = async () => {
    setLocating(true);
    setMapError('');
    try {
      const pos = await requestCurrentPosition();
      onLocationChange(pos.coords.latitude.toFixed(6), pos.coords.longitude.toFixed(6));
    } catch (e: unknown) {
      setMapError(e instanceof Error ? e.message : 'Could not get location');
    } finally {
      setLocating(false);
    }
  };

  return (
    <div className="map-location-picker">
      <div className="map-location-picker__toolbar">
        <p className="map-location-picker__hint">
          <MapPin size={14} /> Tap the map or drag the pin. The circle is your attendance zone.
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={useLiveLocation} disabled={locating}>
          {locating ? <Loader2 size={14} className="spin-icon" /> : <Navigation size={14} />}
          Use my live location
        </button>
      </div>
      {mapError && <p className="geo-error">{mapError}</p>}
      <div ref={containerRef} className="map-location-picker__map" aria-label="Office location map" />
      {latitude && longitude ? (
        <p className="map-location-picker__coords">
          Selected: <strong>{parseFloat(latitude).toFixed(6)}</strong>, <strong>{parseFloat(longitude).toFixed(6)}</strong>
          {' · '}{radiusMeters}m radius
        </p>
      ) : (
        <p className="map-location-picker__coords map-location-picker__coords--muted">
          No pin yet — tap the map or use live location.
        </p>
      )}
    </div>
  );
}
