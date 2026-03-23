// ── Elements ──────────────────────────────────────────────────────
const promptInput = document.getElementById('promptInput');
const runBtn      = document.getElementById('runBtn');
const stopBtn     = document.getElementById('stopBtn');
const statusBanner = document.getElementById('statusBanner');
const modeSwitch  = document.getElementById('mode-switch');
const modeLabel   = document.getElementById('mode-label');
const gridView    = document.getElementById('gridView');
const timelineView = document.getElementById('timelineView');
const timelineItems = document.getElementById('timelineItems');
const attachBtn    = document.getElementById('attachBtn');
const fileInput    = document.getElementById('fileInput');
const fileChip     = document.getElementById('fileChip');
const fileChipName = document.getElementById('fileChipName');
const fileChipRemove = document.getElementById('fileChipRemove');
const micBtn         = document.getElementById('micBtn');
const promptContainer = document.querySelector('.prompt-container');

const panels = {
  chatgpt: {
    el:   document.getElementById('panelChatgpt'),
    body: document.getElementById('bodyChatgpt'),
    meta: document.getElementById('metaChatgpt'),
  },
  gemini: {
    el:   document.getElementById('panelGemini'),
    body: document.getElementById('bodyGemini'),
    meta: document.getElementById('metaGemini'),
  },
};

// ── State ─────────────────────────────────────────────────────────
let isRunning = false;
let extensionReady = false;
let currentMode = 'parallel'; // 'parallel' | 'debate'
let pendingRequests = {};
let selectedFile = null; // { name, type, size, dataUrl }

// ── Web Speech API ────────────────────────────────────────────────
let recognition = null;
let isRecording = false;
let originalPrompt = '';

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('recording');
    originalPrompt = promptInput.value;
    if (originalPrompt && !originalPrompt.endsWith(' ') && !originalPrompt.endsWith('\n')) {
      originalPrompt += ' ';
    }
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    promptInput.value = originalPrompt + transcript;
    promptInput.dispatchEvent(new Event('input'));
  };

  recognition.onerror = (e) => {
    console.warn("Speech recognition error:", e.error);
    isRecording = false;
    micBtn.classList.remove('recording');
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove('recording');
  };
} else {
  micBtn.style.display = 'none';
  micBtn.title = "Voice typing is not supported in this browser";
}

document.addEventListener('DOMContentLoaded', () => {
  micBtn.addEventListener('click', () => {
    if (!recognition) return alert('Speech Recognition not supported in this browser.');
    if (isRecording) {
      recognition.stop();
    } else {
      recognition.start();
    }
  });

  runBtn.addEventListener('click', handleRun);
  stopBtn.addEventListener('click', handleStop);
  promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRun();
    }
  });

  // ── File Attach Wiring ────────────────────────────────────────
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (file) await handleFileSelected(file);
    fileInput.value = '';
  });

  fileChipRemove.addEventListener('click', () => clearFile());

  promptContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    promptContainer.classList.add('drag-over');
  });
  promptContainer.addEventListener('dragleave', () => {
    promptContainer.classList.remove('drag-over');
  });
  promptContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    promptContainer.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await handleFileSelected(file);
  });

  // Mode Switcher
  modeSwitch.addEventListener('change', (e) => {
    currentMode = e.target.checked ? 'debate' : 'parallel';
    modeLabel.textContent = currentMode === 'debate' ? 'Debate Mode' : 'Parallel Compare';
    
    if (currentMode === 'debate') {
      gridView.classList.add('hidden');
      timelineView.classList.remove('hidden');
      runBtn.querySelector('.run-btn-text').textContent = 'Start Debate';
    } else {
      gridView.classList.remove('hidden');
      timelineView.classList.add('hidden');
      runBtn.querySelector('.run-btn-text').textContent = 'Run Comparison';
    }
  });

  // Listen for extension responses
  window.addEventListener('ai-compare-response', (e) => {
    const { requestId, results } = e.detail;
    if (pendingRequests[requestId]) {
      pendingRequests[requestId](results);
      delete pendingRequests[requestId];
    }
  });

  // Check if extension is ready
  window.addEventListener('ai-compare-ready', () => {
    extensionReady = true;
    if (statusBanner) statusBanner.style.display = 'none';
  });

  // Give the content script a moment to load
  setTimeout(() => {
    if (!extensionReady && statusBanner) {
      statusBanner.style.display = 'flex';
    }
  }, 1500);
});

