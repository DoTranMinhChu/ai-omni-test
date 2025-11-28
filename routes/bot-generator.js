const express = require('express');
const router = express.Router();
const BotChat = require('../models/BotChat');
const DeepseekService = require('../services/deepseekService');
const fs = require('fs');
const deepseekService = new DeepseekService(process.env.DEEPSEEK_API_KEY);

// ========== CONFIGURATION CONSTANTS ==========
const GENERATION_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000,
    maxTokens: {
        systemPrompt: 1500,
        knowledgeChunks: 2000,
        customerFields: 1200
    },
    limits: {
        maxKnowledgeChunks: 20,
        maxCustomerFields: 8,
        minChunkLength: 50
    }
};

// ========== MAIN ROUTES ==========

router.post('/generate', async (req, res) => {
    try {
        const validationError = validateRequiredFields(req.body);
        if (validationError) return res.status(400).json(validationError);

        const { botCode } = req.body;
        const existingBot = await BotChat.findOne({ code: botCode });
        if (existingBot) {
            return res.status(400).json({ error: 'Mã bot đã tồn tại' });
        }

        console.log('🔄 Bắt đầu generate bot config chuyên sâu...');

        const generationPrompt = buildGenerationPrompt(req.body);
        const fileName = 'myFile.txt';
        const fileContent = 'This is some text content that will be written to the file.\nIt can span multiple lines.';

        fs.writeFile(fileName, generationPrompt, (err) => {
            if (err) {
                console.error('Error writing file:', err);
                return;
            }
            console.log('File written successfully!');
        })
        const botConfig = await generateBotConfigWithFallback(generationPrompt, req.body);

        const newBot = new BotChat(botConfig);
        await newBot.save();

        res.status(201).json({
            message: 'Tạo bot tự động thành công',
            bot: formatBotResponse(newBot, req.body.industry),
            generatedConfig: formatConfigSummary(newBot)
        });

    } catch (error) {
        console.error('❌ Bot generation error:', error);
        handleGenerationError(res, error);
    }
});

router.post('/preview', async (req, res) => {
    try {
        const validationError = validateRequiredFields(req.body, false);
        if (validationError) return res.status(400).json(validationError);

        console.log('👁️ Bắt đầu preview bot config...');

        const generationPrompt = buildGenerationPrompt(req.body);
        const botConfig = await generateBotConfigWithFallback(generationPrompt, req.body);

        res.json({
            preview: true,
            config: formatPreviewConfig(botConfig),
            statistics: calculatePreviewStatistics(botConfig)
        });

    } catch (error) {
        console.error('❌ Preview generation error:', error);
        handleGenerationError(res, error);
    }
});

// ========== CORE GENERATION LOGIC ==========

async function generateBotConfigWithFallback(prompt, bodyParams) {
    const { botName, botCode, industry, targetAudience } = bodyParams;

    try {
        console.log('🤖 Sử dụng cơ chế generate chia nhỏ...');
        return await generateMultiStepConfig(prompt, botName, botCode, industry, targetAudience);
    } catch (error) {
        console.log('🔄 Fallback: Sử dụng cơ chế generate đơn giản...');
        return await generateSimpleConfig(prompt, botName, botCode, industry, targetAudience);
    }
}

async function generateMultiStepConfig(originalPrompt, botName, botCode, industry, targetAudience) {
    const steps = [
        { name: 'systemPrompt', fn: () => generateSystemPromptAndBehavior(originalPrompt) },
        { name: 'knowledgeChunks', fn: () => generateAllKnowledgeChunks(originalPrompt) },
        { name: 'customerFields', fn: () => generateCustomerFields(originalPrompt) }
    ];

    const results = {};

    for (const step of steps) {
        try {
            console.log(`🔄 Bước: ${step.name}...`);
            results[step.name] = await withRetry(step.fn, step.name);
        } catch (error) {
            console.error(`❌ Lỗi bước ${step.name}:`, error.message);
            results[step.name] = getFallbackForStep(step.name, industry, botName);
        }
    }

    return combineConfigData(results, originalPrompt, botName, botCode, industry, targetAudience);
}

