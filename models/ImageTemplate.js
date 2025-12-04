const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
    templateCode: { type: String, required: true, unique: true, uppercase: true },
    templateName: { type: String, required: true },
    basePrompt: { type: String, required: true },
    // CẬP NHẬT: Variables là mảng object
    variables: [{
        key: { type: String, required: true },   // VD: DISH_NAME (Dùng để thay thế trong prompt)
        label: { type: String, required: true } // VD: Tên món ăn (Dùng để hiển thị UI)
    }],
    description: {type: String},
    createdBy: { type: String, default: 'ADMIN' }
}, { timestamps: true });

module.exports = mongoose.model('_ImageTemplate', templateSchema);