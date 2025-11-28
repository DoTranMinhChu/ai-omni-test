const mongoose = require("mongoose");

const knowledgeChunkSchema = new mongoose.Schema({
  title: String,
  content: String,
  keywords: [String],
  category: String,
  priority: { type: Number, default: 1 },
  tokenCount: Number,
  source: String, // 'manual', 'document', 'url'
  documentPage: Number, // Trang trong tài liệu gốc
  isActive: { type: Boolean, default: true },
});

const behaviorConfigSchema = new mongoose.Schema({
  // Loại bot
  botType: {
    type: String,
    enum: [
      "sales",
      "consulting",
      "support",
      "education",
      "entertainment",
      "general",
    ],
    default: "general",
  },

  // Phong cách giao tiếp
  communicationStyle: {
    type: String,
    enum: ["friendly", "professional", "formal", "casual", "enthusiastic"],
    default: "friendly",
  },

  // Mức độ chi tiết
  detailLevel: {
    type: String,
    enum: ["concise", "balanced", "detailed"],
    default: "balanced",
  },

  // Ngôn ngữ
  language: {
    type: String,
    default: "vi",
  },

  // Tự động thu thập thông tin
  autoCollectInfo: {
    enabled: { type: Boolean, default: true },
    priorityFields: [String], // ['name', 'phone', 'email']
    timing: {
      type: String,
      enum: ["immediate", "delayed", "contextual"],
      default: "contextual",
    },
  },

  // Chiến lược bán hàng (nếu là bot sales)
  salesStrategy: {
    enabled: { type: Boolean, default: false },
    productFocus: [String],
    upselling: { type: Boolean, default: false },
    leadFollowUp: { type: Boolean, default: true },
  },

  // Giới hạn
  limits: {
    maxResponseLength: { type: Number, default: 500 },
    useEmojis: { type: Boolean, default: true },
    allowSmallTalk: { type: Boolean, default: true },
  },
});

const trainingConfigSchema = new mongoose.Schema({
  // Cấu hình training từ tài liệu
  documentProcessing: {
    chunkSize: { type: Number, default: 1000 },
    chunkOverlap: { type: Number, default: 200 },
    maxTokensPerChunk: { type: Number, default: 500 },
  },

  // Tự động extract keywords
  autoKeywordExtraction: { type: Boolean, default: true },

  // Categories tự động
  autoCategorization: { type: Boolean, default: true },

  // Xử lý tài liệu lớn
  largeDocumentSupport: { type: Boolean, default: true },
  maxDocumentPages: { type: Number, default: 1000 },
});

const botChatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true },
  description: String,

  // System prompt linh động
  systemPrompt: { type: String, required: true },

  // Prompt phụ trợ
  welcomeMessage: String,
  fallbackMessage: String,
  collectingMessage: String,

  // Knowledge được cấu trúc hóa
  knowledgeChunks: [knowledgeChunkSchema],

  // Fields để thu thập từ khách hàng
  customerFields: [
    {
      fieldName: String,
      fieldType: {
        type: String,
        enum: ["text", "number", "email", "phone", "date", "enum"],
      },
      description: String,
      required: Boolean,
      relevanceKeywords: [String],
      enumValues: [String], // Cho fieldType enum
      priority: { type: Number, default: 1 },
    },
  ],

  // Cấu hình hành vi - QUAN TRỌNG
  behaviorConfig: behaviorConfigSchema,

  // Cấu hình training
  trainingConfig: trainingConfigSchema,

  // Cấu hình RAG
  ragConfig: {
    maxChunks: { type: Number, default: 5 },
    chunkSize: { type: Number, default: 200 },
    similarityThreshold: { type: Number, default: 0.3 },
    useSemanticSearch: { type: Boolean, default: true },
  },

  // Metadata
  status: {
    type: String,
    enum: ["active", "inactive", "training"],
    default: "active",
  },
  version: { type: String, default: "1.0.0" },

  // Thống kê
  stats: {
    totalConversations: { type: Number, default: 0 },
    totalMessages: { type: Number, default: 0 },
    trainedDocuments: { type: Number, default: 0 },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Index cho tìm kiếm
botChatSchema.index({ code: 1 });
botChatSchema.index({ "behaviorConfig.botType": 1 });
botChatSchema.index({ "knowledgeChunks.keywords": 1 });

module.exports = mongoose.model("_BotChat", botChatSchema);
