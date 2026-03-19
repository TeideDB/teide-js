import { Table } from './table';
import { Session } from './sql/session';
import { planAndExecuteSync, planAndExecute } from './sql/planner';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Context {
    private _native: any;
    private _destroyed = false;
    private _session = new Session();

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

    registerTable(name: string, table: Table): void {
        this._checkAlive();
        this._session.register(name, table);
    }

    executeSync(sql: string): Table | null {
        this._checkAlive();
        return planAndExecuteSync(sql, this._session, this._native);
    }

    async execute(sql: string): Promise<Table | null> {
        this._checkAlive();
        return planAndExecute(sql, this._session, this._native);
    }

    destroy(): void {
        if (!this._destroyed) {
            this._session.clear();
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
