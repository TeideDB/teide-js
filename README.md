# TeideDB

Zero-copy Node.js bindings for the Teide columnar dataframe engine.

## Features

- Zero-copy Node.js NAPI bindings for the Teide columnar engine
- Full SQL engine (SELECT, JOIN, GROUP BY, window functions, CTEs, set operations)
- Graph pattern matching with SQL/PGQ
- Vector similarity search with HNSW indexes
- Browser-based SQL console (Web REPL)
- Fluent TypeScript API for programmatic access

## Quick Start

```bash
git clone https://github.com/TeideDB/teide-js.git
cd teide-js
npm install
npm run build
```

### Web REPL

```bash
node bin/teide.js
```

Opens a browser-based SQL console at http://127.0.0.1:3141. Load CSV files with `.load`, query with SQL. Specify column types explicitly with `types` or `read_csv()`:

```
.load data.csv types i32,sym,f64
SELECT * FROM read_csv('data.csv', 'i32,sym,f64');
```

Valid types: `bool`, `u8`, `i16`, `i32`, `i64`, `f64`, `sym`, `date`, `time`, `timestamp`.

### Node.js API

```js
import { Context } from 'teidedb';

const ctx = new Context();
const table = ctx.readCsvSync('data.csv');
const result = ctx.executeSync('SELECT * FROM t WHERE price > 100');
console.log(result.columns, result.nRows);
ctx.destroy();
```

## Requirements

- Node.js >= 18
- CMake >= 3.15
- C17/C++17 compiler
- git

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Full build: native addon (debug) + TypeScript |
| `npm run build:native` | Native addon only (debug) |
| `npm run build:native:release` | Native addon with -O3 optimizations |
| `npm run build:ts` | TypeScript compilation only |
| `npm test` | Run all tests (vitest) |
| `npm run repl` | Start the Web REPL server |
| `npm run clean` | Remove build artifacts and vendored source |

## Documentation

https://teidedb.github.io/teide-js/

## License

MIT
