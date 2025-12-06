const mongoose = require('mongoose');

const CustomerSchema = new mongoose.Schema({
    identifier: { type: String, required: true },
    botCode: { type: String, required: true, index: true },

    // 1. Explicit Memory (Cứng - Do Admin định nghĩa)
    attributes: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: {}
    },

    // 2. Implicit Memory (Mềm - Do AI tự tóm tắt)
    // Đây là "Nhật ký" tóm tắt quá trình trò chuyện
    contextSummary: {
        type: String,
        default: ""
    },

    lastActiveAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

CustomerSchema.index({ identifier: 1, botCode: 1 }, { unique: true });
module.exports = mongoose.model('_Customer', CustomerSchema);