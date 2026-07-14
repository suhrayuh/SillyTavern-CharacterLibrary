import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getSaucepanLinkInfo,
    isLegacySaucepanDatacatLink,
    writeSaucepanLinkInfo,
} from '../modules/providers/saucepan/saucepan-links.js';

const NOW = '2026-07-13T14:00:00.000Z';

test('canonical Saucepan link wins over unrelated DataCat metadata', () => {
    const char = { data: { extensions: { saucepan: { id: 42, pageName: 'Pan' }, datacat: { id: 'dc', sourceKind: 'janitor' } } } };
    assert.deepEqual(getSaucepanLinkInfo(char), { providerId: 'saucepan', id: '42', fullPath: '42', linkedAt: null, pageName: 'Pan' });
});

test('legacy DataCat Saucepan link resolves to Saucepan', () => {
    const char = { data: { extensions: { datacat: { id: 'sp-1', sourceKind: 'saucepan', linkedAt: NOW } } } };
    assert.equal(isLegacySaucepanDatacatLink(char), true);
    assert.deepEqual(getSaucepanLinkInfo(char), { providerId: 'saucepan', id: 'sp-1', fullPath: 'sp-1', linkedAt: NOW, pageName: null, legacyNamespace: 'datacat' });
});

test('missing or non-Saucepan source remains unclaimed', () => {
    assert.equal(getSaucepanLinkInfo({ data: { extensions: { datacat: { id: 'dc-1' } } } }), null);
    assert.equal(getSaucepanLinkInfo({ data: { extensions: { datacat: { id: 'dc-2', sourceKind: 'janitor' } } } }), null);
});

test('writing canonical ownership removes only legacy Saucepan DataCat metadata', () => {
    const legacy = { data: { extensions: { datacat: { id: 'sp-1', sourceKind: 'saucepan' }, custom: { keep: true } } } };
    writeSaucepanLinkInfo(legacy, { id: 'sp-1', creatorName: 'Raya' }, () => NOW);
    assert.equal(legacy.data.extensions.datacat, undefined);
    assert.deepEqual(legacy.data.extensions.custom, { keep: true });
    assert.deepEqual(legacy.data.extensions.saucepan, { id: 'sp-1', creatorName: 'Raya', linkedAt: NOW });

    const unrelated = { data: { extensions: { datacat: { id: 'dc-1', sourceKind: 'janitor' } } } };
    writeSaucepanLinkInfo(unrelated, { id: 'sp-2' }, () => NOW);
    assert.equal(unrelated.data.extensions.datacat.id, 'dc-1');
});

test('unlink deletes canonical and legacy Saucepan namespaces', () => {
    const char = { data: { extensions: { saucepan: { id: 'sp-1' }, datacat: { id: 'sp-1', sourceKind: 'saucepan' } } } };
    writeSaucepanLinkInfo(char, null);
    assert.equal(char.data.extensions.saucepan, undefined);
    assert.equal(char.data.extensions.datacat, undefined);
});
