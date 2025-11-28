const express = require('express');
const router = express.Router();
const BotChat = require('../models/BotChat');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const CustomerMemory = require('../models/CustomerMemory');
const DeepseekService = require('../services/deepseekService');

const deepseekService = new DeepseekService(process.env.DEEPSEEK_API_KEY);

// Cache với TTL (Time To Live)
const botCache = new Map();
const knowledgeCache = new Map();
const customerMemoryCache = new Map();

// Cache cleanup every hour
setInterval(() => {
    botCache.clear();
    knowledgeCache.clear();
    customerMemoryCache.clear();
    console.log('🔄 Cache cleared');
}, 60 * 60 * 1000);

// ========== MAIN CHAT ENDPOINT ==========

router.post('/:botCode', async (req, res) => {
    try {
        const { message, customerIdentifier } = req.body;
        const { botCode } = req.params;

        if (!message || !customerIdentifier) {
            return res.status(400).json({ error: 'Thiếu message hoặc customerIdentifier' });
        }

        console.log(`💬 Chat request: ${botCode}, Customer: ${customerIdentifier}, Message: ${message.substring(0, 100)}...`);

        // 1. Load bot và dữ liệu với memory enhancement
        const [bot, customer, conversation, customerMemory] = await loadChatDataWithMemory(botCode, customerIdentifier);

        // 2. Phân tích câu hỏi và xây dựng context với memory
        const context = await buildSmartContextWithMemory(bot, customer, conversation, message, customerMemory);

        // 3. Xây dựng messages với memory context
        const messages = buildDynamicMessagesWithMemory(bot, context, message, conversation, customerMemory);

        console.log(`🤖 Bot: ${botCode}, Type: ${bot.behaviorConfig.botType}, Tokens: ${estimateTokens(messages)}`);

        // 4. Gọi API và xử lý response với memory
        const result = await processIntelligentResponseWithMemory(bot, customer, conversation, message, messages, context, customerMemory);

        res.json(result);

    } catch (error) {
        console.error('❌ Chat error:', error);
        res.status(500).json({
            error: 'Lỗi server: ' + error.message,
            fallbackResponse: getFallbackResponse()
        });
    }
});

// ========== MEMORY-ENHANCED DATA LOADING ==========

async function loadChatDataWithMemory(botCode, customerIdentifier) {
    try {
        console.log(`📥 Loading chat data with memory for bot: ${botCode}, customer: ${customerIdentifier}`);

        // Load song song để tối ưu performance
        const [bot, customer, conversation] = await Promise.all([
            getBotFromCache(botCode),
            findOrCreateCustomer(customerIdentifier, botCode),
            findOrCreateConversation(customerIdentifier, botCode)
        ]);

        // Validate bot tồn tại và active
        if (!bot) {
            throw new Error(`Bot với mã '${botCode}' không tồn tại hoặc đã bị vô hiệu hóa`);
        }

        if (bot.status !== 'active') {
            throw new Error(`Bot '${bot.name}' hiện không hoạt động`);
        }

        // Load hoặc tạo memory cho khách hàng
        const customerMemory = await getOrCreateCustomerMemory(customerIdentifier, botCode, customer);

        console.log(`✅ Loaded chat data with memory successfully:
  - Bot: ${bot.name} (${bot.behaviorConfig.botType})
  - Customer: ${customer.identifier} (${customer.collectedFields.length} fields)
  - Conversation: ${conversation.messages?.length || 0} messages
  - Memory: ${customerMemory.knownFacts.length} known facts`);

        return [bot, customer, conversation, customerMemory];

    } catch (error) {
        console.error('❌ Error loading chat data with memory:', error);
        throw new Error(`Không thể tải dữ liệu chat: ${error.message}`);
    }
}

async function getBotFromCache(botCode) {
    if (botCache.has(botCode)) {
        const cachedBot = botCache.get(botCode);
        console.log(`♻️ Loaded bot from cache: ${cachedBot.name}`);
        return cachedBot;
    }

    try {
        const bot = await BotChat.findOne({
            code: botCode,
            status: 'active'
        }).select('name code description systemPrompt welcomeMessage fallbackMessage knowledgeChunks customerFields behaviorConfig trainingConfig ragConfig status');

        if (!bot) {
            console.error(`❌ Bot not found: ${botCode}`);
            return null;
        }

        validateBotStructure(bot);
        botCache.set(botCode, bot);
        console.log(`💾 Cached bot: ${bot.name}`);

        return bot;

    } catch (error) {
        console.error(`❌ Error loading bot ${botCode}:`, error);
        throw new Error(`Lỗi tải bot: ${error.message}`);
    }
}

async function findOrCreateCustomer(customerIdentifier, botCode) {
    try {
        let customer = await Customer.findOne({
            identifier: customerIdentifier,
            botCode: botCode
        });

        if (customer) {
            console.log(`👤 Found existing customer: ${customerIdentifier}`);
            customer.lastActive = new Date();
            await customer.save();
            return customer;
        }

        customer = new Customer({
            identifier: customerIdentifier,
            botCode: botCode,
            collectedFields: [],
            conversationCount: 0,
            firstSeen: new Date(),
            lastActive: new Date(),
            metadata: {
                source: 'chat',
                created: new Date()
            }
        });

        await customer.save();
        console.log(`👶 Created new customer: ${customerIdentifier} for bot: ${botCode}`);
        return customer;

    } catch (error) {
        console.error(`❌ Error with customer ${customerIdentifier}:`, error);
        return createTemporaryCustomer(customerIdentifier, botCode);
    }
}

async function findOrCreateConversation(customerIdentifier, botCode) {
    try {
        let conversation = await Conversation.findOne({
            customerIdentifier: customerIdentifier,
            botCode: botCode,
            status: 'active'
        }).sort({ createdAt: -1 });

        if (conversation) {
            console.log(`💭 Found existing conversation: ${conversation._id}`);
            const hoursSinceLastMessage = getHoursSinceLastMessage(conversation);
            if (hoursSinceLastMessage > 24) {
                console.log(`🕐 Conversation expired (${hoursSinceLastMessage}h), creating new one`);
                return await createNewConversation(customerIdentifier, botCode);
            }
            return conversation;
        }

        return await createNewConversation(customerIdentifier, botCode);

    } catch (error) {
        console.error(`❌ Error with conversation for ${customerIdentifier}:`, error);
        return createTemporaryConversation(customerIdentifier, botCode);
    }
}

