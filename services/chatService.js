const Bot = require('../models/Bot');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const deepseekService = require('./deepseekService');
const knowledgeService = require('./knowledgeService');
const promptBuilder = require('./promptBuilder');

class ChatService {
    async processMessage(botCode, userIdentifier, userMessageContent) {
        // 1. Validate & Get Data
        const bot = await Bot.findOne({ code: botCode });
        if (!bot) throw new Error("Bot not found");

        let customer = await Customer.findOne({ identifier: userIdentifier, botCode });
        if (!customer) {
            customer = await Customer.create({ identifier: userIdentifier, botCode });
        }

        // 2. LƯU TIN NHẮN USER NGAY LẬP TỨC (Persistence)
        await Message.create({
            botCode,
            customerIdentifier: userIdentifier,
            role: 'user',
            content: userMessageContent
        });

        // 3. LẤY CONTEXT (Short-term Memory)
        // Chỉ lấy 10 tin nhắn gần nhất để gửi cho AI (Tiết kiệm token)
        const recentMessages = await Message.find({ 
            botCode, 
            customerIdentifier: userIdentifier 
        })
        .sort({ createdAt: -1 }) // Lấy mới nhất trước
        .limit(10)               // Giới hạn 10 tin
        .lean();

        // Đảo ngược lại để đúng thứ tự thời gian (Cũ -> Mới) cho AI hiểu
        const historyForAI = recentMessages.reverse().map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // 4. RAG: Tìm kiến thức
        const contextDocs = await knowledgeService.retrieveContext(bot._id, userMessageContent);

        // 5. Build Prompt
        const systemPrompt = promptBuilder.build(bot, customer.attributes, contextDocs);

        // 6. Gọi DeepSeek
        const messagesPayload = [
            { role: "system", content: systemPrompt },
            ...historyForAI
            // Lưu ý: Không cần push userMessageContent vào đây nữa vì nó đã nằm trong historyForAI rồi
        ];

        const aiResponseRaw = await deepseekService.chat(messagesPayload);

        // 7. Parse Response
        const { replyText, extractedData } = this.parseResponse(aiResponseRaw);

        // 8. CẬP NHẬT TRÍ NHỚ DÀI HẠN (Customer Attributes)
        if (Object.keys(extractedData).length > 0) {
            let hasChange = false;
            for (const [key, value] of Object.entries(extractedData)) {
                // Chỉ update nếu field được định nghĩa trong bot
                const config = bot.memoryConfig.find(c => c.key === key);
                if (config) {
                    customer.attributes.set(key, value);
                    hasChange = true;
                }
            }
            if (hasChange) await customer.save();
        }

        // 9. LƯU TIN NHẮN BOT
        await Message.create({
            botCode,
            customerIdentifier: userIdentifier,
            role: 'assistant',
            content: replyText,
            metadata: { extractedData } // Lưu lại để Admin biết tại tin nhắn này Bot đã học được gì
        });

        // Update thời gian active
        customer.lastActiveAt = new Date();
        await customer.save();

        return {
            reply: replyText,
            captured_data: extractedData
        };
    }

    parseResponse(rawText) {
        // Logic tách JSON giữ nguyên như cũ
        const separatorStart = "|||DATA_START|||";
        const separatorEnd = "|||DATA_END|||";
        const startIndex = rawText.indexOf(separatorStart);
        
        if (startIndex === -1) return { replyText: rawText, extractedData: {} };

        const replyText = rawText.substring(0, startIndex).trim();
        const jsonString = rawText.substring(startIndex + separatorStart.length, rawText.indexOf(separatorEnd));

        try {
            return { replyText, extractedData: JSON.parse(jsonString) };
        } catch (e) {
            return { replyText, extractedData: {} };
        }
    }
}

module.exports = new ChatService();