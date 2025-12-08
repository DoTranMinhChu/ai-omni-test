require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const imageRoutes = require('./routes/imageRoute');
const knowledgeRAGService = require('./services/knowledgeRAGService');
const path = require("path");

const app = express();
app.use(bodyParser.json());

// Database Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ DB Connection Error:', err));

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/image', imageRoutes);
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});
const dedicatedChatPath = path.join(__dirname, 'dedicated_chat.html');

// ROUTE MỚI: Dùng để phục vụ trang chat độc lập
app.get('/chat/:botCode', (req, res) => {
    // req.params.botCode sẽ chứa mã bot (ví dụ: 'nutrition_bot')
    // JavaScript trong dedicated_chat.html sẽ tự động đọc mã này từ URL
    res.sendFile(dedicatedChatPath, (err) => {
        if (err) {
            console.error('Error sending file:', err);
            res.status(500).send('Internal Server Error');
        }
    });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});