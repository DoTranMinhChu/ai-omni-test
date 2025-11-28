const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    botCode: { type: String, required: true, index: true },
    customerIdentifier: { type: String, required: true, index: true },
    
    role: { 
        type: String, 
        enum: ['user', 'assistant', 'system'], 
        required: true 
    },
    
    content: { type: String, required: true },
    
    // Nếu là tin nhắn của Bot, có thể lưu thêm metadata (ví dụ: data vừa trích xuất được)
    metadata: { type: Object, default: {} },

    createdAt: { type: Date, default: Date.now }
});

// Index quan trọng để load lịch sử chat nhanh theo thời gian (Pagination)
MessageSchema.index({ botCode: 1, customerIdentifier: 1, createdAt: -1 });

module.exports = mongoose.model('_Message', MessageSchema);