const mongoose = require("mongoose");

const CustomerMemorySchema = new mongoose.Schema(
  {
    customerIdentifier: { type: String, required: true, index: true },
    botCode: { type: String, required: true, index: true },
    knownFacts: [
      {
        fieldName: String,
        fieldValue: String,
        confidence: { type: Number, default: 1.0 },
        lastConfirmed: Date,
        source: { type: String, enum: ["direct", "inferred", "conversation"] },
      },
    ],
    conversationHistory: [
      {
        timestamp: Date,
        userMessage: String,
        botResponse: String,
        topics: [String],
        intent: String,
      },
    ],
    preferences: {
      communicationStyle: String,
      topicsOfInterest: [String],
      painPoints: [String],
      productInterests: [String],
    },
    lastUpdated: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
CustomerMemorySchema.index(
  { customerIdentifier: 1, botCode: 1 },
  { unique: true }
);

module.exports = mongoose.model("_CustomerMemory", CustomerMemorySchema);
