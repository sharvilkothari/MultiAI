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
document.addEventListener('DOMContentLoaded', () => {
  runBtn.addEventListener('click', handleRun);
  stopBtn.addEventListener('click', handleStop);
  promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRun();
    }
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
    const results = await sendViaExtension('runComparison', { prompt });

    for (const [name, result] of Object.entries(results)) {
      const panel = panels[name];
      if (!panel) continue;

      if (result.success) {
        setResponse(panel, result.response, result.duration);
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
    const { type, agent, response, round, score, message, error } = e.detail;
    
    if (type === 'status') {
      runBtn.querySelector('.run-btn-text').textContent = message;
    } 
    else if (type === 'turn') {
      const name = agent === 'chatgpt' ? 'ChatGPT' : 'Gemini';
      const badge = `Round ${round}`;
      if (response) {
        addTimelineItem(agent, name, response, badge, score);
      } else if (error) {
        addTimelineItem(agent, name, `Error: ${error}`, badge);
      }
    }
  };

  window.addEventListener('ai-compare-debate-turn', handleTurn);

  try {
    // Start the long-running process
    const result = await sendViaExtension('startDebate', { prompt });
    
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
    runBtn.querySelector('.run-btn-icon').textContent = '⟳';
    runBtn.querySelector('.run-btn-text').textContent = 'Running...';
    // Show stop button only in debate mode
    if (currentMode === 'debate') {
        stopBtn.classList.remove('hidden');
    }
  } else {
    runBtn.classList.remove('loading');
    runBtn.querySelector('.run-btn-icon').textContent = '▶';
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

function setResponse(panel, text, durationMs) {
  const html = marked.parse(text, { breaks: true, gfm: true });
  panel.body.innerHTML = `<div class="response-content">${html}</div>`;
  const duration = (durationMs / 1000).toFixed(1);
  panel.meta.textContent = `${duration}s`;
  panel.meta.style.color = '';
}

function addTimelineItem(type, name, content, badgeText = '', score = null) {
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
  
  const mdHtml = marked.parse(content, { breaks: true, gfm: true });
  item.innerHTML = headerHtml + `<div class="response-content">${mdHtml}</div>`;
  
  timelineItems.appendChild(item);
  item.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
