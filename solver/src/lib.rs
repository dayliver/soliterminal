//! The search of the Klondike solver, compiled to WebAssembly.
//!
//! This is `search` in `src/core/solver.ts`, move for move: the same move
//! generation and ordering, the same scores, the same queue order, the same
//! budget checks. With the same node budget both visit the same positions and
//! return the same answer (`test/solver-wasm.test.ts` holds them to that), so
//! the TypeScript one stays the reference and this one is only faster.
//!
//! No dependencies and no bindings generator: JavaScript writes a packed
//! position into `input()`, calls `run`, and reads the answer it points to.

use std::collections::BinaryHeap;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// Milliseconds, as `Date.now()`.
    fn now() -> f64;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn now() -> f64 {
    0.0
}

#[cfg(target_arch = "wasm32")]
fn memory_bytes() -> f64 {
    core::arch::wasm32::memory_size(0) as f64 * 65536.0
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_bytes() -> f64 {
    0.0
}

const COLS: usize = 7;
/// Six face-down cards under a king-to-ace run is the longest a column gets.
const COL_CAP: usize = 20;
const TALON_CAP: usize = 24;
/// Marks a game with no redeal limit.
const UNLIMITED: u8 = 255;

#[derive(Clone, Copy)]
struct S {
    cols: [[u8; COL_CAP]; COLS],
    len: [u8; COLS],
    down: [u8; COLS],
    found: [u8; 4],
    talon: [u8; TALON_CAP],
    tlen: u8,
    pos: u8,
    left: u8,
    n: u8,
}

#[inline]
fn suit_of(c: u8) -> usize {
    (c / 13) as usize
}
#[inline]
fn rank_of(c: u8) -> u8 {
    c % 13 + 1
}
#[inline]
fn is_red(c: u8) -> bool {
    let s = c / 13;
    s == 1 || s == 2
}
#[inline]
fn can_stack(card: u8, onto: u8) -> bool {
    rank_of(onto) == rank_of(card) + 1 && is_red(onto) != is_red(card)
}

impl S {
    #[inline]
    fn top(&self, i: usize) -> Option<u8> {
        let l = self.len[i] as usize;
        if l == 0 {
            None
        } else {
            Some(self.cols[i][l - 1])
        }
    }
    #[inline]
    fn face_up(&self, i: usize) -> i32 {
        self.len[i] as i32 - self.down[i] as i32
    }
    #[inline]
    fn fits_foundation(&self, c: u8) -> bool {
        self.found[suit_of(c)] == rank_of(c) - 1
    }
    #[inline]
    fn push(&mut self, i: usize, c: u8) {
        let l = self.len[i] as usize;
        self.cols[i][l] = c;
        self.len[i] += 1;
    }
    #[inline]
    fn flip(&mut self, i: usize) {
        if self.down[i] > 0 && self.down[i] >= self.len[i] {
            self.down[i] = self.len[i] - 1;
        }
    }

    /// See `safeToFoundation` in solver.ts.
    fn safe_to_foundation(&self, c: u8) -> bool {
        let r = rank_of(c);
        if r <= 2 {
            return true;
        }
        let suit = suit_of(c);
        let (a, b) = if is_red(c) { (0, 3) } else { (1, 2) };
        let same_other = match suit {
            1 => 2,
            2 => 1,
            0 => 3,
            _ => 0,
        };
        self.found[a] >= r - 1 && self.found[b] >= r - 1 && self.found[same_other] >= r - 2
    }

    fn unpack(b: &[u8], n: usize) -> S {
        let mut s = S {
            cols: [[0; COL_CAP]; COLS],
            len: [0; COLS],
            down: [0; COLS],
            found: [b[0], b[1], b[2], b[3]],
            talon: [0; TALON_CAP],
            tlen: b[6],
            pos: b[4],
            left: b[5],
            n: n as u8,
        };
        let mut i = 7;
        let t = s.tlen as usize;
        s.talon[..t].copy_from_slice(&b[i..i + t]);
        i += t;
        for k in 0..n {
            s.down[k] = b[i];
            let l = b[i + 1] as usize;
            s.len[k] = l as u8;
            i += 2;
            s.cols[k][..l].copy_from_slice(&b[i..i + l]);
            i += l;
        }
        s
    }

    fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.found);
        out.push(self.pos);
        out.push(self.left);
        out.push(self.tlen);
        out.extend_from_slice(&self.talon[..self.tlen as usize]);
        for k in 0..self.n as usize {
            out.push(self.down[k]);
            out.push(self.len[k]);
            out.extend_from_slice(&self.cols[k][..self.len[k] as usize]);
        }
    }

    /// How promising a position looks. Hidden cards are the main obstacle.
    fn score(&self) -> i32 {
        let home: i32 = self.found.iter().map(|&f| f as i32).sum();
        let hidden: i32 = self.down[..self.n as usize].iter().map(|&d| d as i32).sum();
        let spare = if self.left == UNLIMITED { 0 } else { self.left as i32 * 3 };
        home * 2 - hidden * 6 - self.tlen as i32 + spare
    }

    /// The position as bytes that are equal exactly when two positions are the
    /// same for the search: column order does not matter, nor does the talon
    /// pointer in Draw 1 without a redeal limit. Redeals left are not part of it.
    fn key(&self, draw: u8, out: &mut Vec<u8>) {
        out.clear();
        out.extend_from_slice(&self.found);
        out.push(if self.left == UNLIMITED && draw == 1 { 255 } else { self.pos });
        out.push(self.tlen);
        out.extend_from_slice(&self.talon[..self.tlen as usize]);
        let n = self.n as usize;
        let mut order = [0usize, 1, 2, 3, 4, 5, 6];
        let order = &mut order[..n];
        order.sort_unstable_by(|&a, &b| {
            (self.down[a], &self.cols[a][..self.len[a] as usize]).cmp(&(self.down[b], &self.cols[b][..self.len[b] as usize]))
        });
        for &k in order.iter() {
            out.push(self.down[k]);
            out.push(self.len[k]);
            out.extend_from_slice(&self.cols[k][..self.len[k] as usize]);
        }
    }
}