async function handleRun() {
  if (currentMode === 'debate') {
    await runDebate();
  } else {
    await runParallelComparison();
  }
}

// ── Send prompt via extension ─────────────────────────────────────
function sendViaExtension(action, payload) {
  return new Promise((resolve) => {
    const requestId = Date.now().toString() + Math.random().toString(36).slice(2);
    pendingRequests[requestId] = resolve;

    window.dispatchEvent(new CustomEvent('ai-compare-request', {
      detail: { action, payload, requestId },
    }));

    // Timeout fallback (10 minutes)
    setTimeout(() => {
      if (pendingRequests[requestId]) {
        pendingRequests[requestId]({ error: 'Timeout — no response from extension' });
        delete pendingRequests[requestId];
      }
    }, 600000);
  });
}

// ── Run Parallel Comparison (Original) ────────────────────────────
async function runParallelComparison() {
  const prompt = promptInput.value.trim();
  if (!prompt || isRunning) return;

  if (!checkExtension()) return;

  isRunning = true;
  setBtnLoading(true);

  // Set both panels to loading
  for (const [, panel] of Object.entries(panels)) {
    setLoading(panel);
  }

  try {
    const results = await sendViaExtension('runComparison', { prompt, fileData: selectedFile });

    for (const [name, result] of Object.entries(results)) {
      const panel = panels[name];
      if (!panel) continue;

      if (result.success) {
        setResponse(panel, result.response, result.duration, result.responseHtml);
      } else {
        setError(panel, result.error);
      }
    }
  } catch (err) {
    for (const [, panel] of Object.entries(panels)) {
      setError(panel, `Error: ${err.message}`);
    }
  }

  isRunning = false;
  setBtnLoading(false);
}

// ── Run Debate (New) ──────────────────────────────────────────────
async function runDebate() {
  const prompt = promptInput.value.trim();
  if (!prompt || isRunning) return;

  if (!checkExtension()) return;
  
  // Clear timeline for new debate
  timelineItems.innerHTML = '';
  addTimelineItem('user', 'User', prompt);

  isRunning = true;
  setBtnLoading(true);

  // Streaming Listener
  const handleTurn = (e) => {
    const { type, agent, response, responseHtml, round, score, message, error } = e.detail;
    
    if (type === 'status') {
      runBtn.querySelector('.run-btn-text').textContent = message;
    } 
    else if (type === 'turn') {
      const name = agent === 'chatgpt' ? 'ChatGPT' : 'Gemini';
      const badge = `Round ${round}`;
      if (response) {
        addTimelineItem(agent, name, response, badge, score, responseHtml);
      } else if (error) {
        addTimelineItem(agent, name, `Error: ${error}`, badge);
      }
    }
  };

  window.addEventListener('ai-compare-debate-turn', handleTurn);

  try {
    // Start the long-running process
    const result = await sendViaExtension('startDebate', { prompt, fileData: selectedFile });
    
    if (!result.success) {
      addTimelineItem('system', 'System', `Debate stopped: ${result.error}`);
    } else {
      if (result.consensus) {
         addTimelineItem('system', 'System', 'Consensus Reached! The last responses represent the agreed conclusion.');
      } else {
         addTimelineItem('system', 'System', 'Debate finished (Max rounds reached).');
      }
    }

  } catch (err) {
    addTimelineItem('system', 'System', `Error executing debate: ${err.message}`);
  } finally {
    window.removeEventListener('ai-compare-debate-turn', handleTurn);
    isRunning = false;
    setBtnLoading(false);
  }
}


// ── File Helpers ──────────────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

