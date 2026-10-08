import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { gzipSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

type SizeReport = {
  totals: {
    js: { raw: number; gzip: number }
    css: { raw: number; gzip: number }
    all: { raw: number; gzip: number }
  }
  assets: { file: string; type: string; raw: number; gzip: number }[]
  topModules: { id: string; raw: number; gzipEst: number }[]
}

let pendingReport: SizeReport | null = null

/**
 * Audit helper (used because npm registry was unreachable for rollup-plugin-visualizer).
 * Writes dist/module-sizes.json with raw + gzip asset totals and largest modules.
 */
function moduleSizeReport(): Plugin {
  return {
    name: 'module-size-report',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules: { id: string; raw: number; gzipEst: number }[] = []
      let totalJsRaw = 0
      let totalJsGzip = 0
      let totalCssRaw = 0
      let totalCssGzip = 0
      const assets: { file: string; type: string; raw: number; gzip: number }[] = []

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          const code = output.code
          const raw = Buffer.byteLength(code, 'utf8')
          const gzip = gzipSync(code).length
          const ratio = gzip / Math.max(raw, 1)
          totalJsRaw += raw
          totalJsGzip += gzip
          assets.push({ file: fileName, type: 'js', raw, gzip })
          for (const [id, mod] of Object.entries(output.modules)) {
            const mRaw = mod.renderedLength || 0
            if (mRaw < 400) continue
            modules.push({
              id: id.replace(/\\/g, '/'),
              raw: mRaw,
              gzipEst: Math.round(mRaw * ratio),
            })
          }
        } else if (output.type === 'asset' && fileName.endsWith('.css')) {
          const source = typeof output.source === 'string'
            ? output.source
            : Buffer.from(output.source).toString('utf8')
          const raw = Buffer.byteLength(source, 'utf8')
          const gzip = gzipSync(source).length
          totalCssRaw += raw
          totalCssGzip += gzip
          assets.push({ file: fileName, type: 'css', raw, gzip })
        }
      }

      modules.sort((a, b) => b.raw - a.raw)
      assets.sort((a, b) => b.raw - a.raw)

      pendingReport = {
        totals: {
          js: { raw: totalJsRaw, gzip: totalJsGzip },
          css: { raw: totalCssRaw, gzip: totalCssGzip },
          all: { raw: totalJsRaw + totalCssRaw, gzip: totalJsGzip + totalCssGzip },
        },
        assets,
        topModules: modules.slice(0, 25),
      }
    },
    writeBundle(options) {
      if (!pendingReport) return
      const dir = options.dir || resolve('dist')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'module-sizes.json'), JSON.stringify(pendingReport, null, 2))
      pendingReport = null
    },
  }
}

const appVersion = process.env.npm_package_version || '1.3.7'
const webBuildId =
  process.env.VITE_WEB_BUILD_ID ||
  `${appVersion}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`

/** Writes the exact id baked into JS so write-version-json.mjs cannot drift. */
function persistWebBuildId(): Plugin {
  return {
    name: 'persist-web-build-id',
    apply: 'build',
    buildStart() {
      try {
        mkdirSync(resolve('public'), { recursive: true })
        writeFileSync(resolve('public', '.web-build-id'), webBuildId, 'utf8')
      } catch {
        /* ignore */
      }
    },
    writeBundle(options) {
      const dir = options.dir || resolve('dist')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, '.web-build-id'), webBuildId, 'utf8')
      writeFileSync(resolve('public', '.web-build-id'), webBuildId, 'utf8')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), persistWebBuildId(), moduleSizeReport()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_WEB_BUILD_ID': JSON.stringify(webBuildId),
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@supabase/supabase-js'],
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    // Content-hashed assets already cache-bust; keep index.html no-cache via headers in vercel.json when present.
    // Avoid preloading async-only vendor chunks (jspdf/xlsx/etc.) on the landing entry.
    modulePreload: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const n = id.replace(/\\/g, '/')
          if (!n.includes('/node_modules/')) return

          // React core (+ react-router if/when added). Keep scheduler with react-dom.
          if (
            /\/node_modules\/(react-dom|scheduler)\//.test(n)
            || /\/node_modules\/react\//.test(n)
            || /\/node_modules\/react-router(?:-dom)?\//.test(n)
            || /\/node_modules\/@remix-run\/router\//.test(n)
          ) {
            return 'react'
          }

          // Supabase MUST NOT use manualChunks: forcing @supabase into a shared
          // chunk caused Rolldown to place Vite's module-preload helper there,
          // which made the landing entry sync-import the entire SDK.
          // PortalApp / Login / MFA dynamic-import `./lib/supabase` instead.

          // Charting libraries (none installed today; rule ready for recharts/etc.)
          if (
            /\/node_modules\/(recharts|chart\.js|chartjs|victory|d3|nivo|@nivo|echarts|plotly\.js|highcharts)\//.test(n)
            || /\/node_modules\/@tanstack\/react-charts\//.test(n)
          ) {
            return 'charts'
          }

          // UI libraries: Radix / shadcn-style helpers only.
          // Do NOT put lucide-react in a shared chunk — that would pull every
          // icon used anywhere into one file and sync-load it on the landing
          // page. Named imports tree-shake per consuming chunk instead.
          if (
            /\/node_modules\/@radix-ui\//.test(n)
            || /\/node_modules\/(class-variance-authority|clsx|tailwind-merge|cmdk|vaul|sonner)\//.test(n)
          ) {
            return 'ui'
          }

          // Maps stay async (only pulled by live-tracking / office settings)
          if (/\/node_modules\/leaflet\//.test(n)) return 'map'

          // Keep jspdf/xlsx/html2canvas/dompurify out of manualChunks so they
          // remain behind dynamic import() and never sync-link to the landing entry.
        },
      },
    },
  },
})
