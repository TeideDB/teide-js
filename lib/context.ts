import { Table } from './table';
import { Graph } from './graph';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export interface CsvReadOpts {
    delimiter?: string;
    header?: boolean;
    columnTypes?: string[];
}

export class Context {
    private _native: any;
    private _destroyed = false;

    constructor() {
        this._native = new addon.NativeContext();
    }

    readCsvSync(filePath: string, opts?: CsvReadOpts): Table {
        this._checkAlive();
        return new Table(
            opts ? this._native.readCsvSync(filePath, opts) : this._native.readCsvSync(filePath),
            this._native
        );
    }

    async readCsv(filePath: string, opts?: CsvReadOpts): Promise<Table> {
        this._checkAlive();
        const nativeTable = opts
            ? await this._native.readCsv(filePath, opts)
            : await this._native.readCsv(filePath);
        return new Table(nativeTable, this._native);
    }

    writeCsvSync(table: Table, filePath: string): void {
        this._checkAlive();
        this._native.writeCsvSync(table._native, filePath);
    }

    async writeCsv(table: Table, filePath: string): Promise<void> {
        this._checkAlive();
        await this._native.writeCsv(table._native, filePath);
    }

    saveTableSync(table: Table, dir: string): void {
        this._checkAlive();
        this._native.saveTableSync(table._native, dir);
    }

    loadTableSync(dir: string): Table {
        this._checkAlive();
        return new Table(this._native.loadTableSync(dir), this._native);
    }

    get _threadExternal(): any { return this._native.threadExternal; }

    graph(table: Table): Graph {
        this._checkAlive();
        return new Graph(table, this._native);
    }

    destroy(): void {
        if (!this._destroyed) {
            this._native.destroy();
            this._destroyed = true;
        }
    }

    [Symbol.dispose](): void {
        this.destroy();
    }

    private _checkAlive(): void {
        if (this._destroyed) throw new Error('Context has been destroyed');
    }
}
