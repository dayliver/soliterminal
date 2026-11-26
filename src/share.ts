/**
 * Sharing results for Klondike research, only ever when the player agrees.
 *
 * Nothing is collected on its own. Each time the finished games reach a new
 * thousand (1,000, 2,000, …) the player is asked once. Yes sends every game
 * not sent yet; no waits for the next thousand, which then sends them all.
 * There is no way to send smaller batches: a server that takes a few games at
 * a time from everyone is a server under needless load.
 *
 * What goes out is the deal and how it went, and a random name for the
 * installation so a batch sent twice counts once. Nothing about the player or
 * their computer: no names, paths, addresses or clock times beyond the day.
 */
import { randomUUID } from 'node:crypto';
import type { GameRecord, ShareState, Stats } from './stats.ts';

/** Games per question, and the smallest batch ever sent. */
export const SHARE_EVERY = 1000;

/** Where results go: SOLITERMINAL_SHARE_URL if set, else the project's own server once it has one. */
export const SHARE_URL: string | undefined = undefined;

export function shareUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.SOLITERMINAL_SHARE_URL || SHARE_URL;
}

const finished = (g: GameRecord) => g.result !== 'playing';

/** Finished games not sent yet, oldest first: the next batch. */
export function unsent(stats: Stats): GameRecord[] {
  return stats.games.filter((g) => finished(g) && !g.sent).reverse();
}

/** Every game finished so far, counting those sent and since dropped from the list. */
export function finishedGames(stats: Stats): number {
  return (stats.share?.sent ?? 0) + unsent(stats).length;
}

const state = (stats: Stats): ShareState => stats.share ?? { id: randomUUID(), sent: 0, asked: 0, pending: false };

/** Whether to ask now: the finished games have passed a thousand not asked about, and a full batch waits. */
export function shareDue(stats: Stats): boolean {
  const total = finishedGames(stats);
  const asked = stats.share?.asked ?? 0;
  return !stats.share?.pending && unsent(stats).length >= SHARE_EVERY && Math.floor(total / SHARE_EVERY) > Math.floor(asked / SHARE_EVERY);
}

/** The player said yes: the batch is sent as soon as possible, and again on later starts until it goes through. */
export function acceptShare(stats: Stats): Stats {
  return { ...stats, share: { ...state(stats), asked: finishedGames(stats), pending: true } };
}

/** The player said no: ask again at the next thousand. */
export function declineShare(stats: Stats): Stats {
  return { ...stats, share: { ...state(stats), asked: finishedGames(stats), pending: false } };
}

/** One game as sent. */
export interface SharedGame {
  readonly seed: number;
  readonly draw: 1 | 3;
  /** Redeals allowed, null for no limit. */
  readonly limit: number | null;
  readonly result: 'won' | 'lost';
  readonly ms: number;
  readonly moves: number;
  readonly redeals?: number;
  readonly lostAt?: number;
  readonly level?: number;
  /** The day it was played, UTC, like 2026-11-26. */
  readonly day: string;
}

export interface SharePayload {
  readonly v: 1;
  readonly id: string;
  readonly client: string;
  readonly games: readonly SharedGame[];
}

const DEFAULT_LIMIT = 3;

/** The batch waiting to go out, if the player agreed to send one. */
export function sharePayload(stats: Stats, client: string): { payload: SharePayload; games: GameRecord[] } | undefined {
  if (!stats.share?.pending) return undefined;
  const games = unsent(stats);
  if (games.length < SHARE_EVERY) return undefined;
  const shared = games.map(
    (g): SharedGame => ({
      seed: g.seed,
      draw: g.drawMode,
      limit: g.limit === undefined ? DEFAULT_LIMIT : g.limit,
      result: g.result as 'won' | 'lost',
      ms: g.ms,
      moves: g.moves,
      ...(g.redeals === undefined ? {} : { redeals: g.redeals }),
      ...(g.lostAt === undefined ? {} : { lostAt: g.lostAt }),
      ...(g.level === undefined ? {} : { level: g.level }),
      day: new Date(g.at).toISOString().slice(0, 10),
    }),
  );
  return { payload: { v: 1, id: stats.share.id, client, games: shared }, games };
}

/** The batch went through: its games are marked sent. */
export function markShared(stats: Stats, games: readonly GameRecord[]): Stats {
  const key = (g: GameRecord) => `${g.seed}/${g.drawMode}/${g.at}`;
  const done = new Set(games.map(key));
  const marked = stats.games.map((g) => (done.has(key(g)) ? { ...g, sent: true as const } : g));
  const share = state(stats);
  return { ...stats, games: marked, share: { ...share, sent: share.sent + games.length, pending: false } };
}

/** Posts a batch. Resolves to an error message, or undefined once the server has it. Never throws. */
export async function postShare(url: string, payload: SharePayload, timeoutMs = 30_000): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': payload.client },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return undefined;
    return `the server said ${res.status}`;
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? 'no answer from the server' : 'no connection to the server';
  }
}
