const express = require('express');
const router = express.Router();

// 1. API Gửi tin nhắn (Chat)
router.post('/generate', async (req, res) => {
    try {
        const { templateCode, variables } = req.body;

        // 1. Tìm Template trong DB
        const template = await ImageTemplate.findOne({ templateCode });
        if (!template) {
            return res.status(404).json({ error: 'Template code không tồn tại' });
        }

        // 2. Validate input
        const missingVars = template.variables.filter(v => !variables[v]);
        if (missingVars.length > 0) {
            return res.status(400).json({ error: `Thiếu biến: ${missingVars.join(', ')}` });
        }

        // 3. Dùng Gemini để tạo Final Prompt (Kết hợp + Dịch + Tối ưu)
        const finalPrompt = await geminiService.buildFinalPrompt(template.basePrompt, variables);

        console.log("👉 Final Prompt generated:", finalPrompt);

        // 4. (Giả lập) Gửi Final Prompt tới API tạo ảnh (như OpenAI DALL-E, Stability AI)
        // const imageUrl = await callImageGenAPI(finalPrompt); 

        // Hiện tại trả về Prompt để bạn test
        return res.json({
            success: true,
            originalIntent: variables,
            finalOptimizedPrompt: finalPrompt,
            // imageUrl: "https://example.com/generated-image.png" // Sau này sẽ là link ảnh thật
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;