async function createNewConversation(customerIdentifier, botCode) {
    const conversation = new Conversation({
        customerIdentifier: customerIdentifier,
        botCode: botCode,
        messages: [],
        metadata: {
            startTime: new Date(),
            messageCount: 0,
            lastBotResponse: null
        },
        status: 'active'
    });

    await conversation.save();
    console.log(`💬 Created new conversation for: ${customerIdentifier}`);
    return conversation;
}

// ========== CUSTOMER MEMORY MANAGEMENT ==========

async function getOrCreateCustomerMemory(customerIdentifier, botCode, customer) {
    const memoryKey = `${botCode}:${customerIdentifier}`;

    if (customerMemoryCache.has(memoryKey)) {
        return customerMemoryCache.get(memoryKey);
    }

    try {
        let memory = await CustomerMemory.findOne({ customerIdentifier, botCode });

        if (!memory) {
            memory = new CustomerMemory({
                customerIdentifier,
                botCode,
                knownFacts: customer.collectedFields.map(field => ({
                    fieldName: field.fieldName,
                    fieldValue: field.fieldValue,
                    confidence: 1.0,
                    lastConfirmed: new Date(),
                    source: 'direct'
                })),
                conversationHistory: [],
                preferences: {
                    communicationStyle: 'friendly',
                    topicsOfInterest: [],
                    painPoints: [],
                    productInterests: []
                },
                lastUpdated: new Date()
            });
            await memory.save();
            console.log(`🧠 Created new customer memory for: ${customerIdentifier}`);
        }

        await updateMemoryFromConversationHistory(memory, customerIdentifier, botCode);
        customerMemoryCache.set(memoryKey, memory);
        return memory;

    } catch (error) {
        console.error(`❌ Error loading customer memory:`, error);
        return createTemporaryMemory(customerIdentifier, botCode, customer);
    }
}

async function updateMemoryFromConversationHistory(memory, customerIdentifier, botCode) {
    try {
        const recentConversations = await Conversation.find({
            customerIdentifier,
            botCode,
            updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }).sort({ updatedAt: -1 }).limit(5);

        for (const conversation of recentConversations) {
            for (const msg of conversation.messages) {
                if (msg.role === 'user') {
                    await extractFactsFromMessage(memory, msg.content, 'conversation');
                }
            }
        }

        memory.lastUpdated = new Date();
        await memory.save();
    } catch (error) {
        console.error('❌ Error updating memory from conversation history:', error);
    }
}

async function extractFactsFromMessage(memory, message, source) {
    const facts = [];
    const messageLower = message.toLowerCase();

    const patterns = [
        { regex: /(?:tên|mình|tôi)(?:\s+(?:là|tên là|là tên))?\s+([a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ\s]+)/i, field: 'tên' },
        { regex: /(\b0[3|5|7|8|9][0-9]{8}\b)/, field: 'số điện thoại' },
        { regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/, field: 'email' },
        { regex: /(?:kinh doanh|làm|lĩnh vực)\s+([^.,!?]+)/i, field: 'lĩnh vực kinh doanh' },
        { regex: /(?:cửa hàng|quán|doanh nghiệp|công ty)(?:\s+(?:của|mình|tôi))?\s+(?:ở|tại)\s+([^.,!?]+)/i, field: 'địa điểm' }
    ];

    for (const pattern of patterns) {
        const match = messageLower.match(pattern.regex);
        if (match && match[1]) {
            const existingFact = memory.knownFacts.find(f => f.fieldName === pattern.field);
            if (!existingFact || existingFact.confidence < 0.8) {
                facts.push({
                    fieldName: pattern.field,
                    fieldValue: match[1].trim(),
                    confidence: 0.7,
                    lastConfirmed: new Date(),
                    source: source
                });
            }
        }
    }

    if (facts.length > 0) {
        memory.knownFacts.push(...facts);
        await memory.save();
    }
}

// ========== MEMORY-ENHANCED CONTEXT BUILDING ==========

async function buildSmartContextWithMemory(bot, customer, conversation, message, customerMemory) {
    const [relevantChunks, allCustomerFields, conversationContext, messageAnalysis] = await Promise.all([
        findRelevantKnowledge(message, bot),
        getAllCustomerFields(customer, bot),
        buildConversationContext(conversation, message),
        analyzeMessageWithMemory(message, bot.behaviorConfig.botType, customerMemory)
    ]);

    const salesOpportunity = analyzeSalesOpportunityWithMemory(message, customer, conversation, bot, customerMemory);
    const infoCollectionOpportunity = analyzeInfoCollectionOpportunityWithMemory(message, customer, bot, conversation, customerMemory);

    return {
        relevantChunks,
        allCustomerFields,
        conversationContext,
        messageAnalysis,
        salesOpportunity,
        infoCollectionOpportunity,
        botConfig: bot.behaviorConfig,
        customerHistory: customer,
        customerMemory: customerMemory
    };
}

function getAllCustomerFields(customer, bot) {
    const allFields = [];
    customer.collectedFields.forEach(field => {
        const fieldConfig = bot.customerFields.find(f => f.fieldName === field.fieldName);
        if (fieldConfig) {
            allFields.push({
                fieldName: field.fieldName,
                fieldValue: field.fieldValue,
                description: fieldConfig.description,
                collectedAt: field.collectedAt
            });
        }
    });
    return allFields;
}

function analyzeSalesOpportunity(message, customer, conversation, bot) {
    if (bot.behaviorConfig.botType !== 'sales') {
        return { hasOpportunity: false, level: 'none', reason: '' };
    }

    const analysis = {
        hasOpportunity: false,
        level: 'low',
        reason: '',
        suggestedProducts: [],
        nextBestAction: ''
    };

    const messageLower = message.toLowerCase();

    // Phát hiện intent mua hàng
    const purchaseKeywords = getPurchaseKeywordsByBotType(bot.behaviorConfig.botType);
    const hasPurchaseIntent = purchaseKeywords.some(keyword => messageLower.includes(keyword));

    const interestKeywords = ['tư vấn', 'giới thiệu', 'tìm hiểu', 'thông tin', 'có sản phẩm'];
    const hasProductInterest = interestKeywords.some(keyword => messageLower.includes(keyword));

    if (hasPurchaseIntent) {
        analysis.hasOpportunity = true;
        analysis.level = 'high';
        analysis.reason = 'Khách hàng thể hiện nhu cầu mua hàng trực tiếp';
    } else if (hasProductInterest) {
        analysis.hasOpportunity = true;
        analysis.level = 'medium';
        analysis.reason = 'Khách hàng quan tâm đến sản phẩm/dịch vụ';
    }

    // Gợi ý sản phẩm dựa trên từ khóa
    analysis.suggestedProducts = suggestProducts(messageLower, bot);

    return analysis;
}
function analyzeMessageWithMemory(message, botType, customerMemory) {
    const baseAnalysis = analyzeMessage(message, botType);

    return {
        ...baseAnalysis,
        hasKnownInformation: customerMemory.knownFacts.length > 0,
        knownTopics: extractKnownTopics(customerMemory),
        shouldUseMemory: shouldUseMemoryInResponse(baseAnalysis, customerMemory)
    };
}

