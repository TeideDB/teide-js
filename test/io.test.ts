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

  it('readCsvSync with delimiter option', () => {
    const ctx = new Context();
    const tsvPath = path.join(os.tmpdir(), `teide-test-${Date.now()}.tsv`);
    fs.writeFileSync(tsvPath, 'a\tb\n1\t2\n3\t4\n');
    try {
      const df = ctx.readCsvSync(tsvPath, { delimiter: '\t' });
      expect(df.nRows).toBe(2);
      expect(df.columns).toContain('a');
      expect(df.columns).toContain('b');
    } finally {
      ctx.destroy();
      if (fs.existsSync(tsvPath)) fs.unlinkSync(tsvPath);
    }
  });

  it('readCsv async with delimiter option', async () => {
    const ctx = new Context();
    const tsvPath = path.join(os.tmpdir(), `teide-test-async-${Date.now()}.tsv`);
    fs.writeFileSync(tsvPath, 'x\ty\n10\t20\n30\t40\n');
    try {
      const df = await ctx.readCsv(tsvPath, { delimiter: '\t' });
      expect(df.nRows).toBe(2);
      expect(df.columns).toContain('x');
      expect(df.columns).toContain('y');
    } finally {
      ctx.destroy();
      if (fs.existsSync(tsvPath)) fs.unlinkSync(tsvPath);
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
