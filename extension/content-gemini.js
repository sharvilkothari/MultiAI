/**
 * Content script injected into Gemini tab.
 * Receives a prompt, types it, waits for the response, extracts and returns it.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'sendPrompt') return;
  handlePrompt(msg.prompt).then(
    response => sendResponse({ response }),
    err => sendResponse({ error: err.message || String(err) })
  );
  return true;
});

async function handlePrompt(prompt) {
  await dismissPopups();
  await typePrompt(prompt);
  await submitPrompt();
  await waitForResponse();
  return extractResponse();
}

/* ── Helpers ──────────────────────────────────────────────── */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dismissPopups() {
  const texts = ['Got it', 'Dismiss', 'No thanks', 'Close', 'Skip'];
  for (const text of texts) {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.trim().includes(text));
    if (btn && btn.offsetParent !== null) {
      btn.click();
      await sleep(500);
    }
  }
}

async function typePrompt(prompt) {
  const selectors = [
    '.ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
  ];

  let input = null;
  for (const sel of selectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) throw new Error('Gemini input field not found');

  input.click();
  input.focus();
  await sleep(300);

  // Clear and type
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await sleep(100);
  document.execCommand('insertText', false, prompt);
  await sleep(300);

  // Fallback
  if (!input.textContent.trim()) {
    input.innerText = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await sleep(500);
}

async function submitPrompt() {
  const sendSelectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Submit"]',
    'button.send-button',
    '.send-button-container button',
    'button[mattooltip="Send message"]',
  ];

  for (const sel of sendSelectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) {
      btn.click();
      await sleep(300);
      return;
    }
  }

  // Fallback: Enter key
  const input = document.querySelector('.ql-editor, div[contenteditable="true"]');
  if (input) {
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
    }));
  }
}

async function waitForResponse() {
  await sleep(3000);

  // Wait for loading indicator to appear then disappear
  const loadingSelectors = [
    '.loading-indicator',
    '.progress-indicator',
    'mat-progress-bar',
    '.thinking-indicator',
  ];

  let foundLoading = false;
  for (const sel of loadingSelectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      foundLoading = true;
      // Wait for it to disappear (up to 120s)
      for (let i = 0; i < 240; i++) {
        const still = document.querySelector(sel);
        if (!still || still.offsetParent === null) break;
        await sleep(500);
      }
      break;
    }
  }

  if (!foundLoading) {
    await waitForTextStability();
  }

  await sleep(2000);
}

async function waitForTextStability() {
  let prev = '', stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    await sleep(2000);
    const cur = getResponseText();
    if (cur && cur === prev) stable++;
    else stable = 0;
    prev = cur;
  }
}

function getResponseSelectors() {
  return [
    '.model-response-text',
    '.response-container',
    'message-content',
    '.message-content',
    '.markdown-main-panel',
  ];
}

function getResponseText() {
  for (const sel of getResponseSelectors()) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return els[els.length - 1].innerText;
  }
  return '';
}

function extractResponse() {
  for (const sel of getResponseSelectors()) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      const el = els[els.length - 1];
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button, .action-buttons, .chip-container, .feedback-buttons').forEach(n => n.remove());
      const text = clone.innerText.trim();
      if (text && text.length > 5) return text;
    }
  }

  // Fallback: find the longest text block on the page
  const allDivs = [...document.querySelectorAll('div')];
  const candidates = allDivs
    .filter(d => d.innerText.length > 50 && d.children.length > 0)
    .sort((a, b) => b.innerText.length - a.innerText.length);
  if (candidates[1]) {
    const text = candidates[1].innerText.trim();
    if (text) return text;
  }

  throw new Error('Could not extract Gemini response');
}
