import { BaseProvider } from './base.js';

export class ChatGPTProvider extends BaseProvider {
  constructor() {
    super('ChatGPT', 'https://chatgpt.com');
  }

  async dismissPopups(page) {
    // Dismiss any "Get started" / cookie / upgrade modals
    const dismissSelectors = [
      'button:has-text("Dismiss")',
      'button:has-text("No thanks")',
      'button:has-text("Maybe later")',
      'button:has-text("Close")',
      '[data-testid="close-button"]',
    ];

    for (const sel of dismissSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          this.log.info(`Dismissed popup: ${sel}`);
          await page.waitForTimeout(500);
        }
      } catch { /* not present, skip */ }
    }
  }

  async typePrompt(page, prompt) {
    // ChatGPT uses a contenteditable ProseMirror editor
    const inputSelectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'div[contenteditable="true"]',
    ];

    const input = await this.trySelectors(page, inputSelectors, { timeout: 15_000 });

    // Focus and clear
    await input.click();
    await page.waitForTimeout(300);

    // Type the prompt using keyboard to handle contenteditable properly
    // First clear any existing text
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);

    // For contenteditable, we need to use fill or type depending on what works
    try {
      await input.fill(prompt);
    } catch {
      // Fallback: use clipboard paste for contenteditable
      await page.evaluate((text) => {
        navigator.clipboard.writeText(text);
      }, prompt).catch(() => {});

      // Alternative: set innerHTML directly
      await input.evaluate((el, text) => {
        el.innerHTML = `<p>${text}</p>`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, prompt);
    }

    await page.waitForTimeout(500);
  }

  async submit(page) {
    // Try clicking the send button first, then fallback to Enter
    const sendSelectors = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
    ];

    try {
      const sendBtn = await this.trySelectors(page, sendSelectors, { timeout: 3000 });
      await sendBtn.click();
    } catch {
      this.log.info('Send button not found, pressing Enter');
      await page.keyboard.press('Enter');
    }
  }

  async waitForResponse(page) {
    // Wait for the response to start streaming (assistant message appears)
    await page.waitForTimeout(2000);

    // Wait for streaming to finish by watching for the stop button to disappear
    const stopSelectors = [
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop"]',
      'button[data-testid="stop-button"]',
    ];

    // First, check if a stop button appeared (means streaming started)
    let streamingStarted = false;
    for (const sel of stopSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10_000 });
        streamingStarted = true;
        this.log.info('Streaming started (stop button visible)');
        break;
      } catch { /* not found */ }
    }

    if (streamingStarted) {
      // Now wait for stop button to disappear (streaming complete)
      for (const sel of stopSelectors) {
        try {
          await page.locator(sel).first().waitFor({ state: 'hidden', timeout: this.timeout });
          this.log.info('Streaming complete (stop button hidden)');
          break;
        } catch { /* continue */ }
      }
    } else {
      // No stop button — use text stability as fallback
      this.log.info('No stop button detected, using text stability check');
      await this.waitForTextStability(page);
    }

    // Extra wait for final render
    await page.waitForTimeout(1500);
  }

  async waitForTextStability(page) {
    const responseSelectors = [
      '[data-message-author-role="assistant"]',
      '.markdown.prose',
      '.agent-turn',
    ];

    let previousText = '';
    let stableCount = 0;
    const requiredStable = 3; // 3 checks with same text = stable
    const checkInterval = 2000;
    const maxChecks = Math.ceil(this.timeout / checkInterval);

    for (let i = 0; i < maxChecks && stableCount < requiredStable; i++) {
      await page.waitForTimeout(checkInterval);
      let currentText = '';
      for (const sel of responseSelectors) {
        try {
          const els = page.locator(sel);
          const count = await els.count();
          if (count > 0) {
            currentText = await els.last().innerText();
            break;
          }
        } catch { /* skip */ }
      }

      if (currentText && currentText === previousText) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      previousText = currentText;
    }
  }

  async extractResponse(page) {
    const responseSelectors = [
      '[data-message-author-role="assistant"]',
      '.markdown.prose',
      '.agent-turn',
    ];

    for (const sel of responseSelectors) {
      try {
        const els = page.locator(sel);
        const count = await els.count();
        if (count > 0) {
          // Get the last assistant message
          const el = els.last();

          // Extract the markdown content, preserving code blocks
          const text = await el.evaluate((node) => {
            // Remove action buttons, copy buttons, etc.
            const clone = node.cloneNode(true);
            clone.querySelectorAll('button, .flex.items-center.gap-1, .result-streaming')
              .forEach(el => el.remove());
            return clone.innerText.trim();
          });

          if (text) {
            this.log.info(`Extracted using selector: ${sel}`);
            return text;
          }
        }
      } catch { /* try next */ }
    }

    throw new Error('Could not extract ChatGPT response');
  }
}
