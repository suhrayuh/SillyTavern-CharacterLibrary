function extensionsOf(char) {
    return char?.data?.extensions || char?.extensions || null;
}

export function getSaucepanLinkInfo(char) {
    const extensions = extensionsOf(char);
    const canonical = extensions?.saucepan;
    if (canonical?.id) {
        return {
            providerId: 'saucepan',
            id: String(canonical.id),
            fullPath: String(canonical.id),
            linkedAt: canonical.linkedAt || null,
            pageName: canonical.pageName || null,
        };
    }

    const legacy = extensions?.datacat;
    if (legacy?.sourceKind !== 'saucepan' || !legacy.id) return null;
    return {
        providerId: 'saucepan',
        id: String(legacy.id),
        fullPath: String(legacy.id),
        linkedAt: legacy.linkedAt || null,
        pageName: legacy.pageName || null,
        legacyNamespace: 'datacat',
    };
}

export function writeSaucepanLinkInfo(char, linkInfo, now = () => new Date().toISOString()) {
    if (!char) return;
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    const extensions = char.data.extensions;

    if (!linkInfo) {
        delete extensions.saucepan;
        if (extensions.datacat?.sourceKind === 'saucepan') delete extensions.datacat;
        return;
    }

    const existing = extensions.saucepan || {};
    extensions.saucepan = {
        id: String(linkInfo.id || linkInfo.fullPath),
        ...(linkInfo.creatorId || existing.creatorId ? { creatorId: linkInfo.creatorId || existing.creatorId } : {}),
        ...(linkInfo.creatorName || existing.creatorName ? { creatorName: linkInfo.creatorName || existing.creatorName } : {}),
        ...(linkInfo.pageName || existing.pageName ? { pageName: linkInfo.pageName || existing.pageName } : {}),
        linkedAt: linkInfo.linkedAt || existing.linkedAt || now(),
    };
    if (extensions.datacat?.sourceKind === 'saucepan') delete extensions.datacat;
}

export function isLegacySaucepanDatacatLink(char) {
    return extensionsOf(char)?.datacat?.sourceKind === 'saucepan';
}
