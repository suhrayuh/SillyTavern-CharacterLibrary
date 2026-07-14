// First-class Saucepan provider. DataCat may supply fallback card bodies, but
// Saucepan remains the canonical owner for links, imports, updates, and gallery.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, CL_HELPER_PLUGIN_BASE, fetchWithProxy, importFromPng, slugify } from '../provider-utils.js';
import saucepanBrowseView from './saucepan-browse.js';
import {
    fetchSaucepanCompanion,
    setApiRequest,
    setSaucepanTokenGetter,
} from './saucepan-api.js';
import { resolveSaucepanImageUrl } from './saucepan-images.js';
import { canonicalizeSaucepanCard, resolveSaucepanCard } from './saucepan-card-service.js';
import { getSaucepanLinkInfo, writeSaucepanLinkInfo } from './saucepan-links.js';

let api = null;
let cachedPreview = null;

function getExtensions(char) {
    return char?.data?.extensions || char?.extensions || null;
}

function getCompanionId(value) {
    return String(value?.character_id || value?.id || value || '').trim();
}

function buildListing(companion, id) {
    if (!companion) return { id, character_id: id, primary_content_source_kind: 'saucepan', _source: 'saucepan' };
    return {
        id: companion.id || id,
        character_id: companion.id || id,
        name: companion.display_name || companion.name || 'Unknown',
        display_name: companion.display_name || companion.name || 'Unknown',
        avatar: companion.image?.highres_url || companion.image?.url || '',
        description: companion.short_description || '',
        tags: Array.isArray(companion.tags) ? companion.tags : [],
        creator_id: companion.author_id || '',
        creator_name: companion.author_handle || '',
        chat_count: companion.chat_count || 0,
        message_count: companion.interaction_count || 0,
        totalTokens: companion.card_token_count || 0,
        createdAt: companion.posted_at || '',
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
    };
}

function companionPortraits(companion) {
    const portraits = Array.isArray(companion?.portraits) ? companion.portraits : [];
    return portraits.map(portrait => {
        const image = portrait?.image || portrait;
        return { url: resolveSaupanImage(image?.highres_url || image?.url || ''), id: image?.id || portrait?.id || null };
    }).filter(item => item.url);
}

function resolveSaupanImage(url) {
    return resolveSaucepanImageUrl(url) || url || '';
}

async function pluginAvailable() {
    if (!api?.apiRequest) return false;
    try {
        const response = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
        return !!response?.ok;
    } catch {
        return false;
    }
}

