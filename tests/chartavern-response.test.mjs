import assert from 'node:assert/strict';
import { gzipSync, deflateSync } from 'node:zlib';
import test from 'node:test';

import { parseCharacterTavernJson } from '../modules/providers/chartavern/chartavern-response.js';

const payload = { hits: [{ name: 'Raya' }], totalHits: 1 };
const json = JSON.stringify(payload);

test('parses plain CharacterTavern JSON', async () => {
    const result = await parseCharacterTavernJson(new Response(json), 'search');
    assert.deepEqual(result, payload);
});

test('detects and decodes gzip CharacterTavern JSON', async () => {
    const result = await parseCharacterTavernJson(new Response(gzipSync(json)), 'search');
    assert.deepEqual(result, payload);
});

test('detects and decodes zlib CharacterTavern JSON', async () => {
    const result = await parseCharacterTavernJson(new Response(deflateSync(json)), 'detail');
    assert.deepEqual(result, payload);
});

test('reports invalid JSON with a byte prefix', async () => {
    await assert.rejects(
        parseCharacterTavernJson(new Response('(not json)'), 'search'),
        /invalid JSON \(28 6e 6f 74 20 6a 73 6f 6e 29\)/,
    );
});

test('identifies leaked zstd bytes as a stale cl-helper install', async () => {
    const zstdMagic = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]);
    await assert.rejects(
        parseCharacterTavernJson(new Response(zstdMagic), 'search'),
        /Update cl-helper to v1\.8\.1 and restart SillyTavern/,
    );
});
