const mongoose = require('mongoose');

const CustomerSchema = new mongoose.Schema({
    identifier: { type: String, required: true },
    botCode: { type: String, required: true, index: true },

    // ĐÂY LÀ TRÍ NHỚ DÀI HẠN (Long-term Memory)
    // VD: { "ten": "Lan", "thai_ky": "tuan_12", "so_thich": "nhac_thien" }
    attributes: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: {}
    },

    // Metadata quản lý
    lastActiveAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

// Index tìm kiếm nhanh khách hàng của bot cụ thể
CustomerSchema.index({ identifier: 1, botCode: 1 }, { unique: true });

module.exports = mongoose.model('_Customer', CustomerSchema);