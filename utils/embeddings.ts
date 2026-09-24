// ─── Local embeddings (Transformers.js) ──────────────────────────────────────
// We run the embedding model LOCALLY via @xenova/transformers instead of HF's
// hosted Inference API. The hosted API is now credit-gated ("Inference
// Providers") and was silently returning [] for our token. Local inference has
// no key, no rate limits, no network — the brain can't silently go empty.
//
// Model: Xenova/bge-small-en-v1.5 (ONNX port of BAAI/bge-small-en-v1.5).
// 384 dimensions — MUST match the Pinecone index dimension.
const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;

// Lazily-initialized singleton pipeline. The first call downloads + caches the
// model (~30MB); every call after is fully in-process.
let extractorPromise: Promise<any> | null = null;

const getExtractor = async (): Promise<any> => {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            // Dynamic import so the (ESM) library loads cleanly under CommonJS.
            const TJS: any = await import('@xenova/transformers');
            // Don't look for local model files; pull the ONNX weights from the hub.
            if (TJS?.env) TJS.env.allowLocalModels = false;
            // console.log('[Embeddings] Loading local model', EMBEDDING_MODEL, '(first run downloads ~30MB)…');
            const pipe = await TJS.pipeline('feature-extraction', EMBEDDING_MODEL);
            // console.log('[Embeddings] Local embedding model ready.');
            return pipe;
        })().catch((err) => {
            // Reset so a later call can retry instead of being stuck on a bad promise.
            extractorPromise = null;
            throw err;
        });
    }
    return extractorPromise;
};

/**
 * Local embeddings are always available (no API key required). Kept as a helper
 * so callers can branch on "embeddings on" without caring about the backend.
 */
export const embeddingsConfigured = (): boolean => true;

/**
 * Eagerly warm the embedding model (call once at boot so the first real ingest
 * isn't slowed by the model download/load). Safe to call repeatedly.
 */
export const warmEmbeddings = async (): Promise<void> => {
    try { await getExtractor(); } catch (err: any) {
        console.error('[Embeddings] Warm-up failed:', err?.message || err);
    }
};

/**
 * Generate a single embedding vector for a piece of text.
 * Returns an empty array only if the model fails to load/run.
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
    const clean = (text || '').trim();
    if (!clean) return [];

    try {
        const extractor = await getExtractor();
        // BGE was trained with CLS pooling; normalize for cosine similarity.
        const output = await extractor(clean.substring(0, 8192), { pooling: 'cls', normalize: true });
        const vector: number[] = Array.from(output.data as Float32Array | number[]);
        if (vector.length !== EMBEDDING_DIMENSIONS) {
            console.error(`[Embeddings] Unexpected vector length ${vector.length} (expected ${EMBEDDING_DIMENSIONS}).`);
            return [];
        }
        return vector;
    } catch (err: any) {
        // Surface the real reason — never swallow into a silent empty brain.
        console.error('[Embeddings] Failed to generate embedding:', err?.message || err);
        return [];
    }
};

/**
 * Split long text into overlapping chunks suitable for embedding.
 * @param text     Source text
 * @param maxChars Maximum characters per chunk (default 500)
 * @param overlap  Overlap characters between consecutive chunks (default 100)
 */
export const chunkText = (text: string, maxChars = 500, overlap = 100): string[] => {
    const chunks: string[] = [];
    const cleaned = text.replace(/\s+/g, ' ').trim();

    if (cleaned.length <= maxChars) return [cleaned];

    let start = 0;
    while (start < cleaned.length) {
        const end = Math.min(start + maxChars, cleaned.length);
        chunks.push(cleaned.slice(start, end));
        start += maxChars - overlap;
    }
    return chunks;
};

/**
 * Generate embeddings for multiple texts in a single function call.
 * Returns array aligned with the input array — failed embeddings are [].
 */
export const generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
    const results: number[][] = [];
    for (const text of texts) {
        const emb = await generateEmbedding(text);
        results.push(emb);
    }
    return results;
};
