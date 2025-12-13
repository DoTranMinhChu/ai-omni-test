// services/KnowledgeRAGService.js
const KnowledgeChunk = require('../models/KnowledgeChunk');

class KnowledgeRAGService {
    constructor() {
        this.embeddingModel = null;
        this.initialized = false;
        this.embeddingCache = new Map();
        this.vectorFieldName = 'embedding';
        this.DEFAULT_SIMILARITY_THRESHOLD = 0.65; // hạ chút để không thiếu kết quả
        this.DEFAULT_LIMIT = 5;
    }

    async initEmbeddingModel() {
        if (this.initialized) return;
        try {
            console.log('Đang tải embedding model...');
            const { pipeline } = await import('@xenova/transformers');
            this.embeddingModel = await pipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                { revision: 'main', quantized: true }
            );
            this.initialized = true;
            console.log('Embedding model đã sẵn sàng');
        } catch (error) {
            console.error('Không thể tải embedding model:', error);
            this.embeddingModel = 'tfidf';
        }
    }

    async createEmbedding(text) {
        if (!this.initialized) {
            await this.initEmbeddingModel();
        }

        const cacheKey = text.substring(0, 200);
        if (this.embeddingCache.has(cacheKey)) {
            return this.embeddingCache.get(cacheKey);
        }

        try {
            if (this.embeddingModel === 'tfidf') {
                return this.createTFIDFVector(text);
            }
            const processedText = text.substring(0, 512);
            const output = await this.embeddingModel(processedText, {
                pooling: 'mean',
                normalize: true
            });
            const embedding = Array.from(output.data);
            this.embeddingCache.set(cacheKey, embedding);
            return embedding;
        } catch (error) {
            console.error('Lỗi tạo embedding:', error);
            return this.createTFIDFVector(text);
        }
    }

    createTFIDFVector(text) {
        const tokens = this.tokenizeVietnamese(text);
        const vectorSize = 300;
        const vector = new Array(vectorSize).fill(0);
        tokens.forEach(token => {
            const hash = this.hashToken(token) % vectorSize;
            vector[hash] += 1;
        });
        const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            return vector.map(val => val / norm);
        }
        return vector;
    }

    tokenizeVietnamese(text) {
        return text.toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(token => token.length > 1 && token.length < 20);
    }

    hashToken(token) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
            hash = ((hash << 5) - hash) + token.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    cosineSimilarity(vecA, vecB) {
        const maxLength = Math.max(vecA.length, vecB.length);
        const a = this.padVector(vecA, maxLength);
        const b = this.padVector(vecB, maxLength);
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < maxLength; i++) {
            const ai = a[i] || 0;
            const bi = b[i] || 0;
            dotProduct += ai * bi;
            normA += ai * ai;
            normB += bi * bi;
        }
        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        return isNaN(similarity) ? 0 : Math.max(0, similarity);
    }

    padVector(vector, targetLength) {
        if (vector.length >= targetLength) return vector.slice(0, targetLength);
        const padded = [...vector];
        while (padded.length < targetLength) padded.push(0);
        return padded;
    }

    /**
     * retrieveContext cải tiến:
     * - Thử vector search (nếu có)
     * - Nếu không, fallback keyword
     * - Sau khi có candidates, chạy merge/cluster để trả về các tri thức "đầy đủ" (không rời rạc)
     */
    async retrieveContext(botId, query, options = {}) {
        const {
            limit = this.DEFAULT_LIMIT,
            similarityThreshold = this.DEFAULT_SIMILARITY_THRESHOLD,
            useHybrid = false
        } = options;

        try {
            const queryEmbedding = await this.createEmbedding(query);

            if (this.embeddingModel === 'tfidf') {
                const fallback = await this.keywordFallback(botId, query, limit);
                return this._postProcessAndMerge(fallback, limit, similarityThreshold);
            }

            // Try vector search (MongoDB Atlas or custom vector aggregation)
            try {
                const vectorSearchPipeline = [
                    { $match: { botId: botId } },
                    {
                        $vectorSearch: {
                            index: 'vector_index_name',
                            path: this.vectorFieldName,
                            queryVector: queryEmbedding,
                            numCandidates: 10 * limit,
                            limit: 10 * limit
                        }
                    },
                    { $match: { botId: botId } },
                    {
                        $project: {
                            _id: 0,
                            content: 1,
                            keywords: 1,
                            entityId: 1,
                            sourceMeta: 1,
                            chunkId: 1,
                            embedding: 1,
                            score: { $meta: 'vectorSearchScore' }
                        }
                    },
                    { $sort: { score: -1 } },
                    { $limit: 10 * limit }
                ];

                const searchResults = await KnowledgeChunk.aggregate(vectorSearchPipeline).exec();

                const transformed = searchResults.map(r => ({
                    content: r.content,
                    keywords: r.keywords || [],
                    entityId: r.entityId || null,
                    sourceMeta: r.sourceMeta || null,
                    chunkId: r.chunkId || null,
                    embedding: r.embedding || null,
                    score: r.score || 0,
                    scores: { semantic: r.score || 0, keyword: 0 }
                }));

                return await this._postProcessAndMerge(transformed, limit, similarityThreshold);

            } catch (vectorSearchError) {
                console.warn('Vector search lỗi, fallback to precomputed manual', vectorSearchError.message);
                return await this.retrieveWithPrecomputed(botId, query, limit, similarityThreshold);
            }

        } catch (error) {
            console.error('Lỗi chính trong retrieveContext:', error);
            return await this.keywordFallback(botId, query, limit);
        }
    }

    async keywordFallback(botId, query, limit) {
        try {
            const chunks = await KnowledgeChunk.find(
                { botId: botId, $text: { $search: query } },
                { score: { $meta: "textScore" } }
            )
                .sort({ score: { $meta: "textScore" } })
                .limit(limit * 5)
                .select('content keywords entityId sourceMeta chunkId')
                .lean();

            const mapped = chunks.map(chunk => ({
                content: chunk.content,
                keywords: chunk.keywords || [],
                entityId: chunk.entityId || null,
                sourceMeta: chunk.sourceMeta || null,
                chunkId: chunk.chunkId || null,
                score: chunk.score || 0,
                scores: { semantic: 0, keyword: chunk.score || 0 }
            }));

            return this._postProcessAndMerge(mapped, limit, 0.0 /* low thresh for text search */);
        } catch (error) {
            console.error('Keyword fallback cũng bị lỗi:', error);
            return [];
        }
    }

    async retrieveWithPrecomputed(botId, query, limit = this.DEFAULT_LIMIT, similarityThreshold = this.DEFAULT_SIMILARITY_THRESHOLD) {
        try {
            const queryEmbedding = await this.createEmbedding(query);

            const chunks = await KnowledgeChunk.find({
                botId: botId,
                embedding: { $exists: true, $ne: null }
            })
                .select('content keywords embedding entityId sourceMeta chunkId')
                .lean();

            if (chunks.length === 0) {
                console.warn(`[RAG] Không có chunks pre-computed cho bot ${botId}.`);
                return [];
            }

            const scored = chunks.map(chunk => {
                const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
                return {
                    content: chunk.content,
                    keywords: chunk.keywords || [],
                    entityId: chunk.entityId || null,
                    sourceMeta: chunk.sourceMeta || null,
                    chunkId: chunk.chunkId || null,
                    embedding: chunk.embedding || null,
                    score: similarity,
                    scores: { semantic: similarity, keyword: 0 }
                };
            });

            // sort + top candidates
            const candidates = scored.sort((a, b) => b.score - a.score).slice(0, Math.min(chunks.length, 10 * limit));

            return await this._postProcessAndMerge(candidates, limit, similarityThreshold);

        } catch (error) {
            console.error('Lỗi retrieveWithPrecomputed (Manual Sim):', error);
            return await this.keywordFallback(botId, query, limit);
        }
    }

    /**
     * Sau khi có candidates (mảng objects), thực hiện:
     * - Nếu nhiều chunk có cùng entityId -> gộp lại
     * - Nếu không có entityId, thực hiện clustering văn bản/embedding để gộp những đoạn giống nhau
     * - Trả về <= limit kết quả đã merge, mỗi result có fields: entityId, title(optional), content, keywords, score (aggregated)
     */
    async _postProcessAndMerge(candidates, limit, similarityThreshold) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        // 1) Group by entityId if provided
        const groups = new Map();
        const noEntity = [];

        for (const c of candidates) {
            if (c.entityId) {
                const key = c.entityId.toString().toLowerCase();
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(c);
            } else {
                noEntity.push(c);
            }
        }

        // Merge group by entityId: combine content, keywords, average score
        const mergedResults = [];
        for (const [key, arr] of groups.entries()) {
            const combined = {
                entityId: arr[0].entityId,
                content: arr.map(x => x.content).filter(Boolean).join('\n\n'),
                keywords: Array.from(new Set((arr.flatMap(x => x.keywords || [])))),
                score: arr.reduce((s, x) => s + (x.score || 0), 0) / arr.length,
                pieces: arr.map(x => ({ chunkId: x.chunkId, sourceMeta: x.sourceMeta }))
            };
            mergedResults.push(combined);
        }

        // 2) Cluster noEntity candidates using embeddings similarity (if available) else simple text similarity
        const clustered = await this._clusterAndMergeNoEntity(noEntity, similarityThreshold);

        // 3) Combine and sort by score and return top limit
        const combinedAll = mergedResults.concat(clustered);
        combinedAll.sort((a, b) => (b.score || 0) - (a.score || 0));

        return combinedAll.slice(0, limit).map(r => ({
            entityId: r.entityId || null,
            title: r.title || null,
            content: r.content,
            keywords: r.keywords || [],
            score: r.score,
            provenance: r.pieces || r.provenance || []
        }));
    }

    async _clusterAndMergeNoEntity(items, similarityThreshold) {
        if (!items || items.length === 0) return [];

        // If items have embeddings, use them. Otherwise, fallback to text-based rough sim (cosine on TFIDF)
        const withEmb = items.filter(it => it.embedding && Array.isArray(it.embedding));
        const withoutEmb = items.filter(it => !it.embedding);

        const clusters = [];

        // Cluster items with embedding: greedy agglomerative by similarityThreshold
        const used = new Set();
        for (let i = 0; i < withEmb.length; i++) {
            if (used.has(i)) continue;
            const base = withEmb[i];
            const cluster = [base];
            used.add(i);
            for (let j = i + 1; j < withEmb.length; j++) {
                if (used.has(j)) continue;
                const cand = withEmb[j];
                const sim = this.cosineSimilarity(base.embedding, cand.embedding);
                if (sim >= Math.max(0.8, similarityThreshold)) {
                    cluster.push(cand);
                    used.add(j);
                }
            }
            // combine cluster
            const content = cluster.map(x => x.content).join('\n\n');
            const keywords = Array.from(new Set(cluster.flatMap(x => x.keywords || [])));
            const score = cluster.reduce((s, x) => s + (x.score || 0), 0) / cluster.length;
            clusters.push({ entityId: null, content, keywords, score, pieces: cluster.map(x => ({ chunkId: x.chunkId })) });
        }

        // For withoutEmb: simple greedy merge by text containment or keyword overlap
        const used2 = new Set();
        for (let i = 0; i < withoutEmb.length; i++) {
            if (used2.has(i)) continue;
            const a = withoutEmb[i];
            const group = [a];
            used2.add(i);
            for (let j = i + 1; j < withoutEmb.length; j++) {
                if (used2.has(j)) continue;
                const b = withoutEmb[j];
                // simple heuristics: if one content contains the other OR share many keywords
                const contains = (a.content && b.content && (a.content.includes(b.content) || b.content.includes(a.content)));
                const kwOverlap = (a.keywords || []).filter(k => (b.keywords || []).includes(k)).length;
                if (contains || kwOverlap >= Math.max(1, Math.floor(Math.min((a.keywords || []).length, (b.keywords || []).length) / 2))) {
                    group.push(b);
                    used2.add(j);
                }
            }
            const content = group.map(x => x.content).join('\n\n');
            const keywords = Array.from(new Set(group.flatMap(x => x.keywords || [])));
            const score = group.reduce((s, x) => s + (x.score || 0), 0) / group.length;
            clusters.push({ entityId: null, content, keywords, score, pieces: group.map(x => ({ chunkId: x.chunkId })) });
        }

        return clusters;
    }

    /**
     * Batch tính embeddings cho tất cả chunks
     */
    async precomputeAllEmbeddings() {
        try {
            await this.initEmbeddingModel();

            const allChunks = await KnowledgeChunk.find({
                $or: [
                    { embedding: { $exists: false } },
                    { embeddingModel: { $ne: 'Xenova/all-MiniLM-L6-v2' } }
                ]
            });

            console.log(`Bắt đầu tính embeddings cho ${allChunks.length} chunks...`);

            for (let i = 0; i < allChunks.length; i++) {
                const chunk = allChunks[i];
                try {
                    const embedding = await this.createEmbedding(chunk.content);
                    await KnowledgeChunk.updateOne(
                        { _id: chunk._id },
                        {
                            $set: {
                                embedding: embedding,
                                embeddingModel: 'Xenova/all-MiniLM-L6-v2'
                            }
                        }
                    );
                    if ((i + 1) % 10 === 0 || i === allChunks.length - 1) {
                        console.log(`Đã xử lý ${i + 1}/${allChunks.length} chunks`);
                    }
                } catch (error) {
                    console.error(`Lỗi tính embedding cho chunk ${chunk._id}:`, error);
                }
            }
            console.log('Hoàn thành tính embeddings!');
        } catch (error) {
            console.error('Lỗi trong precomputeAllEmbeddings:', error);
        }
    }
}

module.exports = new KnowledgeRAGService();
