/**
 * Content script injected into Gemini tab.
 * Receives a prompt, types it, waits for the response, extracts and returns it.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'sendPrompt') return;
  handlePrompt(msg.prompt, msg.fileData).then(
    response => sendResponse({ response }),
    err => sendResponse({ error: err.message || String(err) })
  );
  return true;
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

  // Try clipboard paste first, then menu file input
  let injected = false;

  try {
    injected = await tryClipboardPaste(dt);
  } catch (e) { /* ignore */ }

  if (!injected) {
    try {
      injected = await tryMenuFileInput(dt);
    } catch (e) { /* ignore */ }
  }

  // After injection, wait for the file to be fully processed by Gemini
  // PDFs can take 10-30s to upload and process
  await waitForFilesProcessed(fileDataArray.map(f => f.name));
}

async function waitForFilesProcessed(fileNames) {
  // Wait for the file chip to appear and its loading to finish
  // Poll for up to 30 seconds
  for (let i = 0; i < 60; i++) {
    await sleep(500);

    // Look for ANY element in the input area that contains the filename or "PDF"
    const allEls = document.querySelectorAll('*');
    let allReady = true;

    for (const fileName of fileNames) {
      let chipFound = false;
      let stillLoading = false;

      for (const el of allEls) {
        const text = el.textContent || '';
        // Check if this element looks like a file chip (contains filename or "PDF")
        if (text.includes(fileName.replace(/\.[^.]+$/, '')) || 
            (text.includes('PDF') && el.closest && el.closest('[class*="chip"], [class*="file"], [class*="upload"], [class*="attachment"]'))) {
          chipFound = true;
          // Check if there's a loading/progress indicator nearby
          const parent = el.closest('div') || el.parentElement;
          if (parent) {
            const loadingEl = parent.querySelector('[class*="loading"], [class*="progress"], [role="progressbar"], mat-spinner, .spinner');
            if (loadingEl && loadingEl.offsetParent !== null) {
              stillLoading = true;
            }
          }
          break;
        }
      }

      if (!chipFound || stillLoading) {
        allReady = false;
        break;
      }
    }

    // If all chips found and NOT loading → file is ready
    if (allReady && i > 10) return; // minimum 5s wait
  }

  // Fallback: wait a fixed 15 seconds to be safe
  await sleep(15000);
}

async function tryClipboardPaste(dt) {
  const editorSels = [
    '.ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
  ];
  let editor = null;
  for (const sel of editorSels) {
    editor = document.querySelector(sel);
    if (editor) break;
  }
  if (!editor) return false;

  editor.focus();
  await sleep(300);

  editor.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: dt,
  }));
  await sleep(2000);
  return true;
}

async function tryMenuFileInput(dt) {
  const menuSels = [
    'button[aria-label*="Open input area menu"]',
    'button[aria-label*="input area menu"]',
    'button.menu-button',
  ];
  let menuBtn = null;
  for (const sel of menuSels) {
    menuBtn = document.querySelector(sel);
    if (menuBtn) break;
  }
  if (!menuBtn) {
    const btns = [...document.querySelectorAll('button')];
    menuBtn = btns.find(b => b.textContent.trim() === '+' || b.textContent.trim() === 'add');
  }
  if (!menuBtn) return false;

  menuBtn.click();
  await sleep(1500);

  let input = null;
  for (let i = 0; i < 30; i++) {
    input = document.querySelector('input[type="file"][name="Filedata"]')
         || document.querySelector('input[type="file"]');
    if (input) break;
    await sleep(200);
  }
  if (!input) { document.body.click(); return false; }

  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));

  await sleep(500);
  document.body.click();
  return true;
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
  if (!prompt || !prompt.trim()) return;

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
  // Count existing responses BEFORE this one arrives
  const responseSels = getResponseSelectors();
  let prevCount = 0;
  for (const sel of responseSels) {
    const els = document.querySelectorAll(sel);
    prevCount = Math.max(prevCount, els.length);
  }

  // Step 1: Wait for a NEW response element to appear (up to 30s)
  let newResponseAppeared = false;
  for (let i = 0; i < 60; i++) {
    for (const sel of responseSels) {
      if (document.querySelectorAll(sel).length > prevCount) {
        newResponseAppeared = true;
        break;
      }
    }
    if (newResponseAppeared) break;
    await sleep(500);
  }

  // Step 2: Wait for response text to STABILIZE (unchanged for 6+ seconds)
  // This is the most reliable method — works regardless of Gemini's UI elements
  let prev = '', stableCount = 0;
  const REQUIRED_STABLE = 3; // 3 checks × 2s = 6 seconds of stability
  const MAX_ITERATIONS = 150; // 150 × 2s = 5 minutes max
  for (let i = 0; i < MAX_ITERATIONS && stableCount < REQUIRED_STABLE; i++) {
    await sleep(2000);
    const cur = getResponseText();
    if (cur && cur.length > 5 && cur === prev) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    prev = cur;
  }

  await sleep(1000);
}

