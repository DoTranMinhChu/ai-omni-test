const KnowledgeChunk = require('../models/KnowledgeChunk');

class KnowledgeService {
    /**
     * Trả về danh sách các chunk tốt nhất, sắp xếp theo độ liên quan
     */
    async retrieveContext(botId, query) {
        try {
            // Tìm kiếm Full-text search của MongoDB
            const chunks = await KnowledgeChunk.find(
                {
                    botId: botId,
                    $text: { $search: query }
                },
                { score: { $meta: "textScore" } } // Lấy điểm số phù hợp
            )
                .sort({ score: { $meta: "textScore" } }) // Sắp xếp: Điểm cao nhất lên đầu
                .limit(5) // Lấy tối đa 5 đoạn tốt nhất (để lọc sau)
                .select('content keywords');

            if (!chunks || chunks.length === 0) return [];

            // Trả về mảng object, KHÔNG join thành string tại đây
            return chunks.map(c => ({
                content: c.content,
                keywords: c.keywords
            }));

        } catch (error) {
            console.error("RAG Retrieval Error:", error);
            return [];
        }
    }
}

module.exports = new KnowledgeService();