class SaucepanProvider extends ProviderBase {
    get id() { return 'saucepan'; }
    get name() { return 'Saucepan'; }
    get icon() { return 'fa-solid fa-bowl-food'; }
    get iconUrl() { return new URL('./assets/saucepan-logo.svg', import.meta.url).href; }
    get browseView() { return saucepanBrowseView; }
    get disabledByDefault() { return false; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-envelope', label: 'Messages' },
            stat3: { icon: 'fa-solid fa-text-width', label: 'Tokens' },
        };
    }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setApiRequest(coreAPI.apiRequest);
        setSaucepanTokenGetter(() => coreAPI.getSetting('saucepanToken') || null);
        saucepanBrowseView.provider = this;

        const token = coreAPI.getSetting('saucepanToken');
        if (token) {
            try {
                await coreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`, 'POST', { token });
            } catch (error) {
                console.warn('[SaucepanProvider] Failed to restore token:', error.message);
            }
        }

        this._installAuthApi();
    }

    async activate(container, options = {}) {
        await saucepanBrowseView.activate(container, options);
    }

    deactivate() { saucepanBrowseView.deactivate(); }
    get hasView() { return true; }
    renderFilterBar() { return saucepanBrowseView.renderFilterBar(); }
    renderView() { return saucepanBrowseView.renderView(); }
    renderModals() { return saucepanBrowseView.renderModals(); }

    getLinkInfo(char) { return getSaucepanLinkInfo(char); }

    setLinkInfo(char, linkInfo) { writeSaucepanLinkInfo(char, linkInfo); }

    getLegacyLinkNamespaces() { return ['datacat']; }

    getCharacterUrl(linkInfo) {
        const id = linkInfo?.id || linkInfo?.fullPath;
        return id ? `https://saucepan.ai/companion/${encodeURIComponent(id)}` : null;
    }

    openLinkUI(char) { CoreAPI.openProviderLinkModal?.(char); }
    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const id = linkInfo?.id || linkInfo?.fullPath;
        if (!id) return null;
        const companion = await fetchSaucepanCompanion(id);
        const preview = buildListing(companion, id);
        cachedPreview = preview;
        return preview;
    }

    openPreview(previewChar) { saucepanBrowseView.openAggregatedHit(previewChar); }
    getCachedLinkNode() { return cachedPreview; }
    clearCachedLinkNode() { cachedPreview = null; }

    async enrichLocalImport(cardData) {
        const link = this.getLinkInfo(cardData);
        if (!link) return null;
        const canonical = canonicalizeSaucepanCard(cardData, {
            id: link.id,
            creatorId: getExtensions(cardData)?.saucepan?.creatorId || getExtensions(cardData)?.datacat?.creatorId,
            creatorName: getExtensions(cardData)?.saucepan?.creatorName || getExtensions(cardData)?.datacat?.creatorName,
            pageName: link.pageName,
            linkedAt: link.linkedAt || new Date().toISOString(),
        });
        return {
            cardData: canonical || cardData,
            providerInfo: { providerId: 'saucepan', charId: link.id, fullPath: link.id, hasGallery: true, avatarUrl: null },
        };
    }

    async fetchMetadata(id) {
        const companion = await fetchSaucepanCompanion(id);
        return companion ? { ...companion, id: companion.id || id } : null;
    }

    async fetchRemoteCard(linkInfo) {
        const id = linkInfo?.id || linkInfo?.fullPath;
        if (!id) return null;
        const resolution = await resolveSaucepanCard(id);
        if (resolution.card) resolution.card._listingName = resolution.listing?.display_name || resolution.listing?.name || null;
        return resolution.card;
    }

    normalizeRemoteCard(rawData) { return rawData?.spec === 'chara_card_v2' ? rawData : null; }

    async fetchLorebook(linkInfo) {
        const resolution = await resolveSaucepanCard(linkInfo?.id || linkInfo?.fullPath);
        return resolution.card?.data?.character_book || null;
    }

    async fetchLinkStats(linkInfo) {
        const companion = await fetchSaucepanCompanion(linkInfo?.id || linkInfo?.fullPath);
        if (!companion) return null;
        cachedPreview = buildListing(companion, linkInfo.id || linkInfo.fullPath);
        return {
            stat1: companion.chat_count || 0,
            stat2: companion.interaction_count || 0,
            stat3: companion.card_token_count || 0,
        };
    }

    get hasAuth() { return true; }
    get isAuthenticated() { return !!api?.getSetting('saucepanToken'); }
    openAuthUI() { document.getElementById('settingsSaucepanSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?saucepan\.ai$/i.test(parsed.hostname) && /\/companion\/[0-9a-f-]+/i.test(parsed.pathname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
            return parsed.pathname.match(/\/companion\/([0-9a-f-]+)/i)?.[1] || null;
        } catch {
            return null;
        }
    }

    get supportsImport() { return true; }

    async importCharacter(identifier, hitData = null, options = {}) {
        try {
            const id = getCompanionId(identifier);
            if (!id) throw new Error('Saucepan character id is missing');
            const resolution = hitData?._resolvedSaucepan?.card
                ? hitData._resolvedSaucepan
                : await resolveSaucepanCard(hitData || id);
            if (!resolution?.card?.data) {
                throw new Error(resolution?.fallbackError?.message || resolution?.nativeError?.message || 'No usable Saucepan card was found');
            }

            const owner = resolution.card.data.extensions?.saucepan || { id };
            const characterCard = canonicalizeSaucepanCard(resolution.card, {
                id,
                creatorId: owner.creatorId,
                creatorName: owner.creatorName,
                pageName: owner.pageName || resolution.listing?.display_name || resolution.listing?.name,
                linkedAt: owner.linkedAt || new Date().toISOString(),
            });
            assignGalleryId(characterCard, options, api);

            const avatarUrl = resolveSaupanImage(
                resolution.listing?.avatar
                || resolution.companion?.image?.highres_url
                || resolution.companion?.image?.url
                || hitData?.avatar,
            );
            let imageBuffer = null;
            if (avatarUrl) {
                try {
                    const response = await fetchWithProxy(avatarUrl);
                    imageBuffer = await response.arrayBuffer();
                } catch (error) {
                    console.warn('[SaucepanProvider] Avatar download failed:', error.message);
                }
            }

            const characterName = characterCard.data.name || resolution.listing?.name || 'Saucepan Companion';
            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `saucepan_${slugify(characterName)}.png`,
                characterName,
                hasGallery: (resolution.portraits || []).length > 0,
                providerCharId: id,
                fullPath: id,
                avatarUrl: avatarUrl || null,
                api,
            });
        } catch (error) {
            console.error(`[SaucepanProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        const companion = await fetchSaucepanCompanion(linkInfo?.id || linkInfo?.fullPath);
        return companionPortraits(companion);
    }

    getSettings() { return []; }

    _installAuthApi() {
        window.saucepanLogin = async (handle, password) => {
            if (!await pluginAvailable()) return { ok: false, error: 'cl-helper plugin not available' };
            try {
                const response = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-login`, 'POST', { handle, password });
                if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}` };
                const data = await response.json();
                if (data?.ok && data.token) CoreAPI.setSetting('saucepanToken', data.token);
                return data;
            } catch (error) {
                return { ok: false, error: error.message };
            }
        };

        window.saucepanSetToken = async token => {
            const trimmed = String(token || '').trim();
            if (!trimmed) return { ok: false, error: 'Token is empty' };
            CoreAPI.setSetting('saucepanToken', trimmed);
            if (!await pluginAvailable()) return { ok: false, error: 'Saved locally, but cl-helper plugin not available' };
            try {
                const response = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`, 'POST', { token: trimmed });
                return response.ok ? await response.json() : { ok: false, error: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}` };
            } catch (error) {
                return { ok: false, error: error.message };
            }
        };

        window.saucepanValidateSession = async () => {
            if (!await pluginAvailable()) return { valid: false, reason: 'cl-helper plugin not available' };
            try {
                const token = CoreAPI.getSetting('saucepanToken');
                if (token) await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`, 'POST', { token });
                const response = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-validate`);
                return response.ok ? await response.json() : { valid: false, reason: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}` };
            } catch (error) {
                return { valid: false, reason: error.message };
            }
        };

        window.saucepanClearSession = async () => {
            CoreAPI.setSetting('saucepanToken', null);
            if (!await pluginAvailable()) return false;
            try {
                return (await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-clear-token`, 'POST')).ok;
            } catch {
                return false;
            }
        };
    }
}

const saucepanProvider = new SaucepanProvider();
export default saucepanProvider;
