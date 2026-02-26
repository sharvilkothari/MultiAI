/**
 * Background service worker — orchestrates AI interactions.
 * Supports both single-turn "Compare" and multi-turn "Debate".
 * Uses minimized windows to keep tabs active without disturbing the user.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action, payload } = msg;

  if (action === 'runComparison') {
    runComparison(payload.prompt).then(sendResponse);
    return true; // async
  }
  
  if (action === 'startDebate') {
    runDebate(payload.prompt, sender.tab.id).then(sendResponse);
    return true; // async
  }

  if (action === 'stopDebate') {
    debateActive = false;
    sendResponse({ success: true });
    return false;
  }
});

// ── Shared Session Logic ──────────────────────────────────────────

async function createSession(name, url) {
  const win = await chrome.windows.create({
    url,
    state: 'minimized',
    focused: false,
  });
  
  const tabId = win.tabs[0].id;
  await waitForTabLoad(tabId);
  
  // Inject content script once
  const scriptFile = name === 'chatgpt' ? '/content-chatgpt.js' : '/content-gemini.js';
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [scriptFile],
  });

  return { name, tabId, windowId: win.id };
}

async function querySession(session, prompt) {
  const t0 = Date.now();
  try {
    const result = await sendTabMessage(session.tabId, { action: 'sendPrompt', prompt });
    return {
      success: true,
      response: result.response,
      duration: Date.now() - t0
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      duration: Date.now() - t0
    };
  }
}

async function closeSession(session) {
  if (session && session.windowId) {
    try { await chrome.windows.remove(session.windowId); } catch(e) {}
  }
}

// ── Single Turn Comparison ────────────────────────────────────────

async function runComparison(prompt) {
  let sessions = {};
  
  try {
    // 1. Create sessions in parallel
    const [chatgpt, gemini] = await Promise.all([
      createSession('chatgpt', 'https://chatgpt.com/'),
      createSession('gemini', 'https://gemini.google.com/app')
    ]);
    sessions = { chatgpt, gemini };

    // 2. Query in parallel
    const [resGPT, resGemini] = await Promise.all([
      querySession(chatgpt, prompt),
      querySession(gemini, prompt)
    ]);

    return { chatgpt: resGPT, gemini: resGemini };

  } catch (err) {
    return { error: err.message };
  } finally {
    // 3. Cleanup
    await Promise.all(Object.values(sessions).map(closeSession));
  }
}

// ── Multi-Turn Debate ─────────────────────────────────────────────

let debateActive = false;

async function runDebate(initialPrompt, clientTabId) {
  let sessions = {};
  debateActive = true;
  
  try {
    // 1. Start Sessions
    const [chatgpt, gemini] = await Promise.all([
      createSession('chatgpt', 'https://chatgpt.com/'),
      createSession('gemini', 'https://gemini.google.com/app')
    ]);
    sessions = { chatgpt, gemini };

    const emit = (type, data) => {
      // Send to the specific client tab
      if (clientTabId) {
        chrome.tabs.sendMessage(clientTabId, { action: 'debateTurn', payload: { type, ...data } });
      }
    };

    if (!debateActive) throw new Error('Debate stopped by user.');

    // ── Round 1: Initial Arguments ──────────────────────────────────
    emit('status', { message: 'Round 1: Generating initial arguments...' });
    
    let [resGPT, resGemini] = await Promise.all([
      querySession(chatgpt, initialPrompt),
      querySession(gemini, initialPrompt)
    ]);

    emit('turn', { agent: 'chatgpt', ...resGPT, round: 1 });
    emit('turn', { agent: 'gemini', ...resGemini, round: 1 });

    // ── Rounds 2 to 5: Critique & Refine Loop ───────────────────────
    let round = 2;
    const MAX_ROUNDS = 5;
    let consensusReached = false;

    // Helper to separate logic
    // We store the *latest* response text to use in the next prompt
    let lastGPTObj = resGPT;
    let lastGeminiObj = resGemini;

    while (round <= MAX_ROUNDS && !consensusReached) {
       if (!debateActive) throw new Error('Debate stopped by user.');
       
       emit('status', { message: `Round ${round}: Critique & Refinement...` });

       // Prompt asking for score
       // Note: We ask them to update their answer based on the other's feedback.
       // The "Final Answer" is the text they generate here.
       const createSystematicPrompt = (otherResponse) => `You are in a collaborative debate with another AI. Your goal is to reach a CONSENSUS on the user's query: "${initialPrompt}".

Here is the other AI's latest response:
"""${otherResponse}"""

Response Structure:
1. **Disagreements**: List exactly which factors/points you interpret differently. Be specific.
2. **Critique**: Briefly critique their logic on those points.
3. **Synthesis**: Provide an UPDATED, comprehensive answer that incorporates valid points from BOTH sides. Try to resolve the disagreements.
4. **Agreement Score**: End your response with a new line containing exactly: "AGREEMENT_SCORE: <number>" (1-10).
   - 10 = Complete consensus (we say the same thing).
   - 1 = Fundamental disagreement.`;

       const promptGPT = createSystematicPrompt(lastGeminiObj.response);
       const promptGemini = createSystematicPrompt(lastGPTObj.response);

       const [rGPT, rGemini] = await Promise.all([
         querySession(chatgpt, promptGPT),
         querySession(gemini, promptGemini)
       ]);

       // Parse scores
       const parseScore = (text) => {
         const match = text.match(/AGREEMENT_SCORE:\s*(\d+)/i);
         return match ? parseInt(match[1], 10) : 0;
       };
       
       const scoreGPT = parseScore(rGPT.response || '');
       const scoreGemini = parseScore(rGemini.response || '');

       // Store for next round
       lastGPTObj = rGPT;
       lastGeminiObj = rGemini;

       // Emit turns
       emit('turn', { agent: 'chatgpt', ...rGPT, round, score: scoreGPT });
       emit('turn', { agent: 'gemini', ...rGemini, round, score: scoreGemini });

       // Check strict consensus: Both must be high (>= 8)
       if (scoreGPT >= 8 && scoreGemini >= 8) {
         consensusReached = true;
       }
       
       round++;
    }

    if (!debateActive) throw new Error('Debate stopped by user.');

    // ── Final Conclusion ──────────────────────────────────────────────
    if (consensusReached) {
        emit('status', { message: 'Consensus Reached! Finalizing...' });
    } else {
        emit('status', { message: 'Max rounds reached. Finalizing...' });
    }
    
    // We can emit a specific "final" event or just rely on the last turn being the final one.
    // Let's emit a system message confirming the end.
    // The visual "Final Answer" is simply the last turn from each agent.
    
    return { success: true, consensus: consensusReached };

  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    debateActive = false;
    await Promise.all(Object.values(sessions).map(closeSession));
  }
}


/* ── Tab helpers ─────────────────────────────────────────── */

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tab load timeout')), 30000);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.get(tabId, tab => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

function sendTabMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Response timeout (600s)')), 600000); // 10 min timeout
    chrome.tabs.sendMessage(tabId, msg, response => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
