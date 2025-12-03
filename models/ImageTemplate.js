const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
    templateCode: { type: String, required: true, unique: true, uppercase: true }, // Mã định danh (VD: BANNER_SALE)
    templateName: { type: String, required: true }, // Tên hiển thị
    basePrompt: { type: String, required: true }, // Prompt chứa {{VAR}}
    variables: [{ type: String }], // Danh sách biến: ['PRODUCT', 'COLOR']
    description: String,
    createdBy: { type: String, default: 'ADMIN' } // 'ADMIN' hoặc 'AI'
}, { timestamps: true });

module.exports = mongoose.model('_ImageTemplate', templateSchema);