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

/** Scorr logo — inline wordmark for bundled asset, img for custom uploads. */
export default function BrandLogo({
  src,
  variant = 'header',
  alt = 'Scorr',
  className = '',
}: BrandLogoProps) {
  const url = resolveLogoUrl(src);
  const useInline = isBundledLogo(url);

  if (useInline) {
    const wordmarkVariant =
      variant === 'header' || variant === 'login' || variant === 'preview' ? variant === 'preview' ? 'header' : variant : 'default';
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
