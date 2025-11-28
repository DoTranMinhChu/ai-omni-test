const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema({
  customerIdentifier: { type: String, required: true },
  botCode: { type: String, required: true },

  // Tin nhắn với metadata
  messages: [
    {
      role: { type: String, enum: ["user", "assistant", "system"] },
      content: String,
      tokensUsed: Number,
      timestamp: { type: Date, default: Date.now },

      // Metadata cho RAG
      metadata: {
        usedKnowledgeChunks: [String], // IDs của knowledge chunks được sử dụng
        customerFieldsUsed: [String], // Fields khách hàng được tham chiếu
        containsSaveCommand: Boolean,
        responseQuality: Number, // Đánh giá chất lượng phản hồi (cho training)
      },
    },
  ],

  // Context summary để giảm token
  contextSummary: {
    mainTopics: [String],
    customerNeeds: [String],
    lastSummaryUpdate: Date,
  },

  startedAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now },
});

conversationSchema.index({ customerIdentifier: 1, botCode: 1 });

module.exports = mongoose.model("_Conversation", conversationSchema);