async function generateSimpleConfig(prompt, botName, botCode, industry, targetAudience) {
    const messages = [
        {
            role: 'system',
            content: buildSimpleSystemPrompt()
        },
        {
            role: 'user',
            content: prompt
        }
    ];

    const response = await deepseekService.chat(messages, {
        temperature: 0.7,
        max_tokens: 3000
    });

    // Log response for debugging
    const fileName = `debug-${Date.now()}.txt`;
    fs.writeFileSync(fileName, response);
    console.log(`📁 Đã lưu response debug vào: ${fileName}`);

    return parseGeneratedConfig(response, botName, botCode, industry, targetAudience);
}

// ========== STEP GENERATORS ==========

async function generateSystemPromptAndBehavior(originalPrompt) {
    const messages = [
        {
            role: 'system',
            content: `Bạn là chuyên gia thiết kế chatbot. CHỈ TRẢ VỀ JSON.

TẠO SYSTEM PROMPT VÀ BEHAVIOR CONFIG CHO CHATBOT.

FORMAT JSON:
{
  "systemPrompt": "string (400-600 từ)",
  "welcomeMessage": "string",
  "fallbackMessage": "string", 
  "behaviorConfig": {
    "botType": "sales|consulting|support|education",
    "communicationStyle": "friendly|professional|formal|casual",
    "detailLevel": "concise|balanced|detailed",
    "autoCollectInfo": {
      "enabled": boolean,
      "priorityFields": ["string"],
      "timing": "immediate|delayed|contextual"
    }
  }
}

YÊU CẦU:
- System prompt chi tiết, bao gồm vai trò, nhiệm vụ, hướng dẫn thu thập thông tin
- Behavior config phù hợp với ngành nghề
- Welcome message thân thiện, chuyên nghiệp
- Fallback message hữu ích

CHỈ TRẢ VỀ JSON, KHÔNG TEXT NÀO KHÁC.`
        },
        {
            role: 'user',
            content: `Từ prompt gốc sau, hãy tạo system prompt và behavior config:
${originalPrompt.substring(0, 1000)}`
        }
    ];

    const response = await deepseekService.chat(messages, {
        temperature: 0.7,
        max_tokens: GENERATION_CONFIG.maxTokens.systemPrompt
    });

    return parseJsonResponse(response, 'systemPrompt và behavior config');
}

async function generateAllKnowledgeChunks(originalPrompt) {
    const batches = [
        { number: 1, categories: ["Giới thiệu", "Dịch vụ", "Sản phẩm", "Giá cả", "Chính sách"] },
        { number: 2, categories: ["Hỗ trợ", "FAQ", "Chiến lược", "Thị trường", "Lợi ích"] }
    ];

    const allChunks = [];

    for (const batch of batches) {
        try {
            const chunks = await generateKnowledgeChunksBatch(originalPrompt, batch);
            allChunks.push(...chunks);
        } catch (error) {
            console.error(`❌ Lỗi batch ${batch.number}:`, error.message);
        }
    }

    return allChunks;
}

async function generateKnowledgeChunksBatch(originalPrompt, batch) {
    const messages = [
        {
            role: 'system',
            content: `Bạn là chuyên gia nội dung. CHỈ TRẢ VỀ JSON.

TẠO KNOWLEDGE CHUNKS CHO CHATBOT.

FORMAT JSON:
{
  "knowledgeChunks": [
    {
      "title": "string",
      "content": "string (150-300 ký tự)",
      "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
      "category": "string",
      "priority": number (1-10, 1 là cao nhất)
    }
  ]
}

YÊU CẦU:
- Tạo 5-6 chunks
- Categories tập trung vào: ${batch.categories.join(', ')}
- Nội dung chi tiết, thực tế, hữu ích
- Keywords đa dạng và liên quan
- Priority: cao cho thông tin quan trọng

CHỈ TRẢ VỀ JSON, KHÔNG TEXT NÀO KHÁC.`
        },
        {
            role: 'user',
            content: `Từ prompt gốc sau, hãy tạo knowledge chunks (batch ${batch.number}):
${originalPrompt.substring(0, 800)}`
        }
    ];

    const response = await deepseekService.chat(messages, {
        temperature: 0.7,
        max_tokens: GENERATION_CONFIG.maxTokens.knowledgeChunks
    });

    const parsed = parseJsonResponse(response, `knowledge chunks batch ${batch.number}`);
    return parsed.knowledgeChunks || [];
}

