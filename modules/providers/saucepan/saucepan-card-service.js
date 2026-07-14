const dependencyNames = [
    'fetchSaucepanCompanion',
    'fetchSaucepanV2Card',
    'hasSaucepanToken',
    'fetchDatacatCharacter',
    'fetchDatacatDownload',
    'buildV2FromDatacat',
    'buildV2FromDownload',
    'hasUnfetchedLorebook',
    'hydrateDatacatScripts',
];

async function resolveDependencies(injected) {
    if (dependencyNames.every(name => typeof injected[name] === 'function')) {
        return { now: () => new Date().toISOString(), ...injected };
    }

    const [saucepanApi, datacatApi] = await Promise.all([
        import('./saucepan-api.js'),
        import('../datacat/datacat-api.js'),
    ]);
    return {
        fetchSaucepanCompanion: saucepanApi.fetchSaucepanCompanion,
        fetchSaucepanV2Card: saucepanApi.fetchSaucepanV2Card,
        hasSaucepanToken: saucepanApi.hasSaucepanToken,
        fetchDatacatCharacter: datacatApi.fetchDatacatCharacter,
        fetchDatacatDownload: datacatApi.fetchDatacatDownload,
        buildV2FromDatacat: datacatApi.buildV2FromDatacat,
        buildV2FromDownload: datacatApi.buildV2FromDownload,
        hasUnfetchedLorebook: datacatApi.hasUnfetchedLorebook,
        hydrateDatacatScripts: datacatApi.hydrateDatacatScripts,
        now: () => new Date().toISOString(),
        ...injected,
    };
}

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '') ?? null;
}

function normalizeListing(hitOrId) {
    const input = hitOrId && typeof hitOrId === 'object' ? hitOrId : {};
    const id = String(firstValue(input.characterId, input.character_id, input.id, hitOrId) || '').trim();
    if (!id) throw new TypeError('Saucepan card resolver requires a character id');

    return {
        ...input,
        id,
        character_id: id,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
    };
}

function listingFromCompanion(listing, companion) {
    if (!companion) return listing;
    return {
        ...listing,
        id: companion.id || listing.id,
        character_id: companion.id || listing.character_id,
        name: companion.name || listing.name || 'Unknown',
        display_name: companion.display_name || companion.name || listing.display_name || listing.name || 'Unknown',
        avatar: companion.image?.highres_url || companion.image?.url || listing.avatar || '',
        description: companion.short_description || listing.description || '',
        tags: Array.isArray(companion.tags) ? companion.tags : (listing.tags || []),
        creator_id: companion.author_id || listing.creator_id || listing.author_id || '',
        creator_name: companion.author_handle || listing.creator_name || listing.author_handle || '',
    };
}

function extractPortraits(...sources) {
    const portraits = [];
    const seen = new Set();
    for (const source of sources) {
        const entries = source?.companion_snapshot?.portraits || source?.portraits;
        if (!Array.isArray(entries)) continue;
        for (const portrait of entries) {
            const image = portrait?.image || portrait;
            const url = image?.highres_url || image?.url;
            if (!url || seen.has(url)) continue;
            seen.add(url);
            portraits.push({ url, id: image?.id || portrait?.id || null });
        }
    }
    return portraits;
}

function toError(error, fallbackMessage) {
    if (error instanceof Error) return error;
    return new Error(error ? String(error) : fallbackMessage);
}

function combineErrors(errors) {
    if (errors.length === 0) return null;
    if (errors.length === 1) return errors[0];
    return new AggregateError(errors, errors.map(error => error.message).join('; '));
}

/**
 * Clone a V2 card and assign it exclusively to its canonical Saucepan owner.
 * DataCat metadata for other source kinds is retained as unrelated provenance.
 */
