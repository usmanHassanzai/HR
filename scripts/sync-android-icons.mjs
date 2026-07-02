#!/usr/bin/env node
/** Copy Scorr brand icons into Android mipmap folders. Run: node scripts/sync-android-icons.mjs */
import sharp from 'sharp';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'public', 'icons', 'icon-512.png');
const resDir = join(root, 'android', 'app', 'src', 'main', 'res');

const sizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

async function main() {
  for (const [folder, size] of Object.entries(sizes)) {
    const dir = join(resDir, folder);
    mkdirSync(dir, { recursive: true });
    const buf = await sharp(src).resize(size, size).png().toBuffer();
    writeFileSync(join(dir, 'ic_launcher.png'), buf);
    writeFileSync(join(dir, 'ic_launcher_round.png'), buf);
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), buf);
    console.log(`  ${folder}/ (${size}px)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
