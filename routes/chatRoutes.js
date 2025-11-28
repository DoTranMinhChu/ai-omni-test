const express = require('express');
const router = express.Router();
const chatService = require('../services/chatService');
const Message = require('../models/Message');

// 1. API Gửi tin nhắn (Chat)
router.post('/:botCode/message', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { userIdentifier, message } = req.body;
        const result = await chatService.processMessage(botCode, userIdentifier, message);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. API Lấy lịch sử chat (Load More / Pagination)
// Client gọi: GET /api/chat/MOM_CARE/history?userIdentifier=0988&limit=20&beforeId=xxx
router.get('/:botCode/history', async (req, res) => {
    try {
        const { botCode } = req.params;
        const { userIdentifier, limit = 20, beforeId } = req.query;

        if (!userIdentifier) return res.status(400).json({ error: "Missing userIdentifier" });

        // Query cơ bản
        let query = {
            botCode,
            customerIdentifier: userIdentifier
        };

        // Nếu client gửi beforeId (ID của tin nhắn cũ nhất đang hiển thị trên màn hình)
        // Hệ thống sẽ lấy những tin nhắn cũ hơn tin đó
        if (beforeId) {
            query._id = { $lt: beforeId };
        }

        const messages = await Message.find(query)
            .sort({ _id: -1 }) // Lấy từ mới nhất trở về quá khứ
            .limit(parseInt(limit))
            .lean();

        // Trả về dữ liệu đã đảo ngược lại (Cũ -> Mới) để Client dễ render
        // Hoặc giữ nguyên tùy frontend quy ước
        res.json({
            data: messages.reverse(),
            pagination: {
                hasMore: messages.length === parseInt(limit),
                lastId: messages.length > 0 ? messages[0]._id : null // ID để load trang tiếp theo (thực tế là previous page)
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;