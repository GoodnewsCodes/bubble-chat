import { Pinecone, PineconeRecord, RecordMetadata } from '@pinecone-database/pinecone';

let pineconeClient: Pinecone | null = null;

export const getPinecone = (): Pinecone | null => {
    const key = process.env.PINECONE_API_KEY;
    if (!key || key === 'your_pinecone_api_key_here') return null;
    if (!pineconeClient) pineconeClient = new Pinecone({ apiKey: key });
    return pineconeClient;
};

export const hasPinecone = (): boolean => {
    const key = process.env.PINECONE_API_KEY;
    return !!(key && key !== 'your_pinecone_api_key_here');
};

const getIndex = (namespace?: string) => {
    const pc = getPinecone();
    if (!pc) return null;
    const indexName = process.env.PINECONE_INDEX || 'bubble-org-knowledge';
    const index = pc.index(indexName);
    return namespace ? index.namespace(namespace) : index;
};

export interface PineconeVector {
    id: string;
    values: number[];
    metadata?: Record<string, any>;
}

/**
 * Upsert vectors into Pinecone
 */
export const upsertVectors = async (vectors: PineconeVector[], namespace?: string): Promise<boolean> => {
    const index = getIndex(namespace);
    if (!index) return false;
    try {
        const records: PineconeRecord<RecordMetadata>[] = vectors.map(v => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata,
        }));
        await index.upsert({ records });
        return true;
    } catch (err) {
        console.error('[Pinecone] Upsert error:', err);
        return false;
    }
};

/**
 * Query Pinecone for similar vectors.
 *
 * organizationId is REQUIRED for multi-tenant isolation. Namespace alone is
 * not enough — we layer a metadata filter on top so a misconfigured namespace
 * still cannot leak data across organizations.
 */
export const queryVectors = async (
    embedding: number[],
    topK = 5,
    organizationId: string,
    namespace?: string,
    extraFilter?: Record<string, any>
): Promise<{ id: string; score: number; metadata?: Record<string, any> }[]> => {
    if (!organizationId) {
        console.error('[Pinecone] queryVectors called without organizationId — refusing to query');
        return [];
    }
    const index = getIndex(namespace);
    if (!index) return [];
    try {
        const filter: Record<string, any> = {
            ...(extraFilter || {}),
            organizationId: { $eq: organizationId },
        };
        const res = await index.query({
            vector: embedding,
            topK,
            includeMetadata: true,
            filter,
        });
        return (res.matches || []).map((m) => ({
            id: m.id,
            score: m.score ?? 0,
            metadata: m.metadata as Record<string, any>,
        }));
    } catch (err) {
        console.error('[Pinecone] Query error:', err);
        return [];
    }
};

/**
 * Delete vectors by IDs
 */
export const deleteVectors = async (ids: string[], namespace?: string): Promise<boolean> => {
    const index = getIndex(namespace);
    if (!index || ids.length === 0) return false;
    try {
        await index.deleteMany(ids);
        return true;
    } catch (err) {
        console.error('[Pinecone] Delete error:', err);
        return false;
    }
};
