const express = require('express');
const router = express.Router();
const Bot = require('../models/Bot');
const Customer = require('../models/Customer');
const KnowledgeChunk = require('../models/KnowledgeChunk');
const botGenerator = require('../services/botGenerator');
const ImageTemplate = require('../models/ImageTemplate')
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() }); // Lưu RAM để xử lý nhanh
const fileKnowledgeService = require('../services/fileKnowledgeService');
const geminiService = require('../services/geminiService')
const GeneratedImage = require('../models/GeneratedImage')
const botOptimizer = require('../services/botOptimizer')
const knowledgeRAGService = require('../services/knowledgeRAGService')
// ==========================================
// 1. QUẢN LÝ BOT (CRUD & GENERATE)
// ==========================================

// [GET] Lấy danh sách Bot
router.get('/bots', async (req, res) => {
    try {
        const bots = await Bot.find().sort({ createdAt: -1 });
        res.json(bots);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [POST] Tạo Bot Thủ Công (Manual Create)
// Dành cho trường hợp Admin muốn tự config chi tiết JSON
router.post('/bots', async (req, res) => {
    try {
        const { name, code, systemPrompt, behaviorConfig, memoryConfig } = req.body;

        // Validate cơ bản
        if (!name || !code || !systemPrompt) {
            return res.status(400).json({ error: "Thiếu thông tin bắt buộc (name, code, systemPrompt)" });
        }

        const existingBot = await Bot.findOne({ code });
        if (existingBot) {
            return res.status(400).json({ error: "Mã Bot đã tồn tại!" });
        }
        console.log("⚡ Đang tối ưu hóa System Prompt...");
        const optimizedPrompt = await botOptimizer.optimizeBotInstruction(
            systemPrompt,
            behaviorConfig,
            memoryConfig
        );

        const newBot = await Bot.create({
            name, code, systemPrompt, behaviorConfig, memoryConfig,
            optimizedPrompt // <--- Lưu bản đã tối ưu vào DB
        });


        res.status(201).json({
            message: "Tạo bot thủ công thành công",
            bot: newBot
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [POST] Auto-Generate Bot (AI tạo cấu hình)
// Admin chỉ cần cung cấp: name, code, description. AI sẽ lo phần còn lại.
router.post('/bots/auto-generate', async (req, res) => {
    try {
        const { name, code, description } = req.body;

        if (!description) {
            return res.status(400).json({ error: "Cần mô tả bot để AI làm việc" });
        }

        // 1. Gọi AI tạo cấu hình dựa trên mô tả
        const aiConfig = await botGenerator.generateBotConfig(description);

        // 2. Ghi đè Name và Code do Admin chỉ định (nếu có)
        // Nếu admin không nhập name/code thì lấy cái AI gợi ý
        const finalConfig = {
            ...aiConfig,
            name: name || aiConfig.name,
            code: code || aiConfig.code,
            // Giữ nguyên các config hành vi mà AI đã tạo
        };

        // 3. Kiểm tra trùng mã
        const existingBot = await Bot.findOne({ code: finalConfig.code });
        if (existingBot) {
            return res.status(400).json({ error: `Mã Bot '${finalConfig.code}' đã tồn tại. Vui lòng chọn mã khác.` });
        }

        // 4. Lưu vào DB
        const newBot = await Bot.create(finalConfig);

        res.status(201).json({
            message: "Bot được AI tạo thành công!",
            bot: newBot
        });

    } catch (err) {
        console.error("Generate Error:", err);
        res.status(500).json({ error: "Lỗi khi tạo bot tự động: " + err.message });
    }
});

// [PUT] Cập nhật Bot (Edit Rule & Trí tuệ)
router.put('/bots/:id', async (req, res) => {
    try {
        const { name, systemPrompt, behaviorConfig, memoryConfig } = req.body;

        let updateData = req.body;

        if (systemPrompt || behaviorConfig || memoryConfig) {
            // Lấy data cũ nếu body thiếu để tối ưu cho chuẩn (nếu cần thiết), 
            // ở đây giả sử FE gửi full data lên
            const optimizedPrompt = await botOptimizer.optimizeBotInstruction(
                systemPrompt,
                behaviorConfig,
                memoryConfig
            );
            updateData.optimizedPrompt = optimizedPrompt;
        }

        const updatedBot = await Bot.findByIdAndUpdate(req.params.id, { $set: updateData }, { new: true });

        if (!updatedBot) return res.status(404).json({ error: "Bot không tồn tại" });
        res.json(updatedBot);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.delete('/bots/:id', async (req, res) => {
    try {

        const botExisted = await Bot.findById(req.params.id)
        const deleteBot = await Bot.deleteOne({ _id: req.params.id });
        await KnowledgeChunk.deleteMany({ botId: req.params.id })
        await Customer.deleteMany({ botCode: botExisted.code });
        if (!deleteBot) return res.status(404).json({ error: "Bot không tồn tại" });
        res.json(deleteBot);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. QUẢN LÝ TRI THỨC (KNOWLEDGE BASE)
// ==========================================

// [POST] Nạp tri thức cho Bot (Upload Knowledge)
router.post('/bots/:botCode/knowledge', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { content, keywords } = req.body; // content: đoạn văn bản, keywords: mảng từ khóa (optional)

        if (!content) return res.status(400).json({ error: "Nội dung tri thức không được để trống" });

        // 1. Tìm Bot để lấy ID
        const bot = await Bot.findOne({ code: botCode });
        if (!bot) return res.status(404).json({ error: "Bot không tồn tại" });

        // 2. Tạo Knowledge Chunk
        const embedding = await knowledgeRAGService.createEmbedding(chunk.content);
        const chunk = await KnowledgeChunk.create({
            botId: bot._id,
            content: content,
            keywords: keywords || [],// Nếu không có keywords thì để mảng rỗng
            embedding: embedding,
            embeddingModel: 'Xenova/all-MiniLM-L6-v2'
        });



        res.status(201).json({
            message: "Đã nạp tri thức thành công",
            chunkId: chunk._id
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [GET] Xem danh sách tri thức của Bot
router.get('/bots/:botCode/knowledge', async (req, res) => {
    try {
        const bot = await Bot.findOne({ code: req.params.botCode });
        if (!bot) return res.status(404).json({ error: "Bot không tồn tại" });

        const knowledge = await KnowledgeChunk.find({ botId: bot._id }).sort({ createdAt: -1 });
        res.json(knowledge);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// 3. QUẢN LÝ KHÁCH HÀNG (CUSTOMER DATA)
// ==========================================

// [GET] Lấy danh sách khách hàng & thông tin đã thu thập
router.get('/bots/:botCode/customers', async (req, res) => {
    try {
        const bot = await Bot.findOne({ code: req.params.botCode });
        if (!bot) return res.status(404).json({ error: "Bot không tồn tại" });

        // Lấy danh sách khách hàng thuộc bot này
        // Lưu ý: Trong kiến trúc mới, Customer không còn chứa mảng history quá lớn
        const customers = await Customer.find({ botCode: bot.code }) // Hoặc botId tuỳ schema bạn chốt
            .sort({ lastActiveAt: -1 })
            .limit(50); // Giới hạn 50 người gần nhất để đỡ lag

        const formattedList = customers.map(c => ({
            id: c.identifier,
            attributes: c.attributes, // Những gì bot đã nhớ (Tên, Tuổi, Sở thích...)
            lastActive: c.lastActiveAt
        }));

        res.json(formattedList);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==========================================
// ... (Các API nạp và xem tri thức đã có ở trên)
// ==========================================

// [PUT] Cập nhật nội dung một mẩu tri thức (Update Knowledge Chunk)
// Dùng khi bạn nạp sai nội dung hoặc muốn bổ sung từ khóa
router.put('/knowledge/:chunkId', async (req, res) => {
    try {
        const { chunkId } = req.params;
        const { content, keywords } = req.body;

        // Cập nhật
        const updatedChunk = await KnowledgeChunk.findByIdAndUpdate(
            chunkId,
            {
                $set: {
                    content: content,
                    keywords: keywords // keywords nên là mảng string
                }
            },
            { new: true } // Option này để trả về document mới sau khi update
        );

        if (!updatedChunk) {
            return res.status(404).json({ error: "Không tìm thấy mẩu tri thức này" });
        }

        res.json({
            message: "Cập nhật tri thức thành công",
            chunk: updatedChunk
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [DELETE] Xóa một mẩu tri thức (Delete Knowledge Chunk)
// Dùng khi tri thức đó bị sai hoặc lỗi thời
router.delete('/knowledge/:chunkId', async (req, res) => {
    try {
        const { chunkId } = req.params;

        const deletedChunk = await KnowledgeChunk.findByIdAndDelete(chunkId);

        if (!deletedChunk) {
            return res.status(404).json({ error: "Không tìm thấy tri thức để xóa" });
        }

        res.json({
            message: "Đã xóa tri thức thành công",
            deletedId: chunkId
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [DELETE] Xóa TOÀN BỘ tri thức của một Bot (Reset Knowledge)
// CẢNH BÁO: Dùng cẩn thận, chức năng này sẽ xóa sạch kiến thức để nạp lại từ đầu
router.delete('/bots/:botCode/knowledge/all', async (req, res) => {
    try {
        const { botCode } = req.params;

        // 1. Tìm Bot
        const bot = await Bot.findOne({ code: botCode });
        if (!bot) return res.status(404).json({ error: "Bot không tồn tại" });

        // 2. Xóa tất cả chunk thuộc bot này
        const result = await KnowledgeChunk.deleteMany({ botId: bot._id });

        res.json({
            message: `Đã xóa sạch ${result.deletedCount} mẩu tri thức của bot ${bot.name}`,
            count: result.deletedCount
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ... các dòng require cũ ...

// [POST] Đăng nhập Admin (Simple Hardcoded)
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    // Kiểm tra tài khoản cứng
    if (username === 'admin' && password === '123123123') {
        return res.json({
            success: true,
            message: 'Đăng nhập thành công',
            token: 'admin-fake-token-' + Date.now() // Token giả lập
        });
    }

    return res.status(401).json({
        success: false,
        error: 'Sai tài khoản hoặc mật khẩu'
    });
});


// ... (Các code cũ giữ nguyên)

// [API 1] UPLOAD & PREVIEW (Đọc file -> Trả về danh sách JSON để Admin xem trước)
// [API] UPLOAD & PREVIEW
router.post('/bots/:botCode/knowledge/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Chưa chọn file" });

        // Service mới tự động phát hiện loại file và xử lý (Markdown, Table, OCR...)
        const rawText = await fileKnowledgeService.processInput(req.file);

        // Gửi cho AI
        const chunks = await fileKnowledgeService.generateChunksFromText(rawText);

        res.json({
            success: true,
            previewChunks: chunks
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi xử lý file: " + err.message });
    }
});

// [API MỚI] XỬ LÝ URL (Thêm vào adminRoutes.js)
router.post('/bots/:botCode/knowledge/url', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: "Thiếu URL" });

        const rawText = await fileKnowledgeService.processInput(url);
        const chunks = await fileKnowledgeService.generateChunksFromText(rawText);

        res.json({ success: true, previewChunks: chunks });
    } catch (err) {
        res.status(500).json({ error: "Lỗi xử lý URL: " + err.message });
    }
});
// [API 2] SAVE BULK (Lưu danh sách tri thức đã duyệt vào DB)
router.post('/bots/:botCode/knowledge/bulk', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { chunks } = req.body; // Mảng [{content, keywords}, ...]

        if (!Array.isArray(chunks) || chunks.length === 0) {
            return res.status(400).json({ error: "Dữ liệu không hợp lệ" });
        }

        const bot = await Bot.findOne({ code: botCode });
        if (!bot) return res.status(404).json({ error: "Bot không tồn tại" });

        // Map dữ liệu để lưu
        const knowledgeDocs = chunks.map(c => ({
            botId: bot._id,
            content: c.content,
            keywords: c.keywords || []
        }));

        // Insert many
        await KnowledgeChunk.insertMany(knowledgeDocs);

        res.json({
            message: `Đã nhập thành công ${knowledgeDocs.length} tri thức mới!`
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1. Tạo Template (Body: { type: 'AUTO'/'MANUAL', ... })
router.post('/image-template', async (req, res) => {
    try {
        const { type, templateCode, description, manualData } = req.body;
        // type: 'MANUAL' | 'AUTO'

        let newTemplateData = {};

        if (type === 'AUTO') {
            // Case 1: AI tự nghĩ ra cấu trúc dựa trên mô tả
            if (!description) return res.status(400).json({ error: 'Cần mô tả cho AI' });

            const aiConfig = await geminiService.autoGenerateTemplateImageConfig(description);

            newTemplateData = {
                templateCode: templateCode, // Admin vẫn phải đặt mã code
                templateName: aiConfig.templateName,
                basePrompt: aiConfig.basePrompt,
                variables: aiConfig.variables,
                description: `Auto-generated from: ${description}`,
                createdBy: 'AI'
            };

        } else {
            // Case 2: Tạo thủ công
            if (!manualData) return res.status(400).json({ error: 'Thiếu dữ liệu thủ công' });

            newTemplateData = {
                templateCode: templateCode,
                templateName: manualData.templateName,
                basePrompt: manualData.basePrompt,
                variables: manualData.variables,
                description: manualData.description || 'Manual creation',
                createdBy: 'ADMIN'
            };
        }

        // Lưu vào DB
        const savedTemplate = await ImageTemplate.create(newTemplateData);

        return res.status(201).json({
            success: true,
            message: 'Tạo template thành công',
            data: savedTemplate
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
});
// 2. Lấy danh sách
router.get('/image-template', async (req, res) => {
    const templates = await ImageTemplate.find();
    res.json(templates);
});

router.delete('/image-template/:id', async (req, res) => {
    await ImageTemplate.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// UPDATE
router.put('/image-template/:id', async (req, res) => {
    const { templateName, basePrompt, variables } = req.body;
    await ImageTemplate.findByIdAndUpdate(req.params.id, {
        templateName, basePrompt, variables
    });
    res.json({ success: true });
});
router.get('/generated-images', async (req, res) => {
    const { userId, templateCode } = req.query;
    let filter = {};
    if (userId) filter.userId = userId;
    if (templateCode) filter.templateCode = templateCode;

    const images = await GeneratedImage.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json(images);
});
module.exports = router;