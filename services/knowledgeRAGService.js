const KnowledgeChunk = require('../models/KnowledgeChunk');

class KnowledgeRAGService {
    constructor() {
        this.embeddingModel = null;
        this.initialized = false;
        this.embeddingCache = new Map();
        // Cần biết trường vector embedding trong MongoDB là gì
        this.vectorFieldName = 'embedding';
        // Thiết lập ngưỡng mặc định
        this.DEFAULT_SIMILARITY_THRESHOLD = 0.7;
        this.DEFAULT_LIMIT = 5;
    }

    /**
     * Khởi tạo embedding model (Giữ nguyên)
     */
    async initEmbeddingModel() {
        if (this.initialized) return;

        try {
            console.log('Đang tải embedding model...');
            // ... (Giữ nguyên logic tải Xenova/all-MiniLM-L6-v2) ...
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

    /**
     * Tạo embedding vector từ text (Giữ nguyên)
     */
    async createEmbedding(text) {
        // ... (Giữ nguyên logic createEmbedding) ...
        if (!this.initialized) {
            await this.initEmbeddingModel();
        }

        const cacheKey = text.substring(0, 100);
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

    /**
     * Tạo vector TF-IDF đơn giản (fallback) (Giữ nguyên)
     */
    createTFIDFVector(text) {
        // ... (Giữ nguyên logic createTFIDFVector) ...
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

    /**
     * Tokenization đơn giản cho tiếng Việt (Giữ nguyên)
     */
    tokenizeVietnamese(text) {
        // ... (Giữ nguyên logic tokenizeVietnamese) ...
        return text.toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(token => token.length > 1 && token.length < 20);
    }

    /**
     * Hash function đơn giản cho token (Giữ nguyên)
     */
    hashToken(token) {
        // ... (Giữ nguyên logic hashToken) ...
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
            hash = ((hash << 5) - hash) + token.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    /**
     * Tính cosine similarity giữa hai vectors (Giữ nguyên)
     */
    cosineSimilarity(vecA, vecB) {
        // ... (Giữ nguyên logic cosineSimilarity) ...
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

    /**
     * Pad vector về cùng chiều dài (Giữ nguyên)
     */
    padVector(vector, targetLength) {
        // ... (Giữ nguyên logic padVector) ...
        if (vector.length >= targetLength) return vector.slice(0, targetLength);
        const padded = [...vector];
        while (padded.length < targetLength) padded.push(0);
        return padded;
    }

    /**
     * [CẢI TIẾN LỚN] RAG retrieval với Vector Search (Tối ưu nhất)
     * Ưu tiên tìm kiếm bằng vector trong database, chỉ lấy những chunks liên quan.
     */
    async retrieveContext(botId, query, options = {}) {
        const {
            limit = this.DEFAULT_LIMIT,
            similarityThreshold = this.DEFAULT_SIMILARITY_THRESHOLD,
            useHybrid = false // Tắt hybrid search mặc định để tối ưu hóa vector search
        } = options;

        try {
            // 1. Tạo embedding cho query
            const queryEmbedding = await this.createEmbedding(query);

            if (this.embeddingModel === 'tfidf') {
                // Nếu là TF-IDF fallback, quay lại Full-Text Search của MongoDB
                return await this.keywordFallback(botId, query, limit);
            }

            // 2. [VECTOR SEARCH] Sử dụng MongoDB Aggregation để truy vấn vector gần nhất (nearestNeighbors)
            const pipeline = [
                {
                    $match: {
                        botId: botId
                    }
                },
                {
                    $limit: 1 // Giảm giới hạn tạm thời để tìm index vector
                }
            ];

            // Lấy một document mẫu để kiểm tra sự tồn tại của vector
            const sampleChunk = await KnowledgeChunk.aggregate(pipeline).exec();

            if (!sampleChunk || !sampleChunk.length || !sampleChunk[0][this.vectorFieldName]) {
                console.warn(`[RAG] Bot ${botId} chưa có pre-computed embedding. Falling back to Keyword Search.`);
                return await this.keywordFallback(botId, query, limit);
            }

            // Kích thước vector phải khớp
            if (queryEmbedding.length !== sampleChunk[0][this.vectorFieldName].length) {
                console.warn(`[RAG] Kích thước vector không khớp. Falling back to Keyword Search.`);
                return await this.keywordFallback(botId, query, limit);
            }


            // Cấu trúc truy vấn Vector Search (Áp dụng cho MongoDB Atlas Search hoặc Vector DB chuyên dụng)
            const vectorSearchPipeline = [
                {
                    $vectorSearch: {
                        index: 'vector_index_name', // THAY THẾ BẰNG TÊN INDEX VECTOR THỰC TẾ
                        path: this.vectorFieldName,
                        queryVector: queryEmbedding,
                        numCandidates: 10 * limit, // Số lượng ứng viên tìm kiếm (tăng độ chính xác)
                        limit: limit,
                        // filter: { botId: botId } // Nếu index scope là toàn bộ collection
                    }
                },
                {
                    $match: {
                        botId: botId // Đảm bảo chỉ lấy của bot hiện tại (nếu index không filter)
                    }
                },
                {
                    $project: {
                        _id: 0,
                        content: 1,
                        keywords: 1,
                        score: { $meta: 'vectorSearchScore' }, // Lấy điểm từ vector search
                        // vectorSearchScore: { $meta: 'vectorSearchScore' }
                    }
                }
            ];

            // Nếu không dùng MongoDB Vector Search (ví dụ MongoDB Compass, local, ...)
            // Sẽ cần dùng cách thứ 3 (retrieveWithPrecomputed), nhưng tôi sẽ ưu tiên
            // Vector Search Aggregation vì nó hiệu quả hơn.

            try {
                const searchResults = await KnowledgeChunk.aggregate(vectorSearchPipeline).exec();

                // Chuyển đổi kết quả về format chung
                const relevantChunks = searchResults
                    .filter(chunk => chunk.score >= similarityThreshold)
                    .map(chunk => ({
                        content: chunk.content,
                        keywords: chunk.keywords,
                        score: chunk.score,
                        scores: {
                            semantic: chunk.score,
                            keyword: 0
                        }
                    }));

                if (relevantChunks.length === 0 && similarityThreshold > 0.3) {
                    // Thử lại với ngưỡng thấp hơn nếu không có kết quả
                    return await this.retrieveContext(botId, query, { ...options, similarityThreshold: 0.3 });
                }
              
                return relevantChunks;

            } catch (vectorSearchError) {
                console.error('Lỗi Vector Search Aggregation. Thử lại với Pre-computed Manual:', vectorSearchError);
                // Fallback về cách tính manual nếu Vector Search thất bại
                return await this.retrieveWithPrecomputed(botId, query, limit, similarityThreshold);
            }


        } catch (error) {
            console.error('Lỗi chính trong retrieveContext:', error);
            // Fallback cuối cùng
            return await this.keywordFallback(botId, query, limit);
        }
    }

    /**
     * [CẢI TIẾN] Fallback về keyword search (Full-text search của MongoDB)
     */
    async keywordFallback(botId, query, limit) {
        try {
            const chunks = await KnowledgeChunk.find(
                {
                    botId: botId,
                    $text: { $search: query }
                },
                { score: { $meta: "textScore" } }
            )
                .sort({ score: { $meta: "textScore" } })
                .limit(limit)
                .select('content keywords')
                .lean();

            return chunks.map(chunk => ({
                content: chunk.content,
                keywords: chunk.keywords,
                score: chunk.score || 0,
                scores: {
                    semantic: 0,
                    keyword: chunk.score || 0
                }
            }));

        } catch (error) {
            console.error('Keyword fallback cũng bị lỗi:', error);
            return [];
        }
    }

    /**
     * [CẢI TIẾN] Optimized retrieval với pre-computed embeddings (Manual Cosine Sim)
     * Dùng cho môi trường không có Vector DB hoặc Vector Search.
     * Vẫn kém hiệu quả hơn Vector Search nhưng tốt hơn việc tính embedding tại chỗ.
     */
    async retrieveWithPrecomputed(botId, query, limit = this.DEFAULT_LIMIT, similarityThreshold = this.DEFAULT_SIMILARITY_THRESHOLD) {
        try {
            // 1. Tạo embedding cho query
            const queryEmbedding = await this.createEmbedding(query);

            // 2. Tải tất cả chunks CÓ EMBEDDING của bot
            const chunks = await KnowledgeChunk.find({
                botId: botId,
                embedding: { $exists: true, $ne: null }
            })
                .select('content keywords embedding')
                .lean();

            if (chunks.length === 0) {
                console.warn(`[RAG] Không có chunks pre-computed nào cho bot ${botId}.`);
                return [];
            }

            // 3. TÍNH SIMILARITY BẰNG TAY (Hiệu năng thấp hơn Vector DB)
            const scoredChunks = chunks.map(chunk => {
                const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);

                return {
                    content: chunk.content,
                    keywords: chunk.keywords,
                    score: similarity,
                    scores: {
                        semantic: similarity,
                        keyword: 0
                    }
                };
            });

            // 4. Sắp xếp và giới hạn kết quả
            return scoredChunks
                .filter(chunk => chunk.score >= similarityThreshold)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);

        } catch (error) {
            console.error('Lỗi retrieveWithPrecomputed (Manual Sim):', error);
            return await this.keywordFallback(botId, query, limit);
        }
    }

    /**
     * Batch tính embeddings cho tất cả chunks (Giữ nguyên)
     */
    async precomputeAllEmbeddings() {
        // ... (Giữ nguyên logic precomputeAllEmbeddings) ...
        try {
            await this.initEmbeddingModel();

            // Cập nhật: Chỉ tính cho chunks chưa có embedding HOẶC model cũ
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

                    // Lưu embedding vào database
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