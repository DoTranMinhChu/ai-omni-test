const deepseekService = require('./deepseekService');

class BotOptimizer {
    async optimizeBotInstruction(rawSystemPrompt, behaviorConfig, memoryConfig) {
        const memoryKeys = memoryConfig.map(m => m.key).join(', ');

        // Meta-Prompt hoàn toàn bằng Tiếng Việt để DeepSeek hiểu sắc thái
        const prompt = `
        Bạn là một chuyên gia thiết kế nhân cách cho AI (Persona Designer).
        Nhiệm vụ: Biến "Mô tả thô" thành một "Bản thiết lập nhân vật" (System Instruction) chi tiết, tự nhiên và tối ưu cho LLM.

        THÔNG TIN ĐẦU VÀO:
        - Mô tả gốc: "${rawSystemPrompt}"
        - Giọng điệu (Tone): "${behaviorConfig.tone}"
        - Thái độ (Attitude): "${behaviorConfig.attitude}"
        - Cấm kỵ: "${behaviorConfig.prohibitedTopics.join(', ')}"
        - Dữ liệu cần nhớ: "${memoryKeys}"

        YÊU CẦU ĐẦU RA (OUTPUT):
        Hãy viết một đoạn System Prompt bằng TIẾNG VIỆT, sử dụng ngôi thứ 2 ("Bạn là..."), bao gồm các phần sau:
        1. **ĐỊNH DANH & CỐT LÕI**: Bạn là ai? Sứ mệnh là gì? (Viết thật "deep", có hồn).
        2. **PHONG CÁCH GIAO TIẾP**: Hướng dẫn cụ thể cách dùng từ, cách xưng hô, emoji (nếu có), độ dài câu. Phải phản ánh đúng Tone & Attitude ở trên.
        3. **QUY TẮC ỨNG XỬ**: Những điều CẤM và những điều KHUYẾN KHÍCH.
        4. **NHIỆM VỤ TRÍ NHỚ**: Hướng dẫn khéo léo trích xuất thông tin: ${memoryKeys} nhưng không được hỏi dồn dập như công an.

        LƯU Ý: 
        - Viết dưới dạng văn xuôi mạch lạc hoặc gạch đầu dòng rõ ràng.
        - Tối ưu hóa để AI "nhập vai" sâu sắc, không bị máy móc.
        - KHÔNG giải thích gì thêm, chỉ đưa ra kết quả Prompt đã tối ưu.
        `;

        try {
            const optimizedText = await deepseekService.chat([
                { role: 'system', content: 'Bạn là chuyên gia thiết kế Prompt Tiếng Việt.' },
                { role: 'user', content: prompt }
            ], { temperature: 0.7, max_tokens: 2000 });

            return optimizedText.trim();
        } catch (error) {
            console.error("Optimization Failed:", error);
            return rawSystemPrompt; // Fallback
        }
    }
}

module.exports = new BotOptimizer();