// ---------------------------------------------------------------------------
// Moves

#[derive(Clone, Copy)]
enum M {
    /// Tableau to foundation.
    Tf { from: u8 },
    /// The talon card at position `p` to its foundation, after `r` redeals.
    Xf { p: u8, r: u8 },
    /// Talon to tableau.
    Xt { p: u8, r: u8, to: u8 },
    /// Tableau to tableau.
    Tt { from: u8, to: u8, count: u8 },
    /// Foundation back to the tableau.
    Ft { suit: u8, to: u8 },
}

/// A move as the integer solver.ts decodes: where from, where to, the lead card, how many.
fn encode(s: &S, m: M) -> u32 {
    let (fk, fi, tk, ti, card, count): (u32, u32, u32, u32, u8, u32) = match m {
        M::Tf { from } => (1, from as u32, 0, 0, s.top(from as usize).unwrap_or(0), 1),
        M::Xf { p, .. } => (0, 0, 0, 0, s.talon[p as usize - 1], 1),
        M::Xt { p, to, .. } => (0, 0, 1, to as u32, s.talon[p as usize - 1], 1),
        M::Tt { from, to, count } => {
            let f = from as usize;
            (1, from as u32, 1, to as u32, s.cols[f][(s.len[f] - count) as usize], count as u32)
        }
        M::Ft { suit, to } => (2, 0, 1, to as u32, suit * 13 + s.found[suit as usize] - 1, 1),
    };
    fk | (fi << 2) | (tk << 5) | (ti << 6) | ((card as u32) << 9) | (count << 15)
}

