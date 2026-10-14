// Wireframe X-Ray — service worker
// One click on the icon (or Alt+Shift+W) toggles wireframe mode on or off.

const ACCENT = '#3b6cff';

async function setBadge(tabId, on) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT });
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__wfx.toggle(),
    });
    await setBadge(tab.id, result);
  } catch (err) {
    // chrome://, the Web Store and other protected pages don't allow scripts.
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d14343' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Wireframe X-Ray does not work on this page' });
  }
});

// The toolbar on the page can turn the mode off itself.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'wfx-state' && sender.tab?.id) setBadge(sender.tab.id, msg.active);
});

// New page in the same tab: the wireframe is gone, so is the badge.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Wireframe X-Ray (Alt+Shift+W)' });
  }
});
