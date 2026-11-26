/**
 * Sharing results for Klondike research, only ever when the player agrees.
 *
 * Nothing is collected on its own. Each time the finished games reach a new
 * hundred (100, 200, …) the player is asked once. Yes sends the games not
 * sent yet; no waits for the next hundred, which then sends them all. There is
 * no way to send smaller batches: a server that takes a game at a time from
 * everyone is a server under needless load.
 *
 * What goes out is the deal and how it went, and a random name for the
 * installation so a batch sent twice counts once. Nothing about the player or
 * their computer: no names, paths, addresses or clock times beyond the day.
 */
import { randomUUID } from 'node:crypto';
import { type GameRecord, type ShareState, type Stats, withSent } from './stats.ts';

/** Games per question, and the smallest batch ever sent. */
export const SHARE_EVERY = 100;
/** The most games one batch carries; any more wait for the next. */
export const MAX_BATCH = 1000;

/** Where results go: SOLITERMINAL_SHARE_URL if set, else the project's own server once it has one. */
export const SHARE_URL: string | undefined = undefined;

export function shareUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.SOLITERMINAL_SHARE_URL || SHARE_URL;
}

/** Finished games not sent yet, oldest first: the next batch. */
export function unsent(stats: Stats): GameRecord[] {
  return stats.games.filter((g) => !g.sent).reverse();
}

/** Every game finished so far, sent or not. */
export function finishedGames(stats: Stats): number {
  return stats.games.length;
}

const state = (stats: Stats): ShareState => stats.share ?? { id: randomUUID(), asked: 0, pending: false };

/** Whether to ask now: the finished games have passed a hundred not asked about, and a full batch waits. */
export function shareDue(stats: Stats): boolean {
  const total = finishedGames(stats);
  const asked = stats.share?.asked ?? 0;
  return !stats.share?.pending && unsent(stats).length >= SHARE_EVERY && Math.floor(total / SHARE_EVERY) > Math.floor(asked / SHARE_EVERY);
}

/** The player said yes: the batch is sent as soon as possible, and again on later starts until it goes through. */
export function acceptShare(stats: Stats): Stats {
  return { ...stats, share: { ...state(stats), asked: finishedGames(stats), pending: true } };
}

/** The player said no: ask again at the next hundred. */
export function declineShare(stats: Stats): Stats {
  return { ...stats, share: { ...state(stats), asked: finishedGames(stats), pending: false } };
}

/** One game as sent. */
export interface SharedGame {
  /** The game's own random name, so the server stores it once however often it comes. */
  readonly id: string;
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
  const waiting = unsent(stats);
  if (waiting.length < SHARE_EVERY) return undefined;
  const games = waiting.slice(0, MAX_BATCH);
  const shared = games.map(
    (g): SharedGame => ({
      id: g.id,
      seed: g.seed,
      draw: g.drawMode,
      limit: g.limit === undefined ? DEFAULT_LIMIT : g.limit,
      result: g.result,
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
export function markShared(stats: Stats, ids: readonly string[]): Stats {
  return { ...withSent(stats, ids), share: { ...state(stats), pending: false } };
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
    // One batch a day per installation: another window, or an earlier try that did get through.
    if (res.status === 429) return 'the server takes one batch a day';
    return `the server said ${res.status}`;
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? 'no answer from the server' : 'no connection to the server';
  }
}