fn apply(s: &mut S, m: M) {
    match m {
        M::Tf { from } => {
            let f = from as usize;
            s.len[f] -= 1;
            let c = s.cols[f][s.len[f] as usize];
            s.found[suit_of(c)] += 1;
            s.flip(f);
        }
        M::Xf { p, r } | M::Xt { p, r, .. } => {
            let at = p as usize - 1;
            let c = s.talon[at];
            let t = s.tlen as usize;
            s.talon.copy_within(at + 1..t, at);
            s.tlen -= 1;
            s.pos = p - 1;
            if s.left != UNLIMITED {
                s.left -= r;
            }
            match m {
                M::Xt { to, .. } => s.push(to as usize, c),
                _ => s.found[suit_of(c)] += 1,
            }
        }
        M::Tt { from, to, count } => {
            let (f, t, k) = (from as usize, to as usize, count as usize);
            let start = s.len[f] as usize - k;
            for x in 0..k {
                let c = s.cols[f][start + x];
                s.push(t, c);
            }
            s.len[f] -= count;
            s.flip(f);
        }
        M::Ft { suit, to } => {
            s.found[suit as usize] -= 1;
            let c = suit * 13 + s.found[suit as usize];
            s.push(to as usize, c);
        }
    }
}

/// Every talon position reachable by drawing from `pos`, with the redeals it takes. See `reach` in solver.ts.
fn reach(length: usize, pos: usize, draw: usize, left: u32, at: &mut [u8; TALON_CAP + 1], redeals: &mut [u8; TALON_CAP + 1]) -> usize {
    let mut count = 0;
    if length == 0 {
        return 0;
    }
    let mut seen = [false; TALON_CAP + 2];
    let mut p = pos;
    let mut used: u32 = 0;
    for _ in 0..2 * length + 4 {
        if p >= 1 && !seen[p] {
            seen[p] = true;
            at[count] = p as u8;
            redeals[count] = used as u8;
            count += 1;
        }
        if p == length {
            if used >= left {
                break;
            }
            p = 0;
            used += 1;
        } else {
            p = (p + draw).min(length);
        }
        if p == pos {
            break;
        }
    }
    count
}

