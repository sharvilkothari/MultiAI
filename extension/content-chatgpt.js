/**
 * Content script injected into ChatGPT tab.
 * Receives a prompt, types it, waits for the response, extracts and returns it.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'sendPrompt') return;
  handlePrompt(msg.prompt).then(
    response => sendResponse({ response }),
    err => sendResponse({ error: err.message || String(err) })
  );
  return true; // async
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
  const dismissTexts = ['Dismiss', 'No thanks', 'Maybe later', 'Close', 'Stay logged out'];
  for (const text of dismissTexts) {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.trim().includes(text));
    if (btn && btn.offsetParent !== null) {
      btn.click();
      await sleep(500);
    }
  }
  for (const sel of ['[data-testid="close-button"]', '[aria-label="Close"]']) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) {
      btn.click();
      await sleep(500);
    }
  }
}

async function typePrompt(prompt) {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'div[contenteditable="true"]',
  ];

  let input = null;
  for (const sel of selectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) throw new Error('ChatGPT input field not found');

  input.focus();
  await sleep(300);

  // ProseMirror editors ignore innerHTML — use execCommand
  if (input.contentEditable === 'true' || input.getAttribute('contenteditable') === 'true') {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    document.execCommand('insertText', false, prompt);
    await sleep(300);

    // Fallback if execCommand didn't work
    if (!input.textContent.trim()) {
      const p = input.querySelector('p') || input;
      p.textContent = prompt;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: prompt,
      }));
    }
  } else {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(input, prompt);
    else input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await sleep(500);
}

async function submitPrompt() {
  const sendSelectors = [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
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
  const input = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"]');
  if (input) {
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
    }));
  }
}

async function waitForResponse() {
  await sleep(3000);

  const stopSelectors = [
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop"]',
    'button[data-testid="stop-button"]',
  ];

  // Wait for streaming to start
  let streamingStarted = false;
  for (let i = 0; i < 20; i++) {
    for (const sel of stopSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) { streamingStarted = true; break; }
    }
    if (streamingStarted) break;
    await sleep(500);
  }

  if (streamingStarted) {
    // Wait for streaming to finish (stop button disappears)
    for (let i = 0; i < 240; i++) {
      let anyVisible = false;
      for (const sel of stopSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) { anyVisible = true; break; }
      }
      if (!anyVisible) break;
      await sleep(500);
    }
  } else {
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

function getResponseText() {
  for (const sel of getResponseSelectors()) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return els[els.length - 1].innerText;
  }
  return '';
}

function getResponseSelectors() {
  return [
    '[data-message-author-role="assistant"]',
    '.markdown.prose',
    '.agent-turn',
    'article[data-testid^="conversation-turn"]',
    '[class*="assistant"]',
  ];
}

function extractResponse() {
  for (const sel of getResponseSelectors()) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      const el = els[els.length - 1];
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button, nav, header, [class*="copy"], [class*="action"]').forEach(n => n.remove());
      const text = clone.innerText.trim();
      if (text && text.length > 5) return text;
    }
  }

  const articles = document.querySelectorAll('article, [data-testid*="conversation"]');
  if (articles.length > 0) {
    const text = articles[articles.length - 1].innerText.trim();
    if (text && text.length > 5) return text;
  }

  throw new Error('Could not extract ChatGPT response');
}
