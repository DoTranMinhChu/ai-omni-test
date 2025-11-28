class PromptBuilder {
    build(bot, customerAttributes, retrievedDocs) {
        // 1. Attribute Context
        const currentMemory = JSON.stringify(Object.fromEntries(customerAttributes));

        // 2. Memory Extraction Rules
        const fieldsToExtract = bot.memoryConfig.map(f => `- ${f.key}: ${f.description}`).join('\n');

        // 3. Prohibited Rules
        const taboos = bot.behaviorConfig.prohibitedTopics.length > 0
            ? `CẤM KỴ TUYỆT ĐỐI (KHÔNG ĐƯỢC NHẮC ĐẾN): ${bot.behaviorConfig.prohibitedTopics.join(', ')}`
            : "";

        return `
        === VAI TRÒ & TÍNH CÁCH ===
        ${bot.systemPrompt}
        
        - GIỌNG ĐIỆU (TONE): ${bot.behaviorConfig.tone}
        - THÁI ĐỘ (ATTITUDE): ${bot.behaviorConfig.attitude}
        - PHONG CÁCH TRẢ LỜI: ${bot.behaviorConfig.responseStyle}
        
        ${taboos}

        === KIẾN THỨC NỀN TẢNG (CHỈ DÙNG THÔNG TIN NÀY ĐỂ TRẢ LỜI) ===
        ${retrievedDocs || "Không có tài liệu cụ thể, hãy trả lời dựa trên kiến thức chung nhưng cẩn trọng."}

        === HỒ SƠ KHÁCH HÀNG HIỆN TẠI ===
        ${currentMemory}

        === NHIỆM VỤ THU THẬP THÔNG TIN (ẨN) ===
        Nếu khách hàng cung cấp thông tin dưới đây, hãy trích xuất nó:
        ${fieldsToExtract}

        === ĐỊNH DẠNG TRẢ LỜI ===
        1. Trả lời đúng giọng điệu đã yêu cầu, không được bỏ trống câu trả lời.
        2. Nếu thu thập được thông tin mới, thêm vào cuối câu trả lời theo định dạng:
           |||DATA_START||| { "key": "value" } |||DATA_END|||
        `;
    }
}

module.exports = new PromptBuilder();