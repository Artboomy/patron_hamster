chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge-content-ping') {
    sendResponse({ ok: true, href: window.location.href, title: document.title });
    return true;
  }

  return false;
});
