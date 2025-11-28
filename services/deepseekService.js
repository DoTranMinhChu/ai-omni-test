const axios = require('axios');

class DeepseekService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.deepseek.com/v1';
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async chat(messages, input = {
    temperature: 0.7, max_tokens: 2000
  }) {
    if (input.max_tokens > 8000) {
      input.max_tokens = 8000;
    }
    try {
      const response = await this.client.post('/chat/completions', {
        ...input,
        model: 'deepseek-chat',
        messages: messages,
        stream: false
      });

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('Deepseek API Error:', error.response?.data || error.message);
      throw new Error(`Deepseek API call failed: ${error.message}`);
    }
  }
}

module.exports = DeepseekService;