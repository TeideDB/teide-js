import { Table } from './table';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export interface RelFromEdgesOpts {
    nSrc: number;
    nDst: number;
    sort?: boolean;
}

export interface RelBuildOpts {
    nTargetNodes: number;
    sort?: boolean;
}

export class Rel implements Disposable {
    /** @internal */
    readonly _native: any;
    private _destroyed = false;

    /** @internal */
    constructor(nativeRel: any) {
        this._native = nativeRel;
    }

    static fromEdgesSync(edgeTable: Table, srcCol: string, dstCol: string, opts: RelFromEdgesOpts): Rel {
        const native = addon.NativeRel.fromEdgesSync(
            edgeTable._native, srcCol, dstCol, opts.nSrc, opts.nDst, opts.sort ?? false
        );
        return new Rel(native);
    }

    static async fromEdges(edgeTable: Table, srcCol: string, dstCol: string, opts: RelFromEdgesOpts): Promise<Rel> {
        const native = await addon.NativeRel.fromEdges(
            edgeTable._native, srcCol, dstCol, opts.nSrc, opts.nDst, opts.sort ?? false
        );
        return new Rel(native);
    }

    static buildSync(table: Table, fkCol: string, opts: RelBuildOpts): Rel {
        const native = addon.NativeRel.buildSync(
            table._native, fkCol, opts.nTargetNodes, opts.sort ?? false
        );
        return new Rel(native);
    }

    static async build(table: Table, fkCol: string, opts: RelBuildOpts): Promise<Rel> {
        const native = await addon.NativeRel.build(
            table._native, fkCol, opts.nTargetNodes, opts.sort ?? false
        );
        return new Rel(native);
    }

    static loadSync(ctx: { _threadExternal: any }, dir: string): Rel {
        const native = addon.NativeRel.loadSync(dir, ctx._threadExternal);
        return new Rel(native);
    }

    static async load(ctx: { _threadExternal: any }, dir: string): Promise<Rel> {
        const native = await addon.NativeRel.load(dir, ctx._threadExternal);
        return new Rel(native);
    }

    static mmapSync(ctx: { _threadExternal: any }, dir: string): Rel {
        const native = addon.NativeRel.mmapSync(dir, ctx._threadExternal);
        return new Rel(native);
    }

    saveSync(dir: string): void {
        this._checkAlive();
        this._native.saveSync(dir);
    }

    async save(dir: string): Promise<void> {
        this._checkAlive();
        await this._native.save(dir);
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
        if (this._destroyed) throw new Error('Rel has been destroyed');
    }
}