function analyzeSalesOpportunityWithMemory(message, customer, conversation, bot, customerMemory) {
    const baseAnalysis = analyzeSalesOpportunity(message, customer, conversation, bot);

    if (customerMemory.preferences.productInterests.length > 0) {
        baseAnalysis.suggestedProducts = [...new Set([
            ...baseAnalysis.suggestedProducts,
            ...customerMemory.preferences.productInterests
        ])];
    }

    baseAnalysis.potentialScore = calculatePotentialScore(customerMemory);
    baseAnalysis.engagementLevel = calculateEngagementLevel(customerMemory);

    return baseAnalysis;
}

function analyzeInfoCollectionOpportunityWithMemory(message, customer, bot, conversation, customerMemory) {
    const baseAnalysis = analyzeInfoCollectionOpportunity(message, customer, bot, conversation);

    const knownFieldNames = customerMemory.knownFacts.map(fact => fact.fieldName);
    baseAnalysis.missingFields = baseAnalysis.missingFields.filter(
        field => !knownFieldNames.includes(field)
    );

    if (baseAnalysis.shouldCollect && baseAnalysis.missingFields.length > 0) {
        const engagementLevel = calculateEngagementLevel(customerMemory);
        if (engagementLevel === 'low') {
            baseAnalysis.strategy = 'gentle';
        } else if (engagementLevel === 'high') {
            baseAnalysis.strategy = 'direct';
        }
    }

    return baseAnalysis;
}

// ========== MESSAGE ANALYSIS FUNCTIONS ==========

function analyzeMessage(message, botType) {
    const keywords = extractKeywords(message);
    const intent = detectIntent(message);
    const entities = extractEntities(message);
    const sentiment = analyzeSentiment(message);

    return {
        keywords,
        intent,
        entities,
        sentiment,
        complexity: estimateComplexity(message),
        requiresKnowledge: requiresKnowledgeLookup(message, intent, keywords, botType),
        isGreeting: isGreeting(message),
        requiresPersonalization: requiresPersonalization(intent, keywords),
        isGoodTimingForInfoCollection: isGoodTimingForInfoCollection(message, intent, sentiment),
        isPotentialLead: isPotentialLead(message, intent, keywords, botType)
    };
}

function extractKeywords(message) {
    const stopWords = ['của', 'và', 'là', 'có', 'tôi', 'bạn', 'nào', 'gì', 'ạ', 'ơi', 'ạ', 'nhé'];
    const words = message.toLowerCase()
        .replace(/[^\w\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));

    return [...new Set(words)];
}

function detectIntent(message) {
    const messageLower = message.toLowerCase();

    if (isGreeting(messageLower)) return 'greeting';
    if (messageLower.includes('giá') || messageLower.includes('bao nhiêu tiền')) return 'price_inquiry';
    if (messageLower.includes('mua') || messageLower.includes('đặt hàng')) return 'purchase_intent';
    if (messageLower.includes('tư vấn') || messageLower.includes('tìm hiểu')) return 'consultation';
    if (messageLower.includes('cảm ơn') || messageLower.includes('thanks')) return 'gratitude';
    if (messageLower.includes('khi nào') || messageLower.includes('thời gian')) return 'timing';
    if (messageLower.includes('địa chỉ') || messageLower.includes('ở đâu')) return 'location';

    return 'general_inquiry';
}

function extractEntities(message) {
    const entities = {};
    const messageLower = message.toLowerCase();

    const phoneMatch = messageLower.match(/(0[3|5|7|8|9])+([0-9]{8})\b/);
    if (phoneMatch) entities.phone = phoneMatch[0];

    const emailMatch = messageLower.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
    if (emailMatch) entities.email = emailMatch[0];

    const numberMatch = messageLower.match(/\d+/g);
    if (numberMatch) entities.numbers = numberMatch;

    return entities;
}

function analyzeSentiment(message) {
    const positiveWords = ['tốt', 'tuyệt vời', 'xuất sắc', 'hài lòng', 'thích', 'đẹp', 'nhanh'];
    const negativeWords = ['tệ', 'kém', 'chậm', 'đắt', 'khó', 'không thích', 'tồi'];

    const messageLower = message.toLowerCase();
    let score = 0;

    positiveWords.forEach(word => {
        if (messageLower.includes(word)) score += 1;
    });

    negativeWords.forEach(word => {
        if (messageLower.includes(word)) score -= 1;
    });

    if (score > 0) return 'positive';
    if (score < 0) return 'negative';
    return 'neutral';
}

function estimateComplexity(message) {
    const wordCount = message.split(/\s+/).length;
    const hasQuestion = /[?？]/.test(message);
    const hasComplexWords = /(phức tạp|chi tiết|giải thích|hướng dẫn)/i.test(message);

    if (wordCount > 15 && hasQuestion && hasComplexWords) return 'high';
    if (wordCount > 8 && hasQuestion) return 'medium';
    return 'low';
}

function requiresKnowledgeLookup(message, intent, keywords, botType) {
    const knowledgeIntents = ['price_inquiry', 'consultation', 'general_inquiry', 'timing', 'location'];
    return knowledgeIntents.includes(intent) && keywords.length > 0;
}

function isGreeting(message) {
    const greetings = ['xin chào', 'chào', 'hello', 'hi', 'chào bạn', 'chào anh', 'chào chị'];
    return greetings.some(greeting => message.toLowerCase().includes(greeting));
}

function requiresPersonalization(intent, keywords) {
    const personalIntents = ['purchase_intent', 'consultation'];
    return personalIntents.includes(intent) || keywords.includes('tôi') || keywords.includes('mình');
}

function isGoodTimingForInfoCollection(message, intent, sentiment) {
    if (intent === 'greeting' || sentiment === 'negative') return false;
    return ['purchase_intent', 'consultation'].includes(intent);
}

