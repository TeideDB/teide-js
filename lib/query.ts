import { Expr } from './expr';
import { Table, GroupBy } from './table';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

interface Op {
    type: string;
    [key: string]: any;
}

export class Query {
    private _ops: Op[] = [];

    /** @internal */
    constructor(
        private readonly _nativeTable: any,
        private readonly _ctx: any,
    ) {}

    filter(expr: Expr): Query {
        this._ops.push({ type: 'filter', expr });
        return this;
    }

    groupBy(...cols: string[]): GroupBy {
        return new GroupBy(this, cols);
    }

    /** @internal */
    _addGroupOp(keys: string[], aggs: Expr[]): Query {
        this._ops.push({ type: 'group', keys, aggs });
        return this;
    }

    sort(col: string, opts?: { descending?: boolean }): Query {
        this._ops.push({
            type: 'sort',
            cols: [col],
            descs: [opts?.descending ?? false],
        });
        return this;
    }

    head(n: number): Query {
        this._ops.push({ type: 'head', n });
        return this;
    }

    collectSync(): Table {
        const result = addon.collectSync(this._nativeTable, this._ops);
        return new Table(result, this._ctx);
    }

    async collect(): Promise<Table> {
        const result = await addon.collect(this._nativeTable, this._ops);
        return new Table(result, this._ctx);
    }
}
