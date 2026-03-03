import type { Context } from './context';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Atom {
    /** @internal */
    constructor(public readonly _native: any) {}

    static bool(ctx: Context, value: boolean): Atom {
        return new Atom(addon.NativeAtom.bool((ctx as any)._native, value));
    }

    static u8(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.u8((ctx as any)._native, value));
    }

    static i16(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.i16((ctx as any)._native, value));
    }

    static i32(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.i32((ctx as any)._native, value));
    }

    static i64(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.i64((ctx as any)._native, value));
    }

    static f64(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.f64((ctx as any)._native, value));
    }

    static str(ctx: Context, value: string): Atom {
        return new Atom(addon.NativeAtom.str((ctx as any)._native, value));
    }

    static sym(ctx: Context, id: number): Atom {
        return new Atom(addon.NativeAtom.sym((ctx as any)._native, id));
    }

    static date(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.date((ctx as any)._native, value));
    }

    static time(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.time((ctx as any)._native, value));
    }

    static timestamp(ctx: Context, value: number): Atom {
        return new Atom(addon.NativeAtom.timestamp((ctx as any)._native, value));
    }

    static guid(ctx: Context, bytes: Uint8Array): Atom {
        return new Atom(addon.NativeAtom.guid((ctx as any)._native, bytes));
    }

    get value(): boolean | number | bigint | string | Uint8Array | null {
        return this._native.value;
    }

    get type(): string {
        return this._native.type;
    }

    [Symbol.dispose](): void {
        /* release handled by GC */
    }
}