function isPotentialLead(message, intent, keywords, botType) {
    if (botType !== 'sales') return false;
    const leadKeywords = ['mua', 'giá', 'đặt', 'order', 'thanh toán', 'giao hàng'];
    return intent === 'purchase_intent' || keywords.some(keyword => leadKeywords.includes(keyword));
}

// ========== KNOWLEDGE MANAGEMENT ==========

function analyzeSalesOpportunity(message, customer, conversation, bot) {
    if (bot.behaviorConfig.botType !== 'sales') {
        return { hasOpportunity: false, level: 'none', reason: '' };
    }

    const analysis = {
        hasOpportunity: false,
        level: 'low',
        reason: '',
        suggestedProducts: [],
        nextBestAction: ''
    };

    const messageLower = message.toLowerCase();

    // Phát hiện intent mua hàng
    const purchaseKeywords = getPurchaseKeywordsByBotType(bot.behaviorConfig.botType);
    const hasPurchaseIntent = purchaseKeywords.some(keyword => messageLower.includes(keyword));

    const interestKeywords = ['tư vấn', 'giới thiệu', 'tìm hiểu', 'thông tin', 'có sản phẩm'];
    const hasProductInterest = interestKeywords.some(keyword => messageLower.includes(keyword));

    if (hasPurchaseIntent) {
        analysis.hasOpportunity = true;
        analysis.level = 'high';
        analysis.reason = 'Khách hàng thể hiện nhu cầu mua hàng trực tiếp';
    } else if (hasProductInterest) {
        analysis.hasOpportunity = true;
        analysis.level = 'medium';
        analysis.reason = 'Khách hàng quan tâm đến sản phẩm/dịch vụ';
    }

    // Gợi ý sản phẩm dựa trên từ khóa
    analysis.suggestedProducts = suggestProducts(messageLower, bot);

    return analysis;
}

function analyzeInfoCollectionOpportunity(message, customer, bot, conversation) {
    if (!bot.behaviorConfig.autoCollectInfo?.enabled) {
        return { shouldCollect: false, missingFields: [], reason: '' };
    }

    const analysis = {
        shouldCollect: false,
        missingFields: [],
        reason: ''
    };

    // Xác định các fields còn thiếu
    const existingFields = customer.collectedFields.map(f => f.fieldName);
    const priorityFields = bot.behaviorConfig.autoCollectInfo.priorityFields || ['tên', 'số điện thoại'];
    analysis.missingFields = priorityFields.filter(
        field => !existingFields.includes(field)
    );

    if (analysis.missingFields.length === 0) {
        return analysis;
    }

    // Phân tích thời điểm
    const messageAnalysis = analyzeMessage(message, bot.behaviorConfig.botType);
    const timing = bot.behaviorConfig.autoCollectInfo.timing || 'contextual';

    if (timing === 'immediate') {
        analysis.shouldCollect = true;
        analysis.reason = 'Thu thập ngay lập tức theo cấu hình';
    } else if (timing === 'contextual') {
        // Chỉ thu thập khi có context phù hợp
        const isGoodContext =
            messageAnalysis.sentiment === 'positive' &&
            !messageAnalysis.isGreeting &&
            conversation.messages.length >= 2;

        analysis.shouldCollect = isGoodContext;
        analysis.reason = isGoodContext ? 'Context phù hợp để thu thập thông tin' : 'Context chưa phù hợp';
    }

    return analysis;
}


async function findRelevantKnowledge(message, bot) {
    if (!bot.knowledgeChunks || bot.knowledgeChunks.length === 0) {
        return [];
    }

    let chunks = knowledgeCache.get(bot.code);
    if (!chunks) {
        chunks = bot.knowledgeChunks.filter(chunk => chunk.isActive);
        knowledgeCache.set(bot.code, chunks);
    }

    const messageAnalysis = analyzeMessage(message, bot.behaviorConfig.botType);
    const relevantChunks = chunks
        .map(chunk => ({
            chunk,
            score: calculateChunkRelevance(chunk, messageAnalysis, bot.behaviorConfig.botType)
        }))
        .filter(item => item.score > (bot.ragConfig?.similarityThreshold || 0.3))
        .sort((a, b) => b.score - a.score)
        .slice(0, bot.ragConfig?.maxChunks || 5)
        .map(item => item.chunk);

    return relevantChunks.length > 0 ? relevantChunks : chunks.slice(0, 1);
}

function calculateChunkRelevance(chunk, messageAnalysis, botType) {
    let score = 0;

    messageAnalysis.keywords.forEach(keyword => {
        const chunkText = (chunk.title + ' ' + chunk.content + ' ' + (chunk.keywords?.join(' ') || '')).toLowerCase();
        if (chunkText.includes(keyword)) {
            score += 2;
        }
    });

    if (chunk.category && chunk.category.toLowerCase().includes(botType)) {
        score += 3;
    }

    score += (chunk.priority || 1) * 0.5;

    return score;
}

function buildConversationContext(conversation, currentMessage) {
    if (!conversation.messages || conversation.messages.length === 0) {
        return [];
    }

    const recentMessages = conversation.messages
        .slice(-10)
        .filter(msg => isMessageRelevantToCurrent(msg.content, currentMessage))
        .slice(-5);

    return recentMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp
    }));
}

function isMessageRelevantToCurrent(previousMessage, currentMessage) {
    const prevLower = previousMessage.toLowerCase();
    const currentLower = currentMessage.toLowerCase();

    const commonKeywords = ['giá', 'mua', 'sản phẩm', 'dịch vụ', 'tư vấn', 'hỏi'];
    return commonKeywords.some(keyword =>
        prevLower.includes(keyword) && currentLower.includes(keyword)
    );
}

// ========== MEMORY-ENHANCED MESSAGE BUILDING ==========

function buildDynamicMessagesWithMemory(bot, context, newMessage, conversation, customerMemory) {
    const messages = [];
    const botConfig = bot.behaviorConfig;

    let systemContent = buildDynamicSystemPromptWithMemory(bot, context, customerMemory);
    messages.push({ role: 'system', content: systemContent });

    const relevantContext = filterRelevantConversationContextWithMemory(conversation, newMessage, context.messageAnalysis, customerMemory);
    messages.push(...relevantContext);

    messages.push({ role: 'user', content: newMessage });

    return messages;
}

