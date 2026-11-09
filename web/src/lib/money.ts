/**
 * Money in the browser.
 *
 * The API sends amounts as text ("3450.00"). They are never turned into
 * JavaScript numbers (which round): sums and shares are done in whole
 * halalas with BigInt, and amounts are formatted from the text itself.
 */

/** "3450.5" or "3450.50" -> 345050n halalas. Throws on anything else. */
export function toHalalas(amount: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not an amount: ${amount}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? '').padEnd(2, '0'));
  const v = whole * 100n + frac;
  return m[1] ? -v : v;
}

/** 345050n -> "3450.50" */
export function fromHalalas(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

export function sum(amounts: (string | null | undefined)[]): string {
  return fromHalalas(amounts.reduce<bigint>((acc, a) => acc + (a ? toHalalas(a) : 0n), 0n));
}

export function subtract(a: string, b: string): string {
  return fromHalalas(toHalalas(a) - toHalalas(b));
}

export function isZero(a: string | null | undefined): boolean {
  return !a || toHalalas(a) === 0n;
}

/**
 * part / whole as a percentage with one decimal, as text ("43.4").
 * Exact (rounded half up). null when whole is zero.
 */
export function share(part: string, whole: string): string | null {
  const w = toHalalas(whole);
  if (w === 0n) return null;
  const tenths = (toHalalas(part) * 2000n + w) / (2n * w); // round half up
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** Thousands separators from the text itself: "3450.50" -> "3,450.50". Western digits in both languages. */
export function groupDigits(amount: string, opts: { decimals?: boolean } = {}): string {
  const v = fromHalalas(toHalalas(amount));
  const [whole, frac] = v.replace('-', '').split('.') as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = v.startsWith('-') ? '-' : '';
  const showFrac = opts.decimals ?? frac !== '00';
  return `${sign}${grouped}${showFrac ? `.${frac}` : ''}`;
}
