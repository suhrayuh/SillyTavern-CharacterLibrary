// SaucepanBrowseView - first-class Saucepan browse/search UI for the Online tab.

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import {
    BROWSE_PURIFY_CONFIG,
    IMG_PLACEHOLDER,
    deferCall,
    deferRender,
    finishBrowseImport,
    formatNumber,
    skeletonLines,
} from '../provider-utils.js';
import {
    fetchSaucepanCompanionsOfUser,
    fetchSaucepanLorebookList,
    resolveSaucepanImageUrl,
    searchSaucepan,
} from './saucepan-api.js';
import { resolveSaucepanCard } from './saucepan-card-service.js';
import {
    getCharId,
    getChatCount,
    getCreatedDate,
    getCreatorId,
    getCreatorName,
    getMsgCount,
    getTotalTokens,
    isNsfw,
} from '../source-hit-utils.js';

const {
    cleanupCreatorNotesContainer,
    escapeHtml,
    formatRichText,
    getCharacterGalleryId,
    getProviderExcludeTags,
    getSetting,
    renderCreatorNotesSecure,
    renderSkeletonGrid,
    safePurify,
    setSetting,
    showPreImportDuplicateWarning,
    checkCharacterForDuplicatesAsync,
    deleteCharacter,
    showToast,
} = CoreAPI;

const PAGE_SIZE = 72;
const FOLLOWING_PAGE_SIZE = 72;
const CURATED_TAGS = [
    'anime', 'assistant', 'comedy', 'fantasy', 'female', 'game', 'historical',
    'horror', 'male', 'non-human', 'original-character', 'romance', 'roleplay',
    'sci-fi', 'slice-of-life', 'supernatural', 'villain',
];

function tagName(tag) {
    if (typeof tag === 'string') return tag.trim();
    return String(tag?.slug || tag?.name || tag?.title || '').trim();
}

function tagsOf(hit) {
    return (Array.isArray(hit?.tags) ? hit.tags : []).map(tagName).filter(Boolean);
}

function parseCompanionId(query) {
    const value = String(query || '').trim();
    const urlMatch = value.match(/saucepan\.ai\/companion\/([0-9a-f-]{20,})/i);
    if (urlMatch) return urlMatch[1];
    return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value) ? value : '';
}

function parseCreatorHandle(query) {
    const value = String(query || '').trim();
    const urlMatch = value.match(/saucepan\.ai\/(?:profile\/|user\/|@)([A-Za-z0-9_.-]+)/i);
    return (urlMatch?.[1] || value.replace(/^@/, '')).trim();
}

function sortCreatorCharacters(characters, sort) {
    const list = [...characters];
    switch (sort) {
        case 'oldest': return list.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        case 'popular': return list.sort((a, b) => getChatCount(b) - getChatCount(a));
        case 'name_asc': return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        case 'name_desc': return list.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        default: return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }
}

function normalizedFollow(entry, index = 0) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        const handle = parseCreatorHandle(entry);
        return handle ? { id: handle.toLowerCase(), handle, name: handle, followedAt: index } : null;
    }
    const handle = parseCreatorHandle(entry.handle || entry.name || entry.username || '');
    if (!handle) return null;
    return {
        id: String(entry.id || handle).toLowerCase(),
        handle,
        name: entry.name || handle,
        avatar: entry.avatar || '',
        characterCount: entry.characterCount,
        followedAt: entry.followedAt ?? index,
    };
}

