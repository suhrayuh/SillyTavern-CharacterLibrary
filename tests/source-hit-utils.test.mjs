import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getCharId,
    getCreatorId,
    getCreatorName,
    getMsgCount,
    getSourceKind,
} from '../modules/providers/source-hit-utils.js';

test('normalizes native Saucepan hit fields', () => {
    const hit = {
        character_id: 'char-1',
        author_id: 'creator-1',
        author_handle: 'Raya',
        interaction_count: 42,
        _source: 'saucepan',
    };

    assert.equal(getCharId(hit), 'char-1');
    assert.equal(getCreatorId(hit), 'creator-1');
    assert.equal(getCreatorName(hit), 'Raya');
    assert.equal(getMsgCount(hit), 42);
    assert.equal(getSourceKind(hit), 'saucepan');
});

test('keeps missing legacy aggregate source Janitor-compatible', () => {
    assert.equal(getSourceKind({ character_id: 'legacy' }), 'janitor');
});

test('preserves unknown explicit aggregate sources', () => {
    assert.equal(getSourceKind({ primary_content_source_kind: 'future-source' }), 'future-source');
});