async function generateCustomerFields(originalPrompt) {
    const messages = [
        {
            role: 'system',
            content: `Bạn là chuyên gia thiết kế form thu thập thông tin. CHỈ TRẢ VỀ JSON.

TẠO CUSTOMER FIELDS CHO CHATBOT.

FORMAT JSON:
{
  "customerFields": [
    {
      "fieldName": "string",
      "fieldType": "text|number|email|phone|date|enum",
      "description": "string",
      "required": boolean,
      "relevanceKeywords": ["keyword1", "keyword2", "keyword3"],
      "enumValues": ["option1", "option2"] (chỉ cho fieldType enum)
    }
  ]
}

YÊU CẦU:
- Tạo 6-8 fields
- Bao gồm field cơ bản: tên, số điện thoại, email
- Thêm field chuyên biệt theo ngành
- relevanceKeywords cụ thể
- Mô tả rõ ràng

CHỈ TRẢ VỀ JSON, KHÔNG TEXT NÀO KHÁC.`
        },
        {
            role: 'user',
            content: `Từ prompt gốc sau, hãy tạo customer fields:
${originalPrompt.substring(0, 800)}`
        }
    ];

    const response = await deepseekService.chat(messages, {
        temperature: 0.7,
        max_tokens: GENERATION_CONFIG.maxTokens.customerFields
    });

    const parsed = parseJsonResponse(response, 'customer fields');
    return parsed.customerFields || [];
}

// ========== HELPER FUNCTIONS ==========

function buildGenerationPrompt(params) {
    const { businessDescription, botName, industry, targetAudience, keyServices, exampleQuestions, specificRequirements } = params;

    return `
TẠO CẤU HÌNH CHATBOT CHUYÊN NGHIỆP. CHỈ TRẢ VỀ JSON.

# THÔNG TIN DOANH NGHIỆP:
## Ngành nghề: ${industry}
## Tên bot: ${botName}
## Mô tả nghiệp vụ: ${businessDescription}
## Đối tượng khách hàng: ${targetAudience || 'Không xác định'}
## Dịch vụ chính: ${keyServices.join(', ') || 'Không có'}
## Yêu cầu đặc biệt: ${specificRequirements || 'Không có'}

# YÊU CẦU:
- Tạo nội dung CHẤT LƯỢNG CAO, THỰC TẾ
- Đảm bảo JSON hợp lệ và đầy đủ
- Ưu tiên tính hoàn chỉnh hơn số lượng

CHỈ TRẢ VỀ JSON, KHÔNG TEXT NÀO KHÁC.`.trim();
}

function buildSimpleSystemPrompt() {
    return `Bạn là chuyên gia thiết kế chatbot. CHỈ TRẢ VỀ JSON.

TẠO CẤU HÌNH ĐẦY ĐỦ CHO CHATBOT. ĐẢM BẢO JSON HOÀN CHỈNH.

FORMAT JSON:
{
  "systemPrompt": "string",
  "welcomeMessage": "string",
  "fallbackMessage": "string",
  "knowledgeChunks": [
    {
      "title": "string",
      "content": "string",
      "keywords": ["string"],
      "category": "string",
      "priority": number
    }
  ],
  "customerFields": [
    {
      "fieldName": "string",
      "fieldType": "text|number|email|phone|date|enum",
      "description": "string",
      "required": boolean,
      "relevanceKeywords": ["string"]
    }
  ],
  "behaviorConfig": {
    "botType": "sales|consulting|support",
    "communicationStyle": "friendly|professional",
    "detailLevel": "balanced"
  }
}

YÊU CẦU:
- System prompt: 300-500 từ, chi tiết
- Knowledge chunks: 10-15 chunks chất lượng
- Customer fields: 5-7 fields hữu ích
- ƯU TIÊN JSON HOÀN CHỈNH

CHỈ TRẢ VỀ JSON, KHÔNG TEXT NÀO KHÁC.`;
}

async function withRetry(operation, operationName, retries = GENERATION_CONFIG.maxRetries) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            console.error(`❌ ${operationName} attempt ${attempt} failed:`, error.message);
            if (attempt === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, GENERATION_CONFIG.retryDelay * attempt));
        }
    }
}

function parseJsonResponse(response, context) {
    console.log(`📄 Raw response for ${context}:`, response);
    try {
        if (!response) throw new Error('Response rỗng');

        const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/) || cleaned.match(/\[[\s\S]*\]/);

        if (!jsonMatch) throw new Error('Không tìm thấy JSON');

        const parsed = JSON.parse(jsonMatch[0]);
        console.log(`✅ Parse ${context} thành công`);
        return parsed;

    } catch (error) {
        console.error(`❌ Lỗi parse ${context}:`, error.message);
        return {};
    }
}