function buildDynamicSystemPromptWithMemory(bot, context, customerMemory) {
    const config = bot.behaviorConfig;
    let systemContent = bot.systemPrompt || 'Bạn là một trợ lý ảo hữu ích.';

    systemContent += `\n\nTHÔNG TIN ĐÃ BIẾT VỀ KHÁCH HÀNG:`;
    if (customerMemory.knownFacts.length > 0) {
        customerMemory.knownFacts.forEach(fact => {
            systemContent += `\n- ${fact.fieldName}: ${fact.fieldValue} (${fact.source})`;
        });
    } else {
        systemContent += `\n- Chưa có thông tin nào về khách hàng này.`;
    }

    if (customerMemory.preferences.topicsOfInterest.length > 0) {
        systemContent += `\n\nKHÁCH HÀNG QUAN TÂM ĐẾN: ${customerMemory.preferences.topicsOfInterest.join(', ')}`;
    }

    if (context.relevantChunks.length > 0 && context.messageAnalysis.requiresKnowledge) {
        const knowledgeText = context.relevantChunks.map(chunk =>
            `[${chunk.title}] ${chunk.content}`
        ).join('\n\n');
        systemContent += `\n\nTHÔNG TIN THAM KHẢO:\n${knowledgeText}`;
    }

    systemContent += `\n\nHƯỚNG DẪN QUAN TRỌNG:`;
    systemContent += `\n- KHÔNG hỏi lại thông tin đã biết về khách hàng`;
    systemContent += `\n- Sử dụng thông tin đã biết để cá nhân hóa câu trả lời`;
    systemContent += `\n- Nếu thông tin chưa đầy đủ, hãy hỏi một cách tự nhiên`;
    systemContent += `\n- Mọi câu trả lời phải thật ngắn gọn đầu đủ ý và thân thiện`;
    systemContent += `\n- Ghi nhận thông tin mới bằng [SAVE:field=value]`;

    if (context.infoCollectionOpportunity.shouldCollect) {
        const missingFields = context.infoCollectionOpportunity.missingFields;
        if (missingFields.length > 0) {
            systemContent += `\n\nCẦN THU THẬP: ${missingFields.join(', ')}`;
            systemContent += `\nChiến lược: ${context.infoCollectionOpportunity.strategy}`;
        }
    }

    return systemContent;
}

function filterRelevantConversationContextWithMemory(conversation, newMessage, messageAnalysis, customerMemory) {
    if (!conversation.messages || conversation.messages.length === 0) {
        return [];
    }

    const recentMessages = conversation.messages.slice(-8);
    return recentMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp
    }));
}

// ========== MEMORY-ENHANCED RESPONSE PROCESSING ==========

async function processIntelligentResponseWithMemory(bot, customer, conversation, userMessage, messages, context, customerMemory) {
    try {
        const botResponse = await deepseekService.chat(messages, {
            temperature: 0.7,
            max_tokens: bot.behaviorConfig.limits?.maxResponseLength || 500
        });

        const { cleanedResponse, fieldsToSave } = extractSaveCommandsNatural(botResponse, bot.customerFields);

        await updateCustomerMemory(customerMemory, userMessage, cleanedResponse, fieldsToSave, context);
        const enhancedResponse = enhanceResponseWithMemory(cleanedResponse, context, customer, fieldsToSave, customerMemory);
        const finalResponse = cleanFinalResponse(enhancedResponse);

        await Promise.all([
            updateCustomerData(customer, fieldsToSave, userMessage, context),
            updateConversationData(conversation, userMessage, finalResponse, messages, context),
            saveCustomerMemory(customerMemory)
        ]);

        return {
            response: finalResponse,
            metadata: {
                botType: bot.behaviorConfig.botType,
                chunksUsed: context.relevantChunks.length,
                fieldsUpdated: fieldsToSave.length,
                salesOpportunity: context.salesOpportunity.level,
                responseStyle: bot.behaviorConfig.communicationStyle,
                sentiment: context.messageAnalysis.sentiment,
                memoryUsed: customerMemory.knownFacts.length,
                potentialScore: context.salesOpportunity.potentialScore
            }
        };

    } catch (error) {
        console.error('❌ Error processing AI response with memory:', error);
        throw new Error('Không thể xử lý phản hồi từ AI');
    }
}

async function updateCustomerMemory(memory, userMessage, botResponse, newFields, context) {
    memory.conversationHistory.push({
        timestamp: new Date(),
        userMessage: userMessage,
        botResponse: botResponse,
        topics: extractTopicsFromMessage(userMessage),
        intent: context.messageAnalysis.intent
    });

    if (memory.conversationHistory.length > 20) {
        memory.conversationHistory = memory.conversationHistory.slice(-20);
    }

    newFields.forEach(field => {
        const existingFactIndex = memory.knownFacts.findIndex(f => f.fieldName === field.fieldName);
        if (existingFactIndex >= 0) {
            memory.knownFacts[existingFactIndex].fieldValue = field.fieldValue;
            memory.knownFacts[existingFactIndex].lastConfirmed = new Date();
            memory.knownFacts[existingFactIndex].confidence = 1.0;
        } else {
            memory.knownFacts.push({
                fieldName: field.fieldName,
                fieldValue: field.fieldValue,
                confidence: 1.0,
                lastConfirmed: new Date(),
                source: 'direct'
            });
        }
    });

    updatePreferencesFromConversation(memory, userMessage, botResponse, context);
    memory.lastUpdated = new Date();
}

async function saveCustomerMemory(memory) {
    try {
        await memory.save();
        const memoryKey = `${memory.botCode}:${memory.customerIdentifier}`;
        customerMemoryCache.set(memoryKey, memory);
    } catch (error) {
        console.error('❌ Error saving customer memory:', error);
    }
}

function enhanceResponseWithMemory(response, context, customer, newFields, customerMemory) {
    let enhancedResponse = response;
    const botConfig = context.behaviorConfig;

    if (shouldAddFollowUpWithMemory(response, context, customer, newFields, customerMemory)) {
        const followUp = generateSmartFollowUpWithMemory(context, customer, newFields, customerMemory);
        if (followUp) {
            enhancedResponse += followUp;
        }
    }

    enhancedResponse = personalizeResponseWithMemory(enhancedResponse, customerMemory);

    if (botConfig?.limits?.maxResponseLength && enhancedResponse.length > botConfig.limits.maxResponseLength) {
        enhancedResponse = enhancedResponse.substring(0, botConfig.limits.maxResponseLength) + '...';
    }

    return enhancedResponse;
}

