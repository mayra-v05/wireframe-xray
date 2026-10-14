// Wireframe X-Ray — service worker
// Eén klik op het icoon (of Alt+Shift+W) zet de wireframe-modus aan of uit.

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
    // chrome://, de Web Store en andere beschermde pagina's staan geen scripts toe.
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d14343' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Wireframe X-Ray werkt niet op deze pagina' });
  }
});

// De toolbar op de pagina kan de modus zelf uitzetten.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'wfx-state' && sender.tab?.id) setBadge(sender.tab.id, msg.active);
});

// Nieuwe pagina in hetzelfde tabblad: wireframe is weg, badge ook.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Wireframe X-Ray (Alt+Shift+W)' });
  }
});
