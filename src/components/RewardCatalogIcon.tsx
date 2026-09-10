import { isRewardImageIcon } from '../utils/rewardIconHelpers';

export default function RewardCatalogIcon({
  icon,
  className = '',
  size = 28,
}: {
  icon: string | null | undefined;
  className?: string;
  size?: number;
}) {
  const value = (icon || '🎁').trim() || '🎁';
  if (isRewardImageIcon(value)) {
    return (
      <img
        src={value}
        alt=""
        className={`reward-catalog-icon-img ${className}`.trim()}
        style={{ width: size, height: size }}
        loading="lazy"
      />
    );
  }
  return (
    <span className={`reward-catalog-icon-emoji ${className}`.trim()} style={{ fontSize: size * 0.85 }} aria-hidden>
      {value}
    </span>
  );
}
