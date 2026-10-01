#!/usr/bin/env node
/** Copy Scorr brand icons into iOS AppIcon + PWA apple-touch-icon. */
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'public', 'icons', 'icon-512.webp');
const appIconDir = join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const publicIcons = join(root, 'public', 'icons');

async function main() {
  mkdirSync(appIconDir, { recursive: true });
  mkdirSync(publicIcons, { recursive: true });

  // Native iOS AppIcon still requires PNG; web assets stay WebP.
  await sharp(src).resize(1024, 1024).png().toFile(join(appIconDir, 'AppIcon-512@2x.png'));
  console.log('  ios/AppIcon-512@2x.png (1024)');

  for (const size of [180, 167, 152, 120]) {
    await sharp(src).resize(size, size).webp({ quality: 90 }).toFile(join(publicIcons, `apple-touch-icon-${size}.webp`));
    console.log(`  public/icons/apple-touch-icon-${size}.webp`);
  }

  await sharp(src).resize(180, 180).webp({ quality: 90 }).toFile(join(publicIcons, 'apple-touch-icon.webp'));
  console.log('  public/icons/apple-touch-icon.webp (180)');

  writeFileSync(
    join(appIconDir, 'Contents.json'),
    JSON.stringify(
      {
        images: [
          {
            filename: 'AppIcon-512@2x.png',
            idiom: 'universal',
            platform: 'ios',
            size: '1024x1024',
          },
        ],
        info: { author: 'xcode', version: 1 },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
