const express = require('express');
const router = express.Router();
const ImageTemplate = require('../models/ImageTemplate');
const geminiService = require('../services/geminiService'); // Service tối ưu prompt (Text)
const GeneratedImage = require('../models/GeneratedImage');

// API Tạo ảnh
router.post('/generate', async (req, res) => {
    try {
        const { templateCode, variables } = req.body;

        // 1. Tìm Template
        const template = await ImageTemplate.findOne({ templateCode });
        if (!template) {
            return res.status(404).json({ error: 'Template code không tồn tại' });
        }

        // 2. Validate
        const missingVars = template.variables.filter(v => !variables[v.key]);
        if (missingVars.length > 0) {
            return res.status(400).json({ error: `Thiếu biến: ${missingVars.join(', ')}` });
        }


        // 3. Tối ưu Prompt (Vẫn dùng logic cũ của bạn)
        const finalPrompt = await geminiService.buildFinalPrompt(template.basePrompt, variables);

        // 4. Gọi Gemini Imagen để tạo ảnh
        // Lưu ý: Kết quả trả về là Base64 String
        const imageBase64 = await geminiService.generateImage(finalPrompt);

        await GeneratedImage.create({
            userId: userId || 'GUEST',
            templateCode,
            finalPrompt,
            variablesUsed: variables,
            imageType: "BASE64",
            imageUrl: imageBase64
        });
        // 5. Trả về kết quả
        return res.json({
            success: true,
            finalOptimizedPrompt: finalPrompt,
            imageBase64: imageBase64 // Dữ liệu này là Base64 Data URI
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;