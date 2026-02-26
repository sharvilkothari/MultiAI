import { BaseProvider } from './base.js';

export class GeminiProvider extends BaseProvider {
  constructor() {
    super('Gemini', 'https://gemini.google.com/app');
  }

  async dismissPopups(page) {
    const dismissSelectors = [
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      'button:has-text("No thanks")',
      'button:has-text("Close")',
      'button:has-text("Skip")',
    ];

    for (const sel of dismissSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          this.log.info(`Dismissed popup: ${sel}`);
          await page.waitForTimeout(500);
        }
      } catch { /* not present */ }
    }
  }

  async typePrompt(page, prompt) {
    const inputSelectors = [
      '.ql-editor',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
    ];

    const input = await this.trySelectors(page, inputSelectors, { timeout: 15_000 });

    await input.click();
    await page.waitForTimeout(300);

    // Clear existing text
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);

    // Type the prompt
    try {
      await input.fill(prompt);
    } catch {
      // Fallback — set content directly
      await input.evaluate((el, text) => {
        el.innerText = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, prompt);
    }

    await page.waitForTimeout(500);
  }

  async submit(page) {
    // Try the send button
    const sendSelectors = [
      'button[aria-label="Send message"]',
      'button[aria-label="Submit"]',
      'button.send-button',
      '.send-button-container button',
      'button[mattooltip="Send message"]',
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
    // Wait for response to start
    await page.waitForTimeout(3000);

    // Gemini shows a loading/progress indicator while generating
    const loadingSelectors = [
      '.loading-indicator',
      '.progress-indicator',
      'mat-progress-bar',
      '.thinking-indicator',
    ];

    // Wait for loading indicator to appear then disappear
    let foundLoading = false;
    for (const sel of loadingSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });
        foundLoading = true;
        this.log.info(`Loading indicator found: ${sel}`);
        await page.locator(sel).first().waitFor({ state: 'hidden', timeout: this.timeout });
        this.log.info('Loading complete');
        break;
      } catch { /* skip */ }
    }

    if (!foundLoading) {
      // Fallback: text stability
      this.log.info('No loading indicator, using text stability');
      await this.waitForTextStability(page);
    }

    await page.waitForTimeout(1500);
  }

  async waitForTextStability(page) {
    const responseSelectors = [
      '.model-response-text',
      '.response-container',
      'message-content',
      '.message-content',
      '.markdown-main-panel',
    ];

    let previousText = '';
    let stableCount = 0;
    const requiredStable = 3;
    const checkInterval = 2000;
    const maxChecks = Math.ceil(this.timeout / checkInterval);

    for (let i = 0; i < maxChecks && stableCount < requiredStable; i++) {
      await page.waitForTimeout(checkInterval);
      let currentText = '';

      // Try extracting last response text
      try {
        currentText = await page.evaluate((sels) => {
          for (const sel of sels) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              return els[els.length - 1].innerText;
            }
          }
          return '';
        }, responseSelectors);
      } catch { /* ignore */ }

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
      '.model-response-text',
      '.response-container',
      'message-content',
      '.message-content',
      '.markdown-main-panel',
    ];

    // Wait a moment for final render
    await page.waitForTimeout(1000);

    for (const sel of responseSelectors) {
      try {
        const els = page.locator(sel);
        const count = await els.count();
        if (count > 0) {
          const el = els.last();
          const text = await el.evaluate((node) => {
            const clone = node.cloneNode(true);
            // Remove action buttons (copy, share, etc.)
            clone.querySelectorAll('button, .action-buttons, .chip-container, .feedback-buttons')
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

    // Ultimate fallback: grab the last large text block on the page
    try {
      const text = await page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll('div'));
        const candidates = allDivs
          .filter(d => d.innerText.length > 50 && d.children.length > 0)
          .sort((a, b) => b.innerText.length - a.innerText.length);
        // Return the second-longest (first is usually the whole page)
        return candidates[1]?.innerText?.trim() || '';
      });
      if (text) return text;
    } catch { /* ignore */ }

    throw new Error('Could not extract Gemini response');
  }
}
