class PromptBuilder {
    build(bot, customerAttributes, retrievedChunks, contextSummary) {

        // 1. Xử lý Attributes (Chuyển thành dạng key:value đơn giản nhất)
        let userFactStr = "New User";
        if (customerAttributes && Object.keys(customerAttributes).length > 0) {
            const attrs = customerAttributes instanceof Map ? Object.fromEntries(customerAttributes) : customerAttributes;
            userFactStr = Object.entries(attrs).map(([k, v]) => `${k}:${v}`).join('|');
        }

        // 2. Xử lý RAG (Chỉ lấy nội dung tinh túy nhất)
        let ragContext = "";
        if (Array.isArray(retrievedChunks) && retrievedChunks.length > 0) {
            // Chỉ lấy 2 chunks tốt nhất và cắt ngắn để tiết kiệm token
            ragContext = retrievedChunks.slice(0, 2).map(c => c.content.substring(0, 500)).join('\n---\n');
        }

        // 3. Lấy Core Instruction (Đã tối ưu ở bước 1)
        const coreInstruction = bot.optimizedPrompt || bot.systemPrompt;

        // 4. Danh sách cần trích xuất
        const extractFields = bot.memoryConfig ? bot.memoryConfig.map(f => f.key).join(',') : "";

        // --- FINAL PROMPT (Cấu trúc dồn nén) ---
        return `
=== SYSTEM ===
${coreInstruction}

=== KNOWLEDGE ===
${ragContext}

=== USER CONTEXT ===
Facts: ${userFactStr}
Summary: ${contextSummary || "None"}

=== STRICT RESPONSE RULES ===
1. **SPEAK VIETNAMESE ONLY.**
2. **BE CONCISE:** Keep response under 3 sentences. Like a chat message, not an email.
3. **NO FORMATTING:** Do not use bold, italics, lists, or markdown.
4. **ACTION:** Answer the user -> Ask a follow-up question (if needed) -> Extract Data.

=== DATA EXTRACTION ===
Target fields: [${extractFields}]
Format: End reply with |||DATA_START|||{"key":"value"}|||DATA_END||| if info found.
`;
    }
}

module.exports = new PromptBuilder();