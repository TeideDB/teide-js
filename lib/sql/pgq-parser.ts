// PGQ (Property Graph Queries) pre-parser.
// Runs before node-sql-parser to intercept graph-specific SQL:
//   - CREATE [OR REPLACE] PROPERTY GRAPH [IF NOT EXISTS] ...
//   - DROP PROPERTY GRAPH [IF EXISTS] ...
//   - GRAPH_TABLE(...) in FROM clauses → rewritten to temp table refs

export interface PgqCreateGraph {
    type: 'create_property_graph';
    orReplace: boolean;
    ifNotExists: boolean;
    name: string;
    vertexTables: VertexTableDef[];
    edgeTables: EdgeTableDef[];
}

export interface PgqDropGraph {
    type: 'drop_property_graph';
    ifExists: boolean;
    name: string;
}

export interface VertexTableDef {
    table: string;
    keyColumn: string;
    label?: string;
    properties: PropertyVisibility;
}

export interface EdgeTableDef {
    table: string;
    sourceTable: string;
    sourceKeyColumn: string;
    destTable: string;
    destKeyColumn: string;
    label?: string;
    properties: PropertyVisibility;
}

export interface PropertyVisibility {
    mode: 'all' | 'only' | 'except' | 'none';
    columns?: string[];
}

export interface GraphTableRef {
    graphName: string;
    matchPattern: MatchPattern;
    columns: GraphTableColumn[];
}

export interface MatchPattern {
    elements: PatternElement[];
    pathMode?: 'walk' | 'any_shortest' | 'all_shortest';
    cost?: { variable: string; expression: string };
}

export interface PatternElement {
    type: 'node' | 'edge';
    variable?: string;
    labels?: string[];
    direction?: '->' | '<-' | '-' | '<->'; // edges only
    quantifier?: { min: number; max: number }; // {m,n}, +, *
}

export interface GraphTableColumn {
    expr: string;   // e.g. "n.name"
    variable: string;
    property: string;
    alias?: string;
}

export interface PgqCreateVectorIndex {
    type: 'create_vector_index';
    name: string;
    tableName: string;
    columnName: string;
    metric: 'cosine' | 'euclidean';
    m: number;
    efConstruction: number;
}

export interface PgqDropVectorIndex {
    type: 'drop_vector_index';
    name: string;
    ifExists: boolean;
}

export type PgqResult =
    | PgqCreateGraph
    | PgqDropGraph
    | PgqCreateVectorIndex
    | PgqDropVectorIndex
    | { type: 'graph_table_rewrite'; original: string; rewritten: string; graphTableRefs: GraphTableRef[]; graphTableAliases: string[] }
    | null; // null = not PGQ syntax, pass through to SQL parser

// Tokenizer
class Lexer {
    private tokens: Token[] = [];
    private idx = 0;

    constructor(private input: string) {
        this.tokenize();
    }

