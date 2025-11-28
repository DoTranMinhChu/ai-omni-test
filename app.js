const express = require("express");
const cors = require("cors");
require("dotenv").config();
const connectDB = require("./db");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// Kết nối database
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/bots", require("./routes/bots"));
app.use("/api/chat", require("./routes/chat"));
app.use("/api/bot-generator", require("./routes/bot-generator")); // Thêm dòng này
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