export class SaucepanBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        this._characters = [];
        this._followingCharacters = [];
        this._followingVisible = FOLLOWING_PAGE_SIZE;
        this._mode = 'browse';
        this._sort = 'saucepan_new';
        this._followingSort = 'newest';
        this._page = 1;
        this._totalPages = 0;
        this._hasMore = true;
        this._loading = false;
        this._loadToken = 0;
        this._active = false;
        this._search = '';
        this._creator = null;
        this._creatorFullList = [];
        this._openDefinitionsOnly = true;
        this._nsfw = false;
        this._hideOwned = false;
        this._hidePossible = false;
        this._tagStates = new Map();
        this._discoveredTags = new Set();
        this._selectedHit = null;
        this._selectedResolution = null;
        this._detailToken = 0;
        this._delegates = [];
        this._modalEventsAttached = false;
    }

    get previewModalId() { return 'saucepanCharModal'; }
    get hasModeToggle() { return true; }
    get supportsFollowingManager() { return true; }

    get mobileFilterIds() {
        return {
            sort: 'saucepanSortSelect',
            timelineSort: 'saucepanFollowingSortSelect',
            tags: 'saucepanTagsBtn',
            filters: 'saucepanFiltersBtn',
            nsfw: 'saucepanNsfwToggle',
            refresh: 'saucepanRefreshBtn',
            modeBrowseSelector: '.saucepan-view-btn[data-saucepan-view="browse"]',
            modeFollowSelector: '.saucepan-view-btn[data-saucepan-view="following"]',
            modeBtnClass: 'saucepan-view-btn',
        };
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'saucepan_new', label: '🆕 New' },
                { value: 'saucepan_trending', label: '🔥 Trending' },
                { value: 'saucepan_popular', label: '👑 Popular' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'popular', label: 'Popular' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'saucepanCreatorSearchInput' : 'saucepanSearchInput';
    }

    _getImageGridIds() { return ['saucepanGrid', 'saucepanFollowingGrid']; }

    _extractProviderIds(char, idSet) {
        const extensions = char?.data?.extensions || char?.extensions || {};
        const data = extensions.saucepan;
        if (data?.id) idSet.add(String(data.id));
        const legacy = extensions.datacat;
        if (legacy?.sourceKind === 'saucepan' && legacy.id) idSet.add(String(legacy.id));
    }

    _isInLibrary(hit) {
        const id = getCharId(hit);
        if (id && this._lookup.byProviderId.has(String(id))) return true;
        const name = (hit?.name || '').toLowerCase().trim();
        const creator = getCreatorName(hit).toLowerCase().trim();
        return !!(name && creator && this._lookup.byNameAndCreator.has(`${name}|${creator}`));
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const hit = this._findHit(card.dataset.saucepanId);
            return !!hit && this._isInLibrary(hit);
        }, this._getImageGridIds());
    }

    canLoadMore() {
        if (this._loading) return false;
        if (this._mode === 'following') return this._followingVisible < this._filteredFollowing().length;
        if (this._creator) return this._characters.length < this._creatorFullList.length;
        return this._hasMore;
    }

    async loadMore() {
        if (!this.canLoadMore()) return;
        if (this._mode === 'following') {
            this._followingVisible += FOLLOWING_PAGE_SIZE;
            this._renderFollowing(true);
            return;
        }
        if (this._creator) {
            const next = this._creatorFullList.slice(this._characters.length, this._characters.length + PAGE_SIZE);
            this._characters.push(...next);
            this._renderGrid(true);
            return;
        }
        this._page++;
        await this._loadBrowse(true);
    }

    renderFilterBar() {
        return `
            <div class="saucepan-view-toggle">
                <button class="saucepan-view-btn active" data-saucepan-view="browse" title="Browse Saucepan"><i class="fa-solid fa-compass"></i> <span>Browse</span></button>
                <button class="saucepan-view-btn" data-saucepan-view="following" title="Characters from locally followed creators"><i class="fa-solid fa-users"></i> <span>Following</span></button>
            </div>
            <div class="browse-sort-container">
                <select id="saucepanSortSelect" class="glass-select" title="Sort Saucepan characters">
                    <option value="saucepan_new">🆕 New</option><option value="saucepan_trending">🔥 Trending</option><option value="saucepan_popular">👑 Popular</option>
                </select>
                <select id="saucepanFollowingSortSelect" class="glass-select hidden" title="Sort followed creators' characters">
                    <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="popular">Popular</option><option value="name_asc">Name A-Z</option><option value="name_desc">Name Z-A</option>
                </select>
            </div>
            <div class="browse-tags-dropdown-container saucepan-dropdown-wrap">
                <button id="saucepanTagsBtn" class="glass-btn" title="Include or exclude tags"><i class="fa-solid fa-tags"></i> <span id="saucepanTagsBtnLabel">Tags</span></button>
                <div id="saucepanTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row"><input id="saucepanTagsSearchInput" type="search" placeholder="Search tags..." autocomplete="one-time-code"><button id="saucepanTagsClearBtn" class="glass-btn icon-only" title="Clear tag filters"><i class="fa-solid fa-rotate-left"></i></button></div>
                    <div id="saucepanTagsList" class="browse-tags-list"></div>
                </div>
            </div>
            <div class="browse-more-filters saucepan-dropdown-wrap">
                <button id="saucepanFiltersBtn" class="glass-btn" title="Library filters"><i class="fa-solid fa-sliders"></i> <span>Features</span></button>
                <div id="saucepanFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    <div class="dropdown-section-title">Library</div>
                    <label class="filter-checkbox"><input id="saucepanFilterHideOwned" type="checkbox"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input id="saucepanFilterHidePossible" type="checkbox"> <i class="fa-solid fa-circle-exclamation"></i> Hide Possible Matches</label>
                </div>
            </div>
            <button id="saucepanNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content"><i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span></button>
            <button id="saucepanOpenDefToggle" class="glass-btn active" title="Show only open definitions"><i class="fa-solid fa-lock-open"></i> <span>Open Defs</span></button>
            <button id="saucepanRefreshBtn" class="glass-btn icon-only" title="Refresh"><i class="fa-solid fa-rotate"></i></button>`;
    }

    renderView() {
        return `
            <div id="saucepanBrowseSection" class="browse-section saucepan-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper"><i class="fa-solid fa-magnifying-glass"></i><input id="saucepanSearchInput" type="search" placeholder="Character name, UUID, or companion URL..." autocomplete="one-time-code"><button id="saucepanClearSearchBtn" class="browse-search-clear hidden" title="Clear"><i class="fa-solid fa-xmark"></i></button><button id="saucepanSearchBtn" class="browse-search-submit" title="Search"><i class="fa-solid fa-arrow-right"></i></button></div>
                    <div class="browse-creator-search"><div class="browse-creator-search-wrapper"><i class="fa-solid fa-user"></i><input id="saucepanCreatorSearchInput" type="search" placeholder="@handle, handle, or profile URL..." autocomplete="one-time-code"><button id="saucepanCreatorSearchBtn" class="browse-search-submit" title="Browse creator"><i class="fa-solid fa-arrow-right"></i></button></div></div>
                </div>
                <div id="saucepanCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content"><i class="fa-solid fa-user"></i><span>Browsing characters by <strong id="saucepanCreatorBannerName"></strong></span></div>
                    <div class="browse-author-banner-actions"><button id="saucepanFollowCreatorBtn" class="glass-btn" title="Follow creator"><i class="fa-regular fa-heart"></i> <span>Follow</span></button><a id="saucepanCreatorExternalBtn" class="glass-btn icon-only" target="_blank" rel="noopener noreferrer" title="Open Saucepan profile"><i class="fa-solid fa-arrow-up-right-from-square"></i></a><button id="saucepanClearCreatorBtn" class="glass-btn icon-only" title="Clear creator"><i class="fa-solid fa-xmark"></i></button></div>
                </div>
                <div id="saucepanGrid" class="browse-grid"></div>
                <div id="saucepanLoadMore" class="browse-load-more" style="display:none"><button id="saucepanLoadMoreBtn" class="glass-btn"><i class="fa-solid fa-plus"></i> Load More</button></div>
            </div>
            <div id="saucepanFollowingSection" class="browse-section saucepan-section hidden">
                <div class="saucepan-timeline-header"><div><h3><i class="fa-solid fa-clock"></i> Following</h3><p>Characters from locally followed Saucepan creators</p></div><button id="saucepanFollowMgrToggle" class="follow-mgr-toggle-btn glass-btn"><i class="fa-solid fa-users-gear"></i> Manage</button></div>
                ${this.renderFollowingManagerPanel()}
                <div id="saucepanFollowingGrid" class="browse-grid"></div>
                <div id="saucepanFollowingLoadMore" class="browse-load-more" style="display:none"><button id="saucepanFollowingLoadMoreBtn" class="glass-btn"><i class="fa-solid fa-plus"></i> Load More</button></div>
            </div>`;
    }

    renderModals() {
        const section = (id, title, icon, collapsed = false) => `
            <div id="saucepanChar${id}Section" class="browse-char-section${collapsed ? ' browse-section-collapsed' : ''}" style="display:none">
                <h3 class="browse-section-title" data-section="saucepanChar${id}" data-label="${title}" data-icon="${icon}"><i class="${icon}"></i> ${title}</h3>
                <div id="saucepanChar${id}" class="scrolling-text"></div>
            </div>`;
        return `
            <div id="saucepanCharModal" class="modal-overlay hidden">
                <div class="modal-glass browse-char-modal saucepan-char-modal">
                    <div class="modal-header">
                        <div class="browse-char-header-info"><img id="saucepanCharAvatar" class="browse-char-avatar" src="/img/ai4.png" alt=""><div><h2 id="saucepanCharName">Character</h2><p class="browse-char-meta">by <a id="saucepanCharCreator" class="browse-meta-identity" href="#">Creator</a></p></div></div>
                        <div class="modal-controls"><a id="saucepanOpenInBrowserBtn" class="action-btn secondary" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a><button id="saucepanImportBtn" class="action-btn primary"><i class="fa-solid fa-download"></i> Import</button><button id="saucepanCharClose" class="close-btn">&times;</button></div>
                    </div>
                    <div class="browse-char-body">
                        <div class="browse-char-meta-grid"><div class="browse-char-stats"><div class="browse-stat"><i class="fa-solid fa-comments"></i> <span id="saucepanCharChats">0</span> chats</div><div class="browse-stat"><i class="fa-solid fa-envelope"></i> <span id="saucepanCharMessages">0</span> messages</div><div class="browse-stat"><i class="fa-solid fa-text-width"></i> <span id="saucepanCharTokens">0</span> tokens</div><div class="browse-stat"><i class="fa-solid fa-calendar"></i> <span id="saucepanCharDate">Unknown</span></div><div class="browse-stat" id="saucepanCharLorebookStat" style="display:none"><i class="fa-solid fa-book"></i> <span id="saucepanCharLorebooksStatCount">0</span> lorebooks</div><div class="browse-stat" id="saucepanCharSourceStat" style="display:none"><i class="fa-solid fa-bowl-food"></i> <span id="saucepanCharSourceLabel">Native</span></div><div class="browse-stat" id="saucepanCharLockStat" style="display:none"><i class="fa-solid fa-lock"></i> Locked</div></div><div id="saucepanCharTags" class="browse-char-tags"></div></div>
                        <div id="saucepanCharDefinitionLoading" class="browse-char-section"><i class="fa-solid fa-spinner fa-spin"></i> Resolving native card and fallback sources...</div>
                        ${section('CreatorNotes', "Creator's Notes", 'fa-solid fa-feather-pointed')}
                        ${section('Description', 'Description', 'fa-solid fa-scroll')}
                        ${section('Scenario', 'Scenario', 'fa-solid fa-masks-theater')}
                        ${section('Examples', 'Example Messages', 'fa-solid fa-comments', true)}
                        ${section('FirstMessage', 'First Message', 'fa-solid fa-message')}
                        <div id="saucepanCharAltGreetingsSection" class="browse-char-section" style="display:none"><h3 class="browse-section-title"><i class="fa-solid fa-comments"></i> Alternate Greetings <span id="saucepanCharAltGreetingsCount" class="browse-section-count"></span></h3><div id="saucepanCharAltGreetings" class="browse-alt-greetings-list"></div></div>
                        <div id="saucepanCharLorebooksSection" class="browse-char-section" style="display:none"><h3 class="browse-section-title"><i class="fa-solid fa-book"></i> Linked Lorebooks <span id="saucepanCharLorebooksCount" class="browse-section-count"></span></h3><div id="saucepanCharLorebooks" class="saucepan-lorebooks-list"></div></div>
                        <div id="saucepanCharGallerySection" class="browse-char-section" style="display:none"><h3 class="browse-section-title"><i class="fa-solid fa-images"></i> Portrait Gallery <span id="saucepanCharGalleryCount" class="browse-section-count"></span></h3><div id="saucepanCharGallery" class="browse-gallery-grid"></div></div>
                    </div>
                </div>
            </div>`;
    }

    init() {
        super.init();
        this._wireView();
        this._wireModal();
        this._registerDropdownDismiss([
            { dropdownId: 'saucepanTagsDropdown', buttonId: 'saucepanTagsBtn' },
            { dropdownId: 'saucepanFiltersDropdown', buttonId: 'saucepanFiltersBtn' },
        ]);
    }

    applyDefaults(defaults = {}) {
        if (defaults.view === 'following') this._mode = 'following';
        if (defaults.sort) {
            if (this._mode === 'following') this._followingSort = defaults.sort;
            else this._sort = defaults.sort;
        }
        this._hideOwned = defaults.hideOwned === true;
        this._hidePossible = defaults.hidePossible === true;
        this._syncControls();
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            this._clearDelegates();
            this._characters = [];
            this._followingCharacters = [];
            this._initialized = false;
        }
        super.activate(container, options);
        this._active = true;
        this._nsfw = getSetting('saucepanNsfw') === true;
        this._openDefinitionsOnly = getSetting('saucepanOpenDefinitionOnly') !== false;
        this.buildLocalLibraryLookup();
        this._syncControls();
        if (this._mode === 'following') {
            this._switchMode('following', this._followingCharacters.length === 0);
        } else if (this._characters.length === 0) {
            this._loadBrowse(false);
        } else {
            this._renderGrid(false);
        }
    }

    deactivate() {
        this._active = false;
        this._loadToken++;
        this.closePreview();
        this.disconnectImageObserver();
        super.deactivate();
    }

    closePreview() {
        this._detailToken++;
        BrowseView.closeAvatarViewer();
        CoreAPI.setBrowseAltGreetings?.(null);
        cleanupCreatorNotesContainer?.(document.getElementById('saucepanCharCreatorNotes'));
        document.getElementById('saucepanCharModal')?.classList.add('hidden');
        this._selectedHit = null;
        this._selectedResolution = null;
    }

    closeDropdowns() {
        document.getElementById('saucepanTagsDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFiltersDropdown')?.classList.add('hidden');
    }

    async getFollowedCreators() {
        return this._readFollows();
    }

    async followCreator(query) {
        const handle = parseCreatorHandle(query);
        if (!handle) return null;
        try {
            const data = await fetchSaucepanCompanionsOfUser(handle);
            const characters = data?.characters || [];
            if (!characters.length) {
                showToast(`Saucepan creator "${handle}" was not found or has no characters`, 'warning');
                return null;
            }
            const hit = characters[0];
            const creator = {
                id: String(getCreatorId(hit) || handle).toLowerCase(),
                handle: getCreatorName(hit) || handle,
                name: getCreatorName(hit) || handle,
                characterCount: characters.length,
                followedAt: Date.now(),
            };
            const follows = this._readFollows();
            if (follows.some(item => item.id === creator.id || item.handle.toLowerCase() === creator.handle.toLowerCase())) {
                showToast(`Already following @${creator.handle}`, 'info');
                return null;
            }
            follows.push(creator);
            this._writeFollows(follows);
            this._updateFollowButton();
            showToast(`Following @${creator.handle}`, 'success');
            return creator;
        } catch (error) {
            showToast(`Could not follow creator: ${error.message}`, 'error');
            return null;
        }
    }

    async unfollowCreator(id) {
        const follows = this._readFollows();
        const next = follows.filter(item => item.id !== String(id).toLowerCase());
        if (next.length === follows.length) return false;
        this._writeFollows(next);
        this._updateFollowButton();
        if (this._mode === 'following') await this._loadFollowing();
        return true;
    }

    browseCreatorFromManager(creator) {
        this._switchMode('browse');
        this._browseCreator(creator.handle || creator.name);
    }

    async openAggregatedHit(hit) {
        if (!hit) return;
        const id = getCharId(hit);
        if (!id) {
            showToast('Saucepan character id is missing', 'warning');
            return;
        }
        const normalized = {
            ...hit,
            id,
            character_id: id,
            creator_name: getCreatorName(hit),
            creator_id: getCreatorId(hit),
            primary_content_source_kind: 'saucepan',
            _source: 'saucepan',
        };
        await this._openPreview(normalized);
    }

    _readFollows() {
        const raw = getSetting('saucepanFollowedCreators');
        const list = Array.isArray(raw) ? raw : [];
        return list.map(normalizedFollow).filter(Boolean);
    }

    _writeFollows(follows) {
        setSetting('saucepanFollowedCreators', follows.map(item => ({
            id: item.id,
            handle: item.handle,
            name: item.name,
            avatar: item.avatar || '',
            characterCount: item.characterCount,
            followedAt: item.followedAt || Date.now(),
        })));
    }

    _listen(target, event, handler) {
        if (!target) return;
        target.addEventListener(event, handler);
        this._delegates.push(() => target.removeEventListener(event, handler));
    }

    _clearDelegates() {
        for (const cleanup of this._delegates.splice(0)) cleanup();
    }

    _wireView() {
        const byId = id => document.getElementById(id);
        this._listen(document.getElementById('onlineView'), 'click', event => this._handleGridClick(event));
        for (const button of document.querySelectorAll('.saucepan-view-btn')) {
            this._listen(button, 'click', () => this._switchMode(button.dataset.saucepanView, true));
        }
        const submitSearch = () => this._performCharacterSearch();
        const submitCreator = () => this._browseCreator(byId('saucepanCreatorSearchInput')?.value);
        this._listen(byId('saucepanSearchBtn'), 'click', submitSearch);
        this._listen(byId('saucepanCreatorSearchBtn'), 'click', submitCreator);
        this._listen(byId('saucepanSearchInput'), 'keydown', event => { if (event.key === 'Enter') submitSearch(); });
        this._listen(byId('saucepanCreatorSearchInput'), 'keydown', event => { if (event.key === 'Enter') submitCreator(); });
        this._listen(byId('saucepanSearchInput'), 'input', event => byId('saucepanClearSearchBtn')?.classList.toggle('hidden', !event.target.value.trim()));
        this._listen(byId('saucepanClearSearchBtn'), 'click', () => {
            byId('saucepanSearchInput').value = '';
            this._search = '';
            byId('saucepanClearSearchBtn').classList.add('hidden');
            this._resetBrowse();
        });
        this._listen(byId('saucepanSortSelect'), 'change', event => { this._sort = event.target.value; this._resetBrowse(); });
        this._listen(byId('saucepanFollowingSortSelect'), 'change', event => { this._followingSort = event.target.value; this._renderFollowing(false); });
        this._listen(byId('saucepanTagsBtn'), 'click', event => { event.stopPropagation(); this.closeDropdowns(); byId('saucepanTagsDropdown')?.classList.toggle('hidden'); this._renderTags(); });
        this._listen(byId('saucepanFiltersBtn'), 'click', event => { event.stopPropagation(); const dropdown = byId('saucepanFiltersDropdown'); const opening = dropdown?.classList.contains('hidden'); this.closeDropdowns(); if (opening) dropdown?.classList.remove('hidden'); });
        this._listen(byId('saucepanTagsSearchInput'), 'input', event => this._renderTags(event.target.value));
        this._listen(byId('saucepanTagsClearBtn'), 'click', () => { this._tagStates.clear(); this._renderTags(); this._updateFilterControls(); this._resetBrowse(); });
        this._listen(byId('saucepanFilterHideOwned'), 'change', event => { this._hideOwned = event.target.checked; this._rerenderCurrent(); });
        this._listen(byId('saucepanFilterHidePossible'), 'change', event => { this._hidePossible = event.target.checked; this._rerenderCurrent(); });
        this._listen(byId('saucepanNsfwToggle'), 'click', () => { this._nsfw = !this._nsfw; setSetting('saucepanNsfw', this._nsfw); this._updateFilterControls(); this._rerenderCurrent(); });
        this._listen(byId('saucepanOpenDefToggle'), 'click', () => { this._openDefinitionsOnly = !this._openDefinitionsOnly; setSetting('saucepanOpenDefinitionOnly', this._openDefinitionsOnly); this._updateFilterControls(); this._resetBrowse(); });
        this._listen(byId('saucepanRefreshBtn'), 'click', () => this._mode === 'following' ? this._loadFollowing() : this._resetBrowse());
        this._listen(byId('saucepanLoadMoreBtn'), 'click', () => this.loadMore());
        this._listen(byId('saucepanFollowingLoadMoreBtn'), 'click', () => this.loadMore());
        this._listen(byId('saucepanClearCreatorBtn'), 'click', () => { this._creator = null; this._creatorFullList = []; this._search = ''; this._syncCreatorBanner(); this._resetBrowse(); });
        this._listen(byId('saucepanFollowCreatorBtn'), 'click', () => this._toggleCurrentCreatorFollow());
        for (const select of [byId('saucepanSortSelect'), byId('saucepanFollowingSortSelect')]) CoreAPI.initCustomSelect?.(select);
    }

    _wireModal() {
        if (this._modalEventsAttached) return;
        this._modalEventsAttached = true;
        const modal = document.getElementById('saucepanCharModal');
        document.getElementById('saucepanCharClose')?.addEventListener('click', () => this.closePreview());
        document.getElementById('saucepanImportBtn')?.addEventListener('click', () => this._importSelected());
        document.getElementById('saucepanCharCreator')?.addEventListener('click', event => {
            event.preventDefault();
            const handle = getCreatorName(this._selectedHit);
            this.closePreview();
            this._switchMode('browse');
            this._browseCreator(handle);
        });
        modal?.addEventListener('click', event => { if (event.target === modal) this.closePreview(); });
        window.registerOverlay?.({ id: 'saucepanCharModal', tier: 7, close: () => this.closePreview() });
    }

    _syncControls() {
        const browseSort = document.getElementById('saucepanSortSelect');
        const followingSort = document.getElementById('saucepanFollowingSortSelect');
        if (browseSort) browseSort.value = this._sort;
        if (followingSort) followingSort.value = this._followingSort;
        document.getElementById('saucepanFilterHideOwned').checked = this._hideOwned;
        document.getElementById('saucepanFilterHidePossible').checked = this._hidePossible;
        this._updateFilterControls();
        this._syncModeDom();
    }

    _syncModeDom() {
        const following = this._mode === 'following';
        document.querySelectorAll('.saucepan-view-btn').forEach(button => button.classList.toggle('active', button.dataset.saucepanView === this._mode));
        document.getElementById('saucepanBrowseSection')?.classList.toggle('hidden', following);
        document.getElementById('saucepanFollowingSection')?.classList.toggle('hidden', !following);
        const browseSort = document.getElementById('saucepanSortSelect');
        const followingSort = document.getElementById('saucepanFollowingSortSelect');
        (browseSort?._customSelect?.container || browseSort)?.classList.toggle('hidden', following);
        (followingSort?._customSelect?.container || followingSort)?.classList.toggle('hidden', !following);
        document.getElementById('saucepanTagsBtn')?.closest('.browse-tags-dropdown-container')?.classList.toggle('hidden', following);
        document.getElementById('saucepanOpenDefToggle')?.classList.toggle('hidden', following);
    }

    async _switchMode(mode, load = false) {
        if (!['browse', 'following'].includes(mode)) return;
        this._mode = mode;
        this.closeDropdowns();
        this._syncModeDom();
        if (load) {
            if (mode === 'following') await this._loadFollowing();
            else if (!this._characters.length) await this._loadBrowse(false);
        }
    }

    _updateFilterControls() {
        const nsfw = document.getElementById('saucepanNsfwToggle');
        if (nsfw) {
            nsfw.classList.toggle('active', this._nsfw);
            nsfw.innerHTML = this._nsfw ? '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>' : '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        }
        const openDef = document.getElementById('saucepanOpenDefToggle');
        if (openDef) {
            openDef.classList.toggle('active', this._openDefinitionsOnly);
            openDef.innerHTML = this._openDefinitionsOnly ? '<i class="fa-solid fa-lock-open"></i> <span>Open Defs</span>' : '<i class="fa-solid fa-lock"></i> <span>All Defs</span>';
        }
        const count = [...this._tagStates.values()].filter(Boolean).length;
        document.getElementById('saucepanTagsBtn')?.classList.toggle('has-filters', count > 0);
        const label = document.getElementById('saucepanTagsBtnLabel');
        if (label) label.textContent = count ? `Tags (${count})` : 'Tags';
        document.getElementById('saucepanFiltersBtn')?.classList.toggle('has-filters', this._hideOwned || this._hidePossible);
    }

    _renderTags(filter = '') {
        const list = document.getElementById('saucepanTagsList');
        if (!list) return;
        const query = filter.trim().toLowerCase();
        const tags = [...new Set([...CURATED_TAGS, ...this._discoveredTags])].sort().filter(tag => !query || tag.toLowerCase().includes(query));
        list.innerHTML = tags.length ? tags.map(tag => {
            const state = this._tagStates.get(tag) || 'neutral';
            const icon = state === 'include' ? 'fa-plus' : state === 'exclude' ? 'fa-minus' : '';
            return `<div class="browse-tag-filter-item" data-saucepan-tag="${escapeHtml(tag)}"><button class="browse-tag-state-btn state-${state}" title="Neutral, include, exclude">${icon ? `<i class="fa-solid ${icon}"></i>` : ''}</button><span class="tag-label">${escapeHtml(tag)}</span></div>`;
        }).join('') : '<div class="browse-tags-empty">No matching tags</div>';
        list.querySelectorAll('[data-saucepan-tag]').forEach(item => item.addEventListener('click', () => {
            const tag = item.dataset.saucepanTag;
            const state = this._tagStates.get(tag) || 'neutral';
            const next = state === 'neutral' ? 'include' : state === 'include' ? 'exclude' : 'neutral';
            if (next === 'neutral') this._tagStates.delete(tag); else this._tagStates.set(tag, next);
            this._renderTags(document.getElementById('saucepanTagsSearchInput')?.value || '');
            this._updateFilterControls();
            this._resetBrowse();
        }));
    }

    async _performCharacterSearch() {
        const input = document.getElementById('saucepanSearchInput');
        const query = input?.value.trim() || '';
        const id = parseCompanionId(query);
        if (id) {
            await this.openAggregatedHit({ id, character_id: id, name: 'Saucepan Companion', _source: 'saucepan' });
            return;
        }
        this._creator = null;
        this._creatorFullList = [];
        this._search = query;
        this._syncCreatorBanner();
        await this._resetBrowse();
    }

    async _browseCreator(query) {
        const handle = parseCreatorHandle(query);
        if (!handle) return;
        this._switchMode('browse');
        this._creator = { handle, name: handle, id: handle.toLowerCase() };
        this._cdRef = { handle, name: handle };
        this._search = '';
        this._page = 1;
        this._syncCreatorBanner();
        await this._loadBrowse(false);
    }

    async browseCreator(query) {
        return this._browseCreator(query);
    }

    async _resetBrowse() {
        this._page = 1;
        this._hasMore = true;
        this._characters = [];
        await this._loadBrowse(false);
    }

    async _loadBrowse(append) {
        if (this._loading) return;
        const token = ++this._loadToken;
        this._loading = true;
        const grid = document.getElementById('saucepanGrid');
        if (!append && grid) renderSkeletonGrid(grid);
        this._setLoadButton('saucepanLoadMoreBtn', true);
        try {
            let list;
            if (this._creator) {
                if (!append || !this._creatorFullList.length) {
                    const data = await fetchSaucepanCompanionsOfUser(this._creator.handle);
                    this._creatorFullList = sortCreatorCharacters(data?.characters || [], this._sort === 'saucepan_popular' ? 'popular' : 'newest');
                    const first = this._creatorFullList[0];
                    if (first) {
                        this._creator = { id: String(getCreatorId(first) || this._creator.handle).toLowerCase(), handle: getCreatorName(first) || this._creator.handle, name: getCreatorName(first) || this._creator.name };
                        this._cdRef = { handle: this._creator.handle, name: this._creator.name };
                    }
                }
                list = this._creatorFullList.slice(append ? this._characters.length : 0, (append ? this._characters.length : 0) + PAGE_SIZE);
                this._hasMore = (append ? this._characters.length : 0) + list.length < this._creatorFullList.length;
            } else {
                const include = [], exclude = [...(getProviderExcludeTags('saucepan') || [])];
                for (const [tag, state] of this._tagStates) (state === 'include' ? include : exclude).push(tag);
                const data = await searchSaucepan({ search: this._search, page: this._page, limit: PAGE_SIZE, sort: this._sort, openDefinitionOnly: this._openDefinitionsOnly, tags: include, excludedTags: exclude });
                list = data?.characters || [];
                this._totalPages = data?.totalPages || 0;
                this._hasMore = this._page < this._totalPages;
            }
            if (token !== this._loadToken || !this._active) return;
            for (const hit of list) for (const tag of tagsOf(hit)) this._discoveredTags.add(tag);
            if (append) {
                const seen = new Set(this._characters.map(hit => String(getCharId(hit))));
                this._characters.push(...list.filter(hit => !seen.has(String(getCharId(hit)))));
            } else {
                this._characters = list;
            }
            this._syncCreatorBanner();
            this._renderGrid(append);
        } catch (error) {
            if (token !== this._loadToken) return;
            console.error('[SaucepanBrowse] Load failed:', error);
            showToast(`Saucepan load failed: ${error.message}`, 'error');
            if (!append && grid) grid.innerHTML = `<div class="saucepan-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${escapeHtml(error.message)}</p><button id="saucepanRetryBtn" class="glass-btn">Retry</button></div>`;
            document.getElementById('saucepanRetryBtn')?.addEventListener('click', () => this._loadBrowse(false));
        } finally {
            if (token === this._loadToken) {
                this._loading = false;
                this._setLoadButton('saucepanLoadMoreBtn', false);
            }
        }
    }

    _filtered(characters) {
        let list = this._nsfw ? [...characters] : characters.filter(hit => !isNsfw(hit));
        if (this._hideOwned) list = list.filter(hit => !this._isInLibrary(hit));
        if (this._hidePossible) list = list.filter(hit => this._isInLibrary(hit) || !this.isCharPossibleMatch(hit.name || '', getCreatorName(hit)));
        const persistent = (getProviderExcludeTags('saucepan') || []).map(tag => tag.toLowerCase());
        if (persistent.length) list = list.filter(hit => !tagsOf(hit).some(tag => persistent.includes(tag.toLowerCase())));
        return list;
    }

    _filteredFollowing() {
        return sortCreatorCharacters(this._filtered(this._followingCharacters), this._followingSort);
    }

    _renderGrid(append) {
        const grid = document.getElementById('saucepanGrid');
        if (!grid) return;
        const filtered = this._filtered(this._characters);
        const current = append ? grid.querySelectorAll('.browse-card').length : 0;
        if (!append) grid.innerHTML = '';
        grid.insertAdjacentHTML('beforeend', filtered.slice(current).map(hit => this._cardHtml(hit)).join(''));
        if (!grid.querySelector('.browse-card')) grid.innerHTML = '<div class="saucepan-empty"><i class="fa-solid fa-bowl-food"></i><p>No Saucepan characters match these filters.</p></div>';
        this.observeImages(grid);
        this.updateLoadMoreVisibility('saucepanLoadMore', this._hasMore, this._characters.length > 0);
    }

    _renderFollowing(append) {
        const grid = document.getElementById('saucepanFollowingGrid');
        if (!grid) return;
        const filtered = this._filteredFollowing();
        const visible = filtered.slice(0, this._followingVisible);
        const current = append ? grid.querySelectorAll('.browse-card').length : 0;
        if (!append) grid.innerHTML = '';
        grid.insertAdjacentHTML('beforeend', visible.slice(current).map(hit => this._cardHtml(hit)).join(''));
        if (!visible.length) grid.innerHTML = '<div class="saucepan-empty"><i class="fa-solid fa-user-plus"></i><p>Follow Saucepan creators to build this timeline.</p></div>';
        this.observeImages(grid);
        this.updateLoadMoreVisibility('saucepanFollowingLoadMore', this._followingVisible < filtered.length, visible.length > 0);
    }

    _cardHtml(hit) {
        const id = String(getCharId(hit));
        const name = hit.name || 'Unknown';
        const creator = getCreatorName(hit);
        const avatar = resolveSaucepanImageUrl(hit.avatar) || hit.avatar || '/img/ai4.png';
        const owned = this._isInLibrary(hit);
        const tier = owned ? null : this.getPossibleMatchTier(name, creator);
        const classes = owned ? 'browse-card in-library' : tier?.show ? 'browse-card possible-library' : 'browse-card';
        const badge = owned ? '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>' : tier?.show ? `<span class="browse-feature-badge possible-library pl-${tier.tier}" title="${tier.tooltip}"><i class="fa-solid fa-check"></i></span>` : '';
        return `<div class="${classes}" data-saucepan-id="${escapeHtml(id)}">
            <div class="browse-card-image"><img data-src="${escapeHtml(avatar)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">${isNsfw(hit) ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}${badge ? `<div class="browse-feature-badges">${badge}</div>` : ''}</div>
            <div class="browse-card-body"><div class="browse-card-name">${escapeHtml(name)}</div>${creator ? `<button class="browse-card-creator-link saucepan-creator-link" data-creator-id="${escapeHtml(String(getCreatorId(hit)))}" data-author="${escapeHtml(creator)}">${escapeHtml(creator)}</button>` : ''}<div class="browse-card-tags">${tagsOf(hit).slice(0, 3).map(tag => `<span class="browse-card-tag">${escapeHtml(tag)}</span>`).join('')}</div></div>
            <div class="browse-card-footer"><span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(getChatCount(hit))}</span><span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(getMsgCount(hit))}</span>${getCreatedDate(hit) ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${escapeHtml(getCreatedDate(hit))}</span>` : ''}</div>
        </div>`;
    }

    async _loadFollowing() {
        const token = ++this._loadToken;
        this._loading = true;
        this._followingVisible = FOLLOWING_PAGE_SIZE;
        const grid = document.getElementById('saucepanFollowingGrid');
        if (grid) renderSkeletonGrid(grid);
        try {
            const follows = this._readFollows();
            const results = await Promise.allSettled(follows.map(item => fetchSaucepanCompanionsOfUser(item.handle)));
            if (token !== this._loadToken || !this._active) return;
            const seen = new Set();
            this._followingCharacters = [];
            results.forEach((result, index) => {
                if (result.status !== 'fulfilled') return;
                const follow = follows[index];
                const list = result.value?.characters || [];
                follow.characterCount = list.length;
                for (const hit of list) {
                    const id = String(getCharId(hit));
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    this._followingCharacters.push(hit);
                }
            });
            if (follows.length) this._writeFollows(follows);
            this._renderFollowing(false);
        } finally {
            if (token === this._loadToken) this._loading = false;
        }
    }

    _handleGridClick(event) {
        const creator = event.target.closest('.saucepan-creator-link');
        if (creator) {
            event.preventDefault();
            event.stopPropagation();
            this._browseCreator(creator.dataset.author);
            return;
        }
        const card = event.target.closest('.browse-card[data-saucepan-id]');
        if (!card) return;
        const hit = this._findHit(card.dataset.saucepanId);
        if (hit) this._openPreview(hit);
    }

    _findHit(id) {
        return [...this._characters, ...this._followingCharacters].find(hit => String(getCharId(hit)) === String(id));
    }

    _syncCreatorBanner() {
        const banner = document.getElementById('saucepanCreatorBanner');
        banner?.classList.toggle('hidden', !this._creator);
        const name = document.getElementById('saucepanCreatorBannerName');
        if (name) name.textContent = this._creator?.name || '';
        const external = document.getElementById('saucepanCreatorExternalBtn');
        if (external) external.href = this._creator ? `https://saucepan.ai/@${encodeURIComponent(this._creator.handle)}` : '#';
        this._updateFollowButton();
    }

    _updateFollowButton() {
        const button = document.getElementById('saucepanFollowCreatorBtn');
        if (!button || !this._creator) return;
        const followed = this._readFollows().some(item => item.id === this._creator.id || item.handle.toLowerCase() === this._creator.handle.toLowerCase());
        button.classList.toggle('active', followed);
        button.innerHTML = followed ? '<i class="fa-solid fa-heart"></i> <span>Following</span>' : '<i class="fa-regular fa-heart"></i> <span>Follow</span>';
    }

    async _toggleCurrentCreatorFollow() {
        if (!this._creator) return;
        const follow = this._readFollows().find(item => item.id === this._creator.id || item.handle.toLowerCase() === this._creator.handle.toLowerCase());
        if (follow) await this.unfollowCreator(follow.id); else await this.followCreator(this._creator.handle);
    }

    async _openPreview(hit) {
        this.injectModals();
        this._wireModal();
        this._selectedHit = hit;
        this._selectedResolution = null;
        const modal = document.getElementById('saucepanCharModal');
        if (!modal) return;
        CoreAPI.resetBrowseSectionCollapseState?.(modal);
        const id = getCharId(hit);
        const name = hit.name || 'Saucepan Companion';
        const creator = getCreatorName(hit) || 'Unknown';
        const avatar = resolveSaucepanImageUrl(hit.avatar) || hit.avatar || '/img/ai4.png';
        document.getElementById('saucepanCharAvatar').src = avatar;
        document.getElementById('saucepanCharName').textContent = name;
        document.getElementById('saucepanCharCreator').textContent = creator;
        document.getElementById('saucepanOpenInBrowserBtn').href = `https://saucepan.ai/companion/${encodeURIComponent(id)}`;
        document.getElementById('saucepanCharChats').textContent = formatNumber(getChatCount(hit));
        document.getElementById('saucepanCharMessages').textContent = formatNumber(getMsgCount(hit));
        document.getElementById('saucepanCharTokens').textContent = formatNumber(getTotalTokens(hit));
        document.getElementById('saucepanCharDate').textContent = getCreatedDate(hit) || 'Unknown';
        const lorebookCount = hit.lorebook_count || 0;
        const lorebookStatEl = document.getElementById('saucepanCharLorebookStat');
        if (lorebookCount > 0 && lorebookStatEl) {
            lorebookStatEl.style.display = '';
            document.getElementById('saucepanCharLorebooksStatCount').textContent = formatNumber(lorebookCount);
        } else if (lorebookStatEl) {
            lorebookStatEl.style.display = 'none';
        }
        document.getElementById('saucepanCharTags').innerHTML = tagsOf(hit).map(tag => `<span class="browse-tag">${escapeHtml(tag)}</span>`).join('');
        document.getElementById('saucepanCharDefinitionLoading').style.display = '';
        document.getElementById('saucepanCharSourceStat')?.style.setProperty('display', 'none');
        document.getElementById('saucepanCharLockStat')?.style.setProperty('display', 'none');
        for (const section of modal.querySelectorAll('[id^="saucepanChar"][id$="Section"]')) if (section.id !== 'saucepanCharDefinitionLoading') section.style.display = 'none';
        const importButton = document.getElementById('saucepanImportBtn');
        importButton.disabled = true;
        importButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resolving...';
        modal.classList.remove('hidden');
        modal.querySelector('.browse-char-body').scrollTop = 0;
        const token = ++this._detailToken;
        try {
            const [resolution, lorebooks] = await Promise.all([
                resolveSaucepanCard(hit),
                fetchSaucepanLorebookList(id),
            ]);
            if (token !== this._detailToken) return;
            this._selectedResolution = resolution;
            this._populatePreview(resolution, lorebooks);
        } catch (error) {
            if (token !== this._detailToken) return;
            document.getElementById('saucepanCharDefinitionLoading').style.display = 'none';
            importButton.innerHTML = '<i class="fa-solid fa-ban"></i> Unavailable';
        }
    }

    _populatePreview(resolution, lorebooks) {
        const cardData = resolution?.card?.data || {};
        const listing = resolution?.listing || this._selectedHit || {};
        const companion = resolution?.companion || {};
        const name = cardData.name || companion.display_name || listing.name || 'Saucepan Companion';
        const creator = cardData.creator || companion.author_handle || getCreatorName(listing) || 'Unknown';
        this._selectedHit = { ...listing, name, creator_name: creator, character_id: getCharId(listing) };
        document.getElementById('saucepanCharName').textContent = name;
        document.getElementById('saucepanCharCreator').textContent = creator;
        document.getElementById('saucepanCharDefinitionLoading').style.display = 'none';
        const lockStat = document.getElementById('saucepanCharLockStat');
        if (lockStat) lockStat.style.display = resolution?.locked ? '' : 'none';
        const sourceStat = document.getElementById('saucepanCharSourceStat');
        const sourceLabel = document.getElementById('saucepanCharSourceLabel');
        const sourceText = resolution?.source === 'native'
            ? 'Native'
            : resolution?.source?.startsWith('datacat-') ? 'Fallback' : '';
        if (sourceStat && sourceLabel && sourceText) {
            sourceStat.style.display = '';
            sourceLabel.textContent = sourceText;
        } else if (sourceStat) {
            sourceStat.style.display = 'none';
        }
        this._renderRichSection('CreatorNotes', cardData.creator_notes || listing.description || '', name, true);
        this._renderRichSection('Description', cardData.description || '', name);
        this._renderRichSection('Scenario', cardData.scenario || '', name);
        this._renderRichSection('Examples', cardData.mes_example || '', name);
        this._renderRichSection('FirstMessage', cardData.first_mes || '', name);
        this._renderAltGreetings(cardData.alternate_greetings || [], name);
        this._renderLorebooks(lorebooks, cardData.character_book);
        this._renderPortraits(resolution?.portraits || [], name);
        const lorebookStatEl = document.getElementById('saucepanCharLorebookStat');
        const resolvedLorebookCount = lorebooks.length || (cardData.character_book?.entries?.length || 0);
        if (resolvedLorebookCount > 0 && lorebookStatEl) {
            lorebookStatEl.style.display = '';
            document.getElementById('saucepanCharLorebooksStatCount').textContent = formatNumber(resolvedLorebookCount);
        } else if (lorebookStatEl) {
            lorebookStatEl.style.display = 'none';
        }
        const importButton = document.getElementById('saucepanImportBtn');
        const owned = this._isInLibrary(this._selectedHit);
        importButton.disabled = !resolution?.card;
        importButton.classList.toggle('secondary', owned);
        importButton.classList.toggle('primary', !owned);
        importButton.innerHTML = !resolution?.card ? '<i class="fa-solid fa-ban"></i> Unavailable' : owned ? '<i class="fa-solid fa-check"></i> In Library' : '<i class="fa-solid fa-download"></i> Import';
    }

    _renderRichSection(id, text, name, creatorNotes = false) {
        const section = document.getElementById(`saucepanChar${id}Section`);
        const element = document.getElementById(`saucepanChar${id}`);
        if (!section || !element || !String(text || '').trim()) {
            if (section) section.style.display = 'none';
            return;
        }
        section.style.display = '';
        element.innerHTML = skeletonLines(3);
        if (creatorNotes) deferCall(element, () => renderCreatorNotesSecure(text, name, element));
        else deferRender(element, () => safePurify(formatRichText(text, name, true), BROWSE_PURIFY_CONFIG));
    }

    _renderAltGreetings(greetings, name) {
        const section = document.getElementById('saucepanCharAltGreetingsSection');
        const list = document.getElementById('saucepanCharAltGreetings');
        if (!Array.isArray(greetings) || !greetings.length) { section.style.display = 'none'; list.innerHTML = ''; return; }
        section.style.display = '';
        document.getElementById('saucepanCharAltGreetingsCount').textContent = `(${greetings.length})`;
        list.innerHTML = greetings.map((greeting, index) => `<details class="browse-alt-greeting" data-index="${index}"><summary><span class="browse-alt-greeting-index">#${index + 1}</span><span class="browse-alt-greeting-preview">${escapeHtml(String(greeting).replace(/\s+/g, ' ').slice(0, 100))}</span><i class="fa-solid fa-chevron-down"></i></summary><div class="browse-alt-greeting-body"></div></details>`).join('');
        list.querySelectorAll('details').forEach(details => details.addEventListener('toggle', () => {
            const body = details.querySelector('.browse-alt-greeting-body');
            if (details.open && !body.dataset.rendered) {
                body.dataset.rendered = '1';
                deferRender(body, () => safePurify(formatRichText(greetings[Number(details.dataset.index)], name, true), BROWSE_PURIFY_CONFIG));
            }
        }));
        CoreAPI.setBrowseAltGreetings?.(greetings);
    }

    _renderLorebooks(lorebooks, characterBook) {
        const section = document.getElementById('saucepanCharLorebooksSection');
        const list = document.getElementById('saucepanCharLorebooks');
        let entries = Array.isArray(lorebooks) ? lorebooks : [];
        if (!entries.length && characterBook?.entries?.length) entries = [{ title: characterBook.name || 'Embedded lorebook', entryCount: characterBook.entries.length }];
        if (!entries.length) { section.style.display = 'none'; list.innerHTML = ''; return; }
        section.style.display = '';
        document.getElementById('saucepanCharLorebooksCount').textContent = `(${entries.length})`;
        list.innerHTML = entries.map(entry => `<div class="saucepan-lorebook-row"><i class="fa-solid fa-book"></i><div><strong>${escapeHtml(entry.title || entry.name || 'Untitled lorebook')}</strong>${entry.user_name ? `<span>by @${escapeHtml(entry.user_name)}</span>` : ''}${entry.entryCount ? `<span>${entry.entryCount} entries</span>` : ''}</div></div>`).join('');
    }

    _renderPortraits(portraits, name) {
        const section = document.getElementById('saucepanCharGallerySection');
        const grid = document.getElementById('saucepanCharGallery');
        const urls = portraits.map(item => resolveSaucepanImageUrl(item.url || item)).filter(Boolean);
        if (!urls.length) { section.style.display = 'none'; grid.innerHTML = ''; return; }
        section.style.display = '';
        document.getElementById('saucepanCharGalleryCount').textContent = `(${urls.length})`;
        grid.innerHTML = urls.map((url, index) => `<button class="browse-gallery-cell" data-index="${index}" title="Open portrait ${index + 1}"><img class="browse-gallery-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(name)} portrait ${index + 1}" loading="lazy"></button>`).join('');
        grid.querySelectorAll('[data-index]').forEach(button => button.addEventListener('click', () => BrowseView.openAvatarViewer(urls[Number(button.dataset.index)], null, urls, Number(button.dataset.index))));
    }

    async _importSelected() {
        const resolution = this._selectedResolution;
        const hit = this._selectedHit;
        if (!resolution?.card || !hit) return;
        const button = document.getElementById('saucepanImportBtn');
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        try {
            const provider = this.provider?.importCharacter ? this.provider : CoreAPI.getProvider('saucepan');
            if (!provider?.importCharacter) throw new Error('Saucepan provider is not available');
            const card = resolution.card;
            const duplicateMatches = await checkCharacterForDuplicatesAsync({
                name: card.data.name || hit.name || '',
                creator: card.data.creator || getCreatorName(hit),
                fullPath: String(getCharId(hit)),
                description: card.data.description || '',
                first_mes: card.data.first_mes || '',
                scenario: card.data.scenario || '',
            });
            let inheritedGalleryId = null;
            if (duplicateMatches?.length) {
                const decision = await showPreImportDuplicateWarning({ name: card.data.name, creator: card.data.creator, fullPath: String(getCharId(hit)), avatarUrl: hit.avatar || '/img/ai4.png' }, duplicateMatches);
                if (decision.choice === 'skip') { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-download"></i> Import'; return; }
                if (decision.choice === 'replace') {
                    inheritedGalleryId = getCharacterGalleryId(duplicateMatches[0].char);
                    await deleteCharacter(duplicateMatches[0].char, false);
                }
            }
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
            const payload = { ...hit, _resolvedSaucepan: resolution, card, characterCard: card };
            const result = await provider.importCharacter(String(getCharId(hit)), payload, { inheritedGalleryId });
            if (!result?.success) throw new Error(result?.error || 'Import failed');
            const mediaUrls = result.embeddedMediaUrls || [];
            const galleryPageUrls = result.galleryPageUrls || [];
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{ name: result.characterName, provider, linkInfo: { providerId: 'saucepan', id: result.providerCharId || getCharId(hit) }, url: `https://saucepan.ai/companion/${getCharId(hit)}`, avatar: result.fileName, galleryId: result.galleryId, cardData: result.cardData }] : [],
                mediaCharacters: (mediaUrls.length || galleryPageUrls.length) ? [{ characterName: result.characterName, name: result.characterName, fileName: result.fileName, avatar: result.fileName, galleryId: result.galleryId, mediaUrls, galleryPageUrls, cardData: result.cardData }] : [],
            };
            const showSummary = (result.hasGallery || mediaUrls.length || galleryPageUrls.length) && getSetting('importMediaAction') !== 'none';
            await finishBrowseImport({ view: this, summaryArgs, showSummary, closePreview: () => this.closePreview(), importBtn: button, characterName: result.characterName, avatarFileName: result.fileName, markImported: () => this._markImported(getCharId(hit)) });
        } catch (error) {
            console.error('[SaucepanBrowse] Import failed:', error);
            showToast(`Import failed: ${error.message}`, 'error');
            button.disabled = false;
            button.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }

    _markImported(id) {
        for (const gridId of this._getImageGridIds()) {
            const card = document.getElementById(gridId)?.querySelector(`[data-saucepan-id="${CSS.escape(String(id))}"]`);
            if (!card) continue;
            card.classList.add('in-library');
            card.classList.remove('possible-library');
        }
    }

    _rerenderCurrent() {
        if (this._mode === 'following') this._renderFollowing(false); else this._renderGrid(false);
        this._updateFilterControls();
    }

    _setLoadButton(id, loading) {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = loading;
        button.innerHTML = loading ? '<i class="fa-solid fa-spinner fa-spin"></i> Loading...' : '<i class="fa-solid fa-plus"></i> Load More';
    }
}

const saucepanBrowseView = new SaucepanBrowseView();

export default saucepanBrowseView;
