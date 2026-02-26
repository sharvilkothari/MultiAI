import { chromium } from 'playwright';
import { createLogger } from './utils/logger.js';

const log = createLogger('SessionManager');
const CDP_PORT = process.env.CDP_PORT || 9222;

class SessionManager {
  constructor() {
    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    this._connectPromise = null;
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      log.info('Connecting to Chrome via CDP');
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      log.info(`Connected — ${this.browser.contexts().length} context(s)`);
      return this.browser;
    })();

    try { return await this._connectPromise; }
    finally { this._connectPromise = null; }
  }

  /**
   * Open a new tab in the user's existing Chrome window.
   * Uses the default browser context (context[0]) so the tab
   * appears alongside the user's existing tabs — same window,
   * same cookies, same logged-in sessions.
   */
  async newPage() {
    const browser = await this.ensureBrowser();
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context found');
    return await ctx.newPage();
  }

  /** Open localhost in the user's Chrome */
  async openApp(url) {
    const page = await this.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    log.info(`Opened ${url}`);
  }

  async closeAll() {
    if (this.browser) {
      // Disconnect only — never close the user's Chrome
      this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export const sessionManager = new SessionManager();