async function waitForTextStability(stableCount = 3) {
  let prev = '', stable = 0;
  for (let i = 0; i < 60 && stable < stableCount; i++) {
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
      clone.querySelectorAll('button, .action-buttons, .chip-container, .feedback-buttons, [class*="toolbar"]').forEach(n => n.remove());
      const html = clone.innerHTML.trim();
      const text = clone.innerText.trim();
      if (text && text.length > 5) return { html, text };
    }
  }

  // Fallback: find the longest text block on the page
  const allDivs = [...document.querySelectorAll('div')];
  const candidates = allDivs
    .filter(d => d.innerText.length > 50 && d.children.length > 0)
    .sort((a, b) => b.innerText.length - a.innerText.length);
  if (candidates[1]) {
    const el = candidates[1];
    const html = el.innerHTML.trim();
    const text = el.innerText.trim();
    if (text) return { html, text };
  }

  throw new Error('Could not extract Gemini response');
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

    // KaTeX / math annotation
    if (tag === 'annotation') {
      result += ` $${node.textContent}$ `;
      continue;
    }
    if (tag === 'span' && (node.classList.contains('katex') || node.classList.contains('katex-display'))) {
      const ann = node.querySelector('annotation');
      if (ann) {
        const isDisplay = node.classList.contains('katex-display');
        result += isDisplay ? `\n$$${ann.textContent}$$\n` : ` $${ann.textContent}$ `;
        continue;
      }
    }
    if (tag === 'script' && (node.type || '').includes('math')) {
      result += ` $${node.textContent}$ `;
      continue;
    }
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

    if (tag === 'p') { result += '\n\n' + htmlToMarkdown(node) + '\n\n'; continue; }
    if (tag === 'br') { result += '\n'; continue; }

    if (tag === 'ul' || tag === 'ol') {
      const items = node.querySelectorAll(':scope > li');
      items.forEach((li, idx) => {
        const prefix = tag === 'ol' ? `${idx + 1}. ` : '- ';
        result += prefix + htmlToMarkdown(li).trim() + '\n';
      });
      result += '\n';
      continue;
    }
    if (tag === 'li') { continue; }

    if (tag === 'pre') {
      const code = node.querySelector('code');
      const lang = code ? (code.className.match(/language-(\w+)/)?.[1] || '') : '';
      result += '\n```' + lang + '\n' + (code || node).textContent + '\n```\n';
      continue;
    }
    if (tag === 'code' && (!node.parentElement || node.parentElement.tagName !== 'PRE')) {
      result += '`' + node.textContent + '`';
      continue;
    }

    if (tag === 'strong' || tag === 'b') { result += '**' + htmlToMarkdown(node) + '**'; continue; }
    if (tag === 'em' || tag === 'i') { result += '*' + htmlToMarkdown(node) + '*'; continue; }

    // Superscript / Subscript → LaTeX notation
    if (tag === 'sup') { result += '^{' + node.textContent + '}'; continue; }
    if (tag === 'sub') { result += '_{' + node.textContent + '}'; continue; }

    if (tag === 'blockquote') {
      const lines = htmlToMarkdown(node).trim().split('\n');
      result += '\n' + lines.map(l => '> ' + l).join('\n') + '\n';
      continue;
    }

    if (tag === 'table') {
      const rows = node.querySelectorAll('tr');
      rows.forEach((row, rIdx) => {
        const cells = row.querySelectorAll('th, td');
        result += '| ' + [...cells].map(c => htmlToMarkdown(c).trim()).join(' | ') + ' |\n';
        if (rIdx === 0) result += '| ' + [...cells].map(() => '---').join(' | ') + ' |\n';
      });
      result += '\n';
      continue;
    }

    if (['div', 'section', 'article', 'main'].includes(tag)) {
      const inner = htmlToMarkdown(node);
      // Add newlines around divs that have meaningful content (acts as paragraph)
      if (inner.trim().length > 0) {
        result += '\n' + inner + '\n';
      }
      continue;
    }

    result += htmlToMarkdown(node);
  }
  return result;
}