function combineConfigData(results, originalPrompt, botName, botCode, industry, targetAudience) {
    const validKnowledgeChunks = validateKnowledgeChunks(results.knowledgeChunks || []);
    const validCustomerFields = validateCustomerFields(results.customerFields || []);

    return {
        name: botName,
        code: botCode,
        description: `Bot ${botName} chuyên về ${industry}`,
        systemPrompt: results.systemPrompt?.systemPrompt || createDefaultSystemPrompt(industry, botName),
        welcomeMessage: results.systemPrompt?.welcomeMessage || `Chào bạn! Tôi là ${botName}, chuyên tư vấn về ${industry}.`,
        fallbackMessage: results.systemPrompt?.fallbackMessage || 'Xin lỗi, tôi chưa hiểu rõ. Bạn có thể diễn đạt lại không?',
        knowledgeChunks: validKnowledgeChunks,
        customerFields: validCustomerFields,
        behaviorConfig: results.systemPrompt?.behaviorConfig || createDefaultBehaviorConfig(industry),
        trainingConfig: createTrainingConfig(),
        ragConfig: createRagConfig(),
        status: 'active',
        generationMethod: 'multi_step'
    };
}

function parseGeneratedConfig(generatedText, botName, botCode, industry, targetAudience) {
    try {
        const cleanedText = generatedText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);

        if (!jsonMatch) throw new Error('Không tìm thấy JSON');

        const config = JSON.parse(jsonMatch[0]);

        return {
            name: botName,
            code: botCode,
            description: `Bot ${botName} chuyên về ${industry}`,
            systemPrompt: config.systemPrompt || createDefaultSystemPrompt(industry, botName),
            welcomeMessage: config.welcomeMessage || `Chào bạn! Tôi là ${botName}, chuyên tư vấn về ${industry}.`,
            fallbackMessage: config.fallbackMessage || 'Xin lỗi, tôi chưa hiểu rõ. Bạn có thể diễn đạt lại không?',
            knowledgeChunks: validateKnowledgeChunks(config.knowledgeChunks || []),
            customerFields: validateCustomerFields(config.customerFields || []),
            behaviorConfig: validateBehaviorConfig(config.behaviorConfig || {}, industry),
            trainingConfig: createTrainingConfig(),
            ragConfig: createRagConfig(),
            status: 'active',
            generationMethod: 'simple'
        };

    } catch (error) {
        console.error('❌ Parse config error:', error.message);
        return createFallbackConfig(botName, botCode, industry, targetAudience);
    }
}

// ========== VALIDATION & FALLBACK FUNCTIONS ==========

function validateKnowledgeChunks(chunks) {
    if (!Array.isArray(chunks)) return getDefaultKnowledgeChunks();

    return chunks
        .filter(chunk => chunk && chunk.title && chunk.content && chunk.content.length > GENERATION_CONFIG.limits.minChunkLength)
        .slice(0, GENERATION_CONFIG.limits.maxKnowledgeChunks)
        .map((chunk, index) => ({
            title: chunk.title || `Chunk ${index + 1}`,
            content: chunk.content,
            keywords: Array.isArray(chunk.keywords) ? chunk.keywords.slice(0, 5) : [],
            category: chunk.category || 'general',
            priority: typeof chunk.priority === 'number' ? Math.min(Math.max(chunk.priority, 1), 10) : 5,
            tokenCount: estimateTokens(chunk.content),
            source: 'ai_generated',
            isActive: true
        }));
}

function validateCustomerFields(fields) {
    if (!Array.isArray(fields)) return getDefaultCustomerFields();

    const validatedFields = fields
        .filter(field => field && field.fieldName)
        .slice(0, GENERATION_CONFIG.limits.maxCustomerFields)
        .map(field => ({
            fieldName: field.fieldName,
            fieldType: ['text', 'number', 'email', 'phone', 'date', 'enum'].includes(field.fieldType) ? field.fieldType : 'text',
            description: field.description || '',
            required: !!field.required,
            relevanceKeywords: Array.isArray(field.relevanceKeywords) ? field.relevanceKeywords : [],
            enumValues: Array.isArray(field.enumValues) ? field.enumValues : [],
            priority: typeof field.priority === 'number' ? field.priority : 1
        }));

    // Ensure basic fields
    const basicFields = ['tên', 'số điện thoại', 'email'];
    basicFields.forEach(fieldName => {
        if (!validatedFields.find(f => f.fieldName === fieldName)) {
            validatedFields.push(createBasicField(fieldName));
        }
    });

    return validatedFields;
}

