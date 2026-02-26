/**
 * Content script injected on localhost:3000
 * Bridges the web page and the extension's background worker.
 *
 * The page dispatches a custom event → this script forwards to background →
 * background responds → this script dispatches the result back to the page.
 */

window.addEventListener('ai-compare-request', async (e) => {
  const { action, payload, prompt, requestId } = e.detail;

  try {
    const response = await chrome.runtime.sendMessage({
      action: action || 'runComparison',
      payload: payload || { prompt },
      requestId // pass through for correlation if needed
    });

    window.dispatchEvent(new CustomEvent('ai-compare-response', {
      detail: { requestId, results: response },
    }));
  } catch (err) {
    window.dispatchEvent(new CustomEvent('ai-compare-response', {
      detail: {
        requestId,
        results: {
          chatgpt: { success: false, error: err.message },
          gemini: { success: false, error: err.message },
        },
      },
    }));
  }
});

// For debate streaming (background -> content -> page)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'debateTurn') {
    window.dispatchEvent(new CustomEvent('ai-compare-debate-turn', {
      detail: msg.payload
    }));
  }
});

// Let the page know the extension is installed
window.dispatchEvent(new CustomEvent('ai-compare-ready'));