/// Candidate moves, most promising first. See `generate` in solver.ts for why each is kept or dropped.
fn generate(s: &S, draw: u8, exhaustive: bool, out: &mut Vec<(i32, M)>) {
    out.clear();
    let n = s.n as usize;
    let mut at = [0u8; TALON_CAP + 1];
    let mut rd = [0u8; TALON_CAP + 1];
    let left = if s.left == UNLIMITED { u32::MAX } else { s.left as u32 };
    let reachable = reach(s.tlen as usize, s.pos as usize, draw as usize, left, &mut at, &mut rd);

    let mut usable = [false; 64];
    let mut king_waiting = false;
    for i in 0..n {
        for k in s.down[i] as usize..s.len[i] as usize {
            let c = s.cols[i][k];
            usable[c as usize] = true;
            if rank_of(c) == 13 && k > 0 {
                king_waiting = true;
            }
        }
    }
    for i in 0..reachable {
        let c = s.talon[at[i] as usize - 1];
        usable[c as usize] = true;
        if rank_of(c) == 13 {
            king_waiting = true;
        }
    }
    if exhaustive && s.found.contains(&13) {
        king_waiting = true;
    }
    let first_empty = (0..n).find(|&i| s.len[i] == 0);

    for i in 0..n {
        if let Some(top) = s.top(i) {
            if s.face_up(i) > 0 && s.fits_foundation(top) {
                out.push((100 + s.down[i] as i32, M::Tf { from: i as u8 }));
            }
        }
    }
    for i in 0..reachable {
        if s.fits_foundation(s.talon[at[i] as usize - 1]) {
            out.push((90 - 30 * rd[i] as i32, M::Xf { p: at[i], r: rd[i] }));
        }
    }
    for i in 0..n {
        let up = s.face_up(i);
        let len = s.len[i] as usize;
        for k in 1..=up.max(0) as usize {
            let lead = s.cols[i][len - k];
            let whole = k as i32 == up;
            for j in 0..n {
                if j == i {
                    continue;
                }
                match s.top(j) {
                    None => {
                        if Some(j) != first_empty || rank_of(lead) != 13 || (whole && s.down[i] == 0) {
                            continue;
                        }
                    }
                    Some(t) => {
                        if !can_stack(lead, t) {
                            continue;
                        }
                    }
                }
                if !whole {
                    if !s.fits_foundation(s.cols[i][len - k - 1]) {
                        if !exhaustive {
                            continue;
                        }
                        let twin = (3 - lead / 13) * 13 + lead % 13;
                        if !usable[twin as usize] && !(s.found[suit_of(twin)] == rank_of(twin) && rank_of(twin) >= 2) {
                            continue;
                        }
                    }
                } else if s.down[i] == 0 && s.len[j] > 0 && !king_waiting {
                    continue;
                }
                let score = if whole {
                    if s.down[i] > 0 {
                        60 + s.down[i] as i32
                    } else {
                        20
                    }
                } else {
                    10
                };
                out.push((score, M::Tt { from: i as u8, to: j as u8, count: k as u8 }));
            }
        }
    }
    for i in 0..reachable {
        let c = s.talon[at[i] as usize - 1];
        for j in 0..n {
            let ok = match s.top(j) {
                None => Some(j) == first_empty && rank_of(c) == 13,
                Some(t) => can_stack(c, t),
            };
            if ok {
                out.push((40 - 30 * rd[i] as i32, M::Xt { p: at[i], r: rd[i], to: j as u8 }));
            }
        }
    }
    for suit in 0..4u8 {
        if s.found[suit as usize] < 2 {
            continue;
        }
        let c = suit * 13 + s.found[suit as usize] - 1;
        let below = if is_red(c) { [0u8, 3] } else { [1u8, 2] };
        if !exhaustive && !below.iter().any(|&t| usable[(t * 13 + c % 13 - 1) as usize]) {
            continue;
        }
        for j in 0..n {
            let ok = match s.top(j) {
                None => exhaustive && Some(j) == first_empty && rank_of(c) == 13,
                Some(t) => can_stack(c, t),
            };
            if ok {
                out.push((0, M::Ft { suit, to: j as u8 }));
            }
        }
    }
    // Stable, like Array.prototype.sort: equal scores keep the order above.
    out.sort_by(|a, b| b.0.cmp(&a.0));
}

// ---------------------------------------------------------------------------
// Positions lost without a search

/// See `dead` in solver.ts: true when some card can never reach its foundation.
///
/// The same rules, applied to all cards at once: bit `c` of a mask is card `c`.
fn dead(s: &S) -> bool {
    const SUIT: u64 = (1 << 13) - 1;
    const ALL: u64 = (1 << 52) - 1;
    const ACES: u64 = 1 | 1 << 13 | 1 << 26 | 1 << 39;
    const KINGS: u64 = ACES << 12;
    const NONE: u8 = 255;
    let n = s.n as usize;
    let mut home: u64 = 0;
    let mut talon: u64 = 0;
    let mut down: u64 = 0;
    let mut top: u64 = 0;
    let mut bottom: u64 = 0;
    let mut covered: u64 = 0; // cards that lie on another
    let mut under = [NONE; 52]; // the card each of those lies on
    let mut empty = false;
    let mut last_home: u64 = 0; // the card on top of each foundation
    for suit in 0..4 {
        home |= ((1u64 << s.found[suit]) - 1) << (13 * suit);
        last_home |= ((1u64 << s.found[suit]) >> 1) << (13 * suit);
    }
    let was_home = home;
    for &c in &s.talon[..s.tlen as usize] {
        talon |= 1 << c;
    }
    let mut present = home | talon;
    for i in 0..n {
        let len = s.len[i] as usize;
        if len == 0 {
            empty = true;
            continue;
        }
        let col = &s.cols[i];
        bottom |= 1 << col[0];
        top |= 1 << col[len - 1];
        for k in 0..len {
            let c = col[k];
            present |= 1 << c;
            if k < s.down[i] as usize {
                down |= 1 << c;
            }
            if k > 0 {
                covered |= 1 << c;
                under[c as usize] = col[k - 1];
            }
        }
    }
    if present != ALL {
        return true;
    }
    loop {
        let before = (home, top, empty);
        // Cards that a card on top would take: one rank lower, of the other color.
        let p = (top >> 1) & !KINGS;
        let black = (p & SUIT) | (p >> 39 & SUIT);
        let red = (p >> 13 & SUIT) | (p >> 26 & SUIT);
        let landing = red | black << 13 | black << 26 | red << 39;
        // From the talon, or from a foundation once the card above it there has come down.
        top |= (talon | was_home & (last_home | p)) & (landing | if empty { KINGS } else { 0 });
        // Tableau cards that can leave where they lie: turned, with somewhere to go.
        let turned = !down | top;
        let leave = turned & (home | landing);
        if leave & bottom != 0 {
            empty = true;
        }
        let mut go = (leave | if empty { turned & KINGS } else { 0 }) & covered;
        covered &= !go;
        while go != 0 {
            let x = go.trailing_zeros() as usize;
            go &= go - 1;
            top |= 1 << under[x];
        }
        // Up each suit as far as the cards are in hand.
        let ready = talon | top;
        loop {
            let next = home | (((home << 1) & !ACES) | ACES) & ready;
            if next == home {
                break;
            }
            home = next;
        }
        if home == ALL {
            return false;
        }
        if (home, top, empty) == before {
            return true;
        }
    }
}

