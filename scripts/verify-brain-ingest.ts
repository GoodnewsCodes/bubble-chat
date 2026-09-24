/**
 * verify-brain-ingest.ts
 * Proves the Workspace Brain vector pipeline works end-to-end WITHOUT touching
 * MongoDB — it exercises embeddings → Pinecone upsert → query → cleanup.
 *
 * Run:  npx ts-node scripts/verify-brain-ingest.ts
 *
 * What it checks:
 *   1. HF embeddings are configured AND actually return a 384-dim vector.
 *   2. The Pinecone index exists and its dimension matches the embedding model.
 *   3. A vector can be upserted and immediately queried back (org-filtered).
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { generateEmbedding, embeddingsConfigured, EMBEDDING_DIMENSIONS } from '../utils/embeddings';
import { getPinecone, hasPinecone, upsertVectors, queryVectors, deleteVectors } from '../utils/pinecone';

const ok = (s: string) => { /* console.log(`  ✅ ${s}`); */ };
const bad = (s: string) => { /* console.log(`  ❌ ${s}`); */ };
const info = (s: string) => { /* console.log(`  •  ${s}`); */ };

    async function run() {
        let failures = 0;
        // console.log('\n🧠 Brain ingestion pipeline verification\n');

        // ── 1. Config ────────────────────────────────────────────────────────────
        // console.log('1) Configuration');
        embeddingsConfigured() ? ok('HF_API_KEY configured') : (bad('HF_API_KEY missing/placeholder'), failures++);
        hasPinecone() ? ok('PINECONE_API_KEY configured') : (bad('PINECONE_API_KEY missing/placeholder'), failures++);
        info(`PINECONE_INDEX = ${process.env.PINECONE_INDEX || 'bubble-org-knowledge (default)'}`);

        // ── 2. Embeddings ────────────────────────────────────────────────────────
        // console.log('\n2) Embeddings');
        const sample = 'Bubble is a collaborative workspace that unifies team chat, meetings, and a shared business brain.';
        const emb = await generateEmbedding(sample);
        if (emb.length === 0) {
            bad('generateEmbedding returned [] — HF call failed (see error above). Vectors will NOT be stored.');
            failures++;
        } else if (emb.length !== EMBEDDING_DIMENSIONS) {
            bad(`embedding length ${emb.length} ≠ expected ${EMBEDDING_DIMENSIONS} — index/model mismatch`);
            failures++;
        } else {
            ok(`embedding length = ${emb.length}`);
        }

        // ── 3. Pinecone index dimension ──────────────────────────────────────────
        // console.log('\n3) Pinecone index');
        const pc = getPinecone();
        if (!pc) {
            bad('Pinecone client unavailable');
            failures++;
        } else {
            try {
                const indexName = process.env.PINECONE_INDEX || 'bubble-org-knowledge';
                const stats = await pc.index(indexName).describeIndexStats();
                const dim = (stats as any)?.dimension;
                info(`index dimension = ${dim}, total vectors = ${(stats as any)?.totalRecordCount ?? '?'}`);
                if (dim && dim !== EMBEDDING_DIMENSIONS) {
                    bad(`index dimension ${dim} ≠ embedding ${EMBEDDING_DIMENSIONS} — recreate the index at ${EMBEDDING_DIMENSIONS} dims or swap the model`);
                    failures++;
                } else if (dim === EMBEDDING_DIMENSIONS) {
                    ok('index dimension matches embedding model');
                }
            } catch (e: any) {
                bad(`describeIndexStats failed: ${e?.message || e}`);
                failures++;
            }
        }

        // ── 4. Upsert → query round trip ─────────────────────────────────────────
        // console.log('\n4) Upsert → query round trip');
        if (emb.length === EMBEDDING_DIMENSIONS && hasPinecone()) {
            const ns = '__verify__';
            const orgId = '__verify_org__';
            const id = `verify-${Date.now()}`;
            try {
                const up = await upsertVectors(
                    [{ id, values: emb, metadata: { organizationId: orgId, title: 'verify', chunk: sample, createdAtTs: Date.now() } }],
                    ns
                );
                up ? ok('upsert succeeded') : (bad('upsert returned false'), failures++);

                // Pinecone is eventually consistent; give it a moment.
                await new Promise(r => setTimeout(r, 3000));

                const matches = await queryVectors(emb, 3, orgId, ns);
                if (matches.find(m => m.id === id)) ok(`query returned the inserted vector (score ${matches[0].score.toFixed(3)})`);
                else { bad('query did NOT return the inserted vector (consistency lag or filter mismatch)'); failures++; }

                await deleteVectors([id], ns);
                ok('cleanup done');
            } catch (e: any) {
                bad(`round trip failed: ${e?.message || e}`);
                failures++;
            }
        } else {
            info('skipped (embeddings or Pinecone not available)');
        }

        // console.log(`\n${failures === 0 ? '🎉 All checks passed — the brain pipeline is wired correctly.' : `⚠️  ${failures} check(s) failed — see above.`}\n`);
        process.exit(failures === 0 ? 0 : 1);
    }

    run().catch(e => { console.error(e); process.exit(1); });
