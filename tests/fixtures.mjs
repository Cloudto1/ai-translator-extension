/** 测试用的 API 配置与样例文本。 */

// 密钥只从环境变量读取，绝不硬编码（.env 已在 .gitignore 中）。
// 未配置时 apiKey 为空，集成测试会自动 skip，而不是静默使用某个固定密钥。
export const API_CONFIG = {
  apiKey: process.env.AIT_API_KEY || '',
  baseUrl: process.env.AIT_BASE_URL || 'https://api.deepseek.com',
  model: process.env.AIT_MODEL || 'deepseek-flash',
  targetLang: 'auto',
  disableThinking: true,
  pageMode: 'replace',
  summaryLength: 'medium',
};

export const EN_ARTICLE = `Artificial intelligence is transforming the way we work and live.

Large language models can now summarize documents, translate between languages, and write code. Researchers say the technology will keep improving rapidly over the next decade, but they also warn about hallucination and privacy risks.

Many companies are experimenting with AI assistants to reduce repetitive work. Early results suggest that productivity improves when people review the model output instead of trusting it blindly.`;

export const ZH_ARTICLE = `人工智能正在改变我们的工作和生活方式。

大语言模型现在可以总结文档、翻译语言以及编写代码。研究人员表示，这项技术在未来十年仍会快速进步，但他们也提醒要注意幻觉和隐私风险。

许多公司正在尝试使用 AI 助手来减少重复性工作。早期结果表明，当人们审查模型输出而不是盲目信任时，生产力会有所提升。`;

export const EN_SEGMENTS = [
  'The quick brown fox jumps over the lazy dog.',
  'Artificial intelligence is transforming the way we work.',
  'Contact us at support@example.com for more information.',
  'The meeting has been postponed until next Tuesday.',
  'Please read the documentation before you start.',
  'Our team released version 2.0 last week.',
  'The price is $19.99 per month.',
  'Heavy rain is expected in the northern region tomorrow.',
  'Click the button below to download the report.',
  'This feature is only available to premium users.',
  'The committee will announce the results in June.',
  'Regular exercise improves both physical and mental health.',
  'The library opens at 9 a.m. and closes at 8 p.m.',
  'We apologize for any inconvenience this may cause.',
  'Subscribe to our newsletter to receive weekly updates.',
];
