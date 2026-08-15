import { DEFAULT_LOGO_URL, DEFAULT_LOGO_FULL_URL, resolveLogoUrl } from '../lib/branding';
import ScorrWordmark from './ScorrWordmark';

export type BrandLogoVariant = 'header' | 'login' | 'preview' | 'icon';

interface BrandLogoProps {
  src?: string;
  variant?: BrandLogoVariant;
  alt?: string;
  className?: string;
}

function isBundledLogo(url: string): boolean {
  return (
    url === DEFAULT_LOGO_URL ||
    url === DEFAULT_LOGO_FULL_URL ||
    url.endsWith('/scorr-logo.svg') ||
    url.endsWith('/scorr-wordmark.svg')
  );
}

/** Icon-only mark — chart tile without the “scorr” wordmark text. */
function ScorrMarkIcon({ className = '', alt = 'Scorr' }: { className?: string; alt?: string }) {
  return (
    <svg
      className={`scorr-mark-icon brand-logo brand-logo--icon ${className}`.trim()}
      viewBox="40 38 160 160"
      role="img"
      aria-label={alt}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="scorr-mark-b1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00E5A0" />
          <stop offset="100%" stopColor="#00B87A" />
        </linearGradient>
        <linearGradient id="scorr-mark-b2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00C98A" />
          <stop offset="100%" stopColor="#009E6A" />
        </linearGradient>
        <linearGradient id="scorr-mark-b3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1AD4FF" />
          <stop offset="100%" stopColor="#00A8D4" />
        </linearGradient>
      </defs>
      <rect x="40" y="38" width="160" height="160" rx="28" fill="#1A2438" />
      <rect x="72" y="128" width="28" height="52" rx="5" fill="url(#scorr-mark-b1)" />
      <rect x="108" y="98" width="28" height="82" rx="5" fill="url(#scorr-mark-b2)" />
      <rect x="144" y="74" width="28" height="106" rx="5" fill="url(#scorr-mark-b3)" />
      <circle cx="158" cy="68" r="8" fill="#00E5A0" />
    </svg>
  );
}

/** Scorr logo — inline wordmark for bundled asset, img for custom uploads. */
export default function BrandLogo({
  src,
  variant = 'header',
  alt = 'Scorr',
  className = '',
}: BrandLogoProps) {
  const url = resolveLogoUrl(src);
  const useInline = isBundledLogo(url);

  if (useInline && variant === 'icon') {
    return <ScorrMarkIcon className={className} alt={alt} />;
  }

  if (useInline) {
    const wordmarkVariant =
      variant === 'header' || variant === 'login' || variant === 'preview'
        ? variant === 'preview'
          ? 'header'
          : variant
        : 'default';
    return (
      <ScorrWordmark
        variant={wordmarkVariant}
        className={`brand-logo brand-logo--${variant} brand-logo--default ${className}`.trim()}
      />
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      className={`brand-logo brand-logo--${variant} ${className}`.trim()}
      decoding="async"
    />
  );
}