async function handleFileSelected(file) {
  if (!ALLOWED_TYPES.includes(file.type) && !file.type.startsWith('image/')) {
    alert('Unsupported file type. Please attach an image or PDF.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 25 MB.`);
    return;
  }
  const dataUrl = await readFileAsDataURL(file);
  selectedFile = { name: file.name, type: file.type, size: file.size, dataUrl };
  fileChipName.textContent = file.name;
  fileChip.classList.remove('hidden');
  attachBtn.classList.add('has-file');
}

function clearFile() {
  selectedFile = null;
  fileChip.classList.add('hidden');
  fileChipName.textContent = '';
  attachBtn.classList.remove('has-file');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ── Helpers ───────────────────────────────────────────────────────
function checkExtension() {
  if (!extensionReady) {
    alert('AI Compare extension not detected.\n\n1. Go to chrome://extensions\n2. Enable Developer Mode\n3. Click "Load unpacked" and select the extension/ folder');
    return false;
  }
  return true;
}

function setBtnLoading(loading) {
  runBtn.disabled = loading;
  if (loading) {
    runBtn.classList.add('loading');
    runBtn.querySelector('.run-btn-text').textContent = 'Running...';
    // Show stop button only in debate mode
    if (currentMode === 'debate') {
        stopBtn.classList.remove('hidden');
    }
  } else {
    runBtn.classList.remove('loading');
    runBtn.querySelector('.run-btn-text').textContent = currentMode === 'debate' ? 'Start Debate' : 'Run Comparison';
    stopBtn.classList.add('hidden');
  }
}

async function handleStop() {
    if (!isRunning) return;
    try {
        await sendViaExtension('stopDebate', {});
        // The background script will stop and the final block in runDebate will fire,
        // eventually setting isRunning = false in the finally block of runDebate()
    } catch (e) {
        console.error("Failed to stop debate:", e);
    }
}

function setLoading(panel) {
  panel.body.innerHTML = `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <div class="loading-text">Waiting for response…</div>
    </div>
  `;
  panel.meta.textContent = '';
}

function setError(panel, message) {
  panel.body.innerHTML = `
    <div class="error-container">
      <div class="error-icon">⚠</div>
      <div class="error-message">${escapeHtml(message)}</div>
    </div>
  `;
  panel.meta.textContent = 'Error';
  panel.meta.style.color = '#ef4444';
}

function setResponse(panel, text, durationMs, rawHtml = null) {
  let html;
  if (rawHtml) {
    // Direct HTML from the AI (e.g. Gemini) — preserves math rendering
    html = `<div class="response-content">${rawHtml}</div>`;
  } else {
    // Markdown text (e.g. ChatGPT) — render through marked + KaTeX
    html = `<div class="response-content">${renderLatex(marked.parse(text, { breaks: true, gfm: true }))}</div>`;
  }
  panel.body.innerHTML = html;
  const duration = (durationMs / 1000).toFixed(1);
  panel.meta.textContent = `${duration}s`;
  panel.meta.style.color = '';
}

function addTimelineItem(type, name, content, badgeText = '', score = null, rawHtml = null) {
  const item = document.createElement('div');
  item.className = `timeline-item ${type}`;
  
  let badgesHtml = '';
  if (badgeText) {
      badgesHtml += `<span class="agreement-badge med">${badgeText}</span>`;
  }
  if (score !== null && score > 0) {
      const scoreClass = score >= 8 ? 'high' : (score >= 5 ? 'med' : 'low');
      badgesHtml += `<span class="agreement-badge ${scoreClass}">Score: ${score}/10</span>`;
  }

  const headerHtml = `
    <div class="timeline-header">
      <span>${name}</span>
      ${badgesHtml}
    </div>
  `;
  
  const displayHtml = rawHtml ? rawHtml : renderLatex(marked.parse(content, { breaks: true, gfm: true }));
  item.innerHTML = headerHtml + `<div class="response-content">${displayHtml}</div>`;
  
  timelineItems.appendChild(item);
  item.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── LaTeX Rendering ──────────────────────────────────────────────
function renderLatex(html) {
  if (typeof katex === 'undefined') return html;

  // Display math: $$ ... $$ or \[ ... \]
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
    catch (e) { return match; }
  });
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (match, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
    catch (e) { return match; }
  });

  // Inline math: \( ... \) or $ ... $ (single, not double)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (match, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
    catch (e) { return match; }
  });
  html = html.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, tex) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
    catch (e) { return match; }
  });

  return html;
}