function shouldAddFollowUpWithMemory(response, context, customer, newFields, customerMemory) {
    if (response.length > 300) return false;
    if (context.salesOpportunity.hasOpportunity && context.salesOpportunity.engagementLevel === 'high') return true;
    if (context.infoCollectionOpportunity.shouldCollect && newFields.length === 0) return true;
    if (context.messageAnalysis.isGreeting && customerMemory.conversationHistory.length <= 1) return false;
    return customerMemory.conversationHistory.length < 5;
}

function generateSmartFollowUpWithMemory(context, customer, newFields, customerMemory) {
    const botConfig = context.botConfig;

    if (botConfig.botType === 'sales' && context.salesOpportunity.hasOpportunity) {
        if (newFields.length === 0 && context.infoCollectionOpportunity.missingFields.length > 0) {
            const missingField = context.infoCollectionOpportunity.missingFields[0];
            return `\n\nĐể mình tư vấn chi tiết hơn, bạn có thể cho mình biết ${getFieldDisplayName(missingField)} không?`;
        }

        if (customerMemory.preferences.productInterests.length > 0) {
            const topInterest = customerMemory.preferences.productInterests[0];
            return `\n\nBạn có muốn tìm hiểu thêm về ${topInterest} không? 🚀`;
        }

        return `\n\nBạn có muốn mình hỗ trợ đặt hàng ngay không? 🛒`;
    }

    if (context.infoCollectionOpportunity.shouldCollect) {
        const missingField = context.infoCollectionOpportunity.missingFields[0];
        return `\n\nTiện thể, bạn có thể cho mình biết ${getFieldDisplayName(missingField)} được không?`;
    }

    const lastTopics = getLastConversationTopics(customerMemory);
    if (lastTopics.length > 0) {
        const lastTopic = lastTopics[0];
        return `\n\nBạn có thắc mắc gì thêm về ${lastTopic} không?`;
    }

    return '';
}

function personalizeResponseWithMemory(response, customerMemory) {
    let personalizedResponse = response;
    const nameFact = customerMemory.knownFacts.find(f => f.fieldName === 'tên');
    if (nameFact && nameFact.confidence > 0.8) {
        if (!personalizedResponse.includes(nameFact.fieldValue)) {
            personalizedResponse = personalizedResponse.replace(/bạn/g, nameFact.fieldValue);
        }
    }
    return personalizedResponse;
}

// ========== DATA UPDATING FUNCTIONS ==========

async function updateCustomerData(customer, fieldsToSave, userMessage, context) {
    if (fieldsToSave.length === 0) return;

    const updates = fieldsToSave.map(field => ({
        fieldName: field.fieldName,
        fieldValue: field.fieldValue,
        collectedAt: new Date(),
        source: 'chat'
    }));

    customer.collectedFields.push(...updates);
    customer.lastActive = new Date();
    customer.conversationCount += 1;

    await customer.save();
    console.log(`✅ Updated customer data: ${updates.map(u => u.fieldName).join(', ')}`);
}

async function updateConversationData(conversation, userMessage, botResponse, messages, context) {
    conversation.messages.push(
        {
            role: 'user',
            content: userMessage,
            timestamp: new Date(),
            metadata: {
                analysis: context.messageAnalysis
            }
        },
        {
            role: 'assistant',
            content: botResponse,
            timestamp: new Date(),
            metadata: {
                chunksUsed: context.relevantChunks.length,
                salesOpportunity: context.salesOpportunity.level
            }
        }
    );

    if (conversation.messages.length > 50) {
        conversation.messages = conversation.messages.slice(-40);
    }

    conversation.updatedAt = new Date();
    await conversation.save();
    console.log(`💾 Updated conversation with ${conversation.messages.length} messages`);
}

function extractSaveCommandsNatural(response, customerFields) {
    const saveCommands = [];
    let cleanedResponse = response;

    const saveRegex = /\[SAVE:([^=]+)=([^\]]+)\]/g;
    let match;

    while ((match = saveRegex.exec(response)) !== null) {
        const fieldName = match[1].trim();
        const fieldValue = match[2].trim();

        const fieldConfig = customerFields.find(f => f.fieldName === fieldName);
        if (fieldConfig) {
            saveCommands.push({
                fieldName: fieldName,
                fieldValue: fieldValue,
                fieldType: fieldConfig.fieldType
            });
        }

        cleanedResponse = cleanedResponse.replace(match[0], '');
    }

    return {
        cleanedResponse: cleanedResponse.trim(),
        fieldsToSave: saveCommands
    };
}

