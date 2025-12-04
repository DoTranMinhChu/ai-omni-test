const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model xử lý Text (Gemini Flash - Hoạt động tốt)
const textModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * 1. Tối ưu Prompt (Giữ nguyên - Dùng Gemini)
 */
async function buildFinalPrompt(basePrompt, userInputData) {
    const prompt = `
    ROLE: Expert AI Prompt Engineer.
    TASK: Merge User Input into Base Template and enhance for image generation.
    
    DATA:
    - Base Template: "${basePrompt}"
    - User Input: ${JSON.stringify(userInputData)}

    REQUIREMENTS:
    1. Replace placeholders {{VAR}} with user values.
    2. Translate Vietnamese to English.
    3. Add artistic details (lighting, texture, 8k resolution).
    4. RETURN ONLY THE FINAL PROMPT STRING. NO JSON.
    `;

    try {
        const result = await textModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error("Gemini prompt error:", error);
        // Fallback đơn giản
        let simple = basePrompt;
        for (const [k, v] of Object.entries(userInputData)) simple = simple.replace(new RegExp(`{{${k}}}`, 'g'), v);
        return simple;
    }
}

/**
 * 2. Tạo Template tự động (Giữ nguyên - Dùng Gemini)
 */
async function autoGenerateTemplateConfig(description) {
    const prompt = `
    Create a JSON image generation template based on: "${description}".
    OUTPUT FORMAT (JSON ONLY):
    {
        "templateName": "Tên tiếng Việt hấp dẫn",
        "basePrompt": "Prompt tiếng Anh có chứa {{KEY}}...",
        "variables": [
            { "key": "KEY_1", "label": "Nhãn hiển thị tiếng Việt 1" },
            { "key": "KEY_2", "label": "Nhãn hiển thị tiếng Việt 2" }
        ]
    }
    `;
    try {
        const result = await textModel.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(text);
    } catch (error) {
        throw new Error("AI Auto-gen failed");
    }
}

/**
 * 3. Tạo ảnh từ Prompt (SỬ DỤNG HUGGING FACE FLUX.1)
 * Thay thế Google Imagen vì lỗi 404 Access Denied
 */
async function generateImageFromPrompt(prompt) {
    // Sử dụng Model FLUX.1-schnell (Tốc độ cực nhanh, chất lượng rất cao, miễn phí qua API)
    // Hoặc dùng: "stabilityai/stable-diffusion-xl-base-1.0"
    const HF_MODEL = "black-forest-labs/FLUX.1-schnell";
    const HF_API_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
    const HF_KEY = process.env.HUGGINGFACE_API_KEY; // Nhớ thêm vào .env

    if (!HF_KEY) {
        throw new Error("Thiếu HUGGINGFACE_API_KEY trong file .env");
    }

    try {
        console.log(`🎨 Gửi prompt tới Hugging Face (${HF_MODEL})...`);
        console.log(`➤ Prompt: ${prompt.substring(0, 50)}...`);

        const response = await axios.post(
            HF_API_URL,
            { inputs: prompt },
            {
                headers: {
                    Authorization: `Bearer ${HF_KEY}`,
                    "Content-Type": "application/json"
                },
                responseType: "arraybuffer" // Quan trọng: Nhận dữ liệu nhị phân (ảnh)
            }
        );

        // Chuyển đổi Binary Buffer sang Base64 Data URI
        const base64Image = Buffer.from(response.data, "binary").toString("base64");
        const dataUri = `data:image/jpeg;base64,${base64Image}`;

        console.log("✅ Tạo ảnh thành công (Hugging Face).");
        return dataUri;

    } catch (error) {
        console.error("❌ Lỗi tạo ảnh HF:", error.message);

        // Xử lý lỗi Model đang khởi động (503)
        if (error.response && error.response.data) {
            const errText = error.response.data.toString('utf8'); // Đọc buffer lỗi
            console.error("Chi tiết lỗi HF:", errText);

            if (errText.includes("loading")) {
                throw new Error("Model AI đang khởi động, vui lòng thử lại sau 30 giây.");
            }
        }
        throw new Error("Không thể tạo ảnh lúc này. Vui lòng thử lại.");
    }
}

module.exports = {
    buildFinalPrompt,
    autoGenerateTemplateConfig,
    generateImageFromPrompt
};