// services/FileKnowledgeService.js
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
const crypto = require('crypto');

class FileKnowledgeService {

    constructor() {
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced'
        });
        this.turndownService.use(gfm);

        // Tunable parameters
        this.MAX_CHARS = 4000;       // Kích thước chunk chính
        this.OVERLAP_CHARS = 600;    // Overlap để giữ ngữ cảnh
        this.MIN_CHUNK = 200;        // Nếu đoạn quá ngắn -> bỏ
    }

    async processInput(input) {
        if (input.buffer && input.mimetype) {
            return await this.extractTextFromFile(input);
        } else if (typeof input === 'string' && input.startsWith('http')) {
            return await this.extractTextFromUrl(input);
        }
        throw new Error("Định dạng đầu vào không hợp lệ");
    }

    async extractTextFromUrl(url) {
        try {
            console.log(`🌐 Đang cào dữ liệu từ: ${url}`);
            const { data } = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            const dom = new JSDOM(data, { url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article) return "";

            const markdownContent = this.turndownService.turndown(article.content);
            const fullText = `Nguồn: ${url}\nTiêu đề: ${article.title}\n\n${markdownContent}`;

            // Trả về ~một object chứa text và metadata để downstream chunking
            return {
                text: fullText,
                meta: { source: url, title: article.title }
            };
        } catch (error) {
            console.error("URL Parse Error:", error.message);
            throw new Error("Không thể đọc nội dung từ đường dẫn này.");
        }
    }

    async extractTextFromFile(file) {
        const buffer = file.buffer;
        const mimeType = file.mimetype;

        try {
            if (mimeType === 'application/pdf') {
                const text = await this.processPdf(buffer);
                return { text, meta: { filename: file.originalname, mimeType } };
            } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const markdown = await this.processDocx(buffer);
                return { text: markdown, meta: { filename: file.originalname, mimeType } };
            } else if (mimeType.startsWith('text/')) {
                return { text: buffer.toString('utf-8'), meta: { filename: file.originalname, mimeType } };
            } else if (mimeType.startsWith('image/')) {
                const text = await this.processImage(buffer);
                return { text, meta: { filename: file.originalname, mimeType } };
            }
            return { text: "", meta: { filename: file.originalname, mimeType } };
        } catch (error) {
            console.error("File Parse Error:", error);
            throw new Error("Lỗi đọc file: " + error.message);
        }
    }

    async processDocx(buffer) {
        let finalMarkdown = "";

        try {
            const { value: html } = await mammoth.convertToHtml({ buffer: buffer });
            finalMarkdown += this.turndownService.turndown(html);
        } catch (e) {
            console.warn("Mammoth error:", e.message);
        }

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
                    if (entry.getData().length > 5000) {
                        return await this.processImage(entry.getData());
                    }
                    return "";
                }));

                const validOcr = ocrTexts.filter(t => t && t.trim().length > 10).join("\n\n");
                if (validOcr) {
                    finalMarkdown += `\n\n## [NỘI DUNG TỪ HÌNH ẢNH]\n${validOcr}`;
                }
            }
        } catch (e) {
            console.error("DOCX Image Error:", e.message);
        }

        return finalMarkdown;
    }

    async processPdf(buffer) {
        // Lấy text bằng pdf-parse; nếu ngắn -> báo để có thể cân nhắc OCR trang PDF (nâng cấp)
        const data = await pdf(buffer);
        const txt = (data && data.text) ? data.text.trim() : "";

        // Nếu pdf-parse trả về quá ngắn -> cảnh báo (nên rasterize pages -> OCR). 
        // Ở đây ta trả về txt (có thể rỗng). Bạn có thể nâng cấp thêm bằng pdf2pic / pdf-lib để rasterize -> Tesseract.
        if (!txt || txt.length < 100) {
            console.warn('[PDF] Có vẻ là PDF scan hoặc pdf-parse trả về ít text. Xem xét bật OCR trang PDF (pdf2pic -> tesseract).');
        }

        return txt;
    }

    async processImage(buffer) {
        try {
            const { data: { text } } = await Tesseract.recognize(buffer, 'vie+eng');
            return text;
        } catch (e) {
            console.warn('OCR image lỗi', e.message);
            return "";
        }
    }

    // =============== Chunking cải tiến ===============
    /**
     * Trả về mảng chunks với metadata:
     * [{ chunkId, text, start, end, chunkIndex, sourceMeta }]
     */
    async generateChunksFromText(raw) {
        const rawText = (typeof raw === 'string') ? raw : (raw && raw.text) ? raw.text : '';
        const sourceMeta = (raw && raw.meta) ? raw.meta : {};

        if (!rawText || rawText.trim().length < 50) return [];

        // 1) Pre-clean: remove common headers/footers (số trang, header của site...). Đây là heuristic.
        const cleanedStep1 = this._cleanHeadersFooters(rawText);


        // 1.5) **MỚI:** Loại bỏ base64 và dữ liệu rác
        const cleaned = this._removeNoiseAndGarbage(cleanedStep1);

        // 2) Split by headings / section markers first (nếu có)
        const sectionCandidates = this._splitByHeadings(cleaned);

        // 3) For each candidate, sub-split using sliding window and keep overlap
        const chunks = [];
        let chunkIndex = 0;
        for (const sec of sectionCandidates) {
            const secTrim = sec.trim();
            if (secTrim.length < this.MIN_CHUNK) continue;

            // sliding window
            let start = 0;
            while (start < secTrim.length) {
                const end = Math.min(start + this.MAX_CHARS, secTrim.length);
                const piece = secTrim.slice(start, end).trim();

                if (piece.length >= this.MIN_CHUNK) {
                    const chunkId = this._makeId(sourceMeta.filename || sourceMeta.source || 'text', chunkIndex, start);
                    chunks.push({
                        chunkId,
                        text: piece,
                        start,
                        end,
                        chunkIndex,
                        sourceMeta
                    });
                    chunkIndex++;
                }

                if (end === secTrim.length) break;
                // move window with overlap
                start = Math.max(0, end - this.OVERLAP_CHARS);
            }
        }

        // If nothing produced (edge-case), fallback to hard split
        if (chunks.length === 0 && cleaned.length > 0) {
            for (let i = 0, idx = 0; i < cleaned.length; i += (this.MAX_CHARS - this.OVERLAP_CHARS), idx++) {
                const piece = cleaned.substring(i, Math.min(i + this.MAX_CHARS, cleaned.length)).trim();
                if (piece.length >= this.MIN_CHUNK) {
                    chunks.push({
                        chunkId: this._makeId(sourceMeta.filename || sourceMeta.source || 'text', idx, i),
                        text: piece,
                        start: i,
                        end: Math.min(i + this.MAX_CHARS, cleaned.length),
                        chunkIndex: idx,
                        sourceMeta
                    });
                }
            }
        }

        console.log(`🔹 Tổng độ dài: ${cleaned.length} chars. Chia thành ${chunks.length} phần.`);

        // 4) Call AI per chunk (thực tế nên batch / concurrency limit)
        const allKnowledge = [];
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            console.log(`⏳ Extracing chunk ${i + 1}/${chunks.length}`);
            try {
                const items = await this.processSingleChunkWithAI(c);
                // attach provenance
                (items || []).forEach(it => {
                    it._provenance = {
                        chunkId: c.chunkId,
                        chunkIndex: c.chunkIndex,
                        start: c.start,
                        end: c.end,
                        sourceMeta: c.sourceMeta
                    };
                });
                if (Array.isArray(items) && items.length) allKnowledge.push(...items);
            } catch (e) {
                console.warn('Lỗi AI extract chunk:', e.message);
            }
        }

        // 5) Merge items by entityId/canonicalId (nếu AI trả) + dedupe small items
        const merged = this.mergeKnowledgeItems(allKnowledge);

        return merged;
    }

    _cleanHeadersFooters(text) {
        // Loại bỏ lines kiểu "Page 1 of 10" hoặc "Trang 1/10" hoặc header heavy
        // Giữ lại các regex làm sạch cũ
        return text
            .replace(/\n?Page\s*\d+\s*(of\s*\d+)?\s*\n?/ig, '\n')
            .replace(/\n?Trang\s*\d+\/\d+\s*\n?/ig, '\n')
            .replace(/\r\n/g, '\n')
            .replace(/\t/g, ' ')
            .replace(/[ ]{2,}/g, ' ');
    }

    _removeNoiseAndGarbage(text) {
        // Regex để tìm kiếm các chuỗi base64 dài (thường do hình ảnh/binary không được xử lý)
        // Đây là regex heuristic, tìm chuỗi ít nhất 50 ký tự A-Za-z0-9+/=
        // Lưu ý: Có thể cần điều chỉnh độ dài tối thiểu (50) tùy theo dữ liệu thực tế.
        const base64Regex = /([A-Za-z0-9+/=]{50,})[\s\n]*/g;

        let cleaned = text.replace(base64Regex, (match, p1) => {
            // Chỉ loại bỏ nếu chuỗi không phải là một đoạn code hợp lý (heuristic)
            if (p1.length > 100 && !p1.includes(' ')) {
                console.log(`[Cleaner] Đã loại bỏ chuỗi base64 dài (len: ${p1.length})`);
                return '\n'; // Thay thế bằng xuống dòng để tránh dính liền nội dung
            }
            return match; // Giữ lại nếu là chuỗi ngắn hoặc có vẻ là code
        });

        // Loại bỏ các ký tự điều khiển/ASCII không in được (trừ \n)
        cleaned = cleaned.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

        // Loại bỏ các dòng chỉ chứa ký tự rác/đánh dấu không liên quan
        cleaned = cleaned.split('\n').filter(line => line.trim().length > 3 || line.trim().length === 0).join('\n');

        return cleaned;
    }

    _splitByHeadings(text) {
        // Chia theo các heading markdown (# ), hoặc dòng viết hoa hoặc dòng kết thúc bằng ':' (Tiêu đề:)
        const parts = [];
        // Try split by markdown headings first
        const mdSections = text.split(/\n(?=#+)/);
        if (mdSections.length > 1) return mdSections;

        // If no markdown, split by double newlines but keep lines which look like headings
        const paragraphs = text.split(/\n\s*\n/);
        let current = '';
        for (const p of paragraphs) {
            const trimmed = p.trim();
            const isHeading = /^#{1,6}\s+/.test(trimmed) || /^[A-Z0-9\s\-\,\(\)\/]{10,}$/.test(trimmed) || /:$/i.test(trimmed);
            if (isHeading && current.trim().length > 0) {
                parts.push(current);
                current = trimmed + '\n\n';
            } else {
                current += '\n\n' + trimmed;
            }
        }
        if (current.trim()) parts.push(current);
        return parts;
    }

    _makeId(prefix, idx, pos) {
        return `${prefix}-${idx}-${pos}-${crypto.createHash('md5').update(prefix + idx + pos).digest('hex').slice(0, 6)}`;
    }

    /**
     * Gọi AI xử lý 1 chunk -> trả về mảng tri thức
     * Yêu cầu AI trả về JSON array gồm object có fields:
     * { "entityId": "canonical id or name", "title": "", "content": "", "keywords": [], "type": "entity|fact|table" }
     */
    async processSingleChunkWithAI(chunk) {
        const textSegment = chunk.text;
        const prompt = `
Bạn là một extractor chuyên nghiệp cho tri thức (RAG).
NHIỆM VỤ: Từ đoạn văn bản dưới đây, trích xuất các mẩu tri thức độc lập (nếu có). Mỗi mẩu tri thức nên mô tả 1 "entity" hoặc 1 fact hoàn chỉnh.
YÊU CẦU CHẤT LƯỢNG VÀ HÌNH THỨC:
1) PHẢI TRẢ VỀ **CHỈ** 1 MẢNG JSON (JSON array). KHÔNG NÓI THÊM, KHÔNG GIẢI THÍCH.
2) MỖI MẢNH TRI THỨC PHẢI **BẢO TOÀN Ý NGHĨA và TÍNH CHÍNH XÁC CAO** so với nội dung gốc. Đừng tóm tắt quá ngắn làm mất đi ngữ cảnh quan trọng.
3) NẾU ĐOẠN VĂN BẢN CHỨA DỮ LIỆU RÁC (ví dụ: chuỗi mã hóa base64 dài, mã HTML bị lỗi, ký tự không liên quan, hoặc chỉ là footer/header rỗng) -> **KHÔNG TRÍCH XUẤT** và trả về **[]** (mảng rỗng).
4) Mỗi phần tử trong mảng có định dạng:
   {
     "entityId": "chuỗi định danh tiêu chuẩn (nếu có thể, đặt tên canonical — ví dụ: 'Công ty ABC', hoặc 'Sản phẩm XYZ' — nếu không biết, để rỗng string)",
     "title": "Tiêu đề ngắn tóm tắt mẩu tri thức",
     "content": "Nội dung chi tiết (1-4 câu) mô tả mẩu tri thức này. PHẢI ĐỦ Ý, không bao gồm thông tin thừa như số trang, header, footer.",
     "keywords": ["từ khóa 1", "từ khóa 2"],
     "type": "entity" | "fact" | "table",
     "confidence": 0.0  // Giá trị 0..1 do model estimate (tùy chọn)
   }

5) Nếu thấy bảng (table), cố gắng chuyển sang JSON hoặc mô tả bảng bằng list.
6) Nếu thông tin thuộc cùng 1 entity xuất hiện nhiều chunk, đảm bảo entityId nhất quán (đặt canonical name).

INPUT:
"""
${textSegment}
"""

OUTPUT: (ví dụ)
[
  { "entityId": "Công ty ABC", "title": "Mô tả công ty ABC", "content": "Công ty ABC là ...", "keywords": ["ABC","công ty"], "type":"entity", "confidence":0.9 }
]
`;

        try {
            const aiResponse = await deepseekService.chat([
                { role: 'system', content: 'Strict JSON Output Agent.' },
                { role: 'user', content: prompt }
            ], {
                temperature: 0.0,
                max_tokens: 1500
            });

            // aiResponse có thể là string hoặc object; chuẩn hóa thành string
            const raw = (typeof aiResponse === 'string') ? aiResponse : (aiResponse && aiResponse.content) ? aiResponse.content : JSON.stringify(aiResponse);

            const jsonStr = this._extractFirstJsonArray(raw);
            if (!jsonStr) return [];
            const parsed = JSON.parse(jsonStr);

            // Ensure each item has minimal fields
            return parsed.map(item => ({
                entityId: (item.entityId || item.title || '').toString().trim(),
                title: (item.title || '').toString().trim(),
                content: (item.content || '').toString().trim(),
                keywords: Array.isArray(item.keywords) ? item.keywords.map(k => k.toString()) : [],
                type: item.type || 'fact',
                confidence: (typeof item.confidence === 'number') ? item.confidence : 0.8
            }));

        } catch (error) {
            console.warn("AI Segment Error (Skipping):", error.message);
            return [];
        }
    }

    _extractFirstJsonArray(s) {
        // Tìm dấu '[' đầu tiên và ']' tương ứng cân bằng
        const first = s.indexOf('[');
        if (first === -1) return null;
        let depth = 0;
        for (let i = first; i < s.length; i++) {
            if (s[i] === '[') depth++;
            else if (s[i] === ']') {
                depth--;
                if (depth === 0) {
                    return s.substring(first, i + 1);
                }
            }
        }
        return null;
    }

    /**
     * Merge knowledge items:
     * - Nếu entityId tồn tại -> group và concat content, merge keywords, keep best title/confidence
     * - Nếu không -> giữ nguyên (có thể later dùng embedding clustering)
     */
    mergeKnowledgeItems(items) {
        if (!Array.isArray(items) || items.length === 0) return [];

        const byEntity = new Map();
        const noEntity = [];

        for (const it of items) {
            const id = (it.entityId || '').trim();
            if (id) {
                const key = id.toLowerCase();
                if (!byEntity.has(key)) {
                    byEntity.set(key, { entityId: it.entityId, title: it.title || '', content: it.content || '', keywords: new Set(it.keywords || []), type: it.type || 'entity', confidence: it.confidence || 0 });
                } else {
                    const cur = byEntity.get(key);
                    // concat content with separation and dedupe small duplicates
                    if (!cur.content.includes(it.content)) {
                        cur.content = cur.content + "\n\n" + it.content;
                    }
                    it.keywords && it.keywords.forEach(k => cur.keywords.add(k));
                    if ((it.title || '').length > (cur.title || '').length) cur.title = it.title;
                    cur.confidence = Math.max(cur.confidence, it.confidence || 0);
                }
            } else {
                noEntity.push(it);
            }
        }

        const merged = [];
        for (const [k, v] of byEntity.entries()) {
            merged.push({
                entityId: v.entityId,
                title: v.title,
                content: v.content,
                keywords: Array.from(v.keywords),
                type: v.type,
                confidence: v.confidence
            });
        }

        // append the noEntity items (optionally de-duplicate by content)
        // Simple dedupe: remove items whose content is contained by merged entity content
        for (const it of noEntity) {
            const dup = merged.find(m => m.content && it.content && m.content.includes(it.content));
            if (!dup) merged.push(it);
        }

        return merged;
    }
}

module.exports = new FileKnowledgeService();
