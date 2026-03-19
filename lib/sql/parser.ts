import { Parser } from 'node-sql-parser';

const parser = new Parser();

export function parse(sql: string): any {
    const result = parser.astify(sql);
    // astify returns a single AST or an array for multi-statement
    if (Array.isArray(result)) {
        if (result.length !== 1) throw new Error('Multi-statement SQL not supported');
        return result[0];
    }
    return result;
}
