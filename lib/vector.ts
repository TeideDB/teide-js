import type { Context } from './context';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Vector {
    /** @internal */
    constructor(public readonly _native: any) {}

    static newSync(ctx: Context, type: string, capacity: number): Vector {
        return new Vector(addon.NativeVector.newSync((ctx as any)._native, type, capacity));
    }

    static fromRawSync(ctx: Context, type: string, data: ArrayBufferView): Vector {
        return new Vector(addon.NativeVector.fromRawSync((ctx as any)._native, type, data));
    }

    append(value: number | bigint | boolean): Vector {
        return new Vector(this._native.append(value));
    }

    set(index: number, value: number | bigint | boolean): void {
        this._native.set(index, value);
    }

    get(index: number): number | bigint | boolean | null {
        return this._native.get(index);
    }

    slice(offset: number, length: number): Vector {
        return new Vector(this._native.slice(offset, length));
    }

    concat(other: Vector): Vector {
        return new Vector(this._native.concat(other._native));
    }

    setNull(index: number, isNull: boolean): void {
        this._native.setNull(index, isNull);
    }

    isNull(index: number): boolean {
        return this._native.isNull(index);
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
