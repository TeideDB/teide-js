import { describe, it, expect } from 'vitest';
import { Context, Vector, Atom, List } from '../lib';

describe('Vector API', () => {
  it('creates and appends to a vector', () => {
    const ctx = new Context();
    try {
      let v = Vector.newSync(ctx, 'f64', 10);
      v = v.append(1.5);
      v = v.append(2.5);
      expect(v.length).toBe(2);
      expect(v.get(0)).toBeCloseTo(1.5);
    } finally {
      ctx.destroy();
    }
  });

  it('creates from raw TypedArray', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      expect(v.length).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('slice and concat', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3, 4, 5]));
      const s = v.slice(1, 3);
      expect(s.length).toBe(3);
      const v2 = Vector.fromRawSync(ctx, 'f64', new Float64Array([6, 7]));
      const merged = v.concat(v2);
      expect(merged.length).toBe(7);
    } finally {
      ctx.destroy();
    }
  });

  it('null handling', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      v.setNull(1, true);
      expect(v.isNull(1)).toBe(true);
      expect(v.isNull(0)).toBe(false);
    } finally {
      ctx.destroy();
    }
  });
});

describe('Atom API', () => {
  it('creates bool atom', () => {
    const ctx = new Context();
    try {
      const a = Atom.bool(ctx, true);
      expect(a.type).toBe('bool');
      expect(a.value).toBe(true);

      const b = Atom.bool(ctx, false);
      expect(b.value).toBe(false);
    } finally {
      ctx.destroy();
    }
  });

  it('creates numeric atoms (u8, i16, i32, f64)', () => {
    const ctx = new Context();
    try {
      const u = Atom.u8(ctx, 42);
      expect(u.type).toBe('u8');
      expect(u.value).toBe(42);

      const s = Atom.i16(ctx, -300);
      expect(s.type).toBe('i16');
      expect(s.value).toBe(-300);

      const i = Atom.i32(ctx, 100000);
      expect(i.type).toBe('i32');
      expect(i.value).toBe(100000);

      const f = Atom.f64(ctx, 3.14);
      expect(f.type).toBe('f64');
      expect(f.value).toBeCloseTo(3.14);
    } finally {
      ctx.destroy();
    }
  });

  it('creates i64 atom (returns bigint)', () => {
    const ctx = new Context();
    try {
      const a = Atom.i64(ctx, 9007199254740992);
      expect(a.type).toBe('i64');
      expect(a.value).toBe(BigInt('9007199254740992'));
    } finally {
      ctx.destroy();
    }
  });

  it('creates str atom', () => {
    const ctx = new Context();
    try {
      const a = Atom.str(ctx, 'hello');
      expect(a.type).toBe('str');
      expect(a.value).toBe('hello');
    } finally {
      ctx.destroy();
    }
  });

  it('creates sym atom', () => {
    const ctx = new Context();
    try {
      const a = Atom.sym(ctx, 0);
      expect(a.type).toBe('sym');
      expect(typeof a.value).toBe('bigint');
    } finally {
      ctx.destroy();
    }
  });

  it('creates date/time/timestamp atoms', () => {
    const ctx = new Context();
    try {
      const d = Atom.date(ctx, 20260101);
      expect(d.type).toBe('date');
      expect(typeof d.value).toBe('bigint');

      const t = Atom.time(ctx, 123456789);
      expect(t.type).toBe('time');
      expect(typeof t.value).toBe('bigint');

      const ts = Atom.timestamp(ctx, 1709510400000);
      expect(ts.type).toBe('timestamp');
      expect(typeof ts.value).toBe('bigint');
    } finally {
      ctx.destroy();
    }
  });

  it('creates guid atom', () => {
    const ctx = new Context();
    try {
      const bytes = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
      const a = Atom.guid(ctx, bytes);
      expect(a.type).toBe('guid');
      const val = a.value as Uint8Array;
      expect(val.length).toBe(16);
      expect(val[0]).toBe(1);
      expect(val[15]).toBe(16);
    } finally {
      ctx.destroy();
    }
  });
});

describe('List API', () => {
  it('creates an empty list', () => {
    const ctx = new Context();
    try {
      const list = List.newSync(ctx, 10);
      expect(list.length).toBe(0);
      expect(list.type).toBe('list');
    } finally {
      ctx.destroy();
    }
  });

  it('appends atoms and retrieves them', () => {
    const ctx = new Context();
    try {
      const a1 = Atom.f64(ctx, 42.0);
      const a2 = Atom.str(ctx, 'hello');

      let list = List.newSync(ctx, 10);
      list = list.append(a1);
      list = list.append(a2);
      expect(list.length).toBe(2);

      const item0 = list.get(0) as Atom;
      expect(item0).not.toBeNull();
      expect(item0.type).toBe('f64');
      expect(item0.value).toBeCloseTo(42.0);

      const item1 = list.get(1) as Atom;
      expect(item1.type).toBe('str');
      expect(item1.value).toBe('hello');
    } finally {
      ctx.destroy();
    }
  });

  it('appends vectors and retrieves them', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));

      let list = List.newSync(ctx, 10);
      list = list.append(v);
      expect(list.length).toBe(1);

      const item = list.get(0) as Vector;
      expect(item).not.toBeNull();
      expect(item.length).toBe(3);
      expect(item.get(0)).toBeCloseTo(1);
    } finally {
      ctx.destroy();
    }
  });

  it('set replaces an element', () => {
    const ctx = new Context();
    try {
      const a1 = Atom.i32(ctx, 10);
      const a2 = Atom.i32(ctx, 20);
      const a3 = Atom.str(ctx, 'replaced');

      let list = List.newSync(ctx, 10);
      list = list.append(a1);
      list = list.append(a2);

      list.set(0, a3);
      const item = list.get(0) as Atom;
      expect(item.type).toBe('str');
      expect(item.value).toBe('replaced');
    } finally {
      ctx.destroy();
    }
  });

  it('mixed types: vectors, atoms, and nested lists', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'i32', new Int32Array([10, 20]));
      const a = Atom.bool(ctx, true);
      let inner = List.newSync(ctx, 4);
      inner = inner.append(Atom.f64(ctx, 99.9));

      let list = List.newSync(ctx, 10);
      list = list.append(v);
      list = list.append(a);
      list = list.append(inner);
      expect(list.length).toBe(3);

      const r0 = list.get(0) as Vector;
      expect(r0.length).toBe(2);

      const r1 = list.get(1) as Atom;
      expect(r1.value).toBe(true);

      const r2 = list.get(2) as List;
      expect(r2.type).toBe('list');
      expect(r2.length).toBe(1);
    } finally {
      ctx.destroy();
    }
  });
});
