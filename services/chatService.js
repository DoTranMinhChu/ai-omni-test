const Bot = require('../models/Bot');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const deepseekService = require('./deepseekService');
const knowledgeService = require('./knowledgeService');
const promptBuilder = require('./promptBuilder');

class ChatService {
    async processMessage(botCode, userIdentifier, userMessageContent) {
        const startTime = Date.now();

        // 1. Lấy Bot & Customer
        const [bot, customer] = await Promise.all([
            Bot.findOne({ code: botCode }).lean(),
            Customer.findOne({ identifier: userIdentifier, botCode })
        ]);

        if (!bot) throw new Error("Bot not found");

        let currentCustomer = customer;
        if (!currentCustomer) {
            currentCustomer = await Customer.create({ identifier: userIdentifier, botCode });
        }

        // 2. Lấy Lịch sử ngắn (Short-term) + RAG
        // Chỉ cần lấy rất ít tin nhắn (ví dụ 4 tin) vì đã có Summary hỗ trợ
        const [ contextDocs] = await Promise.all([

            knowledgeService.retrieveContext(bot._id, userMessageContent)
        ]);


        // 3. Build Prompt (Nâng cấp)
        // Truyền thêm contextSummary vào prompt
        const systemPrompt = promptBuilder.build(
            bot,
            currentCustomer.attributes,
            contextDocs,
            currentCustomer.contextSummary // <--- Truyền tóm tắt ngữ cảnh vào
        );

        // 4. Gọi AI
        const messagesPayload = [
            { role: "system", content: systemPrompt.replace(/\s+/g, ' ').trim() },

            { role: "user", content: userMessageContent }
        ];

        const aiResponseRaw = await deepseekService.chat(messagesPayload);
        const { replyText, extractedData } = this.parseResponse(aiResponseRaw);

        // 5. Trả kết quả ngay
        const responseData = { reply: replyText, captured_data: extractedData };

        // 6. Background Tasks (Nâng cấp: Thêm logic tự tóm tắt)
        this.handleBackgroundTasks(
            bot, currentCustomer, userIdentifier, userMessageContent, replyText, extractedData
        ).catch(err => console.error("BG Error:", err));

        console.log(`🚀 Response Time: ${Date.now() - startTime}ms`);
        return responseData;
    }

    // ... (optimizeHistory giữ nguyên) ...
    optimizeHistory(messages) {
        if (!messages || messages.length === 0) return [];

        // Đảo ngược để có thứ tự thời gian: Cũ -> Mới
        const chronologicalMsgs = messages.reverse();

        return chronologicalMsgs.map(msg => {
            let content = msg.content;

            // CHIẾN THUẬT TỐI ƯU:
            // Nếu là tin nhắn của Assistant (Bot) và không phải tin nhắn cuối cùng,
            // mà nó lại quá dài (> 200 ký tự), ta sẽ cắt bớt để tiết kiệm token.
            // AI chỉ cần biết sơ sơ bot đã nói gì, không cần nguyên văn.
            if (msg.role === 'assistant' && content.length > 300) {
                content = content.substring(0, 300) + "... [Nội dung đã được rút gọn]";
            }

            return {
                role: msg.role,
                content: content
            };
        });
    }
    async handleBackgroundTasks(bot, customer, userIdentifier, userMsg, botMsg, extractedData) {
        try {
            const tasks = [];

            // 1. Lưu tin nhắn
            tasks.push(Message.create({ botCode: bot.code, customerIdentifier: userIdentifier, role: 'user', content: userMsg }));
            tasks.push(Message.create({ botCode: bot.code, customerIdentifier: userIdentifier, role: 'assistant', content: botMsg, metadata: { extractedData } }));

            // 2. Cập nhật Explicit Memory (Attributes - Cứng)
            let attributesChanged = false;
            if (extractedData && Object.keys(extractedData).length > 0) {
                const memoryConfig = bot.memoryConfig || [];
                for (const [key, value] of Object.entries(extractedData)) {
                    if (memoryConfig.some(c => c.key === key)) {
                        if (customer.attributes instanceof Map) customer.attributes.set(key, value);
                        else customer.attributes[key] = value;
                        attributesChanged = true;
                    }
                }
            }

            // 3. Cập nhật Implicit Memory (Context Summary - Mềm)
            // Logic: Gọi AI tóm tắt lại hội thoại để cập nhật contextSummary
            // Để tiết kiệm, ta có thể random xác suất hoặc đếm số tin nhắn để không gọi liên tục
            // Ở đây demo gọi luôn để thấy hiệu quả
            const newSummary = await this.updateContextSummary(
                customer.contextSummary,
                userMsg,
                botMsg
            );

            if (newSummary) {
                customer.contextSummary = newSummary;
                attributesChanged = true; // Đánh dấu để save
            }

            // 4. Lưu Customer nếu có thay đổi
            if (attributesChanged) {
                if (customer.markModified) customer.markModified('attributes');
                customer.lastActiveAt = new Date();
                tasks.push(customer.save());
            } else {
                // Chỉ update lastActiveAt
                await Customer.updateOne({ _id: customer._id }, { lastActiveAt: new Date() });
            }

            await Promise.all(tasks);

        } catch (error) {
            console.error("BG Task Error:", error);
        }
    }

    /**
     * Hàm gọi AI để tóm tắt hội thoại và cập nhật trí nhớ ngữ cảnh
     */
    async updateContextSummary(oldSummary, userMsg, botMsg) {
        try {
            const prompt = `
            Bạn là bộ nhớ của một AI. Nhiệm vụ của bạn là cập nhật bản tóm tắt ngắn gọn về cuộc trò chuyện.
            
            TÓM TẮT CŨ: "${oldSummary || 'Chưa có'}"
            
            HỘI THOẠI MỚI NHẤT:
            User: "${userMsg}"
            Bot: "${botMsg}"
            
            YÊU CẦU:
            - Kết hợp thông tin mới vào tóm tắt cũ.
            - Giữ lại các ý chính quan trọng (sở thích, vấn đề đang bàn, thái độ khách).
            - Loại bỏ các chi tiết thừa, chào hỏi xã giao.
            - Giới hạn dưới 100 từ.
            - CHỈ TRẢ VỀ NỘI DUNG TÓM TẮT MỚI.
            `;

            const summary = await deepseekService.chat([
                { role: "user", content: prompt }
            ], { temperature: 0.5, max_tokens: 150 }); // Nhiệt độ thấp để ổn định, token ít

            return summary.trim();
        } catch (e) {
            console.error("Summary Update Failed:", e.message);
            return null;
        }
    }

    parseResponse(rawText) {
        if (!rawText) return { replyText: "", extractedData: {} };
        const separatorStart = "|||DATA_START|||";
        const separatorEnd = "|||DATA_END|||";
        const startIndex = rawText.indexOf(separatorStart);
        if (startIndex === -1) return { replyText: rawText, extractedData: {} };
        const replyText = rawText.substring(0, startIndex).trim();
        const jsonString = rawText.substring(startIndex + separatorStart.length, rawText.indexOf(separatorEnd));
        try {
            const data = JSON.parse(jsonString);
            return { replyText, extractedData: data };
        } catch (e) {
            return { replyText, extractedData: {} };
        }
    }
}

module.exports = new ChatService();