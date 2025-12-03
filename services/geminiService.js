const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

/**
 * 1. Chức năng cho USER: Trộn biến và Tối ưu Prompt
 */
async function buildFinalPrompt(basePrompt, userInputData) {
    const prompt = `
    ROLE: Expert AI Prompt Engineer.
    TASK: Merge 'User Input' into 'Base Template' and ENHANCE the description for high-quality image generation.
    
    DATA:
    - Base Template: "${basePrompt}"
    - User Input: ${JSON.stringify(userInputData)}

    REQUIREMENTS:
    1. Replace {{VARIABLES}} in Base Template with User Input.
    2. If User Input is simple or in Vietnamese, TRANSLATE to English and ADD artistic details (lighting, texture, mood).
    3. Return ONLY the final English prompt string. No JSON, no quotes.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}

/**
 * 2. Chức năng cho ADMIN: Tự động tạo Template từ mô tả
 * VD Admin nhập: "Tôi muốn làm template tạo ảnh bìa món ăn cho nhà hàng"
 * AI sẽ tự nghĩ ra basePrompt và các biến cần thiết.
 */
async function autoGenerateTemplateConfig(adminDescription) {
    const prompt = `
    ROLE: System Architect for Image Generation App.
    TASK: Create a structural template configuration based on a description.

    DESCRIPTION: "${adminDescription}"

    OUTPUT FORMAT (JSON ONLY):
    {
        "templateName": "Short descriptive name",
        "basePrompt": "A detailed Stable Diffusion/Midjourney prompt with 2-4 placeholders like {{FOOD_NAME}}, {{STYLE}}...",
        "variables": ["FOOD_NAME", "STYLE", "..."]
    }
    
    Ensure the basePrompt is high quality, descriptive, and in English.
    Return ONLY JSON string.
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // Clean markdown code blocks if present
    const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
}

module.exports = { buildFinalPrompt, autoGenerateTemplateConfig };