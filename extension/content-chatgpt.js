/**
 * Content script injected into ChatGPT tab.
 * Receives a prompt, types it, waits for the response, extracts and returns it.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'sendPrompt') return;
  handlePrompt(msg.prompt, msg.fileData).then(
    response => sendResponse({ response }),
    err => sendResponse({ error: err.message || String(err) })
  );
  return true; // async
});

async function handlePrompt(prompt, fileData) {
  await dismissPopups();
  if (fileData && fileData.length > 0) await attachFiles(fileData);
  await typePrompt(prompt);
  await submitPrompt();
  await waitForResponse();
  return extractResponse();
}

/* ── File Attachment ───────────────────────────────────────────── */

async function attachFiles(fileDataArray) {
  const dt = new DataTransfer();
  
  for (const fileData of fileDataArray) {
    const base64 = fileData.dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], fileData.name, { type: fileData.type });
    dt.items.add(file);
  }

  const inputSelectors = ['input[type="file"]', 'input[accept*="image"]'];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) throw new Error('ChatGPT file input not found');

  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Poll every 5s to check upload complete (up to 60s)
  await waitForUploadComplete();
}

async function waitForUploadComplete() {
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const progress = document.querySelector('[role="progressbar"], [class*="progress"], [aria-label*="uploading"]');
    const stillUploading = progress && progress.offsetParent !== null;
    const sendBtn = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"]');
    const sendEnabled = sendBtn && !sendBtn.disabled;
    if (!stillUploading && sendEnabled) return;
    if (!stillUploading && i >= 2) return;
  }
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
  if (!prompt || !prompt.trim()) return;

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

  // Poll for send button to become enabled (up to 15s)
  for (let wait = 0; wait < 30; wait++) {
    for (const sel of sendSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        btn.click();
        await sleep(300);
        return;
      }
    }
    await sleep(500);
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
      clone.querySelectorAll('button, nav, header, [class*="copy"], [class*="action"], [class*="toolbar"]').forEach(n => n.remove());
      const text = htmlToMarkdown(clone).trim();
      if (text && text.length > 5) return text;
    }
  }

  const articles = document.querySelectorAll('article, [data-testid*="conversation"]');
  if (articles.length > 0) {
    const text = htmlToMarkdown(articles[articles.length - 1]).trim();
    if (text && text.length > 5) return text;
  }

  throw new Error('Could not extract ChatGPT response');
}

function htmlToMarkdown(el) {
  let result = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName.toLowerCase();

    // KaTeX: extract LaTeX source from annotation element
    if (tag === 'annotation') {
      result += ` $${node.textContent}$ `;
      continue;
    }
    // KaTeX span wrapper
    if (tag === 'span' && (node.classList.contains('katex') || node.classList.contains('katex-display'))) {
      const ann = node.querySelector('annotation');
      if (ann) {
        const isDisplay = node.classList.contains('katex-display');
        result += isDisplay ? `\n$$${ann.textContent}$$\n` : ` $${ann.textContent}$ `;
        continue;
      }
    }
    // MathJax: extract from script type="math/tex"
    if (tag === 'script' && (node.type || '').includes('math')) {
      result += ` $${node.textContent}$ `;
      continue;
    }
    // Math container with specific math class
    if (node.classList && (node.classList.contains('math') || node.classList.contains('math-inline') || node.classList.contains('math-display') || node.classList.contains('katex-html'))) {
      const ann = node.querySelector('annotation');
      if (ann) {
        const isDisplay = node.classList.contains('math-display') || node.classList.contains('katex-display');
        result += isDisplay ? `\n$$${ann.textContent}$$\n` : ` $${ann.textContent}$ `;
        continue;
      }
    }

    // Headers
    const hMatch = tag.match(/^h([1-6])$/);
    if (hMatch) {
      result += '\n' + '#'.repeat(parseInt(hMatch[1])) + ' ' + htmlToMarkdown(node) + '\n\n';
      continue;
    }

    // Paragraphs
    if (tag === 'p') {
      result += '\n\n' + htmlToMarkdown(node) + '\n\n';
      continue;
    }

    // Line breaks
    if (tag === 'br') { result += '\n'; continue; }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      const items = node.querySelectorAll(':scope > li');
      items.forEach((li, idx) => {
        const prefix = tag === 'ol' ? `${idx + 1}. ` : '- ';
        result += prefix + htmlToMarkdown(li).trim() + '\n';
      });
      result += '\n';
      continue;
    }
    if (tag === 'li') { continue; } // handled by ul/ol

    // Code blocks
    if (tag === 'pre') {
      const code = node.querySelector('code');
      const lang = code ? (code.className.match(/language-(\w+)/)?.[1] || '') : '';
      const text = (code || node).textContent;
      result += '\n```' + lang + '\n' + text + '\n```\n';
      continue;
    }

    // Inline code
    if (tag === 'code' && (!node.parentElement || node.parentElement.tagName !== 'PRE')) {
      result += '`' + node.textContent + '`';
      continue;
    }

    // Bold / Strong
    if (tag === 'strong' || tag === 'b') {
      result += '**' + htmlToMarkdown(node) + '**';
      continue;
    }

    // Italic / Em
    if (tag === 'em' || tag === 'i') {
      result += '*' + htmlToMarkdown(node) + '*';
      continue;
    }

    // Superscript / Subscript → LaTeX notation
    if (tag === 'sup') { result += '^{' + node.textContent + '}'; continue; }
    if (tag === 'sub') { result += '_{' + node.textContent + '}'; continue; }

    // Blockquote
    if (tag === 'blockquote') {
      const lines = htmlToMarkdown(node).trim().split('\n');
      result += '\n' + lines.map(l => '> ' + l).join('\n') + '\n';
      continue;
    }

    // Tables
    if (tag === 'table') {
      const rows = node.querySelectorAll('tr');
      rows.forEach((row, rIdx) => {
        const cells = row.querySelectorAll('th, td');
        result += '| ' + [...cells].map(c => htmlToMarkdown(c).trim()).join(' | ') + ' |\n';
        if (rIdx === 0) {
          result += '| ' + [...cells].map(() => '---').join(' | ') + ' |\n';
        }
      });
      result += '\n';
      continue;
    }

    // Divs and other block elements
    if (['div', 'section', 'article', 'main'].includes(tag)) {
      const inner = htmlToMarkdown(node);
      if (inner.trim().length > 0) {
        result += '\n' + inner + '\n';
      }
      continue;
    }

    // Spans and other inline elements
    result += htmlToMarkdown(node);
  }
  return result;
}
