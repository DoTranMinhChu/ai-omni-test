const mongoose = require('mongoose');

const generatedImageSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true }, // User ID của khách
    templateCode: { type: String, required: true },
    finalPrompt: { type: String }, // Prompt sau khi đã tối ưu
    variablesUsed: { type: Object }, // Các biến user đã nhập
    imageType: { type: String },
    imageUrl: { type: String }, // Đường dẫn file ảnh (nếu lưu file) hoặc để trống nếu chỉ trả base64 (nhưng nên lưu file để xem lại)
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('_GeneratedImage', generatedImageSchema);