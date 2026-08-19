import { describe, expect, it } from 'vitest';

import { mergeMeetingTranscriptContent } from './useMeetingTranscription';

describe('meeting transcript persistence', () => {
    it('replaces only the transcript block and preserves notes edited during recording', () => {
        const existing = [
            '---',
            'type: meeting',
            '---',
            '',
            '# Team sync',
            '',
            'My live note: ask about the Friday deadline.',
            '',
            '```transcript',
            '{"transcript":"old"}',
            '```',
        ].join('\n');
        const generated = [
            '---',
            'type: meeting',
            '---',
            '',
            '# Team sync',
            '',
            '```transcript',
            '{"transcript":"new words"}',
            '```',
        ].join('\n');

        const merged = mergeMeetingTranscriptContent(existing, generated);
        expect(merged).toContain('My live note: ask about the Friday deadline.');
        expect(merged).toContain('{"transcript":"new words"}');
        expect(merged).not.toContain('{"transcript":"old"}');
    });

    it('adds a transcript block when an editable meeting note has none', () => {
        const merged = mergeMeetingTranscriptContent(
            '# Meeting\n\nManual notes',
            '# Meeting\n\n```transcript\n{"transcript":"captured"}\n```',
        );
        expect(merged).toBe('# Meeting\n\nManual notes\n\n```transcript\n{"transcript":"captured"}\n```');
    });
});
