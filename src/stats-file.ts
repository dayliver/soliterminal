import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EMPTY_STATS, type Stats, parseStats } from './stats.ts';

/**
 * Where statistics live: SOLITERMINAL_STATS if set, else the usual place for
 * app state, %LOCALAPPDATA% on Windows and $XDG_STATE_HOME (~/.local/state)
 * elsewhere.
 */
export function statsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.SOLITERMINAL_STATS) return env.SOLITERMINAL_STATS;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'soliterminal', 'stats.json');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'soliterminal', 'stats.json');
}

/** A missing or damaged file just means no games yet. */
export function loadStats(path: string): Stats {
  try {
    return parseStats(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return EMPTY_STATS;
  }
}

/** Writes to a temporary file first, so a crash never leaves half a file. Never throws. */
export function saveStats(path: string, stats: Stats): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
