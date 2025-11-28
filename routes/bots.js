const express = require('express');
const router = express.Router();
const BotChat = require('../models/BotChat');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Cấu hình upload file
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = `uploads/${req.params.botCode}`;
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = ['.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file PDF, Word, Excel, hoặc TXT'));
        }
    }
});

// Tạo bot mới
router.post('/', async (req, res) => {
    try {
        const {
            name,
            code,
            description,
            systemPrompt,
            botType = 'general',
            communicationStyle = 'friendly',
            welcomeMessage,
            fallbackMessage
        } = req.body;

        // Kiểm tra code đã tồn tại chưa
        const existingBot = await BotChat.findOne({ code });
        if (existingBot) {
            return res.status(400).json({ error: 'Mã bot đã tồn tại' });
        }

        // Tạo behavior config mặc định dựa trên botType
        const behaviorConfig = createDefaultBehaviorConfig(botType, communicationStyle);

        // System prompt mặc định nếu không có
        const finalSystemPrompt = systemPrompt || createDefaultSystemPrompt(botType, communicationStyle);

        const bot = new BotChat({
            name,
            code,
            description,
            systemPrompt: finalSystemPrompt,
            welcomeMessage: welcomeMessage || createDefaultWelcomeMessage(botType),
            fallbackMessage: fallbackMessage || 'Xin lỗi, tôi chưa hiểu câu hỏi của bạn. Bạn có thể diễn đạt lại được không?',
            behaviorConfig,
            trainingConfig: {
                documentProcessing: {
                    chunkSize: 1000,
                    chunkOverlap: 200,
                    maxTokensPerChunk: 500
                },
                autoKeywordExtraction: true,
                autoCategorization: true,
                largeDocumentSupport: true
            },
            ragConfig: {
                maxChunks: 5,
                chunkSize: 200,
                similarityThreshold: 0.3,
                useSemanticSearch: true
            }
        });

        await bot.save();

        res.status(201).json({
            success: true,
            message: 'Bot đã được tạo thành công',
            bot: {
                id: bot._id,
                name: bot.name,
                code: bot.code,
                type: bot.behaviorConfig.botType,
                status: bot.status
            }
        });

    } catch (error) {
        console.error('Create bot error:', error);
        res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
});

// Lấy danh sách bot
router.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 10, type, status } = req.query;

        const filter = {};
        if (type) filter['behaviorConfig.botType'] = type;
        if (status) filter.status = status;

        const bots = await BotChat.find(filter)
            .select('name code description behaviorConfig status stats createdAt')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const total = await BotChat.countDocuments(filter);

        res.json({
            success: true,
            data: bots,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Get bots error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Lấy chi tiết bot
router.get('/:botCode', async (req, res) => {
    try {
        const { botCode } = req.params;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        res.json({
            success: true,
            data: bot
        });

    } catch (error) {
        console.error('Get bot error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Cập nhật bot
router.put('/:botCode', async (req, res) => {
    try {
        const { botCode } = req.params;
        const updateData = req.body;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        // Cập nhật từng field một để tránh ghi đè không cần thiết
        Object.keys(updateData).forEach(key => {
            if (key === 'behaviorConfig' && updateData.behaviorConfig) {
                bot.behaviorConfig = { ...bot.behaviorConfig, ...updateData.behaviorConfig };
            } else if (key === 'trainingConfig' && updateData.trainingConfig) {
                bot.trainingConfig = { ...bot.trainingConfig, ...updateData.trainingConfig };
            } else if (key === 'ragConfig' && updateData.ragConfig) {
                bot.ragConfig = { ...bot.ragConfig, ...updateData.ragConfig };
            } else if (updateData[key] !== undefined) {
                bot[key] = updateData[key];
            }
        });

        bot.updatedAt = new Date();

        await bot.save();

        res.json({
            success: true,
            message: 'Bot đã được cập nhật thành công',
            data: bot
        });

    } catch (error) {
        console.error('Update bot error:', error);
        res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
});

// Upload và xử lý tài liệu training
router.post('/:botCode/training/documents', upload.single('document'), async (req, res) => {
    try {
        const { botCode } = req.params;
        const { processImmediately = 'true' } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: 'Vui lòng chọn file để upload' });
        }

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            // Xóa file đã upload nếu bot không tồn tại
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        // Lưu thông tin file
        const documentInfo = {
            filename: req.file.originalname,
            path: req.file.path,
            size: req.file.size,
            uploadedAt: new Date(),
            status: 'uploaded'
        };

        // Xử lý ngay lập tức nếu được yêu cầu
        if (processImmediately === 'true') {
            try {
                documentInfo.status = 'processing';
                await processDocumentForBot(bot, documentInfo);
                documentInfo.status = 'completed';
            } catch (processingError) {
                documentInfo.status = 'error';
                documentInfo.error = processingError.message;
            }
        }

        // TODO: Lưu documentInfo vào database nếu cần

        res.json({
            success: true,
            message: 'Tài liệu đã được upload thành công',
            document: documentInfo
        });

    } catch (error) {
        console.error('Upload document error:', error);
        res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
});

// Thêm knowledge chunk thủ công
router.post('/:botCode/knowledge', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { title, content, keywords, category, priority = 1 } = req.body;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        const newChunk = {
            title,
            content,
            keywords: keywords || extractKeywordsFromText(content),
            category,
            priority,
            tokenCount: estimateTokens(content),
            source: 'manual',
            isActive: true
        };

        bot.knowledgeChunks.push(newChunk);
        await bot.save();

        res.json({
            success: true,
            message: 'Knowledge chunk đã được thêm thành công',
            chunk: newChunk
        });

    } catch (error) {
        console.error('Add knowledge error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Quản lý knowledge chunks
router.get('/:botCode/knowledge', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { page = 1, limit = 20, category, search } = req.query;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        let chunks = bot.knowledgeChunks;

        // Lọc theo category
        if (category) {
            chunks = chunks.filter(chunk => chunk.category === category);
        }

        // Tìm kiếm
        if (search) {
            const searchLower = search.toLowerCase();
            chunks = chunks.filter(chunk =>
                chunk.title.toLowerCase().includes(searchLower) ||
                chunk.content.toLowerCase().includes(searchLower) ||
                chunk.keywords.some(kw => kw.toLowerCase().includes(searchLower))
            );
        }

        // Phân trang
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        const paginatedChunks = chunks.slice(startIndex, endIndex);

        res.json({
            success: true,
            data: paginatedChunks,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: chunks.length,
                pages: Math.ceil(chunks.length / limit)
            }
        });

    } catch (error) {
        console.error('Get knowledge error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Xóa knowledge chunk
router.delete('/:botCode/knowledge/:chunkId', async (req, res) => {
    try {
        const { botCode, chunkId } = req.params;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        bot.knowledgeChunks = bot.knowledgeChunks.filter(
            chunk => chunk._id.toString() !== chunkId
        );

        await bot.save();

        res.json({
            success: true,
            message: 'Knowledge chunk đã được xóa thành công'
        });

    } catch (error) {
        console.error('Delete knowledge error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Cập nhật customer fields
router.put('/:botCode/fields', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { customerFields } = req.body;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        bot.customerFields = customerFields;
        await bot.save();

        res.json({
            success: true,
            message: 'Customer fields đã được cập nhật thành công',
            data: bot.customerFields
        });

    } catch (error) {
        console.error('Update fields error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Test bot
router.post('/:botCode/test', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { message } = req.body;

        const bot = await BotChat.findOne({ code: botCode });
        if (!bot) {
            return res.status(404).json({ error: 'Bot không tồn tại' });
        }

        // TODO: Gọi logic chat để test
        const testResponse = await generateTestResponse(bot, message);

        res.json({
            success: true,
            data: {
                input: message,
                output: testResponse,
                botConfig: {
                    type: bot.behaviorConfig.botType,
                    style: bot.behaviorConfig.communicationStyle
                }
            }
        });

    } catch (error) {
        console.error('Test bot error:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ========== HELPER FUNCTIONS ==========

function createDefaultBehaviorConfig(botType, communicationStyle) {
    const baseConfig = {
        botType,
        communicationStyle,
        detailLevel: 'balanced',
        language: 'vi',
        autoCollectInfo: {
            enabled: true,
            priorityFields: ['name', 'phone', 'email'],
            timing: 'contextual'
        },
        limits: {
            maxResponseLength: 500,
            useEmojis: true,
            allowSmallTalk: true
        }
    };

    // Tùy chỉnh theo botType
    switch (botType) {
        case 'sales':
            baseConfig.salesStrategy = {
                enabled: true,
                productFocus: [],
                upselling: true,
                leadFollowUp: true
            };
            baseConfig.autoCollectInfo.enabled = true;
            break;

        case 'consulting':
            baseConfig.detailLevel = 'detailed';
            baseConfig.autoCollectInfo.priorityFields = ['name', 'email'];
            break;

        case 'support':
            baseConfig.communicationStyle = 'professional';
            baseConfig.autoCollectInfo.enabled = false;
            break;

        case 'education':
            baseConfig.detailLevel = 'detailed';
            baseConfig.limits.useEmojis = false;
            break;
    }

    return baseConfig;
}

function createDefaultSystemPrompt(botType, communicationStyle) {
    const prompts = {
        sales: `Bạn là một chuyên viên tư vấn bán hàng chuyên nghiệp và thân thiện. 
    Nhiệm vụ chính của bạn là hiểu nhu cầu khách hàng, giới thiệu sản phẩm phù hợp 
    và hướng đến chốt sale. Hãy nhiệt tình, am hiểu sản phẩm và luôn tìm cách 
    thu thập thông tin liên hệ để follow-up.`,

        consulting: `Bạn là một chuyên gia tư vấn giàu kinh nghiệm. 
    Hãy lắng nghe vấn đề của khách hàng, phân tích kỹ lưỡng và đưa ra 
    những lời khuyên hữu ích, thiết thực. Tập trung vào giải pháp và 
    thể hiện sự chuyên nghiệp.`,

        support: `Bạn là nhân viên hỗ trợ kỹ thuật. Nhiệm vụ của bạn là 
    giải đáp thắc mắc, hướng dẫn sử dụng và xử lý sự cố. Hãy kiên nhẫn, 
    rõ ràng và cung cấp giải pháp chính xác, nhanh chóng.`,

        education: `Bạn là một trợ lý học tập thông minh. Hãy giải thích 
    các khái niệm một cách dễ hiểu, cung cấp kiến thức chính xác và 
    khuyến khích người học. Sử dụng ngôn ngữ trong sáng, dễ tiếp thu.`,

        general: `Bạn là một trợ lý ảo thông minh và hữu ích. 
    Hãy trả lời câu hỏi một cách chính xác, tự nhiên và thân thiện. 
    Luôn sẵn sàng hỗ trợ người dùng trong mọi lĩnh vực.`
    };

    return prompts[botType] || prompts.general;
}

function createDefaultWelcomeMessage(botType) {
    const messages = {
        sales: 'Xin chào! Tôi có thể giúp gì cho bạn hôm nay? 😊',
        consulting: 'Chào bạn! Tôi sẵn sàng lắng nghe và tư vấn cho bạn.',
        support: 'Xin chào! Tôi ở đây để giúp bạn giải quyết mọi vấn đề.',
        education: 'Chào bạn! Hãy hỏi tôi bất kỳ điều gì bạn muốn học hỏi.',
        general: 'Xin chào! Tôi có thể giúp gì cho bạn?'
    };

    return messages[botType] || messages.general;
}

function extractKeywordsFromText(text) {
    // Logic extract keywords đơn giản
    const stopWords = new Set(['của', 'và', 'là', 'có', 'được', 'cho', 'với', 'tại', 'theo']);
    return text.toLowerCase()
        .replace(/[^\w\sàáâãèéêìíòóôõùúýỳỹỵỷăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word))
        .slice(0, 10); // Giới hạn 10 keywords
}

function estimateTokens(text) {
    return Math.ceil(text.length / 3);
}

async function processDocumentForBot(bot, documentInfo) {
    // TODO: Implement document processing logic
    // Sử dụng thư viện như pdf-parse, mammoth, etc.
    // Chia nhỏ nội dung thành các knowledge chunks
    // Thêm vào bot.knowledgeChunks

    console.log(`Processing document for bot ${bot.code}: ${documentInfo.filename}`);
    // Placeholder implementation
    return new Promise((resolve) => {
        setTimeout(() => {
            console.log(`Document processing completed for ${documentInfo.filename}`);
            resolve();
        }, 2000);
    });
}

async function generateTestResponse(bot, message) {
    // TODO: Implement test response generation
    // Có thể gọi một phiên bản đơn giản của chat logic
    return `Đây là phản hồi test từ bot ${bot.name}: "${message}"`;
}

module.exports = router;