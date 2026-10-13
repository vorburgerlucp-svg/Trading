// INDEPENDENT REFERENCE IMPLEMENTATIONS (tests only).
// Exact rational arithmetic (bigint fractions) and naive textbook definitions, written separately
// from src/quant: no function, helper or shortcut of the engine is reused. Used to cross-check the
// engine's float64 results on random series.

export class Frac {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static of(text: string | number): Frac {
    const s = typeof text === 'number' ? String(text) : text;
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error('bad decimal ' + s);
    const frac = m[3] ?? '';
    const n = BigInt(m[2]! + frac) * (m[1] === '-' ? -1n : 1n);
    return new Frac(n, 10n ** BigInt(frac.length));
  }
  add(o: Frac): Frac {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac): Frac {
    return new Frac(this.n * o.n, this.d * o.d);
  }
  div(o: Frac): Frac {
    return new Frac(this.n * o.d, this.d * o.n);
  }
  cmp(o: Frac): number {
    const a = this.n * o.d;
    const b = o.n * this.d;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  abs(): Frac {
    return this.n < 0n ? new Frac(-this.n, this.d) : this;
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  /** Correctly scaled conversion (keeps 30 significant digits before going to float). */
  toNumber(): number {
    const scale = 10n ** 30n;
    return Number((this.n * scale) / this.d) / 1e30;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

const F = (x: number | bigint) => new Frac(BigInt(x));
const ZERO = F(0);
const max = (...xs: Frac[]) => xs.reduce((m, x) => (x.cmp(m) > 0 ? x : m));

export function refSma(xs: Frac[], p: number): (Frac | null)[] {
  return xs.map((_, i) => {
    if (i < p - 1) return null;
    let s = ZERO;
    for (let j = i - p + 1; j <= i; j++) s = s.add(xs[j]!);
    return s.div(F(p));
  });
}

export function refEma(xs: (Frac | null)[], p: number): (Frac | null)[] {
  const out: (Frac | null)[] = xs.map(() => null);
  const first = xs.findIndex((x) => x !== null);
  if (first < 0 || xs.length - first < p) return out;
  const alpha = F(2).div(F(p + 1));
  let s = ZERO;
  for (let j = first; j < first + p; j++) s = s.add(xs[j]!);
  let e = s.div(F(p));
  out[first + p - 1] = e;
  for (let i = first + p; i < xs.length; i++) {
    e = alpha.mul(xs[i]!).add(F(1).sub(alpha).mul(e)); // α·x + (1 − α)·e  (algebraically equal form)
    out[i] = e;
  }
  return out;
}

export function refRsi(c: Frac[], p: number): (Frac | null)[] {
  const out: (Frac | null)[] = c.map(() => null);
  if (c.length <= p) return out;
  const gains: Frac[] = [ZERO];
  const losses: Frac[] = [ZERO];
  for (let t = 1; t < c.length; t++) {
    const ch = c[t]!.sub(c[t - 1]!);
    gains.push(ch.cmp(ZERO) > 0 ? ch : ZERO);
    losses.push(ch.cmp(ZERO) < 0 ? ZERO.sub(ch) : ZERO);
  }
  let g = gains.slice(1, p + 1).reduce((a, b) => a.add(b), ZERO).div(F(p));
  let l = losses.slice(1, p + 1).reduce((a, b) => a.add(b), ZERO).div(F(p));
  const val = (g: Frac, l: Frac) => (l.isZero() ? (g.isZero() ? F(50) : F(100)) : F(100).sub(F(100).div(F(1).add(g.div(l)))));
  out[p] = val(g, l);
  for (let t = p + 1; t < c.length; t++) {
    g = g.mul(F(p - 1)).add(gains[t]!).div(F(p));
    l = l.mul(F(p - 1)).add(losses[t]!).div(F(p));
    out[t] = val(g, l);
  }
  return out;
}

export function refTr(h: Frac[], l: Frac[], c: Frac[]): (Frac | null)[] {
  return h.map((_, t) => (t === 0 ? null : max(h[t]!.sub(l[t]!), h[t]!.sub(c[t - 1]!).abs(), l[t]!.sub(c[t - 1]!).abs())));
}

export function refAtr(h: Frac[], l: Frac[], c: Frac[], p: number): (Frac | null)[] {
  const tr = refTr(h, l, c);
  const out: (Frac | null)[] = h.map(() => null);
  if (h.length <= p) return out;
  let a = tr.slice(1, p + 1).reduce<Frac>((s, x) => s.add(x!), ZERO).div(F(p));
  out[p] = a;
  for (let t = p + 1; t < h.length; t++) {
    a = a.mul(F(p - 1)).add(tr[t]!).div(F(p));
    out[t] = a;
  }
  return out;
}

export function refAdx(h: Frac[], l: Frac[], c: Frac[], p: number): { plus: (Frac | null)[]; minus: (Frac | null)[]; dx: (Frac | null)[]; adx: (Frac | null)[] } {
  const n = h.length;
  const tr = refTr(h, l, c);
  const pdm: Frac[] = [ZERO];
  const mdm: Frac[] = [ZERO];
  for (let t = 1; t < n; t++) {
    const up = h[t]!.sub(h[t - 1]!);
    const down = l[t - 1]!.sub(l[t]!);
    pdm.push(up.cmp(down) > 0 && up.cmp(ZERO) > 0 ? up : ZERO);
    mdm.push(down.cmp(up) > 0 && down.cmp(ZERO) > 0 ? down : ZERO);
  }
  const plus: (Frac | null)[] = h.map(() => null);
  const minus: (Frac | null)[] = h.map(() => null);
  const dx: (Frac | null)[] = h.map(() => null);
  const adx: (Frac | null)[] = h.map(() => null);
  if (n <= p) return { plus, minus, dx, adx };
  let sTr = ZERO;
  let sP = ZERO;
  let sM = ZERO;
  for (let t = 1; t <= p; t++) {
    sTr = sTr.add(tr[t]!);
    sP = sP.add(pdm[t]!);
    sM = sM.add(mdm[t]!);
  }
  const P = F(p);
  for (let t = p; t < n; t++) {
    if (t > p) {
      sTr = sTr.sub(sTr.div(P)).add(tr[t]!);
      sP = sP.sub(sP.div(P)).add(pdm[t]!);
      sM = sM.sub(sM.div(P)).add(mdm[t]!);
    }
    const pd = sTr.isZero() ? ZERO : F(100).mul(sP).div(sTr);
    const md = sTr.isZero() ? ZERO : F(100).mul(sM).div(sTr);
    plus[t] = pd;
    minus[t] = md;
    dx[t] = pd.add(md).isZero() ? ZERO : F(100).mul(pd.sub(md).abs()).div(pd.add(md));
  }
  if (n > 2 * p - 1) {
    let a = ZERO;
    for (let t = p; t <= 2 * p - 1; t++) a = a.add(dx[t]!);
    a = a.div(P);
    adx[2 * p - 1] = a;
    for (let t = 2 * p; t < n; t++) {
      a = a.mul(F(p - 1)).add(dx[t]!).div(P);
      adx[t] = a;
    }
  }
  return { plus, minus, dx, adx };
}

/** Bollinger: exact mean and population variance; σ itself is irrational (compared via variance). */
export function refBollingerVariance(c: Frac[], p: number): Array<{ mean: Frac; variance: Frac } | null> {
  return c.map((_, i) => {
    if (i < p - 1) return null;
    let s = ZERO;
    for (let j = i - p + 1; j <= i; j++) s = s.add(c[j]!);
    const mean = s.div(F(p));
    let v = ZERO;
    for (let j = i - p + 1; j <= i; j++) {
      const d = c[j]!.sub(mean);
      v = v.add(d.mul(d));
    }
    return { mean, variance: v.div(F(p)) };
  });
}

export function refVwap(rows: Array<{ h: Frac; l: Frac; c: Frac; v: Frac; session: string }>): (Frac | null)[] {
  return rows.map((row, i) => {
    let pv = ZERO;
    let vol = ZERO;
    for (let j = 0; j <= i; j++) {
      if (rows[j]!.session !== row.session) continue;
      const tp = rows[j]!.h.add(rows[j]!.l).add(rows[j]!.c).div(F(3));
      pv = pv.add(tp.mul(rows[j]!.v));
      vol = vol.add(rows[j]!.v);
    }
    return vol.isZero() ? null : pv.div(vol);
  });
}
