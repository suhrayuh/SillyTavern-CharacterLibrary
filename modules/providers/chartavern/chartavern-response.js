// CharacterTavern JSON response decoding.
// Handles stale/misconfigured proxy installs that forward compressed bytes.

function isGzip(bytes) {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZlib(bytes) {
    return bytes.length >= 2 && bytes[0] === 0x78 && (((bytes[0] << 8) + bytes[1]) % 31 === 0);
}

function isZstd(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

async function decompress(bytes, format) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error(`CharacterTavern returned ${format}-compressed JSON, but this browser cannot decompress it`);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a CharacterTavern JSON response, including accidentally forwarded
 * gzip/zlib payloads. The response body is consumed exactly once.
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<any>}
 */
export async function parseCharacterTavernJson(response, label = 'response') {
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (isGzip(bytes)) bytes = await decompress(bytes, 'gzip');
    else if (isZlib(bytes)) bytes = await decompress(bytes, 'deflate');
    else if (isZstd(bytes)) {
        throw new Error('CharacterTavern returned zstd-compressed JSON. Update cl-helper to v1.8.1 and restart SillyTavern.');
    }

    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    try {
        return JSON.parse(text);
    } catch (error) {
        const prefix = [...bytes.slice(0, 12)].map(value => value.toString(16).padStart(2, '0')).join(' ');
        throw new Error(`CharacterTavern ${label} returned invalid JSON (${prefix || 'empty'}): ${error.message}`);
    }
}
