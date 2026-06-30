import { useState } from 'react';
import { Crosshair, Loader2, Navigation, CheckCircle } from 'lucide-react';
import { requestCurrentPosition } from '../utils/geoAttendance';
import '../styles/attendance.css';

interface LiveGpsCaptureProps {
  latitude: string;
  longitude: string;
  onCapture: (lat: string, lng: string) => void;
}

export default function LiveGpsCapture({ latitude, longitude, onCapture }: LiveGpsCaptureProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const hasCoords = latitude !== '' && longitude !== '';

  const capture = async () => {
    setLoading(true);
    setError('');
    try {
      const pos = await requestCurrentPosition();
      onCapture(pos.coords.latitude.toFixed(6), pos.coords.longitude.toFixed(6));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not get your location');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="live-gps-capture" className={`live-gps-capture ${hasCoords ? 'live-gps-capture--success' : ''}`}>
      <div className="live-gps-capture__header">
        <Crosshair size={22} />
        <div>
          <h4>Live GPS location</h4>
          <p>Stand at your office and capture your phone&apos;s real-time GPS coordinates.</p>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary live-gps-capture__btn"
        onClick={capture}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 size={20} className="spin-icon" />
            Getting your location…
          </>
        ) : (
          <>
            <Navigation size={20} />
            {hasCoords ? 'Update live location' : 'Add my live location now'}
          </>
        )}
      </button>

      {error && <p className="geo-error">{error}</p>}

      {hasCoords ? (
        <div className="live-gps-capture__result">
          <CheckCircle size={18} />
          <span>
            Location captured: <strong>{latitude}</strong>, <strong>{longitude}</strong>
          </span>
        </div>
      ) : (
        <p className="live-gps-capture__help">
          Tap the button above — your browser will ask to allow location. You must click <strong>Allow</strong>.
        </p>
      )}
    </div>
  );
}
