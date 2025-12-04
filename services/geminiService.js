const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Cấu hình Gemini (Dùng để tối ưu prompt text)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Dùng bản 2.5 flash mới nhất để tối ưu prompt

/**
 * 1. Chức năng cho USER: Trộn biến và Tối ưu Prompt (Giữ nguyên)
 */
async function buildFinalPrompt(basePrompt, userInputData) {
    const prompt = `
    ROLE: Expert AI Prompt Engineer.
    TASK: Translate Vietnamese input to English and Enhance for Image Generation.
    DATA: Base: "${basePrompt}", User Input: ${JSON.stringify(userInputData)}
    REQUIREMENT: Return ONLY the final English prompt string. No Markdown.
    `;
    try {
        const result = await textModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        return basePrompt;
    }
}

/**
 * 2. Chức năng cho ADMIN (Giữ nguyên)
 */
async function autoGenerateTemplateConfig(adminDescription) {
    const prompt = `Create template config JSON for: "${adminDescription}". Return JSON only.`;
    try {
        const result = await textModel.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (e) { return null; }
}

/**
 * 3. [UPDATE] Hàm tạo ảnh dùng Model trong list của bạn
 * Mặc định dùng: imagen-4.0-generate-001 (Vì đây là model chuyên vẽ ảnh tốt nhất trong list của bạn)
 */
async function generateImage(prompt, outputFilename = 'generated_image.png', modelName = 'imagen-4.0-generate-001') {
    const apiKey = process.env.GEMINI_API_KEY;

    // Endpoint chuẩn cho các model thế hệ mới (Imagen 4, Gemini 2.0 Flash Image Gen)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:predict?key=${apiKey}`;

    const payload = {
        instances: [
            { prompt: prompt }
        ],
        parameters: {
            sampleCount: 1,
            aspectRatio: "1:1", // Tùy chọn: "16:9", "9:16", "3:4", "4:3"
            // outputOptions: { mimeType: "image/png" } // Một số model mới yêu cầu cái này
        }
    };

    try {
        console.log(`🎨 Đang gửi yêu cầu tới model: ${modelName}`);
        console.log(`📝 Prompt: ${prompt.substring(0, 50)}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();

        // Xử lý dữ liệu trả về (Cấu trúc của Imagen/Gemini Image Gen)
        let base64Data = null;

        if (data.predictions && data.predictions[0]) {
            // Trường hợp 1: Cấu trúc Imagen chuẩn
            if (data.predictions[0].bytesBase64Encoded) {
                base64Data = data.predictions[0].bytesBase64Encoded;
            }
            // Trường hợp 2: Cấu trúc mimeType (đôi khi gặp ở các bản preview)
            else if (data.predictions[0].image && data.predictions[0].image.bytesBase64Encoded) {
                base64Data = data.predictions[0].image.bytesBase64Encoded;
            }
        }
        return base64Data

    } catch (error) {
        console.error("❌ Lỗi tạo ảnh:", error.message);

        // Gợi ý fix lỗi nếu chọn sai model
        if (modelName.includes("flash-image") && error.message.includes("404")) {
            console.log("💡 GỢI Ý: Model 'gemini-2.5-flash-image' có thể chỉ là model Vision (nhìn ảnh). Hãy thử đổi sang 'imagen-4.0-generate-001'.");
        }
        throw error;
    }
}

// Export module
module.exports = { buildFinalPrompt, autoGenerateTemplateConfig, generateImage };