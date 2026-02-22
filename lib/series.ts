export class Series {
    /** @internal */
    constructor(private readonly _native: any) {}

    get dtype(): string {
        const d = this._native.dtype;
        // Map numeric dtype codes to human-readable strings
        // Values from vendor/teide/include/teide/td.h
        const map: Record<number, string> = {
            1: 'bool',       // TD_BOOL
            2: 'u8',         // TD_U8
            3: 'char',       // TD_CHAR
            4: 'i16',        // TD_I16
            5: 'i32',        // TD_I32
            6: 'i64',        // TD_I64
            7: 'f64',        // TD_F64
            9: 'date',       // TD_DATE
            10: 'time',      // TD_TIME
            11: 'timestamp', // TD_TIMESTAMP
            12: 'guid',      // TD_GUID
            20: 'sym',       // TD_SYM
        };
        return map[d] ?? `unknown(${d})`;
    }
    get length(): number { return this._native.length; }
    get name(): string { return this._native.name; }
    get data(): Float64Array | BigInt64Array | Int32Array | Int16Array | Uint8Array {
        return this._native.data;
    }
    get nullBitmap(): Uint8Array | null { return this._native.nullBitmap; }
    get indices(): Uint8Array | Uint16Array | Uint32Array { return this._native.indices; }
    get dictionary(): string[] { return this._native.dictionary; }
}
