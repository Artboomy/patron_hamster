import { spawn, type ChildProcess } from 'node:child_process';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type BridgeSuccess = {
  requestId?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

async function sendRequest(baseUrl: string, request: Record<string, unknown>): Promise<BridgeSuccess> {
  const responseRaw = await fetch(`${baseUrl}/v1/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });

  assert(responseRaw.ok, `Bridge endpoint failed: HTTP ${responseRaw.status}`);
  return (await responseRaw.json()) as BridgeSuccess;
}

async function waitForBridge(baseUrl: string): Promise<void> {
  const timeoutMs = 10_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for local bridge at ${baseUrl}`);
}

function startLocalBridgeServer(port: number): ChildProcess {
  const child = spawn(process.execPath, ['dist/local-bridge/server.js'], {
    env: { ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[bridge] ${chunk.toString()}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[bridge] ${chunk.toString()}`);
  });

  return child;
}

async function run(): Promise<void> {
  const port = Number(process.env.BRIDGE_PORT || '17353');
  const baseUrl = process.env.BRIDGE_BASE_URL || `http://127.0.0.1:${port}`;
  const bridgeProcess = startLocalBridgeServer(port);

  try {
    await waitForBridge(baseUrl);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert(healthResponse.ok, `Health endpoint failed: HTTP ${healthResponse.status}`);
    const healthBody = (await healthResponse.json()) as { ok?: boolean };
    assert(healthBody.ok === true, 'Health response should include ok=true');

  const pingRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_ping_1',
    action: 'ping',
    payload: { echo: 'hello-extension' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const pingResponse = await sendRequest(baseUrl, pingRequest);
  assert(pingResponse.requestId === pingRequest.requestId, 'ping requestId mismatch');
  assert(pingResponse.ok === true, 'ping should be successful');
  assert(pingResponse.result?.status === 'ok', 'ping result.status should be ok');
  assert(typeof pingResponse.result?.hostName === 'string', 'ping result.hostName should exist');

  const openTabRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_open_tab_1',
    action: 'openTab',
    payload: { url: 'https://example.com', active: true },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const openTabResponse = await sendRequest(baseUrl, openTabRequest);
  assert(openTabResponse.requestId === openTabRequest.requestId, 'openTab requestId mismatch');
  assert(openTabResponse.ok === true, 'openTab should be successful');
  const tabId = openTabResponse.result?.tabId;
  assert(typeof tabId === 'number', 'openTab result.tabId should be a number');

  const navigateRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_navigate_1',
    action: 'navigate',
    payload: { tabId, url: 'https://example.org/docs' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const navigateResponse = await sendRequest(baseUrl, navigateRequest);
  assert(navigateResponse.requestId === navigateRequest.requestId, 'navigate requestId mismatch');
  assert(navigateResponse.ok === true, 'navigate should be successful');
  assert(navigateResponse.result?.finalUrl === 'https://example.org/docs', 'navigate finalUrl mismatch');

  const getUrlRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_get_url_1',
    action: 'getUrl',
    payload: { tabId },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const getUrlResponse = await sendRequest(baseUrl, getUrlRequest);
  assert(getUrlResponse.requestId === getUrlRequest.requestId, 'getUrl requestId mismatch');
  assert(getUrlResponse.ok === true, 'getUrl should be successful');
  assert(getUrlResponse.result?.url === 'https://example.org/docs', 'getUrl url mismatch');

  const evaluateRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_evaluate_1',
    action: 'evaluate',
    payload: { tabId, expression: 'document.title' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const evaluateResponse = await sendRequest(baseUrl, evaluateRequest);
  assert(evaluateResponse.requestId === evaluateRequest.requestId, 'evaluate requestId mismatch');
  assert(evaluateResponse.ok === true, 'evaluate should be successful');
  assert(typeof evaluateResponse.result?.value === 'string', 'evaluate value should be string');

  const waitForSelectorRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_wait_1',
    action: 'waitForSelector',
    payload: { tabId, selector: 'body', state: 'visible' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const waitForSelectorResponse = await sendRequest(baseUrl, waitForSelectorRequest);
  assert(waitForSelectorResponse.requestId === waitForSelectorRequest.requestId, 'waitForSelector requestId mismatch');
  assert(waitForSelectorResponse.ok === true, 'waitForSelector should be successful');
  assert(waitForSelectorResponse.result?.matched === true, 'waitForSelector matched should be true');

  const countRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_count_1',
    action: 'count',
    payload: { tabId, selector: '.item' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const countResponse = await sendRequest(baseUrl, countRequest);
  assert(countResponse.requestId === countRequest.requestId, 'count requestId mismatch');
  assert(countResponse.ok === true, 'count should be successful');
  assert(countResponse.result?.count === 2, 'count result should be 2 for .item');

  const clickRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_click_1',
    action: 'click',
    payload: { tabId, selector: '.item', index: 0 },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const clickResponse = await sendRequest(baseUrl, clickRequest);
  assert(clickResponse.requestId === clickRequest.requestId, 'click requestId mismatch');
  assert(clickResponse.ok === true, 'click should be successful');
  assert(clickResponse.result?.clicked === true, 'click result.clicked should be true');

  const hoverRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_hover_1',
    action: 'hover',
    payload: { tabId, selector: '.item', index: 1 },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const hoverResponse = await sendRequest(baseUrl, hoverRequest);
  assert(hoverResponse.requestId === hoverRequest.requestId, 'hover requestId mismatch');
  assert(hoverResponse.ok === true, 'hover should be successful');
  assert(hoverResponse.result?.hovered === true, 'hover result.hovered should be true');

  const innerTextRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_inner_text_1',
    action: 'innerText',
    payload: { tabId, selector: '.item', index: 1 },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const innerTextResponse = await sendRequest(baseUrl, innerTextRequest);
  assert(innerTextResponse.requestId === innerTextRequest.requestId, 'innerText requestId mismatch');
  assert(innerTextResponse.ok === true, 'innerText should be successful');
  assert(innerTextResponse.result?.text === 'Item 2', 'innerText result.text mismatch');

  const scrollByRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_scroll_1',
    action: 'scrollBy',
    payload: { tabId, x: 15, y: 35, behavior: 'smooth' },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const scrollByResponse = await sendRequest(baseUrl, scrollByRequest);
  assert(scrollByResponse.requestId === scrollByRequest.requestId, 'scrollBy requestId mismatch');
  assert(scrollByResponse.ok === true, 'scrollBy should be successful');
  assert(scrollByResponse.result?.scrollX === 15, 'scrollBy result.scrollX mismatch');
  assert(scrollByResponse.result?.scrollY === 35, 'scrollBy result.scrollY mismatch');

  const sleepRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_sleep_1',
    action: 'sleep',
    payload: { durationMs: 50 },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const sleepResponse = await sendRequest(baseUrl, sleepRequest);
  assert(sleepResponse.requestId === sleepRequest.requestId, 'sleep requestId mismatch');
  assert(sleepResponse.ok === true, 'sleep should be successful');
  assert(typeof sleepResponse.result?.sleptMs === 'number', 'sleep result.sleptMs should be a number');
  assert((sleepResponse.result?.sleptMs as number) >= 40, 'sleep result.sleptMs should be close to requested duration');

  const listTabsRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_list_tabs_1',
    action: 'listTabs',
    payload: {},
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const listTabsResponse = await sendRequest(baseUrl, listTabsRequest);
  assert(listTabsResponse.requestId === listTabsRequest.requestId, 'listTabs requestId mismatch');
  assert(listTabsResponse.ok === true, 'listTabs should be successful');
  const listedTabs = listTabsResponse.result?.tabs;
  assert(Array.isArray(listedTabs), 'listTabs result.tabs should be array');
  assert(listedTabs.length >= 1, 'listTabs should include at least one tab');

  const activateTabRequest: Record<string, unknown> = {
    version: '1.0',
    requestId: 'req_activate_tab_1',
    action: 'activateTab',
    payload: { tabId },
    timeoutMs: 10000,
    sentAt: new Date().toISOString()
  };
  const activateTabResponse = await sendRequest(baseUrl, activateTabRequest);
  assert(activateTabResponse.requestId === activateTabRequest.requestId, 'activateTab requestId mismatch');
  assert(activateTabResponse.ok === true, 'activateTab should be successful');
  assert(activateTabResponse.result?.active === true, 'activateTab result.active should be true');

    console.log('Local bridge self-test passed.');
    console.log(
      JSON.stringify(
        {
          healthBody,
          pingResponse,
          openTabResponse,
          navigateResponse,
          getUrlResponse,
          evaluateResponse,
          waitForSelectorResponse,
          countResponse,
          clickResponse,
          hoverResponse,
          innerTextResponse,
          scrollByResponse,
          sleepResponse,
          listTabsResponse,
          activateTabResponse
        },
        null,
        2
      )
    );
  } finally {
    bridgeProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      bridgeProcess.once('exit', () => resolve(undefined));
      setTimeout(() => resolve(undefined), 1000);
    });
  }
}

run().catch((error: unknown) => {
  console.error('Local bridge self-test failed:', error);
  process.exit(1);
});
