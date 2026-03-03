import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Context, col } from '../lib';

const SMALL = path.join(__dirname, 'fixtures', 'small.csv');

describe('I/O operations', () => {
  it('writeCsvSync writes a CSV file', () => {
    const ctx = new Context();
    const outPath = path.join(os.tmpdir(), `teide-test-${Date.now()}.csv`);
    try {
      const df = ctx.readCsvSync(SMALL);
      ctx.writeCsvSync(df, outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      const content = fs.readFileSync(outPath, 'utf-8');
      expect(content).toContain('name');
      expect(content).toContain('alpha');
    } finally {
      ctx.destroy();
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });

  it('writeCsv writes async', async () => {
    const ctx = new Context();
    const outPath = path.join(os.tmpdir(), `teide-test-async-${Date.now()}.csv`);
    try {
      const df = await ctx.readCsv(SMALL);
      await ctx.writeCsv(df, outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      const content = fs.readFileSync(outPath, 'utf-8');
      expect(content).toContain('name');
      expect(content).toContain('alpha');
    } finally {
      ctx.destroy();
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });
});
