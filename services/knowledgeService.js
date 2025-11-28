const KnowledgeChunk = require('../models/KnowledgeChunk');

class KnowledgeService {
    /**
     * Tìm kiến thức liên quan dựa trên query người dùng
     * Sử dụng MongoDB Text Search (Hiệu quả & Tiết kiệm hơn Regex thường)
     */
    async retrieveContext(botId, query) {
        try {
            const chunks = await KnowledgeChunk.find(
                { 
                    botId: botId,
                    $text: { $search: query } 
                },
                { score: { $meta: "textScore" } }
            )
            .sort({ score: { $meta: "textScore" } })
            .limit(3) // Chỉ lấy 3 đoạn liên quan nhất để tiết kiệm Token
            .select('content');

            if (!chunks || chunks.length === 0) return "";
            
            return chunks.map(c => c.content).join("\n---\n");
        } catch (error) {
            console.error("RAG Retrieval Error:", error);
            return "";
        }
    }
}

module.exports = new KnowledgeService();