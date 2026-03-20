import * as theme from './theme';

const SQL_KEYWORDS = new Set([
    'SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','AS','ON',
    'JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','HAVING','DISTINCT',
    'UNION','ALL','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
    'CREATE','TABLE','DROP','ALTER','INDEX','VIEW','CASE','WHEN',
    'THEN','ELSE','END','IN','BETWEEN','LIKE','IS','NULL','EXISTS',
    'ASC','DESC','OFFSET','FETCH','WITH','RECURSIVE','EXCEPT',
    'INTERSECT','OVER','PARTITION','WINDOW','ROWS','RANGE',
    'UNBOUNDED','PRECEDING','FOLLOWING','CURRENT','ROW',
    'FULL','CROSS','NOT','TRUE','FALSE','IF','REPLACE',
    'NULLS','FIRST','LAST','PROPERTY','GRAPH','VERTEX','EDGE',
    'TABLES','MATCH','COLUMNS','KEY','SOURCE','DESTINATION',
    'REFERENCES','LABEL','PROPERTIES','CHEAPEST','COST','SHORTEST',
    'ANY','WALK','VECTOR','USING','HNSW',
]);

const AGG_FUNCTIONS = new Set([
    'SUM','AVG','MIN','MAX','COUNT','ROW_NUMBER','RANK','DENSE_RANK',
    'NTILE','LAG','LEAD','FIRST_VALUE','LAST_VALUE','NTH_VALUE',
    'ABS','CEIL','CEILING','FLOOR','SQRT','ROUND','LN','LOG','EXP',
    'LEAST','GREATEST','UPPER','LOWER','LENGTH','LEN','CHAR_LENGTH',
    'TRIM','BTRIM','SUBSTR','SUBSTRING','CONCAT','COALESCE','NULLIF',
    'EXTRACT','DATE_TRUNC','DATE_DIFF','DATEDIFF','NOW',
    'CURRENT_DATE','CURRENT_TIMESTAMP',
    'STDDEV','STDDEV_SAMP','STDDEV_POP','VARIANCE','VAR_SAMP','VAR_POP',
    'COUNT_DISTINCT','CHARACTER_LENGTH',
    'READ_CSV','PAGERANK','COMPONENT','CONNECTED_COMPONENT',
    'COMMUNITY','LOUVAIN','CLUSTERING_COEFFICIENT','CLUSTERING_COEFF',
    'SHORTEST_DISTANCE','DIJKSTRA',
    'COSINE_SIMILARITY','EUCLIDEAN_DISTANCE','GRAPH_TABLE',
]);

const OPERATORS = new Set(['AND', 'OR', 'NOT']);

export function highlight(line: string): string {
    if (line.length === 0) return '';

    if (line.startsWith('.')) {
        return `${theme.DOT_CMD}${line}${theme.R}`;
    }

    let result = '';
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        // Single-quoted string
        if (ch === "'") {
            const start = i;
            i++;
            while (i < line.length && line[i] !== "'") i++;
            if (i < line.length) i++;
            result += `${theme.STR}${line.slice(start, i)}${theme.R}`;
            continue;
        }

        // Comment
        if (ch === '-' && i + 1 < line.length && line[i + 1] === '-') {
            result += `${theme.CM}${line.slice(i)}${theme.R}`;
            break;
        }

        // Number
        if (isDigit(ch) || (ch === '-' && i + 1 < line.length && isDigit(line[i + 1]))) {
            const start = i;
            if (ch === '-') i++;
            while (i < line.length && (isDigit(line[i]) || line[i] === '.')) i++;
            if (i < line.length && (isAlpha(line[i]) || line[i] === '_')) {
                result += line.slice(start, i);
            } else {
                result += `${theme.NUM}${line.slice(start, i)}${theme.R}`;
            }
            continue;
        }

        // Word
        if (isAlpha(ch) || ch === '_') {
            const start = i;
            while (i < line.length && (isAlnum(line[i]) || line[i] === '_')) i++;
            const word = line.slice(start, i);
            const upper = word.toUpperCase();

            if (AGG_FUNCTIONS.has(upper)) {
                result += `${theme.FN}${word}${theme.R}`;
            } else if (OPERATORS.has(upper)) {
                result += `${theme.OP}${word}${theme.R}`;
            } else if (SQL_KEYWORDS.has(upper)) {
                result += `${theme.KW}${word}${theme.R}`;
            } else {
                result += word;
            }
            continue;
        }

        // Comparison operators
        if (ch === '=' || ch === '<' || ch === '>' || ch === '!') {
            const start = i;
            i++;
            if (i < line.length && line[i] === '=') i++;
            result += `${theme.OP}${line.slice(start, i)}${theme.R}`;
            continue;
        }

        result += ch;
        i++;
    }

    return result;
}

export function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[\d;]*m/g, '');
}

function isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
function isAlpha(ch: string): boolean { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'); }
function isAlnum(ch: string): boolean { return isDigit(ch) || isAlpha(ch); }
