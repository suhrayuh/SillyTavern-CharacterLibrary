import test from 'node:test';
import assert from 'node:assert/strict';

import {
    canonicalizeSaucepanCard,
    resolveSaucepanCard,
} from '../modules/providers/saucepan/saucepan-card-service.js';

const NOW = '2026-07-13T12:00:00.000Z';

function card(extensions = {}) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: 'Card Name', description: 'body', extensions },
    };
}

function dependencies(overrides = {}) {
    return {
        hasSaucepanToken: () => false,
        fetchSaucepanCompanion: async () => null,
        fetchSaucepanV2Card: async () => null,
        fetchDatacatDownload: async () => null,
        fetchDatacatCharacter: async () => null,
        hydrateDatacatScripts: async () => true,
        buildV2FromDownload: () => null,
        buildV2FromDatacat: () => null,
        hasUnfetchedLorebook: () => false,
        now: () => NOW,
        ...overrides,
    };
}

test('canonicalizes without mutating the card and removes only Saucepan DataCat ownership', () => {
    const original = card({
        datacat: { id: 'sp-1', sourceKind: 'saucepan' },
        custom: { keep: true },
    });

    const result = canonicalizeSaucepanCard(original, {
        id: 'sp-1',
        creatorId: 'creator-1',
        creatorName: 'Raya',
        pageName: 'Listing Name',
        linkedAt: NOW,
    });

    assert.notEqual(result, original);
    assert.deepEqual(original.data.extensions.datacat, { id: 'sp-1', sourceKind: 'saucepan' });
    assert.deepEqual(result.data.extensions.custom, { keep: true });
    assert.equal(result.data.extensions.datacat, undefined);
    assert.deepEqual(result.data.extensions.saucepan, {
        id: 'sp-1', creatorId: 'creator-1', creatorName: 'Raya', pageName: 'Listing Name', linkedAt: NOW,
    });
});

test('preserves unrelated DataCat extension metadata', () => {
    const result = canonicalizeSaucepanCard(card({
        datacat: { id: 'janitor-1', sourceKind: 'janitor', linkedAt: 'old' },
    }), { id: 'sp-1', linkedAt: NOW });

    assert.deepEqual(result.data.extensions.datacat, {
        id: 'janitor-1', sourceKind: 'janitor', linkedAt: 'old',
    });
    assert.deepEqual(result.data.extensions.saucepan, { id: 'sp-1', linkedAt: NOW });
});

test('uses native Saucepan first and enriches an id with companion detail', async () => {
    const calls = [];
    const result = await resolveSaucepanCard('sp-1', dependencies({
        hasSaucepanToken: () => true,
        fetchSaucepanCompanion: async id => {
            calls.push(`companion:${id}`);
            return {
                id, display_name: 'Native Name', author_id: 'creator-1', author_handle: 'Raya',
                open_definition: false,
                portraits: [{ image: { id: 'portrait-1', highres_url: 'https://cdn/one.png' } }],
            };
        },
        fetchSaucepanV2Card: async listing => {
            calls.push(`native:${listing.display_name}`);
            return card({ datacat: { id: 'sp-1', sourceKind: 'saucepan' } });
        },
        fetchDatacatDownload: async () => { calls.push('download'); return null; },
    }));

    assert.deepEqual(calls, ['companion:sp-1', 'native:Native Name']);
    assert.equal(result.source, 'native');
    assert.equal(result.locked, true);
    assert.equal(result.nativeError, null);
    assert.equal(result.fallbackError, null);
    assert.deepEqual(result.portraits, [{ url: 'https://cdn/one.png', id: 'portrait-1' }]);
    assert.deepEqual(result.card.data.extensions.saucepan, {
        id: 'sp-1', creatorId: 'creator-1', creatorName: 'Raya', pageName: 'Native Name', linkedAt: NOW,
    });
});

test('falls back from native failure to DataCat download before metadata', async () => {
    const calls = [];
    const metadata = {
        character_id: 'sp-2', primary_content_source_kind: 'saucepan', creator_name: 'Fallback Creator',
        companion_snapshot: { portraits: [{ image: { id: 'portrait-2', highres_url: 'https://cdn/two.png' } }] },
    };
    const result = await resolveSaucepanCard({ character_id: 'sp-2', name: 'Listing' }, dependencies({
        hasSaucepanToken: () => true,
        fetchSaucepanV2Card: async () => { calls.push('native'); throw new Error('token rejected'); },
        fetchDatacatDownload: async (id, kind) => { calls.push(`download:${id}:${kind}`); return { data: { name: 'Downloaded' } }; },
        fetchDatacatCharacter: async () => { calls.push('metadata'); return metadata; },
        hydrateDatacatScripts: async value => { calls.push('hydrate'); assert.equal(value, metadata); return true; },
        buildV2FromDownload: (download, character) => {
            calls.push('build-download');
            assert.equal(character, metadata);
            return card({ custom: { keep: true } });
        },
        buildV2FromDatacat: () => { calls.push('build-metadata'); return card(); },
    }));

    assert.deepEqual(calls, ['native', 'download:sp-2:saucepan', 'metadata', 'hydrate', 'build-download']);
    assert.equal(result.source, 'datacat-download');
    assert.equal(result.nativeError.message, 'token rejected');
    assert.equal(result.fallbackError, null);
    assert.equal(result.datacatCharacter, metadata);
    assert.deepEqual(result.portraits, [{ url: 'https://cdn/two.png', id: 'portrait-2' }]);
    assert.deepEqual(result.card.data.extensions.custom, { keep: true });
});

test('uses DataCat metadata only after download is unavailable and reports total failure', async () => {
    const metadataResult = await resolveSaucepanCard('sp-3', dependencies({
        fetchDatacatCharacter: async () => ({ character_id: 'sp-3', name: 'Metadata Name' }),
        buildV2FromDatacat: () => card({ datacat: { id: 'sp-3', sourceKind: 'saucepan' } }),
    }));

    assert.equal(metadataResult.source, 'datacat-metadata');
    assert.equal(metadataResult.card.data.extensions.datacat, undefined);

    const failed = await resolveSaucepanCard('sp-4', dependencies());
    assert.equal(failed.card, null);
    assert.equal(failed.source, null);
    assert.match(failed.fallbackError.message, /No Saucepan card/);
});
