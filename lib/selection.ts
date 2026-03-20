import { Vector } from './vector';
import type { Context } from './context';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Selection {
    /** @internal */
    constructor(public readonly _native: any) {}

    static newSync(ctx: Context, nrows: number): Selection {
        return new Selection(addon.NativeSelection.newSync((ctx as any)._native, nrows));
    }

    static fromPredSync(boolVec: Vector): Selection {
        return new Selection(addon.NativeSelection.fromPredSync(boolVec._native));
    }

    and(other: Selection): Selection {
        return new Selection(this._native.and_(other._native));
    }

    recompute(): void {
        this._native.recompute();
    }

    get nRows(): number {
        return this._native.nRows;
    }

    get type(): string {
        return this._native.type;
    }

    [Symbol.dispose](): void {
        /* release handled by GC */
    }
}