// ---------------------------------------------------------------------------
// The table of positions seen

/// Two independent 64-bit hashes of the key. Positions are told apart by all
/// 128 bits, so two different ones being taken for the same is not something
/// that happens (about 1 in 10^24 for ten million positions).
fn hash(bytes: &[u8]) -> (u64, u64) {
    #[inline]
    fn mix(mut x: u64) -> u64 {
        x ^= x >> 30;
        x = x.wrapping_mul(0xbf58476d1ce4e5b9);
        x ^= x >> 27;
        x = x.wrapping_mul(0x94d049bb133111eb);
        x ^ (x >> 31)
    }
    let mut a: u64 = 0x9e3779b97f4a7c15 ^ bytes.len() as u64;
    let mut b: u64 = 0xc2b2ae3d27d4eb4f ^ ((bytes.len() as u64) << 32);
    for chunk in bytes.chunks(8) {
        let mut w = [0u8; 8];
        w[..chunk.len()].copy_from_slice(chunk);
        let v = u64::from_le_bytes(w);
        a = mix(a ^ v).wrapping_add(0x2545f4914f6cdd1d);
        b = mix(b.rotate_left(23) ^ v.wrapping_mul(0xff51afd7ed558ccd)).wrapping_add(a.rotate_left(17));
    }
    let (a, b) = (mix(a ^ b.rotate_left(32)), mix(b ^ 0x165667b19e3779f9));
    // (0, 0) marks an empty slot.
    if a == 0 && b == 0 {
        (1, 0)
    } else {
        (a, b)
    }
}

/// Positions already queued, with the most redeals any of them had left.
struct Seen {
    keys: Vec<(u64, u64)>,
    left: Vec<u8>,
    used: usize,
}

impl Seen {
    fn new() -> Seen {
        Seen { keys: vec![(0, 0); 1 << 12], left: vec![0; 1 << 12], used: 0 }
    }

    /// True when this position is new, or comes with more redeals left than
    /// before: the same position with more can do everything one with fewer can.
    fn better(&mut self, h: (u64, u64), left: u8) -> bool {
        let mask = self.keys.len() - 1;
        let mut i = h.0 as usize & mask;
        loop {
            let k = self.keys[i];
            if k == (0, 0) {
                self.keys[i] = h;
                self.left[i] = left;
                self.used += 1;
                if self.used * 5 > self.keys.len() * 3 {
                    self.grow();
                }
                return true;
            }
            if k == h {
                if self.left[i] >= left {
                    return false;
                }
                self.left[i] = left;
                return true;
            }
            i = (i + 1) & mask;
        }
    }

