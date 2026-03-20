import { Table } from './table';
import { Series } from './series';
import { Graph } from './graph';
import { Session } from './sql/session';
import { planAndExecuteSync, planAndExecute } from './sql/planner';
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
    private _session = new Session();

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

    loadColSync(filePath: string): Series {
        this._checkAlive();
        return new Series(this._native.loadColSync(filePath));
    }

    mmapColSync(filePath: string): Series {
        this._checkAlive();
        return new Series(this._native.mmapColSync(filePath));
    }

    readPartedSync(dbRoot: string, tableName: string): Table {
        this._checkAlive();
        return new Table(this._native.readPartedSync(dbRoot, tableName), this._native);
    }

    async readParted(dbRoot: string, tableName: string): Promise<Table> {
        this._checkAlive();
        const nativeTable = await this._native.readParted(dbRoot, tableName);
        return new Table(nativeTable, this._native);
    }

    saveSymbolsSync(filePath: string): void {
        this._checkAlive();
        this._native.saveSymbolsSync(filePath);
    }

    async saveSymbols(filePath: string): Promise<void> {
        this._checkAlive();
        await this._native.saveSymbols(filePath);
    }

    loadSymbolsSync(filePath: string): void {
        this._checkAlive();
        this._native.loadSymbolsSync(filePath);
    }

    async loadSymbols(filePath: string): Promise<void> {
        this._checkAlive();
        await this._native.loadSymbols(filePath);
    }

    saveMetaSync(table: Table, filePath: string): void {
        this._checkAlive();
        this._native.saveMetaSync(table._native, filePath);
    }

    async saveMeta(table: Table, filePath: string): Promise<void> {
        this._checkAlive();
        await this._native.saveMeta(table._native, filePath);
    }

    loadMetaSync(filePath: string): Series {
        this._checkAlive();
        return new Series(this._native.loadMetaSync(filePath));
    }

    async loadMeta(filePath: string): Promise<Series> {
        this._checkAlive();
        const nativeSeries = await this._native.loadMeta(filePath);
        return new Series(nativeSeries);
    }

    symIntern(str: string): number {
        this._checkAlive();
        return this._native.symIntern(str);
    }

    symFind(str: string): number {
        this._checkAlive();
        return this._native.symFind(str);
    }

    symStr(id: number): string | null {
        this._checkAlive();
        return this._native.symStr(id);
    }

    symCount(): number {
        this._checkAlive();
        return this._native.symCount();
    }

    get _threadExternal(): any { return this._native.threadExternal; }

    graph(table: Table): Graph {
        this._checkAlive();
        return new Graph(table, this._native);
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
