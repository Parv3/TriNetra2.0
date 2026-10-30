const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SearchTracker, AI_DOMAINS, AI_SERVICES } = require('../src/main/searchTracker');

describe('SearchTracker Engine & URL Query Extractor', () => {
  // Test Group A: Search Engine URLs
  it('A1: Extracts standard Google search query parameter q', () => {
    const res = SearchTracker.extractSearchQuery('https://www.google.com/search?q=binary+search+tree');
    assert.strictEqual(res.service, 'Google');
    assert.strictEqual(res.query, 'binary search tree');
    assert.strictEqual(res.isFlaggedAiTool, false);
  });

  it('A2: Decodes complex math and programming code symbols in Google search', () => {
    const url = 'https://www.google.com/search?q=x%5E2+%2B+y_1+%3D+%5Cint+f(x)dx+%26%26+foo-%3Ebar()';
    const res = SearchTracker.extractSearchQuery(url);
    assert.strictEqual(res.query, 'x^2 + y_1 = \\int f(x)dx && foo->bar()');
  });

  it('A3: Decodes multilingual search queries (Japanese, Hindi)', () => {
    const jp = SearchTracker.extractSearchQuery('https://duckduckgo.com/?q=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF');
    assert.strictEqual(jp.query, 'こんにちは');

    const hi = SearchTracker.extractSearchQuery('https://www.bing.com/search?q=%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87');
    assert.strictEqual(hi.query, 'नमस्ते');
  });

  it('A4: Extracts Yahoo search query using parameter p', () => {
    const res = SearchTracker.extractSearchQuery('https://search.yahoo.com/search?p=quick+sort+algorithm');
    assert.strictEqual(res.service, 'Yahoo');
    assert.strictEqual(res.query, 'quick sort algorithm');
  });

  it('A5: Handles empty or whitespace queries without throwing', () => {
    const empty = SearchTracker.extractSearchQuery('https://www.google.com/search?q=');
    assert.strictEqual(empty.query, '');
  });

  it('A6: Deduplicates query parameter by selecting the first occurrence', () => {
    const multi = SearchTracker.extractSearchQuery('https://www.google.com/search?q=first_query&q=second_query');
    assert.strictEqual(multi.query, 'first_query');
  });

  it('A7: Extracts Baidu (wd) and Ecosia (q) queries', () => {
    const baidu = SearchTracker.extractSearchQuery('https://www.baidu.com/s?wd=%E7%AE%97%E6%B3%95');
    assert.strictEqual(baidu.service, 'Baidu');
    assert.strictEqual(baidu.query, '算法');

    const ecosia = SearchTracker.extractSearchQuery('https://www.ecosia.org/search?q=tree+planting');
    assert.strictEqual(ecosia.service, 'Ecosia');
    assert.strictEqual(ecosia.query, 'tree planting');
  });

  // Test Group B: AI Tool URLs
  it('B1: Identifies ChatGPT search query and flags as AI service', () => {
    const res = SearchTracker.extractSearchQuery('https://chatgpt.com/?q=solve+this+mcq');
    assert.strictEqual(res.service, 'ChatGPT');
    assert.strictEqual(res.query, 'solve this mcq');
    assert.strictEqual(res.isFlaggedAiTool, true);
  });

  it('B2: Identifies chat.openai.com subdomains as ChatGPT', () => {
    const res = SearchTracker.extractSearchQuery('https://chat.openai.com/?prompt=write+a+sort');
    assert.strictEqual(res.service, 'ChatGPT');
    assert.strictEqual(res.query, 'write a sort');
    assert.strictEqual(res.isFlaggedAiTool, true);
  });

  it('B3: Identifies Claude AI URL and flags as AI service', () => {
    const res = SearchTracker.extractSearchQuery('https://claude.ai/?q=explain+recursion');
    assert.strictEqual(res.service, 'Claude');
    assert.strictEqual(res.query, 'explain recursion');
    assert.strictEqual(res.isFlaggedAiTool, true);
  });

  it('B4: Identifies gemini.google.com as Gemini AI (not generic Google)', () => {
    const res = SearchTracker.extractSearchQuery('https://gemini.google.com/app?q=summarize+data');
    assert.strictEqual(res.service, 'Gemini');
    assert.strictEqual(res.isFlaggedAiTool, true);
  });

  it('B5: Identifies Perplexity, Copilot, and DeepSeek AI services', () => {
    const p = SearchTracker.extractSearchQuery('https://www.perplexity.ai/search?q=quantum+computing');
    assert.strictEqual(p.service, 'Perplexity');
    assert.strictEqual(p.isFlaggedAiTool, true);

    const c = SearchTracker.extractSearchQuery('https://copilot.microsoft.com/?q=electron+ipc');
    assert.strictEqual(c.service, 'Copilot');
    assert.strictEqual(c.isFlaggedAiTool, true);

    const d = SearchTracker.extractSearchQuery('https://chat.deepseek.com/?q=merge+sort');
    assert.strictEqual(d.service, 'DeepSeek');
    assert.strictEqual(d.isFlaggedAiTool, true);
  });

  // Test Group C: Edge Cases & Validation
  it('C1: Returns null for malformed or non-http URLs', () => {
    assert.strictEqual(SearchTracker.extractSearchQuery('not-a-valid-url'), null);
    assert.strictEqual(SearchTracker.extractSearchQuery('javascript:alert(1)'), null);
    assert.strictEqual(SearchTracker.extractSearchQuery('file:///C:/test.html'), null);
    assert.strictEqual(SearchTracker.extractSearchQuery('about:blank'), null);
    assert.strictEqual(SearchTracker.extractSearchQuery(''), null);
    assert.strictEqual(SearchTracker.extractSearchQuery(null), null);
  });

  it('C2: interceptAIPrompt formats direct AI prompt submission correctly', () => {
    const res = SearchTracker.interceptAIPrompt('ChatGPT', 'Solve Question 1', 'https://chatgpt.com');
    assert.strictEqual(res.service, 'ChatGPT');
    assert.strictEqual(res.query, 'Solve Question 1');
    assert.strictEqual(res.isFlaggedAiTool, true);
    assert.ok(typeof res.timestamp === 'number');
  });

  it('C3: interceptAIPrompt rejects empty or whitespace prompt', () => {
    assert.strictEqual(SearchTracker.interceptAIPrompt('Claude', '   '), null);
    assert.strictEqual(SearchTracker.interceptAIPrompt('Claude', null), null);
    assert.strictEqual(SearchTracker.interceptAIPrompt('Claude', 123), null);
  });

  // Test Group D: HTTP Telemetry Dispatch
  it('D1: Dispatches search event to HTTP backend server', async () => {
    let receivedPayload = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recorded: true }));
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const tracker = new SearchTracker({ backendPort: port, sessionId: 'sess_test_123' });
      const ok = await tracker.dispatchSearchEvent({
        service: 'Google',
        query: 'quick sort',
        url: 'https://google.com/search?q=quick+sort',
        isFlaggedAiTool: false
      });

      assert.strictEqual(ok, true);
      assert.ok(receivedPayload);
      assert.strictEqual(receivedPayload.sessionId, 'sess_test_123');
      assert.strictEqual(receivedPayload.service, 'Google');
      assert.strictEqual(receivedPayload.query, 'quick sort');
      assert.strictEqual(receivedPayload.isFlaggedAiTool, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('D2: Returns false if no sessionId is set during dispatch', async () => {
    const tracker = new SearchTracker({ backendPort: 4100 });
    const ok = await tracker.dispatchSearchEvent({
      service: 'Google',
      query: 'test'
    });
    assert.strictEqual(ok, false);
  });

  it('D3: handleNavigation extracts and dispatches event when query present', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recorded: true }));
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const tracker = new SearchTracker({ backendPort: port, sessionId: 'sess_nav_1' });
      const extracted = await tracker.handleNavigation('https://bing.com/search?q=dijkstra', 'tab_1');
      assert.ok(extracted);
      assert.strictEqual(extracted.service, 'Bing');
      assert.strictEqual(extracted.query, 'dijkstra');
      assert.ok(received);
      assert.strictEqual(received.sessionId, 'sess_nav_1');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
