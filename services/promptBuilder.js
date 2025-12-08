class PromptBuilder {
    build(bot, customer, recentMessages, retrievedChunks) {

        // 1. Dữ liệu khách hàng (giữ nguyên)
        const userAttrs = customer.attributes instanceof Map
            ? Object.fromEntries(customer.attributes)
            : customer.attributes;
        const userJson = JSON.stringify(userAttrs, null, 2);

        // 2. Kiến thức (RAG) (giữ nguyên)
        let knowledgeSection = "Không có tài liệu tham khảo.";
        if (Array.isArray(retrievedChunks) && retrievedChunks.length > 0) {
            // Giữ nguyên logic này nếu bạn chưa áp dụng Context Compression
            knowledgeSection = retrievedChunks
                .map(c => `- ${c.content}`)
                .join('\n');
        }

        // 3. Lịch sử chat (Recent Messages) (giữ nguyên)
        const historyText = recentMessages.map(msg => {
            const role = msg.role === 'user' ? 'Khách' : 'Bạn';
            return `${role}: ${msg.content}`;
        }).join('\n');

        // 4. Memory Targets (giữ nguyên)
        const memoryKeys = bot.memoryConfig ? bot.memoryConfig.map(m => m.key).join(', ') : "";

        // --- FINAL SYSTEM PROMPT (Tiếng Việt thuần khiết) ---
        return `
${bot.optimizedPrompt || bot.systemPrompt}

### DỮ LIỆU BỐI CẢNH (CONTEXT DATA)
Hãy sử dụng các dữ liệu dưới đây để tư duy, nhưng ĐỪNG nhắc lại chúng một cách máy móc trừ khi cần thiết.

<Hồ_Sơ_Khách_Hàng>
${userJson}
* Phân tích tâm lý hiện tại: ${customer.psychologicalProfile || "Chưa rõ"}
* Tóm tắt chuyện cũ: ${customer.contextSummary || "Mới bắt đầu"}
</Hồ_Sơ_Khách_Hàng>

<Kiến_Thức_Tra_Cứu>
${knowledgeSection}
</Kiến_Thức_Tra_Cứu>

<Lịch_Sử_Hội_Thoại_Gần_Nhất>
${historyText}
</Lịch_Sử_Hội_Thoại_Gần_Nhất>

### HƯỚNG DẪN TƯ DUY (CHAIN OF THOUGHT)
Trước khi trả lời, hãy thực hiện quy trình tư duy ngầm:
1. Quan sát: Khách đang hỏi gì? Cảm xúc của họ thế nào qua tin nhắn cuối?
2. **Kiểm tra Lịch sử**: Đã chào khách chưa? Đã trả lời ý này trong 3 tin nhắn gần nhất chưa?
3. Đối chiếu: Thông tin này có trong <Kiến_Thức_Tra_Cứu> hay <Lịch_Sử_Hội_Thoại> không?
4. Quyết định: Mình nên trả lời ngắn gọn, hài hước, hay nghiêm túc? Có cần hỏi lại để lấy thông tin [${memoryKeys}] không?

### ĐỊNH DẠNG TRẢ LỜI
- **QUY TẮC BẮT BUỘC:** Câu trả lời phải ngắn gọn, súc tích, **dưới 150 từ** và chỉ tập trung vào vấn đề khách hàng đang hỏi.
- Trả lời tự nhiên như người thật nói chuyện qua tin nhắn. **TUYỆT ĐỐI KHÔNG** sử dụng ký hiệu in đậm (như **dấu sao**) hoặc bất kỳ cú pháp Markdown nào khác trong câu trả lời.
- **KHÔNG LẶP LẠI** bất kỳ câu chào hỏi hay đoạn giải thích nào đã có trong <Lịch_Sử_Hội_Thoại_Gần_Nhất>.
- KHÔNG dùng các cụm từ: "Dựa trên thông tin...", "Theo tài liệu...".
- Nếu phát hiện thông tin mới của khách hàng (${memoryKeys}), hãy trích xuất ở cuối tin nhắn theo định dạng chuẩn bên dưới (người dùng sẽ không thấy phần này).

Định dạng trích xuất (nếu có):
|||DATA_START|||{"key": "value"}|||DATA_END|||
`;
    }
}

module.exports = new PromptBuilder();