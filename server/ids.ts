/**
 * IDs and ordering keys.
 *
 * ULID: 26 chars, Crockford base32, monotonically sortable by creation time.
 * Offline-first means no server assigns ids, and ULIDs never collide across
 * devices — which is also why multi-device sync can be added later.
 *
 * Fractional index: block order lives in a lexicographically-ordered string, so
 * inserting between two blocks writes ONE row. No renumbering of siblings, which
 * is what makes drag-reorder cheap on a page with thousands of blocks.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ULID
// ─────────────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING = CROCKFORD;
/** 80 bits of randomness = exactly 16 base32 characters. */
const RANDOM_CHARS = 16;

let lastTime = -1;
/** the 16 five-bit values of the last issued random part, for monotonic ++ */
let lastRandom: number[] = new Array(RANDOM_CHARS).fill(0);

function encodeRandom(buf: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ENCODING[(value << (5 - bits)) & 31];
  return out;
}

function encodeTime(ms: number): string {
  let t = BigInt(ms);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ENCODING[Number(t & 31n)] + out;
    t >>= 5n;
  }
  return out;
}

/** Base-32 increment of the 16-char random component (big-endian, wraps). */
function incrementRandom(rnd: number[]): number[] {
  const out = [...rnd];
  let carry = 1;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const sum = out[i]! + carry;
    out[i] = sum & 31;
    carry = sum >> 5;
  }
  return out;
}

/** Monotonic within a millisecond: increments the random part. */
export function ulid(now = Date.now()): string {
  const timePart = encodeTime(now);

  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
    const randPart = lastRandom.map((v) => ENCODING[v]).join("");
    return timePart + randPart;
  }

  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const randPart = encodeRandom(bytes);
  lastTime = now;
  lastRandom = Array.from({ length: RANDOM_CHARS }, (_, i) =>
    ENCODING.indexOf(randPart[i]!),
  );
  return timePart + randPart;
}

export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

export function ulidTime(id: string): number {
  let t = 0n;
  for (const c of id.slice(0, 10)) {
    const v = ENCODING.indexOf(c);
    if (v < 0) return NaN;
    t = (t << 5n) | BigInt(v);
  }
  return Number(t);
}

export const newId = ulid;

// ─────────────────────────────────────────────────────────────────────────────
// Fractional indexing (base 62)
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 62;
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const VAL = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) VAL.set(ALPHABET[i]!, i);

const charVal = (c: string): number => {
  const v = VAL.get(c);
  if (v === undefined) throw new Error(`Invalid fractional-index char: ${c}`);
  return v;
};

/** base-62 fraction string → BigInt scaled to `precision` digits. */
function toScaled(key: string, precision: number): bigint {
  if (key === "") return 0n;
  let acc = 0n;
  const B = BigInt(BASE);
  for (let i = 0; i < precision; i++) {
    const d = i < key.length ? BigInt(charVal(key[i]!)) : 0n;
    acc = acc * B + d;
  }
  return acc;
}

function fromScaled(n: bigint, precision: number): string {
  const B = BigInt(BASE);
  let out = "";
  let v = n;
  for (let i = 0; i < precision; i++) {
    out = ALPHABET[Number(v % B)] + out;
    v /= B;
  }
  // strip trailing zeros: 0.a0 === 0.a, and prefix order matches numeric order
  return out.replace(/0+$/, "");
}

/**
 * Return a key that sorts strictly between `a` and `b`.
 * `null` a means "smallest possible", `null` b means "largest possible".
 */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b ?? "";
  if (lo !== "" && hi !== "" && !(lo < hi)) {
    throw new Error(`keyBetween: bounds out of order (${lo} !< ${hi})`);
  }

  let precision = 8;
  const B = BigInt(BASE);

  for (let attempt = 0; attempt < 24; attempt++) {
    const A = toScaled(lo, precision);
    const BOUND = hi === "" ? B ** BigInt(precision) : toScaled(hi, precision);

    if (A >= BOUND) {
      // `lo` rounds up to `hi` at this precision: widen and retry
      precision *= 2;
      continue;
    }

    const MID = A + (BOUND - A) / 2n;
    if (MID > A && MID < BOUND) {
      const key = fromScaled(MID, precision);
      // guard: string round-trip must preserve ordering
      if ((lo === "" || lo < key) && (hi === "" || key < hi)) return key;
    }
    precision *= 2;
  }
  throw new Error(`keyBetween: failed to find a key between "${lo}" and "${hi}"`);
}

/**
 * Keys grow by ~1 digit per halving when you keep inserting into the same gap.
 * That is inherent to fractional indexing, so the app rebalances a parent's
 * children when any key crosses this length. Rebalancing rewrites one parent's
 * direct children only — never a whole document.
 */
export const MAX_KEY_LEN = 24;

export function needsRebalance(key: string): boolean {
  return key.length > MAX_KEY_LEN;
}

/** Key for appending after all existing siblings. */
export function keyAfter(last: string | null): string {
  return keyBetween(last, null);
}

/** Key for prepending before all existing siblings. */
export function keyBefore(first: string | null): string {
  return keyBetween(null, first);
}

/**
 * Evenly spaced keys for `n` items between two bounds — used on import, when
 * materialising a whole block list, and when rebalancing a parent's children.
 *
 * Spaced arithmetically at a precision that fits `n`, so a 500-child rebalance
 * yields ~4-character keys. Repeatedly calling `keyBetween` here would converge
 * on the upper bound and lengthen every key.
 */
export function keysBetween(
  a: string | null,
  b: string | null,
  n: number,
): string[] {
  if (n <= 0) return [];

  const precision = Math.max(4, Math.ceil(Math.log(n + 1) / Math.log(BASE)) + 1);
  const B = BigInt(BASE);
  const bs = b ?? "";
  const A = toScaled(a ?? "", precision);
  const BOUND = bs === "" ? B ** BigInt(precision) : toScaled(bs, precision);
  const span = BOUND - A;
  const step = span / BigInt(n + 1);

  if (step <= 0n) {
    // bounds are too tight at this precision: fall back to sequential midpoints
    const out: string[] = [];
    let prev = a;
    for (let i = 0; i < n; i++) {
      const next = keyBetween(prev ?? null, b);
      out.push(next);
      prev = next;
    }
    return out;
  }

  const keys: string[] = [];
  for (let i = 1n; i <= BigInt(n); i++) {
    keys.push(fromScaled(A + step * i, precision));
  }
  return keys;
}

export const FIRST_KEY = keyBetween(null, null);
