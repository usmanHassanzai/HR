/** Inline Scorr wordmark — scales crisply at any size, no external fetch. */
export type ScorrWordmarkVariant = 'default' | 'header' | 'login';

interface ScorrWordmarkProps {
  className?: string;
  variant?: ScorrWordmarkVariant;
}

export default function ScorrWordmark({ className = '', variant = 'default' }: ScorrWordmarkProps) {
  const taglineSize = variant === 'header' ? 30 : variant === 'login' ? 24 : 20;
  const taglineWeight = variant === 'header' || variant === 'login' ? 600 : 500;
  const taglineSpacing = variant === 'header' ? 3.5 : 4.5;

  return (
    <svg
      className={`scorr-wordmark scorr-wordmark--${variant} brand-logo ${className}`.trim()}
      viewBox="25 30 640 165"
      role="img"
      aria-label="Scorr — Performance · Rewards"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="scorr-bar1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00E5A0" />
          <stop offset="100%" stopColor="#00B87A" />
        </linearGradient>
        <linearGradient id="scorr-bar2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00C98A" />
          <stop offset="100%" stopColor="#009E6A" />
        </linearGradient>
        <linearGradient id="scorr-bar3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1AD4FF" />
          <stop offset="100%" stopColor="#00A8D4" />
        </linearGradient>
      </defs>
      <rect x="40" y="38" width="160" height="160" rx="28" fill="#1A2438" />
      <rect x="72" y="128" width="28" height="52" rx="5" fill="url(#scorr-bar1)" />
      <rect x="108" y="98" width="28" height="82" rx="5" fill="url(#scorr-bar2)" />
      <rect x="144" y="74" width="28" height="106" rx="5" fill="url(#scorr-bar3)" />
      <circle cx="158" cy="68" r="8" fill="#00E5A0" />
      <line x1="86" y1="122" x2="158" y2="62" stroke="#00E5A0" strokeWidth="3" strokeLinecap="round" />
      <text
        className="scorr-wordmark__title"
        x="228"
        y="142"
        fontFamily="Outfit, Inter, Arial Black, sans-serif"
        fontSize={variant === 'header' ? 88 : 82}
        fontWeight="700"
        letterSpacing="-2"
      >
        scorr
      </text>
      <text
        className="scorr-wordmark__tagline"
        x="230"
        y="180"
        fontFamily="Inter, Arial, sans-serif"
        fontSize={taglineSize}
        fontWeight={taglineWeight}
        letterSpacing={taglineSpacing}
      >
        PERFORMANCE · REWARDS
      </text>
    </svg>
  );
}
