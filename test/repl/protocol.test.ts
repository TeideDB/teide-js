import { describe, it, expect } from 'vitest';
import { parseClientMessage } from '../../lib/repl/protocol';

describe('protocol', () => {
    it('parses query message', () => {
        const msg = parseClientMessage(JSON.stringify({ type: 'query', id: '1', sql: 'SELECT 1;' }));
        expect(msg).toEqual({ type: 'query', id: '1', sql: 'SELECT 1;' });
    });

    it('parses complete message', () => {
        const msg = parseClientMessage(JSON.stringify({ type: 'complete', prefix: 'SEL', context: 'SEL' }));
        expect(msg).toEqual({ type: 'complete', prefix: 'SEL', context: 'SEL' });
    });

    it('parses dot message', () => {
        const msg = parseClientMessage(JSON.stringify({ type: 'dot', command: '.tables' }));
        expect(msg).toEqual({ type: 'dot', command: '.tables' });
    });

    it('parses meta message', () => {
        const msg = parseClientMessage(JSON.stringify({ type: 'meta' }));
        expect(msg).toEqual({ type: 'meta' });
    });

    it('returns null for invalid JSON', () => {
        expect(parseClientMessage('not json')).toBeNull();
    });

    it('returns null for unknown type', () => {
        expect(parseClientMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    });
});
