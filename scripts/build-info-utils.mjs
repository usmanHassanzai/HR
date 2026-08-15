import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readBuildInfo(root) {
  const path = join(root, 'public', 'downloads', 'build-info.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function writeBuildInfo(root, patch) {
  const dir = join(root, 'public', 'downloads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'build-info.json');
  const next = { ...readBuildInfo(root), ...patch };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function packageVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function formatUpdatedLabel(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
