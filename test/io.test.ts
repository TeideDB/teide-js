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

  it('save and load splayed table', () => {
    const ctx = new Context();
    const dir = path.join(os.tmpdir(), `teide-splay-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const df = ctx.readCsvSync(SMALL);
      ctx.saveTableSync(df, dir);
      const loaded = ctx.loadTableSync(dir);
      expect(loaded.nRows).toBe(3);
      expect(loaded.columns).toContain('name');
    } finally {
      ctx.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('save and load column', () => {
    const ctx = new Context();
    const colPath = path.join(os.tmpdir(), `teide-col-${Date.now()}.td`);
    try {
      const df = ctx.readCsvSync(SMALL);
      const series = df.col('value');
      series.saveColSync(colPath);
      expect(fs.existsSync(colPath)).toBe(true);
      const loaded = ctx.loadColSync(colPath);
      expect(loaded.length).toBe(series.length);
      expect(loaded.dtype).toBe(series.dtype);
    } finally {
      ctx.destroy();
      if (fs.existsSync(colPath)) fs.unlinkSync(colPath);
    }
  });

  it('save and mmap column', () => {
    const ctx = new Context();
    const colPath = path.join(os.tmpdir(), `teide-col-mmap-${Date.now()}.td`);
    try {
      const df = ctx.readCsvSync(SMALL);
      const series = df.col('value');
      series.saveColSync(colPath);
      expect(fs.existsSync(colPath)).toBe(true);
      const mmapped = ctx.mmapColSync(colPath);
      expect(mmapped.length).toBe(series.length);
      expect(mmapped.dtype).toBe(series.dtype);
    } finally {
      ctx.destroy();
      if (fs.existsSync(colPath)) fs.unlinkSync(colPath);
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