export function canonicalizeSaucepanCard(card, owner) {
    if (!card?.data || !owner?.id) return null;

    const extensions = { ...(card.data.extensions || {}) };
    if (extensions.datacat?.sourceKind === 'saucepan') delete extensions.datacat;

    const saucepan = {
        id: String(owner.id),
        ...(owner.creatorId ? { creatorId: owner.creatorId } : {}),
        ...(owner.creatorName ? { creatorName: owner.creatorName } : {}),
        ...(owner.pageName ? { pageName: owner.pageName } : {}),
        linkedAt: owner.linkedAt,
    };

    return {
        ...card,
        data: {
            ...card.data,
            extensions: { ...extensions, saucepan },
        },
    };
}

/** Resolve a Saucepan card through native extraction, DataCat download, then metadata. */
export async function resolveSaucepanCard(hitOrId, injectedDependencies = {}) {
    const deps = await resolveDependencies(injectedDependencies);
    let listing = normalizeListing(hitOrId);
    const id = listing.character_id;
    let companion = null;
    let datacatCharacter = null;
    let nativeError = null;
    const fallbackErrors = [];

    try {
        companion = await deps.fetchSaucepanCompanion(id);
        listing = listingFromCompanion(listing, companion);
    } catch (error) {
        nativeError = toError(error, 'Saucepan companion detail failed');
    }

    let card = null;
    let source = null;
    const canFetchNative = deps.hasSaucepanToken();
    if (canFetchNative) {
        try {
            card = await deps.fetchSaucepanV2Card(listing);
            if (card) source = 'native';
            else nativeError ||= new Error('Native Saucepan card was unavailable');
        } catch (error) {
            nativeError = toError(error, 'Native Saucepan card fetch failed');
        }
    }

    let download = null;
    if (!card) {
        try {
            download = await deps.fetchDatacatDownload(id, 'saucepan');
        } catch (error) {
            fallbackErrors.push(toError(error, 'DataCat download failed'));
        }

        try {
            datacatCharacter = await deps.fetchDatacatCharacter(id, 'saucepan');
            if (datacatCharacter) await deps.hydrateDatacatScripts(datacatCharacter);
        } catch (error) {
            fallbackErrors.push(toError(error, 'DataCat metadata failed'));
        }

        if (download?.data) {
            try {
                card = deps.buildV2FromDownload(download, datacatCharacter);
                if (card) source = 'datacat-download';
            } catch (error) {
                fallbackErrors.push(toError(error, 'DataCat download card build failed'));
            }
        }

        if (!card && datacatCharacter) {
            try {
                card = deps.buildV2FromDatacat(datacatCharacter);
                if (card) source = 'datacat-metadata';
            } catch (error) {
                fallbackErrors.push(toError(error, 'DataCat metadata card build failed'));
            }
        }
    }

    const owner = {
        id,
        creatorId: firstValue(companion?.author_id, listing.creator_id, listing.author_id, datacatCharacter?.creator_id, datacatCharacter?.creatorId),
        creatorName: firstValue(companion?.author_handle, listing.creator_name, listing.author_handle, datacatCharacter?.creator_name, datacatCharacter?.creatorName),
        pageName: firstValue(companion?.display_name, companion?.name, listing.display_name, listing.name, datacatCharacter?.chat_name, datacatCharacter?.name),
        linkedAt: firstValue(card?.data?.extensions?.saucepan?.linkedAt, card?.data?.extensions?.datacat?.linkedAt, deps.now()),
    };

    if (card) {
        card = canonicalizeSaucepanCard(card, owner);
        if (deps.hasUnfetchedLorebook(datacatCharacter)) card._lorebookUnavailable = true;
    } else if (fallbackErrors.length === 0) {
        fallbackErrors.push(new Error('No Saucepan card was available from DataCat'));
    }

    return {
        card,
        listing,
        companion,
        datacatCharacter,
        source,
        locked: companion?.open_definition === false,
        nativeError,
        fallbackError: combineErrors(fallbackErrors),
        portraits: extractPortraits(companion, datacatCharacter),
    };
}
