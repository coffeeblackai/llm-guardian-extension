// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.theme) {
      const iconPath = message.theme === 'dark' ? 'logo-black.png' : 'logo-white.png';
      chrome.action.setIcon({ path: iconPath });
    }
});
