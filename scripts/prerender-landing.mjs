#!/usr/bin/env node
/**
 * Prerender marketing `/` into dist/index.html after `vite build`.
 * Uses Vite SSR (renderToString) — no Chromium, works on Vercel.
 */
import { createServer } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const distIndex = resolve('dist/index.html');

if (!existsSync(distIndex)) {
  console.error('prerender-landing: dist/index.html missing — run vite build first');
  process.exit(1);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  // Keep SSR aligned with the client Vite config (manualChunks etc. don't matter here).
  define: {
    'import.meta.env.SSR': true,
  },
});

try {
  const mod = await vite.ssrLoadModule('/src/prerender/entry-server.tsx');
  const renderLanding = mod.renderLanding;
  if (typeof renderLanding !== 'function') {
    throw new Error('entry-server.tsx must export renderLanding()');
  }

  const appHtml = renderLanding();
  if (!appHtml || !appHtml.includes('landing-hero__title')) {
    throw new Error('Prerender output missing landing hero — aborting');
  }

  let html = readFileSync(distIndex, 'utf8');

  // Replace empty root or a previous prerender pass.
  if (/<div id="root"[^>]*>[\s\S]*?<\/div>\s*<script/.test(html)) {
    html = html.replace(
      /<div id="root"[^>]*>[\s\S]*?<\/div>(\s*<script)/,
      `<div id="root" data-prerender="landing">${appHtml}</div>$1`,
    );
  } else if (html.includes('<div id="root"></div>')) {
    html = html.replace(
      '<div id="root"></div>',
      `<div id="root" data-prerender="landing">${appHtml}</div>`,
    );
  } else {
    throw new Error('Could not find #root in dist/index.html');
  }

  writeFileSync(distIndex, html);
  const bytes = Buffer.byteLength(appHtml, 'utf8');
  console.log(`prerender-landing: wrote / hero HTML into dist/index.html (${bytes} bytes)`);
} finally {
  await vite.close();
}
