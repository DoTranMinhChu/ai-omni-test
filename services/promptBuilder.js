class PromptBuilder {
    build(bot, customerAttributes, retrievedDocs, contextSummary) {


        const memoryObj = customerAttributes instanceof Map
            ? Object.fromEntries(customerAttributes)
            : customerAttributes;

        const currentMemory = JSON.stringify(memoryObj);


        // 2. Extraction Rules
        const fieldsToExtract = bot.memoryConfig
            .map(f => `${f.key} (${f.description})`)
            .join(', ');

        // 3. RAG (Cắt ngắn để tối ưu tốc độ)
        let cleanDocs = retrievedDocs || "";
        // if (cleanDocs.length > 6000) {
        //     cleanDocs = cleanDocs.substring(0, 6000) + "...[truncated]";
        // }
        if (!cleanDocs) cleanDocs = "No specific knowledge found.";

        // 4. Taboos
        const taboos = bot.behaviorConfig.prohibitedTopics.length > 0
            ? `DO NOT MENTION: ${bot.behaviorConfig.prohibitedTopics.join(', ')}`
            : "";
        const summarySection = contextSummary
            ? `\n=== SUMMARY OF CONTEXT CONTINUOUS CONVERSATION ===\n${contextSummary}\n(Please continue this conversation.)`
            : "";

        // --- PROMPT TỐI ƯU (Chỉ thị Anh - Trả lời Việt) ---
        return `
ROLE & PERSONA (Vietnamese):
"${bot.systemPrompt}"

CONFIGURATION:
- Tone: ${bot.behaviorConfig.tone}
- Attitude: ${bot.behaviorConfig.attitude}
- Style: ${bot.behaviorConfig.responseStyle}
${taboos}

KNOWLEDGE BASE (Context):
"""
${cleanDocs}
"""

USER INFO (FACTS):
${currentMemory}
${summarySection}
INSTRUCTIONS:
1. Analyze the user's input and the KNOWLEDGE BASE.
2. **IMPORTANT: REPLY ENTIRELY IN VIETNAMESE (TIẾNG VIỆT).**
3. Keep the answer natural, relevant, and concise (under 150 words if possible).
4. Extract information if user mentions: ${fieldsToExtract}.

OUTPUT FORMAT:
[Your Vietnamese Reply Here]
|||DATA_START||| JSON_DATA |||DATA_END|||
(Append DATA part ONLY if new info is extracted)
`;
    }
}

module.exports = new PromptBuilder();