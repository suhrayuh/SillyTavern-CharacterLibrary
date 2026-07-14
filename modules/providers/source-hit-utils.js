/** Pure accessors for normalized provider and aggregate browse hits. */

export function getCharId(hit) {
    return hit?.characterId || hit?.character_id || hit?.id || '';
}

export function getCreatorId(hit) {
    return hit?.creatorId || hit?.creator_id || hit?.authorId || hit?.author_id || '';
}

export function getCreatorName(hit) {
    return hit?.creatorName || hit?.creator_name || hit?.authorHandle || hit?.author_handle || '';
}

export function getChatCount(hit) {
    return parseInt(hit?.chatCount || hit?.chat_count, 10) || 0;
}

export function getMsgCount(hit) {
    return parseInt(hit?.messageCount || hit?.message_count || hit?.interactionCount || hit?.interaction_count, 10) || 0;
}

export function getTotalTokens(hit) {
    return parseInt(
        hit?.totalTokens
            || hit?.total_tokens
            || hit?.token_counts?.total_tokens
            || hit?.tokenCounts?.total_tokens,
        10,
    ) || 0;
}

export function getCreatedAt(hit) {
    return hit?.createdAt || hit?.created_at || hit?.postedAt || hit?.posted_at || '';
}

export function getCreatedDate(hit) {
    const raw = getCreatedAt(hit);
    return raw ? new Date(raw).toLocaleDateString() : '';
}

export function isNsfw(hit) {
    return !!(hit?.isNsfw || hit?.is_nsfw || hit?.sus);
}

/**
 * DataCat aggregate source normalization. Missing legacy source metadata stays
 * JanitorAI-compatible; unknown explicit values are preserved for future feeds.
 */
export function getSourceKind(hit) {
    const source = hit?.primary_content_source_kind || hit?._source || '';
    if (source === 'saucepan') return 'saucepan';
    if (source === 'janitor' || source === 'janitorai' || !source) return 'janitor';
    return String(source);
}
