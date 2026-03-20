export type ValidationResult = 'complete' | 'incomplete';

export function validate(input: string): ValidationResult {
    const trimmed = input.trim();

    if (trimmed.length === 0) return 'complete';
    if (trimmed.startsWith('.')) return 'complete';

    let depth = 0;
    let inSingle = false;
    let inDouble = false;

    for (const ch of trimmed) {
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
        }
    }
    if (depth > 0) return 'incomplete';

    if (!trimmed.endsWith(';')) return 'incomplete';

    return 'complete';
}
