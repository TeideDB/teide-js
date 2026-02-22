import { Table } from './table';
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