function cleanFinalResponse(response) {
    return response
        .replace(/\[SAVE:[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ========== MEMORY HELPER FUNCTIONS ==========

function extractKnownTopics(customerMemory) {
    const topics = new Set();
    customerMemory.conversationHistory.forEach(conv => {
        conv.topics.forEach(topic => topics.add(topic));
    });
    return Array.from(topics);
}

function calculatePotentialScore(customerMemory) {
    let score = 0;
    score += Math.min(customerMemory.knownFacts.length * 10, 30);
    score += Math.min(customerMemory.conversationHistory.length * 5, 20);
    score += Math.min(customerMemory.preferences.productInterests.length * 15, 30);
    const recentActivity = customerMemory.conversationHistory.filter(
        conv => new Date() - new Date(conv.timestamp) < 24 * 60 * 60 * 1000
    ).length;
    score += Math.min(recentActivity * 10, 20);
    return Math.min(score, 100);
}

function calculateEngagementLevel(customerMemory) {
    const score = calculatePotentialScore(customerMemory);
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
}

function extractTopicsFromMessage(message) {
    const topics = [];
    const messageLower = message.toLowerCase();

    const topicKeywords = {
        'giá cả': ['giá', 'bao nhiêu tiền', 'chi phí', 'đắt', 'rẻ'],
        'tính năng': ['tính năng', 'chức năng', 'làm được gì', 'có gì'],
        'hướng dẫn': ['hướng dẫn', 'sử dụng', 'cài đặt', 'tích hợp'],
        'thanh toán': ['thanh toán', 'mua', 'đặt hàng', 'mua ở đâu'],
        'hỗ trợ': ['hỗ trợ', 'giúp đỡ', 'tư vấn', 'troubleshoot']
    };

    Object.entries(topicKeywords).forEach(([topic, keywords]) => {
        if (keywords.some(keyword => messageLower.includes(keyword))) {
            topics.push(topic);
        }
    });

    return topics.length > 0 ? topics : ['chung'];
}

function updatePreferencesFromConversation(memory, userMessage, botResponse, context) {
    if (context.salesOpportunity.suggestedProducts?.length > 0) {
        context.salesOpportunity.suggestedProducts.forEach(product => {
            if (!memory.preferences.productInterests.includes(product)) {
                memory.preferences.productInterests.push(product);
            }
        });
    }

    if (memory.preferences.productInterests.length > 5) {
        memory.preferences.productInterests = memory.preferences.productInterests.slice(-5);
    }
}

function getLastConversationTopics(customerMemory) {
    if (customerMemory.conversationHistory.length === 0) return [];
    const lastConversation = customerMemory.conversationHistory[customerMemory.conversationHistory.length - 1];
    return lastConversation.topics || [];
}

function shouldUseMemoryInResponse(analysis, customerMemory) {
    return customerMemory.knownFacts.length > 0 && !analysis.isGreeting;
}

// ========== VALIDATION & HELPER FUNCTIONS ==========

function validateBotStructure(bot) {
    const requiredFields = ['name', 'code', 'systemPrompt', 'behaviorConfig'];
    const missingFields = requiredFields.filter(field => !bot[field]);

    if (missingFields.length > 0) {
        console.warn(`⚠️ Bot ${bot.code} missing fields: ${missingFields.join(', ')}`);
    }

    if (!bot.behaviorConfig) {
        bot.behaviorConfig = createDefaultBehaviorConfig();
    }

    if (!Array.isArray(bot.knowledgeChunks)) {
        bot.knowledgeChunks = [];
    }

    if (!Array.isArray(bot.customerFields)) {
        bot.customerFields = getDefaultCustomerFields();
    }

    console.log(`✅ Bot structure validated: ${bot.name}`);
}

function createDefaultBehaviorConfig() {
    return {
        botType: 'general',
        communicationStyle: 'friendly',
        detailLevel: 'balanced',
        autoCollectInfo: {
            enabled: true,
            priorityFields: ['tên', 'số điện thoại'],
            timing: 'contextual'
        },
        limits: {
            maxResponseLength: 500,
            useEmojis: true,
            allowSmallTalk: true
        }
    };
}

function getDefaultCustomerFields() {
    return [
        {
            fieldName: 'tên',
            fieldType: 'text',
            description: 'Họ và tên khách hàng',
            required: true,
            relevanceKeywords: ['tên', 'tôi tên', 'mình tên', 'tên là'],
            priority: 1
        },
        {
            fieldName: 'số điện thoại',
            fieldType: 'phone',
            description: 'Số điện thoại liên hệ',
            required: true,
            relevanceKeywords: ['số điện thoại', 'số phone', 'liên hệ', 'phone'],
            priority: 1
        }
    ];
}

function getHoursSinceLastMessage(conversation) {
    if (!conversation.messages || conversation.messages.length === 0) {
        return 999;
    }

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    const lastMessageTime = lastMessage.timestamp || conversation.updatedAt;
    const hoursDiff = (new Date() - new Date(lastMessageTime)) / (1000 * 60 * 60);

    return hoursDiff;
}

function createTemporaryCustomer(customerIdentifier, botCode) {
    console.log(`🔄 Creating temporary customer: ${customerIdentifier}`);

    return {
        _id: `temp_${Date.now()}`,
        identifier: customerIdentifier,
        botCode: botCode,
        collectedFields: [],
        conversationCount: 0,
        firstSeen: new Date(),
        lastActive: new Date(),
        isTemporary: true
    };
}

function createTemporaryConversation(customerIdentifier, botCode) {
    console.log(`🔄 Creating temporary conversation for: ${customerIdentifier}`);

    return {
        _id: `temp_conv_${Date.now()}`,
        customerIdentifier: customerIdentifier,
        botCode: botCode,
        messages: [],
        metadata: {},
        status: 'active',
        isTemporary: true,
        save: function () { return Promise.resolve(); }
    };
}

function createTemporaryMemory(customerIdentifier, botCode, customer) {
    console.log(`🔄 Creating temporary memory for: ${customerIdentifier}`);

    return {
        customerIdentifier,
        botCode,
        knownFacts: customer.collectedFields.map(field => ({
            fieldName: field.fieldName,
            fieldValue: field.fieldValue,
            confidence: 1.0,
            lastConfirmed: new Date(),
            source: 'direct'
        })),
        conversationHistory: [],
        preferences: {
            communicationStyle: 'friendly',
            topicsOfInterest: [],
            painPoints: [],
            productInterests: []
        },
        lastUpdated: new Date(),
        isTemporary: true,
        save: function () { return Promise.resolve(); }
    };
}

function getFieldDisplayName(fieldName) {
    const displays = {
        'tên': 'tên của bạn',
        'số điện thoại': 'số điện thoại',
        'email': 'email',
        'địa chỉ': 'địa chỉ',
        'tuổi': 'tuổi',
        'nhu cầu': 'nhu cầu cụ thể'
    };
    return displays[fieldName] || fieldName;
}

function estimateTokens(text) {
    if (typeof text === 'string') {
        return Math.ceil(text.length / 3);
    } else if (Array.isArray(text)) {
        return text.reduce((total, msg) => total + estimateTokens(msg.content), 0);
    }
    return 0;
}

function getFallbackResponse() {
    const fallbacks = [
        "Xin lỗi, hiện tại tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.",
        "Hiện hệ thống đang bận, bạn có thể để lại câu hỏi và tôi sẽ trả lời sớm nhất.",
        "Tôi xin lỗi vì sự bất tiện này. Vui lòng liên hệ lại sau ít phút."
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ========== ANALYTICS API ==========

router.get('/:botCode/analytics', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { days = 7 } = req.query;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));

        const [conversations, customers, popularQuestions] = await Promise.all([
            Conversation.countDocuments({
                botCode: botCode,
                createdAt: { $gte: startDate }
            }),
            Customer.countDocuments({
                botCode: botCode,
                lastActive: { $gte: startDate }
            }),
            getPopularQuestions(botCode, startDate)
        ]);

        res.json({
            success: true,
            data: {
                totalConversations: conversations,
                activeUsers: customers,
                popularQuestions: popularQuestions,
                satisfactionRate: await calculateSatisfactionRate(botCode, startDate)
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

async function getPopularQuestions(botCode, startDate) {
    const conversations = await Conversation.find({
        botCode: botCode,
        createdAt: { $gte: startDate },
        'messages.role': 'user'
    });

    const questionCount = {};
    conversations.forEach(conv => {
        conv.messages.forEach(msg => {
            if (msg.role === 'user') {
                const question = msg.content.substring(0, 100);
                questionCount[question] = (questionCount[question] || 0) + 1;
            }
        });
    });

    return Object.entries(questionCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([question, count]) => ({ question, count }));
}

async function calculateSatisfactionRate(botCode, startDate) {
    const conversations = await Conversation.find({
        botCode: botCode,
        createdAt: { $gte: startDate }
    });

    let positiveCount = 0;
    conversations.forEach(conv => {
        conv.messages.forEach(msg => {
            if (msg.metadata?.analysis?.sentiment === 'positive') {
                positiveCount++;
            }
        });
    });

    const totalMessages = conversations.reduce((total, conv) => total + conv.messages.length, 0);
    return totalMessages > 0 ? Math.round((positiveCount / totalMessages) * 100) : 0;
}

// ========== CACHE MANAGEMENT ==========

function clearBotFromCache(botCode) {
    if (botCache.has(botCode)) {
        botCache.delete(botCode);
        console.log(`🗑️ Removed bot from cache: ${botCode}`);
    }

    if (knowledgeCache.has(botCode)) {
        knowledgeCache.delete(botCode);
        console.log(`🗑️ Removed knowledge from cache: ${botCode}`);
    }
}

async function preloadBotToCache(botCode) {
    try {
        const bot = await getBotFromCache(botCode);
        if (bot) {
            console.log(`⚡ Preloaded bot to cache: ${bot.name}`);
        }
        return bot;
    } catch (error) {
        console.error(`❌ Error preloading bot ${botCode}:`, error);
        return null;
    }
}

function getCommunicationStyleGuide(style) {
    const guides = {
        friendly: 'Thân thiện, gần gũi, như người bạn',
        professional: 'Chuyên nghiệp, lịch sự, trang trọng',
        formal: 'Trang trọng, nghiêm túc',
        casual: 'Thoải mái, không gò bó',
        enthusiastic: 'Nhiệt tình, năng động'
    };
    return guides[style] || guides.friendly;
}

function getDetailLevelGuide(level) {
    const guides = {
        concise: 'Ngắn gọn, tập trung vào thông tin chính',
        balanced: 'Cân bằng giữa ngắn gọn và đầy đủ',
        detailed: 'Chi tiết, giải thích kỹ lưỡng'
    };
    return guides[level] || guides.balanced;
}

function getPurchaseKeywordsByBotType(botType) {
    const baseKeywords = ['mua', 'muốn mua', 'cần mua', 'đặt mua', 'giá', 'báo giá'];

    const typeSpecificKeywords = {
        sales: ['mua', 'giá', 'đặt hàng', 'thanh toán'],
        consulting: ['dịch vụ', 'tư vấn', 'hợp đồng'],
        education: ['khóa học', 'đăng ký', 'học phí']
    };

    return [...baseKeywords, ...(typeSpecificKeywords[botType] || [])];
}

function suggestProducts(message, bot) {
    const suggestions = [];
    const messageLower = message.toLowerCase();

    // Tìm sản phẩm phù hợp dựa trên từ khóa trong knowledge chunks
    bot.knowledgeChunks.forEach(chunk => {
        if (chunk.category === 'product' || chunk.category === 'service') {
            const chunkLower = chunk.content.toLowerCase();
            const hasMatchingKeyword = chunk.keywords.some(keyword =>
                messageLower.includes(keyword.toLowerCase())
            );

            if (hasMatchingKeyword) {
                suggestions.push(chunk.title);
            }
        }
    });

    return suggestions.slice(0, 3); // Giới hạn 3 gợi ý
}

function getFieldDisplayName(fieldName) {
    const displays = {
        'tên': 'tên của bạn',
        'số điện thoại': 'số điện thoại',
        'email': 'email',
        'địa chỉ': 'địa chỉ',
        'tuổi': 'tuổi',
        'nhu cầu': 'nhu cầu cụ thể'
    };
    return displays[fieldName] || fieldName;
}

function estimateTokens(text) {
    if (typeof text === 'string') {
        return Math.ceil(text.length / 3);
    } else if (Array.isArray(text)) {
        return text.reduce((total, msg) => total + estimateTokens(msg.content), 0);
    }
    return 0;
}

function getFallbackResponse() {
    const fallbacks = [
        "Xin lỗi, hiện tại tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.",
        "Hiện hệ thống đang bận, bạn có thể để lại câu hỏi và tôi sẽ trả lời sớm nhất.",
        "Tôi xin lỗi vì sự bất tiện này. Vui lòng liên hệ lại sau ít phút."
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ========== ANALYTICS API ==========

router.get('/:botCode/analytics', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { days = 7 } = req.query;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));

        const [conversations, customers, popularQuestions] = await Promise.all([
            Conversation.countDocuments({
                botCode: botCode,
                createdAt: { $gte: startDate }
            }),
            Customer.countDocuments({
                botCode: botCode,
                lastActive: { $gte: startDate }
            }),
            getPopularQuestions(botCode, startDate)
        ]);

        res.json({
            success: true,
            data: {
                totalConversations: conversations,
                activeUsers: customers,
                popularQuestions: popularQuestions,
                satisfactionRate: await calculateSatisfactionRate(botCode, startDate)
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

async function getPopularQuestions(botCode, startDate) {
    const conversations = await Conversation.find({
        botCode: botCode,
        createdAt: { $gte: startDate },
        'messages.role': 'user'
    });

    const questionCount = {};
    conversations.forEach(conv => {
        conv.messages.forEach(msg => {
            if (msg.role === 'user') {
                const question = msg.content.substring(0, 100); // Limit length
                questionCount[question] = (questionCount[question] || 0) + 1;
            }
        });
    });

    return Object.entries(questionCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([question, count]) => ({ question, count }));
}

async function calculateSatisfactionRate(botCode, startDate) {
    // Đơn giản hóa: coi như có positive sentiment là hài lòng
    const conversations = await Conversation.find({
        botCode: botCode,
        createdAt: { $gte: startDate }
    });

    let positiveCount = 0;
    conversations.forEach(conv => {
        conv.messages.forEach(msg => {
            if (msg.metadata?.analysis?.sentiment === 'positive') {
                positiveCount++;
            }
        });
    });

    const totalMessages = conversations.reduce((total, conv) => total + conv.messages.length, 0);
    return totalMessages > 0 ? Math.round((positiveCount / totalMessages) * 100) : 0;
}

module.exports = router;