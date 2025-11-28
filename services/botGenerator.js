const deepseekService = require('./deepseekService');

class BotGenerator {
    async generateBotConfig(description) {
        const prompt = `
        Bạn là chuyên gia thiết kế Chatbot AI. Nhiệm vụ của bạn là chuyển đổi mô tả thô sơ của người dùng thành cấu hình JSON kỹ thuật.

        MÔ TẢ NGƯỜI DÙNG: "${description}"

        HÃY TRẢ VỀ DUY NHẤT 1 JSON (Không giải thích thêm) theo cấu trúc sau:
        {
            "name": "Tên bot gợi ý",
            "code": "MÃ_BOT_VIET_HOA_KHONG_DAU",
            "systemPrompt": "Viết một đoạn prompt chi tiết (khoảng 100 từ) mô tả vai trò, nhiệm vụ chính.",
            "behaviorConfig": {
                "tone": "Mô tả giọng điệu (VD: Hài hước, Nghiêm túc, Teen code...)",
                "attitude": "Mô tả thái độ (VD: Săn đón, Tận tâm, Lạnh lùng...)",
                "responseStyle": "Kiểu trả lời (VD: Ngắn gọn như chat Zalo, hay Dài dòng như Email)",
                "prohibitedTopics": ["Danh sách 3-5 chủ đề cấm kỵ liên quan đến ngữ cảnh này"]
            },
            "memoryConfig": [
                { "key": "field_name", "description": "Mô tả thông tin cần thu thập", "type": "string/number/date" }
            ]
            // Tạo khoảng 3-5 trường thông tin quan trọng cần thu thập từ khách hàng dựa trên mô tả.
        }
        `;

        try {
            const rawContent = await deepseekService.chat([{ role: 'user', content: prompt }]);
            
            // Xử lý chuỗi JSON trả về (đề phòng AI thêm markdown ```json)
            const jsonStr = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (error) {
            console.error("Bot Generation Error:", error);
            throw new Error("Không thể tạo cấu hình Bot từ AI.");
        }
    }
}

module.exports = new BotGenerator();