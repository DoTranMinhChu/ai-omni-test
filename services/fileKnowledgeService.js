const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const AdmZip = require('adm-zip');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm'); // Hỗ trợ Table trong Markdown
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const deepseekService = require('./deepseekService');

class FileKnowledgeService {

    constructor() {
        // Cấu hình bộ chuyển đổi HTML sang Markdown
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced'
        });
        // Kích hoạt plugin để giữ cấu trúc Bảng (Table)
        this.turndownService.use(gfm);
    }

    /**
     * Router chính để điều hướng xử lý theo loại dữ liệu
     */
    async processInput(input) {
        // Nếu input là File Object (từ Multer)
        if (input.buffer && input.mimetype) {
            return await this.extractTextFromFile(input);
        }
        // Nếu input là URL (String)
        else if (typeof input === 'string' && input.startsWith('http')) {
            return await this.extractTextFromUrl(input);
        }
        throw new Error("Định dạng đầu vào không hợp lệ");
    }

    // --- 1. XỬ LÝ URL (TIN TỨC/BÀI VIẾT) ---
    async extractTextFromUrl(url) {
        try {
            console.log(`🌐 Đang cào dữ liệu từ: ${url}`);
            const { data } = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });

            const dom = new JSDOM(data, { url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article) return "";

            // Chuyển nội dung bài báo (HTML) sang Markdown
            const markdownContent = this.turndownService.turndown(article.content);

            return `Nguồn: ${url}\nTiêu đề: ${article.title}\n\n${markdownContent}`;
        } catch (error) {
            console.error("URL Parse Error:", error.message);
            throw new Error("Không thể đọc nội dung từ đường dẫn này.");
        }
    }

    // --- 2. XỬ LÝ FILE (PDF, DOCX, ẢNH) ---
    async extractTextFromFile(file) {
        const buffer = file.buffer;
        const mimeType = file.mimetype;

        try {
            if (mimeType === 'application/pdf') {
                return await this.processPdf(buffer);
            }
            else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                return await this.processDocx(buffer);
            }
            else if (mimeType.startsWith('text/')) {
                return buffer.toString('utf-8');
            }
            else if (mimeType.startsWith('image/')) {
                return await this.processImage(buffer);
            }
            return "";
        } catch (error) {
            console.error("File Parse Error:", error);
            throw new Error("Lỗi đọc file: " + error.message);
        }
    }

    // Xử lý DOCX (Giữ Table + OCR Ảnh)
    async processDocx(buffer) {
        let finalMarkdown = "";

        // B1: Chuyển DOCX sang HTML (để giữ cấu trúc bảng, list)
        try {
            const { value: html } = await mammoth.convertToHtml({ buffer: buffer });
            // B2: Chuyển HTML sang Markdown (Rất quan trọng cho LLM hiểu Table)
            finalMarkdown += this.turndownService.turndown(html);
        } catch (e) {
            console.warn("Mammoth error:", e.message);
        }

        // B3: Quét ảnh trong file DOCX (OCR)
        try {
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();
            const imageEntries = zipEntries.filter(entry =>
                entry.entryName.startsWith('word/media/') &&
                /\.(png|jpg|jpeg|bmp)$/i.test(entry.name)
            );

            if (imageEntries.length > 0) {
                console.log(`📸 DOCX: Tìm thấy ${imageEntries.length} ảnh. Đang OCR...`);
                const ocrTexts = await Promise.all(imageEntries.map(async (entry) => {
                    // Chỉ OCR những ảnh có kích thước > 5KB để tránh icon rác
                    if (entry.getData().length > 5000) {
                        return await this.processImage(entry.getData());
                    }
                    return "";
                }));

                const validOcr = ocrTexts.filter(t => t.trim().length > 10).join("\n\n");
                if (validOcr) {
                    finalMarkdown += `\n\n## [NỘI DUNG TỪ HÌNH ẢNH]\n${validOcr}`;
                }
            }
        } catch (e) {
            console.error("DOCX Image Error:", e.message);
        }

        return finalMarkdown;
    }

    // Xử lý PDF (Cơ bản)
    async processPdf(buffer) {
        // PDF-parse tốt cho text digital. 
        // Nếu là PDF scan (ảnh), pdf-parse sẽ trả về rỗng -> Cần nâng cấp lên OCR nếu cần thiết.
        const data = await pdf(buffer);
        return data.text;
    }

    // Xử lý Ảnh (OCR)
    async processImage(buffer) {
        try {
            const { data: { text } } = await Tesseract.recognize(buffer, 'vie+eng'); // Ưu tiên tiếng Việt
            return text;
        } catch (e) {
            return "";
        }
    }


    /**
    * NÂNG CẤP: Hàm xử lý văn bản dài bằng cách chia nhỏ (Chunking Strategy)
    */
    async generateChunksFromText(rawText) {
        if (!rawText || rawText.trim().length < 20) return [];

        // 1. Chia nhỏ văn bản thành các đoạn an toàn (khoảng 6000 ký tự/đoạn)
        // DeepSeek Output limit thường là 4k-8k tokens, input context lớn hơn nhiều.
        // Tuy nhiên, để AI trả về JSON ổn định, ta nên gửi input vừa phải.
        const textChunks = this.splitTextIntoSafeChunks(rawText, 6000);

        console.log(`🔹 Tổng độ dài: ${rawText.length} chars. Chia thành ${textChunks.length} phần để xử lý.`);

        const allKnowledgeChunks = [];

        // 2. Gửi từng đoạn cho AI (Xử lý tuần tự để tránh Rate Limit, hoặc song song nếu API Key xịn)
        for (let i = 0; i < textChunks.length; i++) {
            const chunkText = textChunks[i];
            console.log(`⏳ Đang xử lý phần ${i + 1}/${textChunks.length}...`);

            try {
                const result = await this.processSingleChunkWithAI(chunkText);
                if (Array.isArray(result)) {
                    allKnowledgeChunks.push(...result);
                }
            } catch (error) {
                console.error(`❌ Lỗi xử lý phần ${i + 1}:`, error.message);
            }
        }

        return allKnowledgeChunks;
    }

    /**
     * Hàm chia nhỏ văn bản thông minh (tránh cắt giữa chừng)
     */
    splitTextIntoSafeChunks(text, maxLength) {
        const chunks = [];
        let currentChunk = "";

        // Tách theo đoạn văn (xuống dòng kép) để giữ ngữ cảnh tốt nhất
        const paragraphs = text.split(/\n\s*\n/);

        for (const para of paragraphs) {
            if ((currentChunk.length + para.length) > maxLength) {
                if (currentChunk.trim()) chunks.push(currentChunk);
                currentChunk = para; // Bắt đầu chunk mới
            } else {
                currentChunk += "\n\n" + para;
            }
        }
        if (currentChunk.trim()) chunks.push(currentChunk);

        // Fallback: Nếu 1 đoạn văn quá dài > maxLength (hiếm gặp), cắt cứng
        if (chunks.length === 0 && text.length > 0) {
            for (let i = 0; i < text.length; i += maxLength) {
                chunks.push(text.substring(i, i + maxLength));
            }
        }

        return chunks;
    }

    /**
     * Gọi AI xử lý 1 đoạn văn bản nhỏ (Đảm bảo JSON hợp lệ)
     */
    async processSingleChunkWithAI(textSegment) {
        const prompt = `
        Bạn là chuyên gia xử lý dữ liệu RAG.
        Nhiệm vụ: Trích xuất các ý chính từ đoạn văn bản dưới đây thành các mẩu tri thức độc lập.
        
        YÊU CẦU:
        1. Nếu văn bản là bảng biểu, hãy tóm tắt thành tri thức dạng liệt kê.
        2. Bỏ qua các thông tin vô nghĩa (header, footer, số trang).
        3. CHỈ TRẢ VỀ JSON MẢNG, không giải thích thêm.

        INPUT TEXT:
        """
        ${textSegment}
        """

        OUTPUT FORMAT (JSON):
        [
            { "content": "Nội dung...", "keywords": ["k1", "k2"] }
        ]
        `;

        try {
            const aiResponse = await deepseekService.chat([
                { role: 'system', content: 'Strict JSON Output Agent.' },
                { role: 'user', content: prompt }
            ], {
                temperature: 0.3, // Giảm nhiệt độ để AI tập trung vào logic chính xác
                max_tokens: 4000  // Dành đất cho output
            });

            // Làm sạch JSON (phòng trường hợp AI vẫn chat nhảm)
            const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            // Tìm mảng JSON đầu tiên và cuối cùng
            const firstBracket = jsonStr.indexOf('[');
            const lastBracket = jsonStr.lastIndexOf(']');

            if (firstBracket !== -1 && lastBracket !== -1) {
                const cleanJson = jsonStr.substring(firstBracket, lastBracket + 1);
                return JSON.parse(cleanJson);
            }
            return [];

        } catch (error) {
            console.warn("AI Segment Error (Skipping):", error.message);
            return [];
        }
    }
}

module.exports = new FileKnowledgeService();