export interface Column {
    name: string;
    dtype: string;
}

export interface QueryMessage { type: 'query'; id: string; sql: string; }
export interface CompleteMessage { type: 'complete'; prefix: string; context: string; }
export interface DotMessage { type: 'dot'; command: string; }
export interface MetaMessage { type: 'meta'; }
export type ClientMessage = QueryMessage | CompleteMessage | DotMessage | MetaMessage;

export interface ResultMessage { type: 'result'; id: string; columns: Column[]; rows: (string | null)[][]; nrows: number; elapsed: number; }
export interface ErrorMessage { type: 'error'; id: string; message: string; }
export interface OkMessage { type: 'ok'; id: string; message: string; elapsed: number; }
export interface CompletionsMessage { type: 'completions'; items: { value: string; description: string }[]; }
export interface MetaResponseMessage { type: 'meta'; tables: { name: string; nrows: number; ncols: number; columns: Column[] }[]; history: string[]; }
export interface PrintMessage { type: 'print'; text: string; }
export type ServerMessage = ResultMessage | ErrorMessage | OkMessage | CompletionsMessage | MetaResponseMessage | PrintMessage;

const VALID_CLIENT_TYPES = new Set(['query', 'complete', 'dot', 'meta']);

export function parseClientMessage(raw: string): ClientMessage | null {
    try {
        const obj = JSON.parse(raw);
        if (!obj || !VALID_CLIENT_TYPES.has(obj.type)) return null;
        return obj as ClientMessage;
    } catch {
        return null;
    }
}
