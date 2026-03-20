import { describe, it, expect } from 'vitest';
import * as theme from '../../lib/repl/theme';

describe('theme', () => {
    it('exports ANSI reset code', () => {
        expect(theme.R).toBe('\x1b[0m');
    });

    it('exports all required constants', () => {
        const required = [
            'BOLD', 'ITALIC', 'R', 'REVERSE',
            'BORDER', 'HEADER', 'TYPE_DIM', 'TEXT', 'NULL_CLR', 'FOOTER',
            'ERROR', 'SUCCESS', 'TIMER',
            'BAN_BORDER', 'BAN_TITLE', 'BAN_INFO', 'BAN_HELP',
        ];
        for (const name of required) {
            expect((theme as any)[name]).toBeDefined();
            expect(typeof (theme as any)[name]).toBe('string');
        }
    });

    it('all constants are ANSI escape sequences', () => {
        for (const [key, val] of Object.entries(theme)) {
            if (typeof val === 'string') {
                expect(val).toMatch(/^\x1b\[[\d;]*m$/);
            }
        }
    });
});
