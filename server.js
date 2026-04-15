const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const DEFAULT_MATRIX = {
  高级感: {
    功能语义: { 智能: 0.93, 自动化: 0.81, 精准控制: 0.77 },
    色彩语义: { 黑白: 0.95, 深灰: 0.82, 金属银: 0.74 }
  },
  年轻活力: {
    功能语义: { 社交互动: 0.86, 游戏化: 0.73, 便携: 0.69 },
    色彩语义: { 明黄: 0.84, 湖蓝: 0.8, 霓虹渐变: 0.78 }
  },
  治愈温暖: {
    功能语义: { 轻提醒: 0.75, 情绪反馈: 0.81, 个性化陪伴: 0.88 },
    色彩语义: { 奶油白: 0.83, 暖粉: 0.8, 木质棕: 0.71 }
  }
};

async function extractTextFromFile(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return file.buffer.toString('utf8');
  }

  if (name.endsWith('.json')) {
    const jsonObj = JSON.parse(file.buffer.toString('utf8'));
    return JSON.stringify(jsonObj, null, 2);
  }

  if (name.endsWith('.csv')) {
    const records = parse(file.buffer, { columns: true, skip_empty_lines: true });
    return JSON.stringify(records, null, 2);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return JSON.stringify(json, null, 2);
  }

  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (name.endsWith('.pdf')) {
    const result = await pdfParse(file.buffer);
    return result.text;
  }

  return `不支持的文件类型：${file.originalname}`;
}

async function callChatCompletion(apiConfig, messages, temperature = 0.4) {
  const baseUrl = (apiConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = apiConfig.model || 'gpt-4o-mini';

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`聊天模型调用失败(${resp.status})：${text}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

function findTopValue(categoryObj = {}) {
  let bestKey = '';
  let bestScore = -Infinity;
  for (const [k, v] of Object.entries(categoryObj)) {
    if (v > bestScore) {
      bestKey = k;
      bestScore = v;
    }
  }
  return { bestKey, bestScore };
}

function pickSemanticByKeyword(profileText, matrix) {
  const profile = profileText || '';
  for (const semantic of Object.keys(matrix)) {
    if (profile.includes(semantic)) {
      const semanticConfig = matrix[semantic] || {};
      const functionTop = findTopValue(semanticConfig['功能语义'] || {});
      const colorTop = findTopValue(semanticConfig['色彩语义'] || {});
      return {
        matchedSemantic: semantic,
        functionSemantic: functionTop.bestKey,
        colorSemantic: colorTop.bestKey,
        rule: `命中用户语义「${semantic}」，功能语义最高关联为「${functionTop.bestKey}」，色彩语义最高关联为「${colorTop.bestKey}」。`
      };
    }
  }

  const firstSemantic = Object.keys(matrix)[0] || '高级感';
  const semanticConfig = matrix[firstSemantic] || {};
  const functionTop = findTopValue(semanticConfig['功能语义'] || {});
  const colorTop = findTopValue(semanticConfig['色彩语义'] || {});

  return {
    matchedSemantic: firstSemantic,
    functionSemantic: functionTop.bestKey,
    colorSemantic: colorTop.bestKey,
    rule: `未命中关键词，默认采用「${firstSemantic}」映射规则。`
  };
}

async function callImageGeneration(apiConfig, prompt) {
  const baseUrl = (apiConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const imageModel = apiConfig.imageModel || 'gpt-image-1';

  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`
    },
    body: JSON.stringify({ model: imageModel, prompt, size: '1024x1024' })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`图像模型调用失败(${resp.status})：${text}`);
  }

  const data = await resp.json();
  const item = data.data?.[0];
  if (!item) {
    throw new Error('图像生成返回为空');
  }

  if (item.url) {
    return item.url;
  }

  if (item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  }

  throw new Error('图像结果既无 URL 也无 b64_json');
}

app.post('/api/profile', upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files || [];
    const userText = req.body.userText || '';
    const promptTemplate = req.body.promptTemplate ||
      '你是资深用户研究专家。请根据输入内容生成一份结构化用户画像，包含：角色名称、核心标签、动机、行为偏好、痛点、购买决策因素、风格倾向（如高级感/年轻活力）。';

    const apiConfig = {
      baseUrl: req.body.baseUrl,
      apiKey: req.body.apiKey,
      model: req.body.model,
      imageModel: req.body.imageModel
    };

    if (!apiConfig.apiKey) {
      return res.status(400).json({ error: '缺少 API Key，请在网页中填写。' });
    }

    let mappingMatrix = DEFAULT_MATRIX;
    if (req.body.mappingMatrix) {
      mappingMatrix = JSON.parse(req.body.mappingMatrix);
    }

    const fileTexts = await Promise.all(files.map(extractTextFromFile));
    const mergedInput = [userText, ...fileTexts].filter(Boolean).join('\n\n---\n\n');

    if (!mergedInput.trim()) {
      return res.status(400).json({ error: '请输入文本或上传文件。' });
    }

    const profileText = await callChatCompletion(apiConfig, [
      { role: 'system', content: promptTemplate },
      { role: 'user', content: `原始用户数据：\n${mergedInput}` }
    ]);

    const mappingResult = pickSemanticByKeyword(profileText, mappingMatrix);

    const supplement = await callChatCompletion(apiConfig, [
      {
        role: 'system',
        content: '你是设计策略顾问。请根据给定语义映射，输出一句简短中文补充句，格式类似：产品有智能的控制面，整体颜色采用黑白。只输出这一句话。'
      },
      {
        role: 'user',
        content: `用户画像：${profileText}\n命中用户语义：${mappingResult.matchedSemantic}\n功能语义：${mappingResult.functionSemantic}\n色彩语义：${mappingResult.colorSemantic}`
      }
    ], 0.3);

    const enrichedPrompt = `${profileText}\n\n设计语义补充：${supplement}`;

    const conceptPrompt = await callChatCompletion(apiConfig, [
      {
        role: 'system',
        content: '你是产品概念图提示词工程师。请把输入内容改写为图像生成提示词，突出产品外观、材质、灯光、色彩、交互细节。输出中文和英文混合的 120~180 字提示词。'
      },
      { role: 'user', content: enrichedPrompt }
    ], 0.5);

    const imageUrl = await callImageGeneration(apiConfig, conceptPrompt);

    res.json({
      profileText,
      mappingResult,
      supplement,
      enrichedPrompt,
      conceptPrompt,
      imageUrl,
      sourceStats: {
        fileCount: files.length,
        charCount: mergedInput.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message || '生成失败' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'nexus-ai-local' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`NEXUS AI Local server running at http://localhost:${port}`);
});
