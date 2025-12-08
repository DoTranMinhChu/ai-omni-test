const Bot = require('../models/Bot');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const deepseekService = require('./deepseekService');
const knowledgeRAGService = require('./knowledgeRAGService');
const promptBuilder = require('./promptBuilder');

class ChatService {
    async processMessage(botCode, userIdentifier, userMessageContent) {
        const startTime = Date.now();

        // 1. Lấy Bot & Customer
        const bot = await Bot.findOne({ code: botCode }).lean();
        if (!bot) throw new Error("Bot not found");

        let customer = await Customer.findOne({ identifier: userIdentifier, botCode });
        if (!customer) {
            customer = await Customer.create({ identifier: userIdentifier, botCode });
        }

        // 2. PARALLEL FETCHING: Lấy Lịch sử + RAG cùng lúc để tối ưu tốc độ
        // Lấy 15 tin nhắn gần nhất để đảm bảo tính liền mạch (Continuity)
        const [recentMessages, ragChunks] = await Promise.all([
            Message.find({ botCode, customerIdentifier: userIdentifier })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean(), // .lean() giúp query nhanh hơn
            knowledgeRAGService.retrieveContext(bot._id, userMessageContent)
        ]);
        console.log("ragChunks ==> ", ragChunks)
        // Đảo ngược lại message để đúng thứ tự thời gian (Cũ -> Mới) cho Prompt
        const sortedMessages = recentMessages.reverse();

        // 3. Xây dựng Prompt "Tiếng Việt hóa"
        const systemPrompt = promptBuilder.build(
            bot,
            customer,
            sortedMessages,
            ragChunks
        );

        // 4. Gọi AI
        // Lưu ý: Chỉ gửi systemPrompt và userMessageContent mới nhất.
        // Lịch sử cũ đã được nhúng vào systemPrompt để AI có cái nhìn toàn cảnh.
        const messagesPayload = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessageContent }
        ];

        // Tăng max_tokens lên một chút để bot thoải mái diễn đạt
        const aiResponseRaw = await deepseekService.chat(messagesPayload, {
            temperature: bot.behaviorConfig?.creativityLevel || 0.7,
            max_tokens: 1000
        });

        const { replyText, extractedData } = this.parseResponse(aiResponseRaw);

        // 5. Trả kết quả ngay cho người dùng (Non-blocking)
        const responseData = { reply: replyText, captured_data: { ...(JSON.parse(JSON.stringify(customer.attributes)) || {}), ...extractedData } };

        // 6. Xử lý hậu kỳ (Lưu DB, Tóm tắt, Update Profile)
        // Không dùng await ở đây để api phản hồi nhanh
        this.handleBackgroundTasks(
            bot, customer, userIdentifier, userMessageContent, replyText, extractedData
        ).catch(err => console.error("BG Task Error:", err));

        console.log(`🚀 Total Latency: ${Date.now() - startTime}ms`);
        return responseData;
    }

    // Tác vụ chạy ngầm thông minh hơn
    async handleBackgroundTasks(bot, customer, userIdentifier, userMsg, botMsg, extractedData) {
        try {
            // A. Lưu tin nhắn vào DB
            await Promise.all([
                Message.create({ botCode: bot.code, customerIdentifier: userIdentifier, role: 'user', content: userMsg }),
                Message.create({ botCode: bot.code, customerIdentifier: userIdentifier, role: 'assistant', content: botMsg, metadata: { extractedData } })
            ]);

            // B. Cập nhật Attributes (Thông tin cứng)
            let needSaveCustomer = false;
            if (extractedData && Object.keys(extractedData).length > 0) {
                // Logic merge attributes...
                for (const [key, value] of Object.entries(extractedData)) {
                    if (customer.attributes instanceof Map) customer.attributes.set(key, value);
                    else customer.attributes[key] = value;
                }
                needSaveCustomer = true;
            }

            // C. Cập nhật "Implicit Memory" (Tóm tắt & Hồ sơ tâm lý)
            // Chiến thuật: Chỉ update sau mỗi 3-5 tin nhắn hoặc khi hội thoại dài
            // Để tiết kiệm chi phí và thời gian
            const messageCount = await Message.countDocuments({ botCode: bot.code, customerIdentifier: userIdentifier });

            if (messageCount % 4 === 0) {
                console.log("🧠 Triggering Memory Consolidation...");
                const newAnalysis = await this.consolidateMemory(
                    customer.contextSummary,
                    customer.psychologicalProfile,
                    userMsg,
                    botMsg
                );

                if (newAnalysis) {
                    customer.contextSummary = newAnalysis.summary;
                    customer.psychologicalProfile = newAnalysis.profile;
                    needSaveCustomer = true;
                }
            }

            // D. Lưu Customer
            if (needSaveCustomer) {
                customer.lastActiveAt = new Date();
                await customer.save();
            } else {
                await Customer.updateOne({ _id: customer._id }, { lastActiveAt: new Date() });
            }

        } catch (error) {
            console.error("Background Task Error:", error);
        }
    }

    // Hàm "Tư duy" để cập nhật bộ nhớ dài hạn
    async consolidateMemory(oldSummary, oldProfile, lastUserMsg, lastBotMsg) {
        const prompt = `
        Tôi cần bạn cập nhật hồ sơ khách hàng dựa trên trao đổi mới nhất.
        
        DỮ LIỆU CŨ:
        - Tóm tắt chuyện cũ: "${oldSummary}"
        - Hồ sơ tâm lý: "${oldProfile}"

        TRAO ĐỔI MỚI NHẤT:
        Khách: "${lastUserMsg}"
        Bot: "${lastBotMsg}"

        YÊU CẦU:
        Trả về JSON update gồm 2 trường:
        1. "summary": Tóm tắt ngắn gọn diễn biến câu chuyện đến hiện tại (dưới 100 từ).
        2. "profile": Cập nhật tính cách/thái độ khách hàng (dưới ̀50 từ).

        Output JSON only.
        `;

        try {
            const result = await deepseekService.chat([{ role: "user", content: prompt }], { temperature: 0.2 });
            // Cố gắng parse JSON từ result (DeepSeek đôi khi wrap trong markdown)
            const cleanJson = result.replace(/```json|```/g, '').trim();
            return JSON.parse(cleanJson);
        } catch (e) {
            console.error("Memory Consolidation Failed:", e);
            return null;
        }
    }

    parseResponse(rawText) {
        // Giữ nguyên logic parse cũ của bạn, nó đã ổn
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