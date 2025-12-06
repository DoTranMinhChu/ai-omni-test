const deepseekService = require('./deepseekService');

class BotOptimizer {
    async optimizeBotInstruction(rawSystemPrompt, behaviorConfig, memoryConfig) {

        // Chuẩn bị dữ liệu đầu vào
        const memoryKeys = memoryConfig.map(m => m.key).join(', ');
        const prohibited = behaviorConfig.prohibitedTopics.join(', ');
        const style = `${behaviorConfig.tone}, ${behaviorConfig.attitude}`;

        // Prompt này KHÔNG chứa ví dụ cụ thể về 3M hay bất cứ ngành nào
        // Nó chỉ chứa hướng dẫn về CẤU TRÚC (Structure Instructions)
        const prompt = `
        Bạn là chuyên gia tối ưu hóa System Prompt (Meta-Prompt Engineer).
        
        NHIỆM VỤ:
        Biên tập lại "DỮ LIỆU ĐẦU VÀO" bên dưới thành một bản hướng dẫn (System Instruction) ngắn gọn, súc tích, logic để nạp cho AI.

        DỮ LIỆU ĐẦU VÀO TỪ NGƯỜI DÙNG:
        - Mô tả gốc (Raw Prompt): "${rawSystemPrompt}"
        - Phong cách (Style): "${style}"
        - Tuyệt đối cấm (Taboos): "${prohibited}"
        - Dữ liệu cần trích xuất (Memory): "${memoryKeys}"

        YÊU CẦU TỐI ƯU HÓA (QUAN TRỌNG):
        1. **Trung thành tuyệt đối:** Chỉ sử dụng thông tin từ "Mô tả gốc". KHÔNG được tự ý thêm các kịch bản bán hàng, tên thương hiệu, hay quy trình không có trong đầu vào.
        2. **Cấu trúc hóa:** Tách đoạn văn dài thành các gạch đầu dòng logic (Role, Goal, Rules, Workflow).
        3. **Văn phong:** Sử dụng câu mệnh lệnh ngắn gọn (Imperative mood). Loại bỏ các từ nối rườm rà như "Bạn hãy...", "Xin vui lòng...".
        4. **Ngôn ngữ:** Output là Tiếng Anh (để AI xử lý nhanh nhất) hoặc Tiếng Việt nhưng phải cực ngắn.

        TEMPLATE OUTPUT BẮT BUỘC (Hãy điền nội dung tương ứng vào):
        ROLE: [Xác định vai trò chính từ mô tả]
        GOAL: [Mục tiêu cốt lõi]
        PERSONALITY: [Phong cách & Thái độ]
        CONSTRAINTS: [Các điều cấm]
        
        KEY GUIDELINES:
        - [Quy tắc 1 rút ra từ mô tả]
        - [Quy tắc 2 rút ra từ mô tả]
        - [Quy tắc 3...]
        
        MEMORY TARGETS: ${memoryKeys}

        HÃY VIẾT LẠI DỰA TRÊN DỮ LIỆU ĐẦU VÀO TRÊN:
        `;

        try {
            const optimizedText = await deepseekService.chat([
                { role: 'system', content: 'You are a neutral Prompt Editor. Do not hallucinate info not present in input.' },
                { role: 'user', content: prompt }
            ], { temperature: 0.3, max_tokens: 2000 }); // Temp thấp để bám sát input

            return optimizedText.trim();
        } catch (error) {
            console.error("Optimization Failed:", error);
            // Fallback an toàn: Trả về nguyên gốc nếu lỗi, không chế bậy
            return rawSystemPrompt;
        }
    }
}

module.exports = new BotOptimizer();