import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadLocalEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* no .env */
  }
}

export function requireSupabasePat() {
  loadLocalEnv();
  const pat = process.env.SUPABASE_PAT;
  if (!pat) {
    console.error('❌  SUPABASE_PAT is required. Add it to .env or run: SUPABASE_PAT=xxx node scripts/...');
    process.exit(1);
  }
  return pat;
}

export function supabaseProjectRef() {
  loadLocalEnv();
  return process.env.SUPABASE_PROJECT_REF || 'yvnbxweitelowucdhwpg';
}
