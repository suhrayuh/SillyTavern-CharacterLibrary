const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';

// Saucepan CDN responses use Cross-Origin-Resource-Policy: same-origin, so all
// browser image requests must pass through cl-helper.
export const SAUCEPAN_CDN_PROXY_BASE = `/api${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`;

/**
 * Rewrite Saucepan CDN URLs to the local cl-helper proxy path.
 * @param {string} url
 * @returns {string}
 */
export function resolveSaucepanImageUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('https://saucepan.ai/cdn/')) {
        return url.replace('https://saucepan.ai/cdn/', SAUCEPAN_CDN_PROXY_BASE);
    }
    if (url.startsWith('https://cdn.saucepan.ai/images/')) {
        return url.replace('https://cdn.saucepan.ai/images/', SAUCEPAN_CDN_PROXY_BASE);
    }
    if (url.startsWith(`${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`)) {
        return `/api${url}`;
    }
    return url;
}
