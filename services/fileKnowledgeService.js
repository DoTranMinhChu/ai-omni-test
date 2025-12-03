const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const AdmZip = require('adm-zip'); // Thư viện mới để giải nén file docx
const deepseekService = require('./deepseekService');

class FileKnowledgeService {

    // 1. Hàm đọc nội dung thô từ file (Đã nâng cấp)
    async extractTextFromFile(file) {
        const buffer = file.buffer;
        const mimeType = file.mimetype;

        try {
            // --- XỬ LÝ PDF ---
            if (mimeType === 'application/pdf') {
                const data = await pdf(buffer);
                return data.text;
            }
            // --- XỬ LÝ WORD (DOCX) - NÂNG CẤP OCR ---
            else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                return await this.processDocxWithImages(buffer);
            }
            // --- XỬ LÝ FILE TEXT ---
            else if (mimeType.startsWith('text/')) {
                return buffer.toString('utf-8');
            }
            // --- XỬ LÝ ẢNH ĐƠN LẺ ---
            else if (mimeType.startsWith('image/')) {
                const { data: { text } } = await Tesseract.recognize(buffer, 'vie+eng');
                return text;
            }
            return "";
        } catch (error) {
            console.error("File Parse Error:", error);
            throw new Error("Không thể đọc định dạng file này: " + error.message);
        }
    }

    /**
     * Hàm chuyên biệt xử lý DOCX:
     * 1. Lấy text thuần bằng mammoth
     * 2. Giải nén lấy ảnh bên trong
     * 3. OCR ảnh bằng Tesseract
     */
    async processDocxWithImages(buffer) {
        let finalContent = "";

        // B1: Lấy văn bản thuần (Text)
        try {
            const result = await mammoth.extractRawText({ buffer: buffer });
            finalContent += result.value + "\n\n";
        } catch (e) {
            console.warn("Mammoth text extract warning:", e.message);
        }

        // B2: Trích xuất hình ảnh từ file DOCX (vì docx là file zip)
        try {
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries(); // Lấy danh sách file bên trong

            // Lọc ra các file ảnh trong thư mục word/media/
            const imageEntries = zipEntries.filter(entry =>
                entry.entryName.startsWith('word/media/') &&
                /\.(png|jpg|jpeg|bmp)$/i.test(entry.name)
            );

            if (imageEntries.length > 0) {
                console.log(`📸 Tìm thấy ${imageEntries.length} ảnh trong file DOCX. Đang thực hiện OCR...`);

                finalContent += "\n--- [NỘI DUNG TRÍCH XUẤT TỪ HÌNH ẢNH TRONG FILE] ---\n";

                // Chạy OCR cho từng ảnh (Promise.all để chạy song song)
                const ocrPromises = imageEntries.map(async (entry) => {
                    const imgBuffer = entry.getData();
                    try {
                        // Sử dụng ngôn ngữ Việt + Anh
                        const { data: { text } } = await Tesseract.recognize(imgBuffer, 'vie+eng');
                        // Lọc bớt các ký tự rác nếu ảnh quá nhỏ hoặc icon
                        if (text.trim().length > 5) {
                            return text.trim();
                        }
                    } catch (err) {
                        console.error(`Lỗi OCR ảnh ${entry.name}:`, err.message);
                    }
                    return "";
                });

                const ocrResults = await Promise.all(ocrPromises);

                // Gộp kết quả
                finalContent += ocrResults.filter(t => t).join("\n\n");
            }

        } catch (e) {
            console.error("Lỗi khi xử lý ảnh trong DOCX:", e.message);
        }

        return finalContent;
    }

    // 2. Hàm dùng AI để chia nhỏ và tạo Knowledge Chunks
    async generateChunksFromText(rawText) {
        if (!rawText || rawText.trim().length < 20) return [];

        // Giới hạn độ dài text gửi đi (tăng lên chút để chứa nội dung ảnh)
        const truncatedText = rawText.substring(0, 20000);

        const prompt = `
        Tôi có một văn bản thô (được trích xuất từ file tài liệu gồm cả văn bản và nội dung quét từ hình ảnh). 
        Nhiệm vụ của bạn là:
        1. Làm sạch văn bản: Loại bỏ các ký tự rác do lỗi OCR (nếu có).
        2. Phân tích nội dung và chia nó thành các "Mẩu tri thức" (Knowledge Chunks) ngắn gọn, độc lập, có ý nghĩa.
        3. Mỗi mẩu tri thức phải có nội dung rõ ràng và các từ khóa liên quan.
        4. TRẢ VỀ KẾT QUẢ DẠNG JSON MẢNG (Array of Objects).

        Cấu trúc JSON bắt buộc:
        [
            { "content": "Nội dung kiến thức...", "keywords": ["từ khóa 1", "từ khóa 2"] },
            { "content": "Nội dung kiến thức...", "keywords": [...] }
        ]

        VĂN BẢN THÔ:
        ${truncatedText}
        `;

        try {
            const aiResponse = await deepseekService.chat([
                { role: 'system', content: 'Bạn là chuyên gia xử lý dữ liệu RAG và làm sạch dữ liệu OCR.' },
                { role: 'user', content: prompt }
            ]);

            const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const chunks = JSON.parse(jsonStr);

            return Array.isArray(chunks) ? chunks : [];
        } catch (error) {
            console.error("AI Chunking Error:", error);
            return [{ content: truncatedText.substring(0, 500) + "...", keywords: ["file_upload_error"] }];
        }
    }
}

module.exports = new FileKnowledgeService();