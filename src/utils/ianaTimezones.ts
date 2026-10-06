/**
 * IANA timezone catalog + search (R76).
 * No country hardcoded as a global default — browser zone is only a suggestion.
 */

export type IanaZoneInfo = {
  id: string;
  /** Human label, e.g. "Dubai" from Asia/Dubai */
  city: string;
  region: string;
  aliases: string[];
};

/** Common abbreviations / city aliases for search (not offsets — offsets come from Intl). */
const ALIASES: Record<string, string[]> = {
  'Asia/Karachi': ['Pakistan', 'PKT', 'PK', 'Karachi', 'Islamabad', 'Lahore'],
  'Asia/Dubai': ['UAE', 'GST', 'Dubai', 'Abu Dhabi', 'Emirates'],
  'Asia/Kuala_Lumpur': ['Malaysia', 'MYT', 'KL', 'Kuala Lumpur'],
  'Asia/Kolkata': ['India', 'IST', 'Delhi', 'Mumbai', 'Kolkata', 'Bangalore'],
  'Asia/Kathmandu': ['Nepal', 'NPT'],
  'Asia/Tehran': ['Iran', 'IRST', 'IRDT'],
  'Europe/Rome': ['Italy', 'CET', 'CEST', 'Rome', 'Milan'],
  'Europe/London': ['UK', 'GMT', 'BST', 'London', 'Britain'],
  'Europe/Paris': ['France', 'CET', 'CEST', 'Paris'],
  'America/Chicago': ['Central', 'CST', 'CDT', 'Chicago', 'US Central'],
  'America/New_York': ['Eastern', 'EST', 'EDT', 'New York', 'US Eastern'],
  'America/Toronto': ['Canada', 'Eastern', 'EST', 'EDT', 'Toronto'],
  'America/Vancouver': ['Canada', 'Pacific', 'PST', 'PDT', 'Vancouver'],
  'America/St_Johns': ['Newfoundland', 'NDT', 'NST', "St John's"],
  'America/Sao_Paulo': ['Brazil', 'BRT', 'Sao Paulo'],
  'Australia/Sydney': ['Australia', 'AEST', 'AEDT', 'Sydney'],
  'Australia/Adelaide': ['Australia', 'ACST', 'ACDT', 'Adelaide'],
  'Australia/Perth': ['Australia', 'AWST', 'Perth'],
  'Pacific/Auckland': ['New Zealand', 'NZST', 'NZDT', 'Auckland'],
  'Asia/Tokyo': ['Japan', 'JST', 'Tokyo'],
  'Asia/Singapore': ['Singapore', 'SGT'],
  'Asia/Shanghai': ['China', 'CST', 'Beijing', 'Shanghai'],
  'Asia/Jakarta': ['Indonesia', 'WIB', 'Jakarta'],
  'Europe/Moscow': ['Russia', 'MSK', 'Moscow'],
  'America/Mexico_City': ['Mexico', 'CST', 'CDT', 'Mexico City'],
};

let cachedZones: IanaZoneInfo[] | null = null;

export function listIanaTimeZones(): IanaZoneInfo[] {
  if (cachedZones) return cachedZones;
  let ids: string[] = [];
  try {
    if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
      ids = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    }
  } catch {
    ids = [];
  }
  if (!ids.length) {
    ids = Object.keys(ALIASES);
  }
  cachedZones = ids.map((id) => {
    const parts = id.split('/');
    const city = (parts[parts.length - 1] || id).replace(/_/g, ' ');
    const region = parts.length > 1 ? parts[0] : '';
    return {
      id,
      city,
      region,
      aliases: ALIASES[id] || [],
    };
  });
  return cachedZones;
}

export function suggestBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export function formatZoneOffset(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: 'numeric',
    }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    // "GMT+4" / "GMT+5:30" → "UTC+4" / "UTC+5:30"
    return name.replace(/^GMT/, 'UTC').replace('UTC', 'UTC') || 'UTC';
  } catch {
    return '';
  }
}

export function formatZoneLocalNow(timeZone: string, at: Date = new Date()): string {
  try {
    return at.toLocaleTimeString(undefined, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function formatZonePickerLabel(timeZone: string, at: Date = new Date()): string {
  const offset = formatZoneOffset(timeZone, at);
  const local = formatZoneLocalNow(timeZone, at);
  return `${timeZone} — ${offset}${local ? ` — now ${local}` : ''}`;
}

export function searchIanaTimeZones(query: string, limit = 40): IanaZoneInfo[] {
  const q = query.trim().toLowerCase();
  const all = listIanaTimeZones();
  if (!q) {
    const prefer = suggestBrowserTimeZone();
    const head = prefer ? all.filter((z) => z.id === prefer) : [];
    const rest = all.filter((z) => z.id !== prefer).slice(0, limit - head.length);
    return [...head, ...rest];
  }
  const scored = all
    .map((z) => {
      const hay = [z.id, z.city, z.region, ...z.aliases].join(' ').toLowerCase();
      let score = 0;
      if (z.id.toLowerCase() === q) score = 100;
      else if (z.aliases.some((a) => a.toLowerCase() === q)) score = 90;
      else if (z.city.toLowerCase().startsWith(q)) score = 80;
      else if (hay.includes(q)) score = 50;
      else return null;
      return { z, score };
    })
    .filter(Boolean) as { z: IanaZoneInfo; score: number }[];
  scored.sort((a, b) => b.score - a.score || a.z.id.localeCompare(b.z.id));
  return scored.slice(0, limit).map((s) => s.z);
}

/** Short city / abbreviation label for display rows. */
export function zoneShortLabel(timeZone: string): string {
  const info = listIanaTimeZones().find((z) => z.id === timeZone);
  if (info?.aliases?.[0] && info.aliases[0].length <= 4) return info.aliases[0];
  return info?.city || timeZone.split('/').pop()?.replace(/_/g, ' ') || timeZone;
}
