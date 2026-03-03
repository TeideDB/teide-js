import { Table } from './table';
import { Rel } from './rel';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export type Direction = 'fwd' | 'rev' | 'both';

export interface VarExpandOpts {
    minDepth?: number;
    maxDepth?: number;
    trackPath?: boolean;
}

export interface ShortestPathOpts {
    maxDepth?: number;
}

export interface WcoJoinOpts {
    nVars: number;
}

const DIR_MAP: Record<Direction, number> = { fwd: 0, rev: 1, both: 2 };

export class Graph {
    private readonly _table: Table;
    private readonly _ctx: any;

    constructor(table: Table, ctx: any) {
        this._table = table;
        this._ctx = ctx;
    }

    expandSync(srcCol: string, rel: Rel, direction: Direction = 'fwd'): Table {
        rel._checkAlive();
        const native = addon.graphExpandSync(
            this._table._native, srcCol, rel._native, DIR_MAP[direction]
        );
        return new Table(native, this._ctx);
    }

    async expand(srcCol: string, rel: Rel, direction: Direction = 'fwd'): Promise<Table> {
        rel._checkAlive();
        const native = await addon.graphExpand(
            this._table._native, srcCol, rel._native, DIR_MAP[direction]
        );
        return new Table(native, this._ctx);
    }

    varExpandSync(startCol: string, rel: Rel, direction: Direction = 'fwd', opts?: VarExpandOpts): Table {
        rel._checkAlive();
        const native = addon.graphVarExpandSync(
            this._table._native, startCol, rel._native, DIR_MAP[direction],
            opts?.minDepth ?? 1, opts?.maxDepth ?? 3, opts?.trackPath ?? false
        );
        return new Table(native, this._ctx);
    }

    async varExpand(startCol: string, rel: Rel, direction: Direction = 'fwd', opts?: VarExpandOpts): Promise<Table> {
        rel._checkAlive();
        const native = await addon.graphVarExpand(
            this._table._native, startCol, rel._native, DIR_MAP[direction],
            opts?.minDepth ?? 1, opts?.maxDepth ?? 3, opts?.trackPath ?? false
        );
        return new Table(native, this._ctx);
    }

    shortestPathSync(src: number, dst: number, rel: Rel, opts?: ShortestPathOpts): Table {
        rel._checkAlive();
        const native = addon.graphShortestPathSync(
            this._table._native, src, dst, rel._native, opts?.maxDepth ?? 10
        );
        return new Table(native, this._ctx);
    }

    async shortestPath(src: number, dst: number, rel: Rel, opts?: ShortestPathOpts): Promise<Table> {
        rel._checkAlive();
        const native = await addon.graphShortestPath(
            this._table._native, src, dst, rel._native, opts?.maxDepth ?? 10
        );
        return new Table(native, this._ctx);
    }

    wcoJoinSync(rels: Rel[], opts: WcoJoinOpts): Table {
        rels.forEach(r => r._checkAlive());
        const native = addon.graphWcoJoinSync(
            this._table._native, rels.map(r => r._native), opts.nVars
        );
        return new Table(native, this._ctx);
    }

    async wcoJoin(rels: Rel[], opts: WcoJoinOpts): Promise<Table> {
        rels.forEach(r => r._checkAlive());
        const native = await addon.graphWcoJoin(
            this._table._native, rels.map(r => r._native), opts.nVars
        );
        return new Table(native, this._ctx);
    }
}
