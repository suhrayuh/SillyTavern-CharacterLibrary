import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SAUCEPAN_CDN_PROXY_BASE,
    resolveSaucepanImageUrl,
} from '../modules/providers/saucepan/saucepan-images.js';

test('rewrites current Saucepan CDN URLs', () => {
    assert.equal(
        resolveSaucepanImageUrl('https://saucepan.ai/cdn/image-id/card'),
        `${SAUCEPAN_CDN_PROXY_BASE}image-id/card`,
    );
});

test('rewrites legacy Saucepan CDN URLs', () => {
    assert.equal(
        resolveSaucepanImageUrl('https://cdn.saucepan.ai/images/image-id/card'),
        `${SAUCEPAN_CDN_PROXY_BASE}image-id/card`,
    );
});

test('repairs old proxy paths and preserves unrelated URLs', () => {
    assert.equal(
        resolveSaucepanImageUrl('/plugins/cl-helper/saucepan-proxy/cdn/image-id/card'),
        '/api/plugins/cl-helper/saucepan-proxy/cdn/image-id/card',
    );
    assert.equal(resolveSaucepanImageUrl('https://example.com/image.png'), 'https://example.com/image.png');
});