function validateBehaviorConfig(behaviorConfig, industry) {
    const defaultConfig = {
        botType: 'consulting',
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

    const merged = { ...defaultConfig, ...behaviorConfig };

    // Industry-specific adjustments
    if (industry.toLowerCase().includes('bất động sản')) {
        merged.botType = 'sales';
        merged.salesStrategy = {
            enabled: true,
            productFocus: ['căn hộ', 'nhà phố', 'đất nền'],
            upselling: true,
            leadFollowUp: true
        };
    }

    return merged;
}

function getFallbackForStep(stepName, industry, botName) {
    const fallbacks = {
        systemPrompt: {
            systemPrompt: createDefaultSystemPrompt(industry, botName),
            welcomeMessage: `Chào bạn! Tôi là ${botName}.`,
            fallbackMessage: 'Xin lỗi, tôi chưa hiểu rõ câu hỏi.',
            behaviorConfig: createDefaultBehaviorConfig(industry)
        },
        knowledgeChunks: getDefaultKnowledgeChunks(industry),
        customerFields: getDefaultCustomerFields()
    };

    return fallbacks[stepName] || {};
}

function createFallbackConfig(botName, botCode, industry, targetAudience) {
    return {
        name: botName,
        code: botCode,
        description: `Bot ${botName} chuyên về ${industry}`,
        systemPrompt: createDefaultSystemPrompt(industry, botName),
        welcomeMessage: `Chào bạn! Tôi là ${botName}, chuyên tư vấn về ${industry}.`,
        fallbackMessage: 'Xin lỗi, tôi chưa hiểu rõ. Bạn có thể diễn đạt lại không?',
        knowledgeChunks: getDefaultKnowledgeChunks(industry),
        customerFields: getDefaultCustomerFields(),
        behaviorConfig: createDefaultBehaviorConfig(industry),
        trainingConfig: createTrainingConfig(),
        ragConfig: createRagConfig(),
        status: 'active',
        generationMethod: 'fallback'
    };
}

// ========== DEFAULT CONFIG GENERATORS ==========

function createDefaultSystemPrompt(industry, botName) {
    return `Bạn là ${botName}, một chuyên gia trong lĩnh vực ${industry}. 

VAI TRÒ:
- Tư vấn chuyên sâu về ${industry}
- Cung cấp thông tin chính xác và hữu ích
- Hỗ trợ giải đáp mọi thắc mắc

THU THẬP THÔNG TIN:
- Sử dụng [SAVE:field=value] để lưu thông tin khách hàng
- Chỉ thu thập khi cần thiết và có ngữ cảnh phù hợp
- Giải thích lý do thu thập thông tin

PHONG CÁCH:
- Chuyên nghiệp, thân thiện
- Tập trung vào giải pháp
- Rõ ràng, dễ hiểu

Hãy đảm bảo mọi thông tin đều chính xác và hữu ích cho khách hàng.`;
}

function createDefaultBehaviorConfig(industry) {
    const isRealEstate = industry.toLowerCase().includes('bất động sản');

    return {
        botType: isRealEstate ? 'sales' : 'consulting',
        communicationStyle: 'friendly',
        detailLevel: 'balanced',
        autoCollectInfo: {
            enabled: true,
            priorityFields: ['tên', 'số điện thoại'],
            timing: 'contextual'
        },
        ...(isRealEstate && {
            salesStrategy: {
                enabled: true,
                productFocus: ['căn hộ', 'nhà phố', 'đất nền'],
                upselling: true,
                leadFollowUp: true
            }
        }),
        limits: {
            maxResponseLength: 500,
            useEmojis: true,
            allowSmallTalk: true
        }
    };
}

function getDefaultKnowledgeChunks(industry = 'chung') {
    const baseChunks = [
        {
            title: "Giới thiệu dịch vụ",
            content: `Chúng tôi cung cấp các dịch vụ chuyên nghiệp trong lĩnh vực ${industry} với chất lượng cao.`,
            keywords: ["giới thiệu", "dịch vụ", "chất lượng"],
            category: "general",
            priority: 1
        },
        {
            title: "Liên hệ hỗ trợ",
            content: "Đội ngũ hỗ trợ của chúng tôi luôn sẵn sàng giải đáp thắc mắc và tư vấn chi tiết.",
            keywords: ["liên hệ", "hỗ trợ", "tư vấn"],
            category: "support",
            priority: 1
        }
    ];

    if (industry.toLowerCase().includes('bất động sản')) {
        baseChunks.push({
            title: "Tư vấn bất động sản",
            content: "Chúng tôi tư vấn các giải pháp đầu tư bất động sản phù hợp với nhu cầu và khả năng tài chính.",
            keywords: ["bất động sản", "đầu tư", "tài chính"],
            category: "real_estate",
            priority: 1
        });
    }

    return baseChunks;
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
        },
        {
            fieldName: 'email',
            fieldType: 'email',
            description: 'Địa chỉ email',
            required: false,
            relevanceKeywords: ['email', 'gmail', 'mail'],
            priority: 2
        }
    ];
}

