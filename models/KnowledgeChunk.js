const mongoose = require('mongoose');

const KnowledgeChunkSchema = new mongoose.Schema({
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
    content: { type: String, required: true }, // Đoạn văn bản kiến thức
    keywords: [String],
    createdAt: { type: Date, default: Date.now }
});

// Tạo Text Index để tìm kiếm (Simple RAG)
// Trong thực tế production nên dùng Vector Search (Atlas Vector Search)
KnowledgeChunkSchema.index({ content: 'text', keywords: 'text' });

module.exports = mongoose.model('_KnowledgeChunk', KnowledgeChunkSchema);