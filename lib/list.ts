import { Vector } from './vector';
import { Atom } from './atom';
import type { Context } from './context';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class List {
    /** @internal */
    constructor(public readonly _native: any) {}

    static newSync(ctx: Context, capacity: number): List {
        return new List(addon.NativeList.newSync((ctx as any)._native, capacity));
    }

    append(item: Vector | Atom | List): List {
        return new List(this._native.append(item._native));
    }

    get(index: number): Vector | Atom | List | null {
        const result = this._native.get(index);
        if (result == null) return null;
        const name = result.constructor?.name;
        if (name === 'NativeList') return new List(result);
        if (name === 'NativeAtom') return new Atom(result);
        if (name === 'NativeVector') return new Vector(result);
        return null;
    }

    set(index: number, item: Vector | Atom | List): void {
        this._native.set(index, item._native);
    }

    get length(): number {
        return this._native.length;
    }

    get type(): string {
        return this._native.type;
    }

    [Symbol.dispose](): void {
        /* release handled by GC */
    }
}
