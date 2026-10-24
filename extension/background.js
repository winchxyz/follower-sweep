// The toolbar button, first install and the "Open Sweep" button on x.com all
// open Sweep's page, or focus it when it is already open.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'open-app') chrome.runtime.openOptionsPage();
});
