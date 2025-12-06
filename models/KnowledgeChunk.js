const mongoose = require('mongoose');

const KnowledgeChunkSchema = new mongoose.Schema({
    botId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Bot',
        required: true
    },
    content: {
        type: String,
        required: true
    },
    keywords: [String],
    embedding: {
        type: [Number],  // Vector embeddings
        default: null
    },
    embeddingModel: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Indexes
KnowledgeChunkSchema.index({ botId: 1 });
KnowledgeChunkSchema.index({ content: 'text', keywords: 'text' });
// Index cho vector search nếu dùng MongoDB 7.0+
KnowledgeChunkSchema.index({ embedding: 'cosmosSearch' }, { sparse: true });

module.exports = mongoose.model('_KnowledgeChunk', KnowledgeChunkSchema);