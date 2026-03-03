import { Expr } from './expr';
import { Table, GroupBy } from './table';
import { WindowOpts, WindowJoinOpts } from './types';
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

    tail(n: number): Query {
        this._ops.push({ type: 'tail', n });
        return this;
    }

    distinct(...cols: string[]): Query {
        this._ops.push({ type: 'distinct', cols });
        return this;
    }

    select(...cols: string[]): Query {
        this._ops.push({ type: 'select', cols });
        return this;
    }

    project(...exprs: Expr[]): Query {
        this._ops.push({ type: 'project', exprs });
        return this;
    }

    window(opts: WindowOpts): Query {
        this._ops.push({ type: 'window', ...opts });
        return this;
    }

    join(other: Table, opts: {
        on?: string | string[];
        leftOn?: string | string[];
        rightOn?: string | string[];
        how?: 'inner' | 'left' | 'full';
    }): Query {
        const how = opts.how ?? 'inner';
        let leftKeys: string[];
        let rightKeys: string[];
        if (opts.on) {
            const keys = Array.isArray(opts.on) ? opts.on : [opts.on];
            leftKeys = keys;
            rightKeys = keys;
        } else {
            leftKeys = Array.isArray(opts.leftOn!) ? opts.leftOn! : [opts.leftOn!];
            rightKeys = Array.isArray(opts.rightOn!) ? opts.rightOn! : [opts.rightOn!];
            if (leftKeys.length !== rightKeys.length) {
                throw new Error(`join leftOn and rightOn must have the same number of keys (got ${leftKeys.length} vs ${rightKeys.length})`);
            }
        }
        this._ops.push({
            type: 'join',
            rightTable: other._native,
            leftKeys,
            rightKeys,
            joinType: how === 'inner' ? 0 : how === 'left' ? 1 : 2,
        });
        return this;
    }

    windowJoin(other: Table, opts: WindowJoinOpts): Query {
        this._ops.push({
            type: 'windowJoin',
            rightTable: other._native,
            timeKey: opts.timeKey,
            symKey: opts.symKey,
            windowLo: opts.windowLo,
            windowHi: opts.windowHi,
            aggs: opts.aggs,
        });
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
