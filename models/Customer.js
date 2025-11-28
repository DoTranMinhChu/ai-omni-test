const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
    {
        identifier: { type: String, required: true },
        botCode: { type: String, required: true },

        // Thông tin profile
        profile: {
            name: String,
            email: String,
            phone: String,
            lastActive: { type: Date, default: Date.now },
            firstSeen: { type: Date, default: Date.now },
            lastInterest: Date,
            lastSentiment: String,
        },

        // Các fields động được thu thập
        collectedFields: [
            {
                fieldName: String,
                fieldValue: String,
                source: String, // 'user_provided', 'inferred', 'system', 'auto_collected'
                confidence: { type: Number, default: 1 },
                lastUpdated: { type: Date, default: Date.now },
                usageCount: { type: Number, default: 0 },
            },
        ],

        // Lead scoring cho bán hàng
        leadScore: { type: Number, default: 0 },
        leadStatus: {
            type: String,
            enum: ["new", "cold", "warm", "hot", "customer"],
            default: "new",
        },

        // Phân loại khách hàng
        segment: String,
        tags: [String],

        // Preferences và behavior
        preferences: {
            communicationStyle: { type: String, default: "friendly" },
            language: { type: String, default: "vi" },
            responseSpeed: { type: String, default: "normal" },
        },

        // Thống kê tương tác
        stats: {
            totalMessages: { type: Number, default: 0 },
            lastSession: Date,
            sessionCount: { type: Number, default: 1 },
            avgResponseTime: Number,
            satisfactionScore: Number,
        },
    },
    {
        timestamps: true,
    }
);

customerSchema.index({ identifier: 1, botCode: 1 }, { unique: true });
customerSchema.index({ leadScore: -1 });
customerSchema.index({ "profile.lastActive": -1 });

module.exports = mongoose.model("_Customer", customerSchema);
