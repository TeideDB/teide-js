import { describe, it, expect } from 'vitest';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

describe('NativeContext', () => {
  it('creates and destroys without error', () => {
    const ctx = new addon.NativeContext();
    ctx.destroy();
  });

  it('throws after destroy', () => {
    const ctx = new addon.NativeContext();
    ctx.destroy();
    expect(() => ctx.readCsvSync('nonexistent.csv')).toThrow('destroyed');
  });

  it('reads CSV sync and returns external', () => {
    const ctx = new addon.NativeContext();
    try {
      const result = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(result).toBeDefined();
    } finally {
      ctx.destroy();
    }
  });

  it('reads CSV async', async () => {
    const ctx = new addon.NativeContext();
    try {
      const result = await ctx.readCsv(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(result).toBeDefined();
    } finally {
      ctx.destroy();
    }
  });
});
