const Bot = require('../models/Bot');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const deepseekService = require('./deepseekService');
const knowledgeService = require('./knowledgeService');
const promptBuilder = require('./promptBuilder');

class ChatService {
    async processMessage(botCode, userIdentifier, userMessageContent) {
        const startTime = Date.now();

        // 1. TỐI ƯU: Chạy song song các tác vụ chuẩn bị dữ liệu (Critical Path)
        // Thay vì await từng cái, ta dùng Promise.all để tiết kiệm thời gian
        const [bot, customer] = await Promise.all([
            Bot.findOne({ code: botCode }).lean(), // Dùng lean() để query nhanh hơn nếu chỉ đọc
            Customer.findOne({ identifier: userIdentifier, botCode })
        ]);

        if (!bot) throw new Error("Bot not found");

        // Nếu khách hàng chưa tồn tại, tạo mới (Tác vụ này nhanh, có thể await)
        let currentCustomer = customer;
        if (!currentCustomer) {
            currentCustomer = await Customer.create({ identifier: userIdentifier, botCode });
        }

        // 2. Lấy Context & History song song
        // - Lấy 10 tin nhắn gần nhất
        // - RAG: Tìm kiếm tri thức
        const [recentMessages, contextDocs] = await Promise.all([
            Message.find({ botCode, customerIdentifier: userIdentifier })
                .sort({ createdAt: -1 })
                .limit(10)
                .lean(), // Dùng lean() cho nhẹ
            knowledgeService.retrieveContext(bot._id, userMessageContent)
        ]);

        const historyForAI = recentMessages.reverse().map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // 3. Build Prompt
        // Chuyển attributes từ Map sang Object (nếu dùng Mongoose Map)
        const customerAttrs = currentCustomer.attributes instanceof Map
            ? Object.fromEntries(currentCustomer.attributes)
            : currentCustomer.attributes;

        const systemPrompt = promptBuilder.build(bot, customerAttrs, contextDocs);

        const messagesPayload = [
            { role: "system", content: systemPrompt },
            ...historyForAI
        ];

        // 4. Gọi DeepSeek (Đây là nút thắt cổ chai chính - không thể né)
        const aiResponseRaw = await deepseekService.chat(messagesPayload);

        // 5. Parse Response
        const { replyText, extractedData } = this.parseResponse(aiResponseRaw);

        // 6. TRẢ KẾT QUẢ NGAY LẬP TỨC CHO NGƯỜI DÙNG (Fast Response)
        // Chúng ta không chờ việc lưu DB hoàn tất
        const responseData = {
            reply: replyText,
            captured_data: extractedData
        };

        // 7. BACKGROUND PROCESSING (Xử lý ngầm - Fire & Forget)
        // Các tác vụ này sẽ chạy sau khi server đã phản hồi cho client
        this.handleBackgroundTasks(
            bot,
            currentCustomer,
            userIdentifier,
            userMessageContent,
            replyText,
            extractedData
        ).catch(err => console.error("Background Task Error:", err));

        console.log(`🚀 Total Response Time: ${Date.now() - startTime}ms`);
        return responseData;
    }

    // Hàm xử lý ngầm các tác vụ I/O tốn thời gian
    async handleBackgroundTasks(bot, customer, userIdentifier, userMsg, botMsg, extractedData) {
        try {
            const botCode = bot.code;
            const tasks = [];

            // Task 1: Lưu tin nhắn User
            tasks.push(Message.create({
                botCode,
                customerIdentifier: userIdentifier,
                role: 'user',
                content: userMsg
            }));

            // Task 2: Lưu tin nhắn Bot
            tasks.push(Message.create({
                botCode,
                customerIdentifier: userIdentifier,
                role: 'assistant',
                content: botMsg,
                metadata: { extractedData }
            }));

            // Task 3: Cập nhật Trí nhớ (Memory)
            if (Object.keys(extractedData).length > 0) {
                let hasChange = false;

                // Cần fetch lại customer mới nhất để tránh conflict nếu có request song song
                // Tuy nhiên ở mức độ đơn giản, ta dùng instance hiện tại
                for (const [key, value] of Object.entries(extractedData)) {
                    // Check config
                    const config = bot.memoryConfig.find(c => c.key === key);
                    if (config) {
                        // Nếu dùng Mongoose Map
                        if (customer.attributes instanceof Map) {
                            customer.attributes.set(key, value);
                        } else {
                            // Nếu dùng Object thường (Mixed)
                            customer.attributes[key] = value;
                            // Cần markModified nếu là Mixed Object
                            customer.markModified('attributes');
                        }
                        hasChange = true;
                    }
                }

                if (hasChange) {
                    customer.lastActiveAt = new Date();
                    tasks.push(customer.save());
                } else {
                    // Vẫn update lastActiveAt
                    customer.lastActiveAt = new Date();
                    tasks.push(customer.save());
                }
            } else {
                customer.lastActiveAt = new Date();
                tasks.push(customer.save());
            }

            // Chạy tất cả tasks song song
            await Promise.all(tasks);
            // console.log("✅ Background tasks completed");

        } catch (error) {
            console.error("❌ Background Task Failed:", error);
            // Ở đây có thể log vào hệ thống monitoring (Sentry, Logstash...)
        }
    }

    parseResponse(rawText) {
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