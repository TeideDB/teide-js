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

  it('readPartedSync loads a partitioned table', () => {
    const ctx = new Context();
    const dbRoot = path.join(os.tmpdir(), `teide-parted-${Date.now()}`);
    const splayTmp = path.join(os.tmpdir(), `teide-splay-tmp-${Date.now()}`);
    fs.mkdirSync(splayTmp, { recursive: true });
    try {
      // Save a splayed table to get column files and sym
      const df = ctx.readCsvSync(SMALL);
      ctx.saveTableSync(df, splayTmp);

      // Create partitioned structure: dbRoot/2024.01.01/data/
      const partDir = path.join(dbRoot, '2024.01.01', 'data');
      fs.mkdirSync(partDir, { recursive: true });

      // Move column files into partition dir, sym to dbRoot/sym
      const files = fs.readdirSync(splayTmp);
      for (const f of files) {
        if (f === '.sym') {
          fs.copyFileSync(path.join(splayTmp, f), path.join(dbRoot, 'sym'));
        } else {
          fs.copyFileSync(path.join(splayTmp, f), path.join(partDir, f));
        }
      }

      // Load as partitioned table
      const loaded = ctx.readPartedSync(dbRoot, 'data');
      expect(loaded.nRows).toBe(3);
      expect(loaded.columns).toContain('id');
      expect(loaded.columns).toContain('name');
      expect(loaded.columns).toContain('value');
    } finally {
      ctx.destroy();
      fs.rmSync(dbRoot, { recursive: true, force: true });
      fs.rmSync(splayTmp, { recursive: true, force: true });
    }
  });

  it('readParted loads a partitioned table async', async () => {
    const ctx = new Context();
    const dbRoot = path.join(os.tmpdir(), `teide-parted-async-${Date.now()}`);
    const splayTmp = path.join(os.tmpdir(), `teide-splay-tmp-async-${Date.now()}`);
    fs.mkdirSync(splayTmp, { recursive: true });
    try {
      const df = ctx.readCsvSync(SMALL);
      ctx.saveTableSync(df, splayTmp);

      const partDir = path.join(dbRoot, '2024.01.01', 'data');
      fs.mkdirSync(partDir, { recursive: true });

      const files = fs.readdirSync(splayTmp);
      for (const f of files) {
        if (f === '.sym') {
          fs.copyFileSync(path.join(splayTmp, f), path.join(dbRoot, 'sym'));
        } else {
          fs.copyFileSync(path.join(splayTmp, f), path.join(partDir, f));
        }
      }

      const loaded = await ctx.readParted(dbRoot, 'data');
      expect(loaded.nRows).toBe(3);
      expect(loaded.columns).toContain('id');
    } finally {
      ctx.destroy();
      fs.rmSync(dbRoot, { recursive: true, force: true });
      fs.rmSync(splayTmp, { recursive: true, force: true });
    }
  });

  it('saveSymbolsSync and loadSymbolsSync round-trip', () => {
    const ctx = new Context();
    const symPath = path.join(os.tmpdir(), `teide-sym-${Date.now()}.sym`);
    try {
      // Load a CSV to populate the symbol table
      ctx.readCsvSync(SMALL);
      ctx.saveSymbolsSync(symPath);
      expect(fs.existsSync(symPath)).toBe(true);

      // Create a new context and load the symbols
      const ctx2 = new Context();
      try {
        ctx2.loadSymbolsSync(symPath);
        // If we get here without error, the load worked
      } finally {
        ctx2.destroy();
      }
    } finally {
      ctx.destroy();
      if (fs.existsSync(symPath)) fs.unlinkSync(symPath);
    }
  });

  it('saveSymbols and loadSymbols async round-trip', async () => {
    const ctx = new Context();
    const symPath = path.join(os.tmpdir(), `teide-sym-async-${Date.now()}.sym`);
    try {
      ctx.readCsvSync(SMALL);
      await ctx.saveSymbols(symPath);
      expect(fs.existsSync(symPath)).toBe(true);

      const ctx2 = new Context();
      try {
        await ctx2.loadSymbols(symPath);
      } finally {
        ctx2.destroy();
      }
    } finally {
      ctx.destroy();
      if (fs.existsSync(symPath)) fs.unlinkSync(symPath);
    }
  });

  it('saveMetaSync and loadMetaSync round-trip', () => {
    const ctx = new Context();
    const metaPath = path.join(os.tmpdir(), `teide-meta-${Date.now()}.meta`);
    try {
      const df = ctx.readCsvSync(SMALL);
      ctx.saveMetaSync(df, metaPath);
      expect(fs.existsSync(metaPath)).toBe(true);

      const schema = ctx.loadMetaSync(metaPath);
      // Schema is an I64 vector of column name symbol IDs
      expect(schema.length).toBe(df.nCols);
      expect(schema.dtype).toBe('i64');
    } finally {
      ctx.destroy();
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    }
  });

  it('saveMeta and loadMeta async round-trip', async () => {
    const ctx = new Context();
    const metaPath = path.join(os.tmpdir(), `teide-meta-async-${Date.now()}.meta`);
    try {
      const df = ctx.readCsvSync(SMALL);
      await ctx.saveMeta(df, metaPath);
      expect(fs.existsSync(metaPath)).toBe(true);

      const schema = await ctx.loadMeta(metaPath);
      expect(schema.length).toBe(df.nCols);
      expect(schema.dtype).toBe('i64');
    } finally {
      ctx.destroy();
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
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
