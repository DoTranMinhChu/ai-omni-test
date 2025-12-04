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
async function autoGenerateTemplateImageConfig(adminDescription) {
    // 1. Định nghĩa cấu trúc chuẩn (Golden Standard) để AI học theo
    const exampleStructure = `
    1. TÊN TEMPLATE
    Thiết Kế Ảnh Bán Hàng 1:1 – 3 Sản Phẩm (Chuẩn Tiếng Việt)

    2. MÃ CODE
    FB_1x1_3IMG_VN_FONTSAFE

    3. BASE PROMPT (BẢN HOÀN THIỆN – CHUẨN TIẾNG VIỆT, CHỐNG LỖI FONT)
    Tạo một thiết kế quảng cáo... dựa trên: {{PRODUCT_1}}...
    
    Yêu cầu chặt chẽ đối với chữ trên thiết kế:
    • Tất cả text trên hình phải dùng tiếng Việt chuẩn Unicode.
    • Không được sai chính tả, không thiếu dấu, không lỗi font.
    • Phải thể hiện đúng nguyên văn HEADLINE và SLOGAN.
    
    Text hiển thị:
    • HEADLINE lớn: "{{HEADLINE}}"
    • SLOGAN nhỏ: "{{SLOGAN}}"

    4. BIẾN SỐ
    PRODUCT_1, HEADLINE, SLOGAN...

    5. GỢI Ý DỮ LIỆU CHUẨN
    HEADLINE: Sale Sập Sàn...

    6. VÌ SAO BẢN NÀY TỐI ƯU?
    ...
    `;

    // 2. Tạo Prompt yêu cầu Gemini đóng vai chuyên gia
    const prompt = `
    ROLE: Expert AI Prompt Engineer for Image Generation (Vietnamese Market).
    TASK: Analyze the user's description and generate a specialized JSON configuration for an Image Generation Template.

    USER DESCRIPTION: "${adminDescription}"

    REQUIREMENTS:
    1.  **Analyze**: Determine necessary variables (e.g., PRODUCT_NAME, DISCOUNT, BACKGROUND, MODEL_GENDER) based on the description.
    2.  **Construct 'basePrompt'**: It MUST follow the "6-SECTION STRUCTURE" strictly.
        -   **Section 3 (IMPORTANT)**: Must include the "Anti-Font-Error Boilerplate" (Yêu cầu chặt chẽ đối với chữ... Unicode... Không lỗi font). This is mandatory for Vietnamese text.
        -   Variables in prompt must be in uppercase double curly braces: {{VARIABLE_NAME}}.
    3.  **Construct 'variables'**: An array of objects with 'key' and Vietnamese 'label'.

    OUTPUT FORMAT (JSON ONLY - NO MARKDOWN):
    {
        "templateName": "Tên tiếng Việt hấp dẫn (VD: Poster Khai Trương Quán Cafe)",
        "basePrompt": "The full 6-section text string (sections 1,2,3,4,5,6) similar to the Example below.",
        "variables": [
            { "key": "HEADLINE", "label": "Tiêu đề chính" },
            { "key": "THEME", "label": "Chủ đề (VD: Giáng sinh)" }
            // ... Add other variables relevant to the description
        ]
    }

    REFERENCE EXAMPLE FOR 'basePrompt' CONTENT (Mimic this style):
    """
    ${exampleStructure}
    """
    
    Ensure the JSON is valid. Keys in 'variables' must match {{KEYS}} in 'basePrompt'.
    `;

    try {
        const result = await textModel.generateContent(prompt);
        const text = result.response.text();

        // Clean JSON string (tránh trường hợp AI trả về ```json ... ```)
        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();

        return JSON.parse(jsonStr);
    } catch (error) {
        console.error("Gemini Auto-Gen Error:", error);
        // Fallback đơn giản nếu lỗi
        return {
            templateName: "Auto Generated Template (Error Fallback)",
            basePrompt: `An image based on: ${adminDescription}. Details: {{DETAILS}}`,
            variables: [{ key: "DETAILS", label: "Chi tiết mô tả" }]
        };
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
module.exports = { buildFinalPrompt, autoGenerateTemplateConfig, generateImage, autoGenerateTemplateImageConfig };