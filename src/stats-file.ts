import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ShareState, type StatEvent, type Stats, eventLine, foldLog, parseLegacyStats, parseShare } from './stats.ts';

/**
 * Where statistics live: SOLITERMINAL_STATS if set, else the usual place for
 * app state, %LOCALAPPDATA% on Windows and $XDG_STATE_HOME (~/.local/state)
 * elsewhere. It is a log, one line per finished game, only ever appended to,
 * so several windows playing at once never write over each other's games.
 */
export function statsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.SOLITERMINAL_STATS) return env.SOLITERMINAL_STATS;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'soliterminal', 'games.jsonl');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'soliterminal', 'games.jsonl');
}

/** Where sharing stands, next to the log. Small, and rewritten whole. */
export const sharePath = (statsFile: string): string => join(dirname(statsFile), 'share.json');

/** The statistics file of earlier versions, next to the log. */
const legacyPath = (statsFile: string): string => join(dirname(statsFile), 'stats.json');

/** Writes through a temporary file, so a crash never leaves half a file. Never throws. */
export function writeWhole(path: string, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves the games of an earlier version's `stats.json` into the log, once:
 * only while there is no log yet. The old file is left where it is.
 */
function migrate(path: string): void {
  if (existsSync(path)) return;
  let old: ReturnType<typeof parseLegacyStats>;
  try {
    old = parseLegacyStats(JSON.parse(readFileSync(legacyPath(path), 'utf8')));
  } catch {
    return;
  }
  // Oldest first, as the log is written.
  writeWhole(path, [...old.games].reverse().map((game) => eventLine({ game })).join(''));
  if (old.share && !existsSync(sharePath(path))) saveShare(path, old.share);
}

/** A missing or damaged file just means no games yet. */
export function loadStats(path: string): Stats {
  migrate(path);
  let stats: Stats;
  try {
    stats = foldLog(readFileSync(path, 'utf8'));
  } catch {
    stats = { games: [] };
  }
  let share: ShareState | undefined;
  try {
    share = parseShare(JSON.parse(readFileSync(sharePath(path), 'utf8')));
  } catch {
    share = undefined;
  }
  return share ? { ...stats, share } : stats;
}

/**
 * Adds events to the log in a single write, so lines from two windows never
 * interleave. A line cut short by a crash is skipped on reading. Never throws.
 */
export function appendStats(path: string, events: readonly StatEvent[]): boolean {
  if (events.length === 0) return true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // After a write cut short, start on a line of its own rather than finish the broken one.
    const lead = endsMidLine(path) ? '\n' : '';
    appendFileSync(path, lead + events.map(eventLine).join(''));
    return true;
  } catch {
    return false;
  }
}

function endsMidLine(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function saveShare(statsFile: string, share: ShareState): boolean {
  return writeWhole(sharePath(statsFile), JSON.stringify(share, null, 2) + '\n');
}
