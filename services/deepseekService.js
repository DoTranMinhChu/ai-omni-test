const axios = require('axios');

class DeepseekService {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.deepseek.com/v1';

    // Cấu hình giá (USD per 1M tokens) - giá mặc định của Deepseek
    this.pricing = {
      input: options.inputPricePerMillion || 0.14,   // $0.14 per 1M input tokens
      output: options.outputPricePerMillion || 0.28, // $0.28 per 1M output tokens
      ...options.pricing
    };

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Ước tính số token từ text (xấp xỉ)
   * Có thể thay thế bằng tokenizer chính xác nếu có
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    // Ước tính: 1 token ≈ 4 ký tự tiếng Anh, 1.3 token cho tiếng Việt
    // Đây là ước lượng gần đúng, không chính xác 100%
    const charCount = text.length;
    const wordCount = text.split(/\s+/).length;

    // Ước lượng token dựa trên cả số ký tự và số từ
    // Có thể điều chỉnh hệ số cho phù hợp
    const estimatedByChars = Math.ceil(charCount / 3.5); // Tiếng Việt/không phải tiếng Anh
    const estimatedByWords = Math.ceil(wordCount * 1.5);

    return Math.max(estimatedByChars, estimatedByWords);
  }

  /**
   * Ước tính token cho toàn bộ messages
   */
  estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;

    let totalTokens = 0;

    // Format mặc định cho system prompt
    const systemPrompt = `You are a helpful AI assistant. Current date: ${new Date().toISOString().split('T')[0]}`;
    totalTokens += this.estimateTokens(systemPrompt);

    // Tính token cho từng message
    messages.forEach(message => {
      if (message.content) {
        totalTokens += this.estimateTokens(message.content);
      }
      // Thêm token cho role và format
      totalTokens += 5; // Ước lượng cho role và formatting
    });

    // Thêm token cho các trường metadata
    totalTokens += 20; // Ước lượng cho các trường khác trong request

    return totalTokens;
  }

  /**
   * Tính chi phí dựa trên số token
   */
  calculateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * this.pricing.input;
    const outputCost = (outputTokens / 1000000) * this.pricing.output;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: inputCost + outputCost,
      costVND: (inputCost + outputCost) * 24000, // Giả định tỷ giá 1 USD = 24,000 VND
      breakdown: {
        inputCostUSD: inputCost,
        outputCostUSD: outputCost,
        inputPricePerMillion: this.pricing.input,
        outputPricePerMillion: this.pricing.output
      }
    };
  }

  async chat(messages, input = {
    temperature: 0.7,
    max_tokens: 2000
  }) {
    if (input.max_tokens > 8000) {
      input.max_tokens = 8000;
    }

    // Ước tính token input trước khi gọi API
    const estimatedInputTokens = this.estimateMessagesTokens(messages);
    let estimatedOutputTokens = Math.min(input.max_tokens || 2000, 8000);

    console.log(`📊 Token ước tính: Input=${estimatedInputTokens}, Output tối đa=${estimatedOutputTokens}`);

    try {
      const startTime = Date.now();
      const response = await this.client.post('/chat/completions', {
        ...input,
        model: 'deepseek-chat',
        messages: messages,
        stream: false
      });

      const endTime = Date.now();
      const responseTime = endTime - startTime;

      const content = response.data.choices[0].message.content;
      const actualOutputTokens = this.estimateTokens(content);

      // Sử dụng usage từ API nếu có (chính xác hơn)
      const apiUsage = response.data.usage;
      let actualInputTokens = estimatedInputTokens;
      let actualOutputTokensFinal = actualOutputTokens;

      if (apiUsage) {
        actualInputTokens = apiUsage.prompt_tokens;
        actualOutputTokensFinal = apiUsage.completion_tokens;
        console.log(`✅ Token thực tế từ API: Input=${actualInputTokens}, Output=${actualOutputTokensFinal}`);
      }

      // Tính chi phí
      const costInfo = this.calculateCost(actualInputTokens, actualOutputTokensFinal);

      // Log thông tin
      console.log('📈 Thông tin chi phí:');
      console.log(`   - Tổng token: ${costInfo.totalTokens}`);
      console.log(`   - Chi phí: $${costInfo.costUSD.toFixed(6)} (${costInfo.costVND.toFixed(2)} VND)`);
      console.log(`   - Thời gian phản hồi: ${responseTime}ms`);
   
      return content;
      // return {
      //   content: content,
      //   usage: {
      //     inputTokens: actualInputTokens,
      //     outputTokens: actualOutputTokensFinal,
      //     totalTokens: costInfo.totalTokens
      //   },
      //   cost: costInfo,
      //   responseTime: responseTime,
      //   rawResponse: response.data
      // };

    } catch (error) {
      console.error('❌ Deepseek API Error:', error.response?.data || error.message);

      // Vẫn trả về ước tính token cho lỗi (nếu có)
      const errorCostInfo = this.calculateCost(estimatedInputTokens, 0);
      console.log(`⚠️  Ước tính chi phí cho request thất bại: $${errorCostInfo.costUSD.toFixed(6)}`);

      throw new Error(`Deepseek API call failed: ${error.message}`);
    }
  }

  /**
   * Tính tổng chi phí cho nhiều requests
   */
  calculateTotalCost(requests) {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUSD = 0;

    requests.forEach(req => {
      totalInputTokens += req.usage?.inputTokens || 0;
      totalOutputTokens += req.usage?.outputTokens || 0;
      totalCostUSD += req.cost?.costUSD || 0;
    });

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUSD,
      totalCostVND: totalCostUSD * 24000,
      numberOfRequests: requests.length
    };
  }
}

// Ví dụ sử dụng:
const deepseekService = new DeepseekService(process.env.DEEPSEEK_API_KEY);

// Hoặc với cấu hình giá tùy chỉnh:
// const deepseekService = new DeepseekService(process.env.DEEPSEEK_API_KEY, {
//   inputPricePerMillion: 0.14,
//   outputPricePerMillion: 0.28
// });

// Ví dụ gọi API và tracking
async function exampleUsage() {
  try {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Xin chào, bạn có thể giúp tôi giải thích về AI không?' }
    ];

    const result = await deepseekService.chat(messages, {
      temperature: 0.7,
      max_tokens: 1000
    });

    console.log('Kết quả:', result.content.substring(0, 100) + '...');
    console.log('Token sử dụng:', result.usage);
    console.log('Chi phí:', result.cost.costUSD.toFixed(6), 'USD');

  } catch (error) {
    console.error('Lỗi:', error);
  }
}

// Nếu muốn tính tổng chi phí cho nhiều requests
function trackMultipleRequests() {
  const requests = []; // Lưu trữ các kết quả từ nhiều requests

  // Sau mỗi request, thêm vào mảng
  // requests.push(result);

  // Tính tổng
  // const summary = deepseekService.calculateTotalCost(requests);
  // console.log('Tổng kết:', summary);
}

module.exports = deepseekService;