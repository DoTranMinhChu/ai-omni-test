const KnowledgeChunk = require('../models/KnowledgeChunk');

class KnowledgeService {
    constructor() {
        this.embeddingModel = null;
        this.initialized = false;
        this.embeddingCache = new Map(); // Cache embeddings để tăng tốc
    }

    /**
     * Khởi tạo embedding model local
     */
    async initEmbeddingModel() {
        if (this.initialized) return;

        try {
            console.log('Đang tải embedding model...');

            // Lựa chọn 1: Mô hình đa ngôn ngữ nhỏ gọn (phổ biến)
            const { pipeline } = await import('@xenova/transformers');

            // Sử dụng mô hình nhẹ cho embedding
            // Xenova/all-MiniLM-L6-v2: ~90MB, hỗ trợ đa ngôn ngữ
            this.embeddingModel = await pipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                {
                    revision: 'main',
                    quantized: true // Sử dụng phiên bản đã quantized để nhẹ hơn
                }
            );

            /*
            // Lựa chọn 2: Mô hình tiếng Việt chuyên dụng (lớn hơn)
            // Xenova/vinai/phobert-base: ~420MB, chuyên tiếng Việt
            this.embeddingModel = await pipeline(
                'feature-extraction',
                'Xenova/vinai/phobert-base',
                {
                    revision: 'main',
                    quantized: false
                }
            );
            */

            this.initialized = true;
            console.log('Embedding model đã sẵn sàng');

        } catch (error) {
            console.error('Không thể tải embedding model:', error);
            // Fallback về TF-IDF đơn giản
            this.embeddingModel = 'tfidf';
        }
    }

    /**
     * Tạo embedding vector từ text
     */
    async createEmbedding(text) {
        if (!this.initialized) {
            await this.initEmbeddingModel();
        }

        // Kiểm tra cache trước
        const cacheKey = text.substring(0, 100); // Lấy 100 ký tự đầu làm key cache
        if (this.embeddingCache.has(cacheKey)) {
            return this.embeddingCache.get(cacheKey);
        }

        try {
            // Nếu là fallback TF-IDF
            if (this.embeddingModel === 'tfidf') {
                return this.createTFIDFVector(text);
            }

            // Xử lý text: giới hạn độ dài để tránh quá tải
            const processedText = text.substring(0, 512); // Giới hạn 512 tokens

            // Tạo embedding với Transformers.js
            const output = await this.embeddingModel(processedText, {
                pooling: 'mean',    // Lấy trung bình các token embeddings
                normalize: true     // Chuẩn hóa vector về độ dài 1
            });

            // Chuyển tensor thành array
            const embedding = Array.from(output.data);

            // Lưu vào cache
            this.embeddingCache.set(cacheKey, embedding);

            return embedding;

        } catch (error) {
            console.error('Lỗi tạo embedding:', error);
            // Fallback về TF-IDF
            return this.createTFIDFVector(text);
        }
    }

    /**
     * Tạo vector TF-IDF đơn giản (fallback)
     */
    createTFIDFVector(text) {
        // Tokenization đơn giản cho tiếng Việt
        const tokens = this.tokenizeVietnamese(text);

        // Tạo vector bằng hashing trick (để có kích thước cố định)
        const vectorSize = 300; // Kích thước vector cố định
        const vector = new Array(vectorSize).fill(0);

        tokens.forEach(token => {
            // Hash token thành index trong vector
            const hash = this.hashToken(token) % vectorSize;
            // Sử dụng TF (term frequency) đơn giản
            vector[hash] += 1;
        });

        // Chuẩn hóa vector
        const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            return vector.map(val => val / norm);
        }

        return vector;
    }

    /**
     * Tokenization đơn giản cho tiếng Việt
     */
    tokenizeVietnamese(text) {
        return text.toLowerCase()
            // Loại bỏ dấu câu nhưng giữ lại chữ cái tiếng Việt có dấu
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(token => token.length > 1 && token.length < 20);
    }

    /**
     * Hash function đơn giản cho token
     */
    hashToken(token) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
            hash = ((hash << 5) - hash) + token.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    /**
     * Tính cosine similarity giữa hai vectors
     */
    cosineSimilarity(vecA, vecB) {
        // Đảm bảo cả hai vector cùng chiều dài
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

        // Trả về similarity, xử lý NaN
        return isNaN(similarity) ? 0 : Math.max(0, similarity);
    }

    /**
     * Pad vector về cùng chiều dài
     */
    padVector(vector, targetLength) {
        if (vector.length >= targetLength) {
            return vector.slice(0, targetLength);
        }

        const padded = [...vector];
        while (padded.length < targetLength) {
            padded.push(0);
        }
        return padded;
    }

    /**
     * RAG retrieval với semantic search local
     */
    async retrieveContext(botId, query, options = {}) {
        const {
            limit = 5,
            similarityThreshold = 0.3,
            useHybrid = true // Kết hợp semantic và keyword search
        } = options;

        try {
            // Tạo embedding cho query
            const queryEmbedding = await this.createEmbedding(query);
            const queryTokens = this.tokenizeVietnamese(query);

            // Lấy tất cả chunks của bot
            const allChunks = await KnowledgeChunk.find({ botId })
                .select('content keywords')
                .lean();

            if (allChunks.length === 0) return [];

            // Tính toán similarity cho từng chunk
            const chunksWithScores = await Promise.all(
                allChunks.map(async (chunk) => {
                    let semanticScore = 0;
                    let keywordScore = 0;

                    // 1. Tính semantic similarity
                    try {
                        const chunkEmbedding = await this.createEmbedding(chunk.content);
                        semanticScore = this.cosineSimilarity(queryEmbedding, chunkEmbedding);
                    } catch (error) {
                        console.error('Lỗi tính semantic score:', error);
                    }

                    // 2. Tính keyword score (nếu dùng hybrid)
                    if (useHybrid) {
                        keywordScore = this.calculateKeywordScore(chunk, queryTokens);
                    }

                    // 3. Kết hợp scores
                    let combinedScore;
                    if (useHybrid) {
                        // Trọng số: 70% semantic, 30% keyword
                        combinedScore = (semanticScore * 0.7) + (keywordScore * 0.3);
                    } else {
                        combinedScore = semanticScore;
                    }

                    return {
                        ...chunk,
                        semanticScore,
                        keywordScore,
                        combinedScore
                    };
                })
            );

            // Lọc và sắp xếp kết quả
            const relevantChunks = chunksWithScores
                .filter(chunk => chunk.combinedScore >= similarityThreshold)
                .sort((a, b) => b.combinedScore - a.combinedScore)
                .slice(0, limit)
                .map(chunk => ({
                    content: chunk.content,
                    keywords: chunk.keywords,
                    score: chunk.combinedScore,
                    scores: {
                        semantic: chunk.semanticScore,
                        keyword: chunk.keywordScore
                    }
                }));

            return relevantChunks;

        } catch (error) {
            console.error('Lỗi trong retrieveContext:', error);

            // Fallback về keyword search
            return await this.keywordFallback(botId, query, limit);
        }
    }

    /**
     * Tính keyword score đơn giản
     */
    calculateKeywordScore(chunk, queryTokens) {
        if (!queryTokens.length) return 0;

        // Chuẩn bị text để so sánh
        const chunkText = (chunk.content + ' ' + (chunk.keywords || []).join(' ')).toLowerCase();
        const chunkTokens = this.tokenizeVietnamese(chunkText);

        // Tính Jaccard similarity đơn giản
        const chunkTokenSet = new Set(chunkTokens);
        const queryTokenSet = new Set(queryTokens);

        let intersection = 0;
        queryTokenSet.forEach(token => {
            if (chunkTokenSet.has(token)) intersection++;
        });

        const union = chunkTokenSet.size + queryTokenSet.size - intersection;

        return union > 0 ? intersection / union : 0;
    }

    /**
     * Fallback về keyword search (full-text search của MongoDB)
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
     * Batch tính embeddings cho tất cả chunks (chạy một lần)
     */
    async precomputeAllEmbeddings() {
        try {
            await this.initEmbeddingModel();

            const allChunks = await KnowledgeChunk.find({
              //  embedding: { $exists: false } // Chỉ tính cho chunks chưa có embedding
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

                    // Progress logging
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

    /**
     * Optimized retrieval với pre-computed embeddings
     */
    async retrieveWithPrecomputed(botId, query) {
        try {
            // Tạo embedding cho query
            const queryEmbedding = await this.createEmbedding(query);

            // Lấy tất cả chunks có sẵn embedding
            const chunks = await KnowledgeChunk.find({
                botId: botId,
                embedding: { $exists: true, $ne: null }
            })
                .select('content keywords embedding')
                .lean();

            if (chunks.length === 0) {
                return await this.retrieveContext(botId, query);
            }

            // Tính similarity và sắp xếp
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

            // Sắp xếp và giới hạn kết quả
            return scoredChunks
                .filter(chunk => chunk.score >= 0.3)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);

        } catch (error) {
            console.error('Lỗi retrieveWithPrecomputed:', error);
            return await this.retrieveContext(botId, query);
        }
    }
}

module.exports = new KnowledgeService();