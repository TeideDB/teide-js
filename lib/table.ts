import { Series } from './series';
import { Query } from './query';
import { Expr } from './expr';

export class Table {
    /** @internal */
    constructor(
        public readonly _native: any,
        private readonly _ctx: any,
    ) {}

    get nRows(): number { return this._native.nRows; }
    get nCols(): number { return this._native.nCols; }
    get columns(): string[] { return this._native.columns; }

    col(name: string): Series {
        return new Series(this._native.col(name));
    }

    filter(expr: Expr): Query {
        return new Query(this._native, this._ctx).filter(expr);
    }

    groupBy(...cols: string[]): GroupBy {
        return new Query(this._native, this._ctx).groupBy(...cols);
    }

    sort(col: string, opts?: { descending?: boolean }): Query {
        return new Query(this._native, this._ctx).sort(col, opts);
    }

    head(n: number): Query {
        return new Query(this._native, this._ctx).head(n);
    }
}

export class GroupBy {
    /** @internal */
    constructor(
        private readonly _query: Query,
        private readonly _keys: string[],
    ) {}

    agg(...exprs: Expr[]): Query {
        return this._query._addGroupOp(this._keys, exprs);
    }
}