    fn grow(&mut self) {
        let size = self.keys.len() * 2;
        let keys = std::mem::replace(&mut self.keys, vec![(0, 0); size]);
        let left = std::mem::replace(&mut self.left, vec![0; size]);
        let mask = size - 1;
        for (k, l) in keys.into_iter().zip(left) {
            if k == (0, 0) {
                continue;
            }
            let mut i = k.0 as usize & mask;
            while self.keys[i] != (0, 0) {
                i = (i + 1) & mask;
            }
            self.keys[i] = k;
            self.left[i] = l;
        }
    }
}

// ---------------------------------------------------------------------------
// Search

/// Packed positions, end to end in blocks, so that millions of them never
/// have to be copied to a larger buffer (which would briefly need both).
struct Arena {
    blocks: Vec<Vec<u8>>,
}

const BLOCK_BITS: u32 = 20;
const BLOCK: usize = 1 << BLOCK_BITS;

impl Arena {
    /// Stores a position and returns where: the block, and the offset in it.
    fn add(&mut self, s: &S) -> u32 {
        if self.blocks.last().map_or(true, |b| b.len() + INPUT_SIZE > BLOCK) {
            self.blocks.push(Vec::with_capacity(BLOCK));
        }
        let block = self.blocks.last_mut().unwrap();
        let at = block.len();
        s.pack(block);
        (((self.blocks.len() - 1) as u32) << BLOCK_BITS) | at as u32
    }

    fn get(&self, at: u32) -> &[u8] {
        &self.blocks[(at >> BLOCK_BITS) as usize][at as usize & (BLOCK - 1)..]
    }
}

const UNKNOWN: u32 = 0;
const SOLVED: u32 = 1;
const UNSOLVABLE: u32 = 2;

fn step(s: &mut S, m: M, out: &mut Vec<u32>) {
    out.push(encode(s, m));
    apply(s, m);
}

/// Plays every safe tableau card home.
fn play_safe(s: &mut S, out: &mut Vec<u32>) {
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..s.n as usize {
            if let Some(top) = s.top(i) {
                if s.face_up(i) > 0 && s.fits_foundation(top) && s.safe_to_foundation(top) {
                    step(s, M::Tf { from: i as u8 }, out);
                    changed = true;
                }
            }
        }
    }
}

/// True once the game is won or trivially winnable; in the latter case plays it out.
fn finished(s: &mut S, out: &mut Vec<u32>) -> bool {
    if s.found.iter().all(|&f| f == 13) {
        return true;
    }
    let n = s.n as usize;
    if s.tlen > 0 || s.down[..n].iter().any(|&d| d > 0) {
        return false;
    }
    let cards: u32 = s.found.iter().map(|&f| f as u32).sum::<u32>() + s.len[..n].iter().map(|&l| l as u32).sum::<u32>();
    if cards != 52 {
        return false;
    }
    while s.found.iter().any(|&f| f < 13) {
        let mut best: Option<usize> = None;
        for i in 0..n {
            if let Some(top) = s.top(i) {
                if best.map_or(true, |b| rank_of(top) < rank_of(s.top(b).unwrap())) {
                    best = Some(i);
                }
            }
        }
        match best {
            Some(b) => step(s, M::Tf { from: b as u8 }, out),
            None => return false,
        }
    }
    true
}

struct Answer {
    status: u32,
    nodes: u32,
    moves: Vec<u32>,
}