function createBasicField(fieldName) {
    const configs = {
        'tên': { fieldType: 'text', description: 'Họ và tên khách hàng', relevanceKeywords: ['tên', 'tôi tên', 'mình tên'] },
        'số điện thoại': { fieldType: 'phone', description: 'Số điện thoại liên hệ', relevanceKeywords: ['số điện thoại', 'số phone', 'liên hệ'] },
        'email': { fieldType: 'email', description: 'Địa chỉ email', relevanceKeywords: ['email', 'gmail', 'mail'] }
    };

    const config = configs[fieldName] || { fieldType: 'text', description: fieldName, relevanceKeywords: [] };

    return {
        fieldName,
        fieldType: config.fieldType,
        description: config.description,
        required: fieldName === 'tên' || fieldName === 'số điện thoại',
        relevanceKeywords: config.relevanceKeywords,
        priority: 1
    };
}

function createTrainingConfig() {
    return {
        documentProcessing: {
            chunkSize: 1000,
            chunkOverlap: 200,
            maxTokensPerChunk: 500
        },
        autoKeywordExtraction: true,
        autoCategorization: true,
        largeDocumentSupport: true
    };
}

function createRagConfig() {
    return {
        maxChunks: 5,
        chunkSize: 200,
        similarityThreshold: 0.3,
        useSemanticSearch: true
    };
}

// ========== UTILITY FUNCTIONS ==========

function validateRequiredFields(body, requireBotCode = true) {
    const { businessDescription, botName, botCode, industry } = body;

    if (!businessDescription || !botName || !industry || (requireBotCode && !botCode)) {
        return {
            error: 'Thiếu thông tin bắt buộc: businessDescription, botName, industry' + (requireBotCode ? ', botCode' : '')
        };
    }
    return null;
}

function estimateTokens(text) {
    return Math.ceil((text || '').length / 3);
}

function formatBotResponse(bot, industry) {
    return {
        id: bot._id,
        name: bot.name,
        code: bot.code,
        description: bot.description,
        industry: industry
    };
}

function formatConfigSummary(bot) {
    return {
        systemPrompt: bot.systemPrompt?.substring(0, 200) + '...',
        knowledgeChunksCount: bot.knowledgeChunks.length,
        customerFieldsCount: bot.customerFields.length,
        behaviorConfig: bot.behaviorConfig
    };
}

function formatPreviewConfig(botConfig) {
    const { _id, createdAt, updatedAt, ...config } = botConfig;
    return config;
}

function calculatePreviewStatistics(botConfig) {
    return {
        knowledgeChunks: botConfig.knowledgeChunks.length,
        customerFields: botConfig.customerFields.length,
        estimatedTokens: estimateTotalTokens(botConfig)
    };
}

function estimateTotalTokens(config) {
    let total = 0;
    total += estimateTokens(config.systemPrompt);
    total += estimateTokens(config.welcomeMessage);
    total += estimateTokens(config.fallbackMessage);

    config.knowledgeChunks.forEach(chunk => {
        total += estimateTokens(chunk.content);
    });

    return total;
}

function handleGenerationError(res, error) {
    res.status(500).json({
        error: 'Lỗi trong quá trình tạo bot',
        details: error.message,
        ...(error.receivedText && { receivedText: error.receivedText.substring(0, 500) })
    });
}

// ========== EXPORT ==========

module.exports = router;