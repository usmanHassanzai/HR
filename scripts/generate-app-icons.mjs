#!/usr/bin/env node
/** Generate PWA PNG icons from brand colors. Run: node scripts/generate-app-icons.mjs */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

async function makeIcon(size) {
  const barW = Math.round(size * 0.08);
  const gap = Math.round(size * 0.04);
  const baseY = Math.round(size * 0.62);
  const bars = [
    { h: Math.round(size * 0.22), color: '#00E5A0' },
    { h: Math.round(size * 0.34), color: '#00C98A' },
    { h: Math.round(size * 0.44), color: '#1AD4FF' },
  ];
  const totalW = bars.length * barW + (bars.length - 1) * gap;
  let x = Math.round((size - totalW) / 2);

  const rects = bars.map((b) => {
    const el = `<rect x="${x}" y="${baseY - b.h}" width="${barW}" height="${b.h}" rx="${Math.max(2, barW / 4)}" fill="${b.color}"/>`;
    x += barW + gap;
    return el;
  }).join('');

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="#0A1628"/>
    <rect x="${Math.round(size * 0.18)}" y="${Math.round(size * 0.18)}" width="${Math.round(size * 0.64)}" height="${Math.round(size * 0.64)}" rx="${Math.round(size * 0.12)}" fill="#0D1F3C"/>
    ${rects}
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(join(outDir, `icon-${size}.png`));
  console.log(`  icon-${size}.png`);
}

console.log('Generating app icons…');
for (const s of [192, 512]) await makeIcon(s);
console.log('Done → public/icons/');
