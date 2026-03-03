import { Table } from './table';
import { Graph } from './graph';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Context {
    private _native: any;
    private _destroyed = false;

    constructor() {
        this._native = new addon.NativeContext();
    }

    readCsvSync(filePath: string): Table {
        this._checkAlive();
        return new Table(this._native.readCsvSync(filePath), this._native);
    }

    async readCsv(filePath: string): Promise<Table> {
        this._checkAlive();
        const nativeTable = await this._native.readCsv(filePath);
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
