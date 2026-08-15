import { useState } from 'react';
import { Crosshair, Loader2, Navigation, CheckCircle } from 'lucide-react';
import { requestFreshOfficePosition } from '../utils/geoAttendance';
import '../styles/attendance.css';

interface LiveGpsCaptureProps {
  latitude: string;
  longitude: string;
  onCapture: (lat: string, lng: string, accuracy?: number | null) => void;
}

export default function LiveGpsCapture({ latitude, longitude, onCapture }: LiveGpsCaptureProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const hasCoords = latitude !== '' && longitude !== '';

  const capture = async () => {
    setLoading(true);
    setError('');
    try {
      const pos = await requestFreshOfficePosition();
      const acc = pos.coords.accuracy ?? null;
      setAccuracy(acc);
      // Keep full precision — this pin becomes the attendance center
      onCapture(
        String(pos.coords.latitude),
        String(pos.coords.longitude),
        acc,
      );
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
          <p>
            Stand where people should check in. We capture your phone&apos;s current GPS and save that exact spot as
            the office center.
          </p>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary live-gps-capture__btn"
        onClick={() => void capture()}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 size={20} className="spin-icon" />
            Capturing best GPS reading…
          </>
        ) : (
          <>
            <Navigation size={20} />
            {hasCoords ? 'Update to my current location' : 'Set office to my current location'}
          </>
        )}
      </button>

      {error && <p className="geo-error">{error}</p>}

      {hasCoords ? (
        <div className="live-gps-capture__result">
          <CheckCircle size={18} />
          <span>
            Office center set to your location:{' '}
            <strong>{Number(latitude).toFixed(6)}</strong>, <strong>{Number(longitude).toFixed(6)}</strong>
            {accuracy != null && Number.isFinite(accuracy) ? (
              <> · GPS accuracy ±{Math.round(accuracy)}m</>
            ) : null}
          </span>
        </div>
      ) : (
        <p className="live-gps-capture__help">
          Tap the button above — allow location when asked. Stand still outdoors or near a window for a clearer pin.
        </p>
      )}
    </div>
  );
}
