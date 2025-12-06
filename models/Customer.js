const mongoose = require('mongoose');

const CustomerSchema = new mongoose.Schema({
    identifier: { type: String, required: true },
    botCode: { type: String, required: true, index: true },

    // Thông tin cứng (Tên, Tuổi, SĐT...)
    attributes: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: {}
    },

    // Hồ sơ tâm lý khách hàng (AI tự xây dựng dần)
    // VD: "Khách hàng khó tính, thích nói thẳng, ghét icon"
    psychologicalProfile: {
        type: String,
        default: "Người dùng mới, chưa rõ tính cách."
    },

    // Tóm tắt câu chuyện cũ
    contextSummary: { type: String, default: "" },

    lastActiveAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

CustomerSchema.index({ identifier: 1, botCode: 1 }, { unique: true });
module.exports = mongoose.model('_Customer', CustomerSchema);