fn search(root_bytes: &[u8], n: usize, draw: u8, max_nodes: f64, time_limit_ms: f64, exhaustive: bool, memory_limit: f64) -> Answer {
    let deadline = unsafe { now() } + time_limit_ms;
    let mut seen = Seen::new();
    let mut parents: Vec<u32> = Vec::new();
    // The moves that led to each position, end to end; position i owns steps[step_at[i]..step_at[i + 1]].
    let mut steps: Vec<u32> = Vec::new();
    let mut step_at: Vec<u32> = vec![0];
    let mut packed = Arena { blocks: Vec::new() };
    let mut packed_at: Vec<u32> = Vec::new();
    let mut queue: BinaryHeap<(i32, u32)> = BinaryHeap::new();
    let mut key = Vec::with_capacity(128);
    let mut moves = Vec::with_capacity(64);
    let mut out: Vec<u32> = Vec::with_capacity(64);

    let mut root = S::unpack(root_bytes, n);
    play_safe(&mut root, &mut out);
    if finished(&mut root, &mut out) {
        return Answer { status: SOLVED, nodes: 1, moves: out };
    }
    if dead(&root) {
        return Answer { status: UNSOLVABLE, nodes: 1, moves: Vec::new() };
    }
    root.key(draw, &mut key);
    seen.better(hash(&key), root.left);
    parents.push(u32::MAX);
    steps.extend_from_slice(&out);
    step_at.push(steps.len() as u32);
    packed_at.push(packed.add(&root));
    queue.push((root.score(), 0));

    while let Some((_, id)) = queue.pop() {
        let s = S::unpack(packed.get(packed_at[id as usize]), n);
        generate(&s, draw, exhaustive, &mut moves);
        for &(_, m) in moves.iter() {
            let mut child = s;
            out.clear();
            step(&mut child, m, &mut out);
            play_safe(&mut child, &mut out);
            if finished(&mut child, &mut out) {
                // The path: this last stretch, then each position's own back to the root.
                let mut chain: Vec<u32> = Vec::new();
                let mut stretches: Vec<(usize, usize)> = Vec::new();
                let mut at = id;
                while at != u32::MAX {
                    stretches.push((step_at[at as usize] as usize, step_at[at as usize + 1] as usize));
                    at = parents[at as usize];
                }
                for &(a, b) in stretches.iter().rev() {
                    chain.extend_from_slice(&steps[a..b]);
                }
                chain.extend_from_slice(&out);
                return Answer { status: SOLVED, nodes: parents.len() as u32, moves: chain };
            }
            child.key(draw, &mut key);
            if !seen.better(hash(&key), child.left) {
                continue;
            }
            if dead(&child) {
                continue;
            }
            let count = parents.len();
            if count as f64 >= max_nodes || (count & 1023 == 0 && (unsafe { now() } > deadline || memory_bytes() > memory_limit)) {
                return Answer { status: UNKNOWN, nodes: count as u32, moves: Vec::new() };
            }
            parents.push(id);
            steps.extend_from_slice(&out);
            step_at.push(steps.len() as u32);
            packed_at.push(packed.add(&child));
            queue.push((child.score(), count as u32));
        }
    }
    Answer { status: UNSOLVABLE, nodes: parents.len() as u32, moves: Vec::new() }
}

// ---------------------------------------------------------------------------
// The boundary with JavaScript

const INPUT_SIZE: usize = 512;
static mut INPUT: [u8; INPUT_SIZE] = [0; INPUT_SIZE];
static mut OUTPUT: Vec<u32> = Vec::new();

/// Where to write the packed position (see `pack` in solver.ts), at most 512 bytes.
#[no_mangle]
pub extern "C" fn input() -> *mut u8 {
    core::ptr::addr_of_mut!(INPUT) as *mut u8
}

/// Searches the position in `input()`. Returns a pointer to 32-bit words:
/// status (0 unknown, 1 solved, 2 unsolvable), positions visited, the number
/// of moves, then the moves.
#[no_mangle]
pub extern "C" fn run(columns: u32, draw: u32, max_nodes: f64, time_limit_ms: f64, exhaustive: u32, memory_limit: f64) -> *const u32 {
    let bytes = unsafe { &*core::ptr::addr_of!(INPUT) };
    let answer = search(bytes, columns as usize, draw as u8, max_nodes, time_limit_ms, exhaustive != 0, memory_limit);
    let out = unsafe { &mut *core::ptr::addr_of_mut!(OUTPUT) };
    out.clear();
    out.push(answer.status);
    out.push(answer.nodes);
    out.push(answer.moves.len() as u32);
    out.extend_from_slice(&answer.moves);
    out.as_ptr()
}
