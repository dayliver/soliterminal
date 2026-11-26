/** The shape of the `key` argument Node's `keypress` event passes. */
export interface RawKey {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  /** Set by Node for escape sequences it has no name for, e.g. `[I`. */
  readonly code?: string;
}

const NAMED: Record<string, string> = {
  return: 'enter',
  enter: 'enter',
  escape: 'escape',
  space: 'space',
  backspace: 'backspace',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  tab: 'tab',
};

/**
 * Turns a Node keypress into one short name the app understands:
 * `q`, `a`, `?`, `left`, `space`, `enter`, `escape`, `tab`, `ctrl+q`…
 * Shifted letters count as the plain letter. Returns `undefined` for keys the
 * game does not use.
 */
export function normalizeKey(str: string | undefined, key: RawKey | undefined): string | undefined {
  // Focus reports (ESC [ I / ESC [ O), sent once focus reporting is turned on.
  if (key?.code === '[I') return 'focus-in';
  if (key?.code === '[O') return 'focus-out';
  if (key?.ctrl) return key.name === 'c' ? 'ctrl+c' : key.name === 'q' ? 'ctrl+q' : undefined;
  const name = key?.name;
  if (name) {
    if (NAMED[name]) return NAMED[name];
    if (/^f\d{1,2}$/.test(name)) return name;
    if (/^[a-z0-9]$/.test(name)) return name;
  }
  // Punctuation such as ` and ? arrives with no name, only the character.
  if (str && str.length === 1 && str >= ' ' && str <= '~') return str;
  return undefined;
}
