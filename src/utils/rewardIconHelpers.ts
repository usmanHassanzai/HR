/** Reward catalog icon helpers — emoji text or uploaded/image URL. */

export function isRewardImageIcon(icon: string | null | undefined): boolean {
  const v = (icon || '').trim();
  return /^(https?:\/\/|data:image\/)/i.test(v);
}

/** Resize + compress an image file for storage in rewards_catalog.icon. */
export async function fileToRewardIconDataUrl(file: File, maxSize = 128): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPG, WebP, or GIF).');
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('Image must be under 8 MB.');
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not process this image.');
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const preferPng = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
  const dataUrl = preferPng
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', 0.88);

  if (dataUrl.length > 350_000) {
    throw new Error('Image is still too large after resize. Try a simpler icon.');
  }
  return dataUrl;
}

export const REWARD_EMOJI_PRESETS = ['🎁', '🎬', '🍽️', '🌴', '☕', '🎧', '🎮', '🏆', '🚌', '💆'] as const;
