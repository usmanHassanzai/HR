import { useEffect, useMemo, useState } from 'react';
import {
  formatZonePickerLabel,
  searchIanaTimeZones,
  suggestBrowserTimeZone,
} from '../utils/ianaTimezones';

type Props = {
  value: string;
  onChange: (iana: string) => void;
  id?: string;
  disabled?: boolean;
  /** Placeholder when empty */
  placeholder?: string;
};

/**
 * Searchable IANA timezone picker (R76).
 * Suggests the browser zone when value is empty — never forces Asia/Karachi.
 */
export default function TimeZonePicker({
  value,
  onChange,
  id,
  disabled,
  placeholder = 'Search country, city, or abbreviation…',
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchIanaTimeZones(query, 50), [query]);

  useEffect(() => {
    if (!value) {
      const suggested = suggestBrowserTimeZone();
      if (suggested) onChange(suggested);
    }
    // only on mount for empty value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type="text"
        disabled={disabled}
        value={open ? query : value ? formatZonePickerLabel(value) : ''}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
        onBlur={() => {
          // delay so click on option registers
          window.setTimeout(() => setOpen(false), 150);
        }}
        autoComplete="off"
        style={{ width: '100%' }}
      />
      {open && (
        <ul
          style={{
            position: 'absolute',
            zIndex: 40,
            left: 0,
            right: 0,
            maxHeight: 240,
            overflow: 'auto',
            margin: 0,
            padding: 0,
            listStyle: 'none',
            background: 'var(--bg-elevated, #fff)',
            border: '1px solid var(--border-color, #ccc)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          {results.map((z) => (
            <li key={z.id}>
              <button
                type="button"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.55rem 0.75rem',
                  border: 'none',
                  background: z.id === value ? 'var(--bg-muted, #f3f4f6)' : 'transparent',
                  cursor: 'pointer',
                  fontSize: '0.88rem',
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(z.id);
                  setQuery('');
                  setOpen(false);
                }}
              >
                {formatZonePickerLabel(z.id)}
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li style={{ padding: '0.65rem 0.75rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No matching time zones
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
