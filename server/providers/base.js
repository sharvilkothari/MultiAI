import { createLogger } from '../utils/logger.js';

export class BaseProvider {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.log = createLogger(name);
    this.timeout = 120_000; // 120 seconds
  }

  /**
   * Send a prompt and return the response text.
   * @param {import('playwright').Page} page
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async sendPrompt(page, prompt) {
    const maxAttempts = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.log.info(`Attempt ${attempt}: navigating`);
        await this.navigate(page);

        this.log.info('Dismissing popups');
        await this.dismissPopups(page);

        this.log.info('Typing prompt');
        await this.typePrompt(page, prompt);

        this.log.info('Submitting');
        await this.submit(page);

        this.log.info('Waiting for response');
        await this.waitForResponse(page);

        this.log.info('Extracting response');
        const response = await this.extractResponse(page);

        this.log.info(`Got response (${response.length} chars)`);
        return response;
      } catch (err) {
        lastError = err;
        this.log.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          await page.waitForTimeout(2000);
        }
      }
    }

    throw lastError;
  }

  async navigate(page) {
    await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000); // let JS hydrate
  }

  /* eslint-disable no-unused-vars */
  async dismissPopups(page) { /* override in subclass */ }
  async typePrompt(page, prompt) { throw new Error('Not implemented'); }
  async submit(page) { throw new Error('Not implemented'); }
  async waitForResponse(page) { throw new Error('Not implemented'); }
  async extractResponse(page) { throw new Error('Not implemented'); }
  /* eslint-enable no-unused-vars */

  /**
   * Try multiple selectors, return the first one that resolves.
   */
  async trySelectors(page, selectors, options = {}) {
    const { timeout = 10_000, state = 'visible' } = options;
    for (const selector of selectors) {
      try {
        const el = page.locator(selector).first();
        await el.waitFor({ state, timeout });
        this.log.debug(`Matched selector: ${selector}`);
        return el;
      } catch {
        this.log.debug(`Selector miss: ${selector}`);
      }
    }
    throw new Error(`No selector matched: ${selectors.join(', ')}`);
  }
}
