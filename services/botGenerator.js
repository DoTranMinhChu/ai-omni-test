const deepseekService = require('./deepseekService');

class BotGenerator {

    /**
     * 1. Tạo cấu hình Bot (System Prompt, Behavior, Memory)
     */
    async generateBotConfig(description, name, code) {
        const prompt = `
        Bạn là chuyên gia thiết kế Chatbot AI (System Prompt Engineer). 
        Nhiệm vụ: Dựa vào mô tả, hãy tạo ra cấu hình JSON chi tiết cho một con Bot.

        INPUT:
        - Tên Bot: "${name}"
        - Mã Bot: "${code}"
        - Mô tả ý tưởng: "${description}"

        YÊU CẦU OUTPUT (JSON ONLY):
        Hãy trả về 1 JSON duy nhất theo cấu trúc sau (giữ nguyên các key):
        {
            "systemPrompt": "Viết một đoạn prompt dài, chi tiết (khoảng 200-300 từ) để hướng dẫn Bot cách nói chuyện, vai trò, nhiệm vụ. Cấu trúc prompt phải có các phần: === THÔNG TIN LIÊN HỆ ===, === PHONG CÁCH TRÒ CHUYỆN ===, === NHIỆM VỤ CHÍNH ===, === DATA EXTRACTION (GHI NHỚ) ===. Lưu ý: Phần DATA EXTRACTION trong prompt phải liệt kê các trường thông tin cần nhớ khớp với memoryConfig bên dưới.",
            "behaviorConfig": {
                "tone": "Mô tả giọng điệu (VD: Mộc mạc, Chân chất...)",
                "attitude": "Mô tả thái độ (VD: Tận tâm, Kiên nhẫn...)",
                "responseStyle": "balanced",
                "prohibitedTopics": ["Danh sách 3-5 chủ đề cấm kỵ liên quan đến ngữ cảnh này"]
            },
            "memoryConfig": [
                { 
                    "key": "ten_truong_viet_lien_khong_dau", 
                    "description": "Mô tả ngắn gọn ý nghĩa", 
                    "type": "string hoặc number hoặc date" 
                }
            ]
            // Tạo khoảng 4-6 trường thông tin quan trọng cần thu thập từ khách hàng phục vụ cho nhiệm vụ và vai trò của ChatBot (VD: tên, sđt, nhu cầu, ngân sách, địa chỉ...).
        }
        
        LƯU Ý QUAN TRỌNG: 
        - Nội dung System Prompt phải thật tự nhiên, "người" nhất có thể, sử dụng icon hợp lý.
        - Memory Config phải bám sát nhu cầu thực tế của mô tả.
        `;

        try {
            const rawContent = await deepseekService.chat([
                { role: 'system', content: 'Bạn là chuyên gia kiến tạo AI Bot.' },
                { role: 'user', content: prompt }
            ]);

            const jsonStr = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (error) {
            console.error("Generate Bot Config Error:", error);
            throw new Error("AI không thể tạo cấu hình Bot.");
        }
    }

    /**
     * 2. Tạo kiến thức nền tảng (Knowledge Chunks)
     */
    async generateKnowledge(description, botName) {
        const prompt = `
        Bạn là chuyên gia nội dung. Hãy tạo ra bộ dữ liệu tri thức (Knowledge Base) cho con Bot có tên "${botName}" với mô tả: "${description}".

        Nhiệm vụ:
        Tạo ra 3-5 mẩu tri thức (Knowledge Chunks) quan trọng nhất mà con Bot này cần biết để tư vấn chính xác.
        Ví dụ: Nếu là Bot nông nghiệp thì cần kiến thức về: Kỹ thuật trồng, Phân bón, Sâu bệnh. Nếu là Bot bán hàng thì cần: Giá cả, Chính sách bảo hành...

        YÊU CẦU OUTPUT (JSON ARRAY ONLY):
        [
            {
                "content": "Nội dung chi tiết của mẩu tri thức (khoảng 100-200 từ). Viết rõ ràng, mạch lạc.",
                "keywords": ["từ khóa 1", "từ khóa 2", "từ khóa 3"]
            },
            ...
        ]
        `;

        try {
            const rawContent = await deepseekService.chat([
                { role: 'system', content: 'Bạn là chuyên gia nội dung tri thức.' },
                { role: 'user', content: prompt }
            ]);

            const jsonStr = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            const knowledge = JSON.parse(jsonStr);
            return Array.isArray(knowledge) ? knowledge : [];
        } catch (error) {
            console.error("Generate Knowledge Error:", error);
            return []; // Trả về mảng rỗng nếu lỗi, không làm chết luồng chính
        }
    }
}

module.exports = new BotGenerator();