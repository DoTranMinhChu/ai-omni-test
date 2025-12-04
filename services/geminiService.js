const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

/**
 * 1. Chức năng cho USER: Trộn biến và Tối ưu Prompt
 */
/**
 * 1. Chức năng cho USER: Trộn biến và Tối ưu Prompt (đã tối ưu hóa cho tiếng Việt)
 */
async function buildFinalPrompt(basePrompt, userInputData) {
    const prompt = `
    ROLE: Expert AI Prompt Engineer specializing in Vietnamese to English image prompt translation and optimization.
    
    TASK: You MUST perform a two-step process: 
    1. Accurately translate and enhance ALL Vietnamese user input from the 'User Input' object.
    2. Integrate the translated and enhanced content into the 'Base Template' to create a final, highly detailed, and optimized English prompt for image generation.

    DATA:
    - Base Template: "${basePrompt}"
    - User Input: ${JSON.stringify(userInputData)}

    REQUIREMENTS:
    1. TRANSLATE: Translate all Vietnamese content into detailed, descriptive English.
    2. ENHANCE: For every product or object description, automatically ADD high-quality artistic details (e.g., 'photorealistic texture', 'studio lighting', 'depth of field', 'vibrant color', 'detailed reflections') to the translated object to ensure the highest image quality, maintaining the user's original intent.
    3. OUTPUT: Return ONLY the final, complete, optimized English prompt string. No JSON, no quotes, no conversational text.
    `;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        // Xử lý lỗi nếu Gemini không trả về chuỗi hợp lệ
        console.error("Gemini failed to build prompt:", error);
        // Fallback: Thực hiện thay thế biến đơn giản nếu AI gặp lỗi
        let simplePrompt = basePrompt;
        for (const [key, value] of Object.entries(userInputData)) {
            const regex = new RegExp(`{{\\b${key}\\b}}`, 'g');
            simplePrompt = simplePrompt.replace(regex, value);
        }
        return `ERROR_FALLBACK: ${simplePrompt}`;
    }
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