    private tokenize(): void {
        let i = 0;
        const s = this.input;
        while (i < s.length) {
            // Skip whitespace
            if (/\s/.test(s[i])) { i++; continue; }

            // Skip block comments: /* ... */
            if (s[i] === '/' && s[i + 1] === '*') {
                i += 2;
                while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
                if (i < s.length) i += 2; // skip closing */
                continue;
            }

            // Skip line comments: -- ...
            if (s[i] === '-' && s[i + 1] === '-') {
                i += 2;
                while (i < s.length && s[i] !== '\n') i++;
                continue;
            }

            // Parentheses and punctuation
            if ('(),.:{}|'.includes(s[i])) {
                this.tokens.push({ type: 'punct', value: s[i] });
                i++;
                continue;
            }

            // Arrow operators
            if (s[i] === '-' && s[i + 1] === '>') {
                this.tokens.push({ type: 'punct', value: '->' });
                i += 2;
                continue;
            }
            if (s[i] === '<' && s[i + 1] === '-' && s[i + 2] === '>') {
                this.tokens.push({ type: 'punct', value: '<->' });
                i += 3;
                continue;
            }
            if (s[i] === '<' && s[i + 1] === '-') {
                this.tokens.push({ type: 'punct', value: '<-' });
                i += 2;
                continue;
            }

            // Dash (undirected edge)
            if (s[i] === '-') {
                this.tokens.push({ type: 'punct', value: '-' });
                i++;
                continue;
            }

            // Numbers
            if (/\d/.test(s[i])) {
                let num = '';
                while (i < s.length && /\d/.test(s[i])) { num += s[i]; i++; }
                this.tokens.push({ type: 'number', value: num });
                continue;
            }

            // Quantifiers: +, *
            if (s[i] === '+' || s[i] === '*') {
                this.tokens.push({ type: 'punct', value: s[i] });
                i++;
                continue;
            }

            // Quoted identifier (handles "" escape for embedded double quotes)
            if (s[i] === '"') {
                let ident = '';
                i++; // skip opening quote
                while (i < s.length) {
                    if (s[i] === '"') {
                        if (i + 1 < s.length && s[i + 1] === '"') {
                            ident += '"'; // escaped double quote
                            i += 2;
                        } else {
                            break; // end of identifier
                        }
                    } else {
                        ident += s[i];
                        i++;
                    }
                }
                if (i >= s.length) throw new Error('Unterminated quoted identifier in PGQ SQL');
                i++; // skip closing quote
                this.tokens.push({ type: 'ident', value: ident });
                continue;
            }

            // Single-quoted string (handles '' escape for embedded single quotes)
            if (s[i] === "'") {
                let str = '';
                i++;
                while (i < s.length) {
                    if (s[i] === "'") {
                        if (i + 1 < s.length && s[i + 1] === "'") {
                            str += "'"; // escaped single quote
                            i += 2;
                        } else {
                            break; // end of string
                        }
                    } else {
                        str += s[i];
                        i++;
                    }
                }
                if (i >= s.length) throw new Error('Unterminated string literal in PGQ SQL');
                i++;
                this.tokens.push({ type: 'string', value: str });
                continue;
            }

            // Identifiers and keywords
            if (/[a-zA-Z_]/.test(s[i])) {
                let word = '';
                while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) { word += s[i]; i++; }
                this.tokens.push({ type: 'ident', value: word });
                continue;
            }

            // Comparison operators
            if ('>=<'.includes(s[i])) {
                this.tokens.push({ type: 'punct', value: s[i] });
                i++;
                continue;
            }

            throw new Error(`Unexpected character in PGQ SQL: '${s[i]}' at position ${i}`);
        }
    }

    peek(): Token | null {
        return this.idx < this.tokens.length ? this.tokens[this.idx] : null;
    }

    next(): Token | null {
        return this.idx < this.tokens.length ? this.tokens[this.idx++] : null;
    }

    expect(value: string): Token {
        const t = this.next();
        if (!t || t.value.toUpperCase() !== value.toUpperCase()) {
            throw new Error(`Expected '${value}', got '${t?.value ?? 'EOF'}'`);
        }
        return t;
    }

    matchKeyword(keyword: string): boolean {
        const t = this.peek();
        if (t && t.type === 'ident' && t.value.toUpperCase() === keyword.toUpperCase()) {
            this.idx++;
            return true;
        }
        return false;
    }

    matchPunct(value: string): boolean {
        const t = this.peek();
        if (t && t.type === 'punct' && t.value === value) {
            this.idx++;
            return true;
        }
        return false;
    }

    readIdent(): string {
        const t = this.next();
        if (!t || (t.type !== 'ident' && t.type !== 'string')) {
            throw new Error(`Expected identifier, got '${t?.value ?? 'EOF'}'`);
        }
        return t.value;
    }

    readNumber(): number {
        const t = this.next();
        if (!t || t.type !== 'number') {
            throw new Error(`Expected number, got '${t?.value ?? 'EOF'}'`);
        }
        return parseInt(t.value, 10);
    }

    done(): boolean {
        return this.idx >= this.tokens.length;
    }

    remaining(): string {
        return this.tokens.slice(this.idx).map(t => t.value).join(' ');
    }
}

