const el = (id) => document.getElementById(id);

const generateBtn = el('generateBtn');
const statusEl = el('status');

function renderTags(mappingResult = {}) {
  const wrap = el('mappingTags');
  wrap.innerHTML = '';
  const pairs = [
    ['命中语义', mappingResult.matchedSemantic],
    ['功能语义', mappingResult.functionSemantic],
    ['色彩语义', mappingResult.colorSemantic]
  ];

  pairs.forEach(([name, value]) => {
    if (!value) return;
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = `${name}：${value}`;
    wrap.appendChild(span);
  });
}

async function generate() {
  try {
    statusEl.textContent = '状态：生成中...';
    generateBtn.disabled = true;

    const formData = new FormData();
    const fileInput = el('files');
    [...fileInput.files].forEach((f) => formData.append('files', f));

    [
      'userText', 'baseUrl', 'apiKey', 'model', 'imageModel',
      'promptTemplate', 'mappingMatrix'
    ].forEach((k) => formData.append(k, el(k).value));

    const resp = await fetch('/api/profile', { method: 'POST', body: formData });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || '请求失败');
    }

    el('profileText').textContent = data.profileText || '';
    el('supplement').textContent = data.supplement || '';
    el('conceptPrompt').textContent = data.conceptPrompt || '';
    el('rawResult').textContent = JSON.stringify(data, null, 2);
    renderTags(data.mappingResult);

    if (data.imageUrl) {
      el('conceptImage').src = data.imageUrl;
    }

    statusEl.textContent = '状态：生成成功';
  } catch (err) {
    statusEl.textContent = `状态：失败 - ${err.message}`;
  } finally {
    generateBtn.disabled = false;
  }
}

generateBtn.addEventListener('click', generate);
