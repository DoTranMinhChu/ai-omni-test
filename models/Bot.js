const mongoose = require('mongoose');

const BotSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    language: { type: String, default: 'vi' },

    // Prompt gốc (Vẫn giữ để định hình cốt lõi)
    systemPrompt: { type: String, required: true },
    optimizedPrompt: { type: String },
    // CẤU HÌNH HÀNH VI CHI TIẾT
    behaviorConfig: {
        tone: {
            type: String,
            default: "professional"
            // VD: "funny", "empathetic", "strict", "gen-z slang"
        },
        attitude: {
            type: String,
            default: "helpful"
            // VD: "assertive" (chốt sale), "patient" (CSKH), "enthusiastic" (Marketing)
        },
        responseStyle: {
            type: String,
            default: "balanced"
            // VD: "short_text_message" (như tin nhắn), "detailed_essay" (chuyên gia)
        },
        // Những từ/chủ đề cấm kỵ tuyệt đối không nói
        prohibitedTopics: [{ type: String }],

        // Mức độ sáng tạo (0: Chỉ bám docs, 1: Chém gió thoải mái)
        creativityLevel: { type: Number, default: 0.7 }
    },

    // Cấu hình bộ nhớ (AI sẽ tự động điền cái này khi Generate)
    memoryConfig: [{
        key: String,
        description: String,
        type: { type: String, default: 'string' }
    }],

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('_Bot', BotSchema);