interface Token {
    type: 'ident' | 'number' | 'string' | 'punct';
    value: string;
}

// Detect and parse PGQ statements.
// Returns null if the SQL is not PGQ syntax.
// Strip string literals and SQL comments from text so keyword detection
// (e.g. GRAPH_TABLE, CREATE PROPERTY GRAPH) doesn't match inside them.
// Uses a single-pass regex so that comment markers inside quoted strings
// are not mistakenly treated as comments.
function stripLiteralsAndComments(s: string): string {
    return s.replace(
        /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
        (match) => {
            // Preserve quoted strings as empty (already stripped),
            // remove comments entirely
            if (match.startsWith("'") || match.startsWith('"')) return '';
            return ''; // comments
        }
    );
}

// Strip leading SQL comments (block and line) so that keyword detection
// works even when the statement starts with a comment.
function stripLeadingComments(s: string): string {
    let result = s;
    while (true) {
        result = result.trimStart();
        if (result.startsWith('--')) {
            const nl = result.indexOf('\n');
            result = nl === -1 ? '' : result.slice(nl + 1);
        } else if (result.startsWith('/*')) {
            const end = result.indexOf('*/');
            result = end === -1 ? '' : result.slice(end + 2);
        } else {
            break;
        }
    }
    return result;
}

export function parsePgq(sql: string): PgqResult {
    const trimmed = stripLeadingComments(sql.trim());
    const upper = trimmed.toUpperCase();

    // CREATE [OR REPLACE] PROPERTY GRAPH or CREATE VECTOR INDEX
    if (upper.startsWith('CREATE')) {
        const lex = new Lexer(trimmed);
        lex.expect('CREATE');

        // CREATE VECTOR INDEX
        if (lex.matchKeyword('VECTOR')) {
            lex.expect('INDEX');
            const name = lex.readIdent();
            lex.expect('ON');
            const tableName = lex.readIdent();
            lex.expect('(');
            const columnName = lex.readIdent();
            lex.expect(')');

            let metric: 'cosine' | 'euclidean' = 'cosine';
            let m = 16;
            let efConstruction = 200;

            // USING HNSW(M, ef_construction) or USING COSINE/EUCLIDEAN
            if (lex.matchKeyword('USING')) {
                const methodOrMetric = lex.readIdent().toUpperCase();
                if (methodOrMetric === 'HNSW') {
                    if (lex.matchPunct('(')) {
                        m = lex.readNumber();
                        lex.expect(',');
                        efConstruction = lex.readNumber();
                        lex.expect(')');
                    }
                } else if (methodOrMetric === 'COSINE') {
                    metric = 'cosine';
                } else if (methodOrMetric === 'EUCLIDEAN') {
                    metric = 'euclidean';
                }

                // Optional metric after HNSW params
                if (lex.matchKeyword('METRIC')) {
                    const met = lex.readIdent().toUpperCase();
                    if (met === 'COSINE') metric = 'cosine';
                    else if (met === 'EUCLIDEAN') metric = 'euclidean';
                }
            }

            return { type: 'create_vector_index', name, tableName, columnName, metric, m, efConstruction };
        }

        let orReplace = false;
        if (lex.matchKeyword('OR')) {
            lex.expect('REPLACE');
            orReplace = true;
        }

        if (!lex.matchKeyword('PROPERTY')) return null;
        lex.expect('GRAPH');

        let ifNotExists = false;
        if (lex.matchKeyword('IF')) {
            lex.expect('NOT');
            lex.expect('EXISTS');
            ifNotExists = true;
        }

        const name = lex.readIdent();

        const vertexTables: VertexTableDef[] = [];
        const edgeTables: EdgeTableDef[] = [];

        // VERTEX TABLES (...)
        if (lex.matchKeyword('VERTEX')) {
            lex.expect('TABLES');
            lex.expect('(');
            while (!lex.matchPunct(')')) {
                vertexTables.push(parseVertexTable(lex));
                lex.matchPunct(',');
            }
        }

        // EDGE TABLES (...)
        if (lex.matchKeyword('EDGE')) {
            lex.expect('TABLES');
            lex.expect('(');
            while (!lex.matchPunct(')')) {
                edgeTables.push(parseEdgeTable(lex));
                lex.matchPunct(',');
            }
        }

        return { type: 'create_property_graph', orReplace, ifNotExists, name, vertexTables, edgeTables };
    }

    // DROP PROPERTY GRAPH or DROP VECTOR INDEX
    if (upper.startsWith('DROP')) {
        const lex = new Lexer(trimmed);
        lex.expect('DROP');

        // DROP VECTOR INDEX
        if (lex.matchKeyword('VECTOR')) {
            lex.expect('INDEX');
            let ifExists = false;
            if (lex.matchKeyword('IF')) {
                lex.expect('EXISTS');
                ifExists = true;
            }
            const name = lex.readIdent();
            return { type: 'drop_vector_index', name, ifExists };
        }

        if (!lex.matchKeyword('PROPERTY')) return null;
        lex.expect('GRAPH');

        let ifExists = false;
        if (lex.matchKeyword('IF')) {
            lex.expect('EXISTS');
            ifExists = true;
        }

        const name = lex.readIdent();
        return { type: 'drop_property_graph', ifExists, name };
    }

    // Check for GRAPH_TABLE in SELECT ... FROM GRAPH_TABLE(...)
    // Strip string literals and comments to avoid false matches
    const stripped = stripLiteralsAndComments(upper);
    if (/\bGRAPH_TABLE\s*\(/.test(stripped)) {
        return parseGraphTableRewrite(trimmed);
    }

    return null;
}

function parseVertexTable(lex: Lexer): VertexTableDef {
    const table = lex.readIdent();
    let keyColumn = 'id';
    let label: string | undefined;
    let properties: PropertyVisibility = { mode: 'all' };

    if (lex.matchKeyword('KEY')) {
        lex.expect('(');
        keyColumn = lex.readIdent();
        lex.expect(')');
    }

    if (lex.matchKeyword('LABEL')) {
        label = lex.readIdent();
    } else if (lex.matchKeyword('AS')) {
        label = lex.readIdent();
    }

    properties = tryParseProperties(lex);

    return { table, keyColumn, label, properties };
}

function parseEdgeTable(lex: Lexer): EdgeTableDef {
    const table = lex.readIdent();

    let sourceTable = '';
    let sourceKeyColumn = '';
    let destTable = '';
    let destKeyColumn = '';
    let label: string | undefined;
    let properties: PropertyVisibility = { mode: 'all' };

    // SOURCE KEY (col) REFERENCES source_table
    if (lex.matchKeyword('SOURCE')) {
        lex.expect('KEY');
        lex.expect('(');
        sourceKeyColumn = lex.readIdent();
        lex.expect(')');
        lex.expect('REFERENCES');
        sourceTable = lex.readIdent();
    }

    // DESTINATION KEY (col) REFERENCES dest_table
    if (lex.matchKeyword('DESTINATION')) {
        lex.expect('KEY');
        lex.expect('(');
        destKeyColumn = lex.readIdent();
        lex.expect(')');
        lex.expect('REFERENCES');
        destTable = lex.readIdent();
    }

    if (lex.matchKeyword('LABEL')) {
        label = lex.readIdent();
    } else if (lex.matchKeyword('AS')) {
        label = lex.readIdent();
    }

    properties = tryParseProperties(lex);

    return { table, sourceTable, sourceKeyColumn, destTable, destKeyColumn, label, properties };
}

function tryParseProperties(lex: Lexer): PropertyVisibility {
    if (lex.matchKeyword('PROPERTIES')) {
        if (lex.matchKeyword('ALL')) {
            if (lex.matchKeyword('COLUMNS')) {} // optional
            return { mode: 'all' };
        }
        if (lex.matchKeyword('NONE')) return { mode: 'none' };
        if (lex.matchKeyword('EXCEPT')) {
            lex.expect('(');
            const cols: string[] = [];
            while (!lex.matchPunct(')')) {
                cols.push(lex.readIdent());
                lex.matchPunct(',');
            }
            return { mode: 'except', columns: cols };
        }
        // ONLY (col1, col2, ...)
        lex.expect('(');
        const cols: string[] = [];
        while (!lex.matchPunct(')')) {
            cols.push(lex.readIdent());
            lex.matchPunct(',');
        }
        return { mode: 'only', columns: cols };
    }
    return { mode: 'all' };
}

// Parse GRAPH_TABLE() references in FROM clause and rewrite to temp table refs.
// Returns a rewrite descriptor with the original SQL and a rewritten version.
function parseGraphTableRewrite(sql: string): PgqResult {
    const graphTableRefs: GraphTableRef[] = [];
    let rewritten = sql;
    const regex = /GRAPH_TABLE\s*\(/gi;
    let match: RegExpExecArray | null;
    const replacements: { start: number; end: number; alias: string }[] = [];

    // Build a set of positions that fall inside string literals or comments
    // so we can skip false GRAPH_TABLE matches inside them.
    const inLiteralOrComment = new Set<number>();
    for (let qi = 0; qi < sql.length; qi++) {
        // Block comments: /* ... */
        if (sql[qi] === '/' && sql[qi + 1] === '*') {
            inLiteralOrComment.add(qi);
            inLiteralOrComment.add(qi + 1);
            qi += 2;
            while (qi < sql.length && !(sql[qi] === '*' && sql[qi + 1] === '/')) {
                inLiteralOrComment.add(qi);
                qi++;
            }
            if (qi < sql.length) { inLiteralOrComment.add(qi); inLiteralOrComment.add(qi + 1); qi++; }
            continue;
        }
        // Line comments: -- ...
        if (sql[qi] === '-' && sql[qi + 1] === '-') {
            while (qi < sql.length && sql[qi] !== '\n') {
                inLiteralOrComment.add(qi);
                qi++;
            }
            continue;
        }
        // String literals (handles '' and "" SQL-standard escapes)
        if (sql[qi] === "'" || sql[qi] === '"') {
            const q = sql[qi];
            qi++; // skip opening quote
            while (qi < sql.length) {
                if (sql[qi] === q) {
                    if (qi + 1 < sql.length && sql[qi + 1] === q) {
                        // Escaped quote: mark both characters as literal
                        inLiteralOrComment.add(qi);
                        inLiteralOrComment.add(qi + 1);
                        qi += 2;
                    } else {
                        break; // closing quote
                    }
                } else {
                    inLiteralOrComment.add(qi);
                    qi++;
                }
            }
            // qi now points at closing quote (or end of string)
        }
    }

    // Find each GRAPH_TABLE(...) occurrence, skipping matches inside string literals
    while ((match = regex.exec(sql)) !== null) {
        if (inLiteralOrComment.has(match.index)) continue;
        const startIdx = match.index;
        // Find matching closing paren, respecting quoted strings and comments
        let depth = 1;
        let i = startIdx + match[0].length;
        while (i < sql.length && depth > 0) {
            // Skip block comments
            if (sql[i] === '/' && sql[i + 1] === '*') {
                i += 2;
                while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
                if (i < sql.length) i += 2;
                continue;
            }
            // Skip line comments
            if (sql[i] === '-' && sql[i + 1] === '-') {
                i += 2;
                while (i < sql.length && sql[i] !== '\n') i++;
                continue;
            }
            if (sql[i] === "'" || sql[i] === '"') {
                const quote = sql[i];
                i++;
                while (i < sql.length) {
                    if (sql[i] === quote) {
                        if (i + 1 < sql.length && sql[i + 1] === quote) {
                            i += 2; // skip escaped quote
                        } else {
                            break; // closing quote
                        }
                    } else {
                        i++;
                    }
                }
                if (i < sql.length) i++; // skip closing quote
                continue;
            }
            if (sql[i] === '(') depth++;
            if (sql[i] === ')') depth--;
            i++;
        }
        const endIdx = i;
        const inner = sql.substring(startIdx + match[0].length, endIdx - 1).trim();

        const ref = parseGraphTableInner(inner);
        graphTableRefs.push(ref);

        // Check for alias after the closing paren
        const afterParenRaw = sql.substring(endIdx);
        const afterParen = afterParenRaw.trimStart();
        const trimmedWhitespace = afterParenRaw.length - afterParen.length;
        let alias = `_gt${graphTableRefs.length}`;
        const SQL_KEYWORDS = new Set([
            'WHERE', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
            'INTERSECT', 'EXCEPT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
            'CROSS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
            'LIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN',
            'ELSE', 'END', 'SELECT', 'FROM', 'INTO', 'SET', 'VALUES',
        ]);
        const aliasMatch = afterParen.match(/^(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);

        let aliasEndIdx = endIdx;
        if (aliasMatch && !SQL_KEYWORDS.has(aliasMatch[1].toUpperCase())) {
            alias = aliasMatch[1];
            aliasEndIdx = endIdx + trimmedWhitespace + afterParen.indexOf(aliasMatch[0]) + aliasMatch[0].length;
        }

        replacements.push({ start: startIdx, end: aliasEndIdx, alias });
    }

    // Apply replacements in reverse order to preserve indices
    for (let i = replacements.length - 1; i >= 0; i--) {
        const { start, end, alias } = replacements[i];
        rewritten = rewritten.substring(0, start) + alias + rewritten.substring(end);
    }

    return {
        type: 'graph_table_rewrite',
        original: sql,
        rewritten,
        graphTableRefs,
        graphTableAliases: replacements.map(r => r.alias),
    };
}

function parseGraphTableInner(inner: string): GraphTableRef {
    const lex = new Lexer(inner);

    const graphName = lex.readIdent();
    lex.expect(',');

    // MATCH pattern
    lex.expect('MATCH');
    const matchPattern = parseMatchPattern(lex);

    // COLUMNS (...)
    const columns: GraphTableColumn[] = [];
    if (lex.matchKeyword('COLUMNS')) {
        lex.expect('(');
        while (!lex.matchPunct(')')) {
            columns.push(parseGraphTableColumn(lex));
            lex.matchPunct(',');
        }
    }

    return { graphName, matchPattern, columns };
}

function parseMatchPattern(lex: Lexer): MatchPattern {
    const elements: PatternElement[] = [];
    let pathMode: MatchPattern['pathMode'];

    // Optional path mode
    if (lex.matchKeyword('ANY')) {
        if (lex.matchKeyword('SHORTEST')) {
            pathMode = 'any_shortest';
        }
    } else if (lex.matchKeyword('ALL')) {
        if (lex.matchKeyword('SHORTEST')) {
            pathMode = 'all_shortest';
        }
    } else if (lex.matchKeyword('WALK')) {
        pathMode = 'walk';
    }

    // Parse pattern elements: (node)-[edge]->(node)...
    while (!lex.done()) {
        const tok = lex.peek();
        if (!tok) break;

        if (tok.value === '(') {
            elements.push(parseNodePattern(lex));
        } else if (tok.value === '-' || tok.value === '->' || tok.value === '<-' || tok.value === '<->') {
            elements.push(parseEdgePattern(lex));
        } else {
            // End of pattern (COLUMNS keyword or similar)
            break;
        }
    }

    return { elements, pathMode };
}

function parseNodePattern(lex: Lexer): PatternElement {
    lex.expect('(');
    let variable: string | undefined;
    const labels: string[] = [];

    const tok = lex.peek();
    if (tok && tok.type === 'ident' && tok.value !== ')') {
        variable = lex.readIdent();

        // :Label or :Label1|Label2
        if (lex.matchPunct(':')) {
            labels.push(lex.readIdent());
            while (lex.matchPunct('|')) {
                labels.push(lex.readIdent());
            }
        }
    }

    lex.expect(')');

    // Optional quantifier
    const quantifier = tryParseQuantifier(lex);

    return { type: 'node', variable, labels: labels.length > 0 ? labels : undefined, quantifier };
}

function parseEdgeBracket(lex: Lexer): { variable?: string; labels: string[] } {
    let variable: string | undefined;
    const labels: string[] = [];

    if (!lex.matchPunct('[')) return { variable, labels };

    const tok2 = lex.peek();
    if (tok2 && tok2.type === 'ident') {
        const ident = lex.next()!;
        if (lex.matchPunct(':')) {
            // variable:Label
            variable = ident.value;
            while (true) {
                const labelTok = lex.peek();
                if (labelTok && labelTok.type === 'ident') {
                    labels.push(lex.next()!.value);
                } else {
                    break;
                }
                if (!lex.matchPunct('|')) break;
            }
        } else {
            // Just a variable name, no label
            variable = ident.value;
        }
    } else if (tok2 && tok2.value === ':') {
        // [:Label] without variable
        lex.next(); // consume ':'
        while (true) {
            const labelTok = lex.peek();
            if (labelTok && labelTok.type === 'ident') {
                labels.push(lex.next()!.value);
            } else {
                break;
            }
            if (!lex.matchPunct('|')) break;
        }
    }
    lex.expect(']');
    return { variable, labels };
}

function parseEdgePattern(lex: Lexer): PatternElement {
    let direction: PatternElement['direction'] = '-';

    const tok = lex.peek();
    if (!tok) throw new Error('Expected edge pattern');

    // Simple complete direction tokens (no bracket notation)
    if (tok.value === '->') {
        lex.next();
        direction = '->';
    } else if (tok.value === '<->') {
        lex.next();
        direction = '<->';
    } else if (tok.value === '<-') {
        lex.next();
        // Check for bracket notation: <-[e:Label]->
        const bracket = parseEdgeBracket(lex);
        // Check right side: -> makes it bidirectional, nothing makes it left-directed
        if (lex.matchPunct('->') || lex.matchPunct('>')) {
            direction = '<->';
        } else if (lex.matchPunct('-')) {
            direction = '<-';
        } else {
            direction = '<-';
        }
        const quantifier = tryParseQuantifier(lex);
        return { type: 'edge', variable: bracket.variable, labels: bracket.labels.length > 0 ? bracket.labels : undefined, direction, quantifier };
    } else if (tok.value === '-') {
        lex.next();
        // Check for bracket notation: -[e:Label]->
        const nextTok = lex.peek();
        if (nextTok && nextTok.value === '[') {
            const bracket = parseEdgeBracket(lex);
            // Check right side direction
            if (lex.matchPunct('->') || lex.matchPunct('>')) {
                direction = '->';
            } else if (lex.matchPunct('-')) {
                direction = '-';
            } else {
                direction = '-';
            }
            const quantifier = tryParseQuantifier(lex);
            return { type: 'edge', variable: bracket.variable, labels: bracket.labels.length > 0 ? bracket.labels : undefined, direction, quantifier };
        }
        // No bracket - check if this is -> or just -
        if (lex.matchPunct('>')) {
            direction = '->';
        } else if (lex.matchPunct('->')) {
            direction = '->';
        } else {
            direction = '-';
        }
    }

    const quantifier = tryParseQuantifier(lex);

    // Simple direction tokens (-> or <->) without bracket notation have no variable/labels
    return { type: 'edge', variable: undefined, labels: undefined, direction, quantifier };
}

function tryParseQuantifier(lex: Lexer): PatternElement['quantifier'] {
    const tok = lex.peek();
    if (!tok) return undefined;

    if (tok.value === '+') {
        lex.next();
        return { min: 1, max: Infinity };
    }
    if (tok.value === '*') {
        lex.next();
        return { min: 0, max: Infinity };
    }
    if (tok.value === '{') {
        lex.next();
        const min = lex.readNumber();
        lex.expect(',');
        const max = lex.readNumber();
        lex.expect('}');
        return { min, max };
    }

    return undefined;
}

function parseGraphTableColumn(lex: Lexer): GraphTableColumn {
    // Parse: variable.property [AS alias]
    const variable = lex.readIdent();
    lex.expect('.');
    const property = lex.readIdent();

    let alias: string | undefined;
    if (lex.matchKeyword('AS')) {
        alias = lex.readIdent();
    }

    return { expr: `${variable}.${property}`, variable, property, alias };
}
