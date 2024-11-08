const isDev = chrome.runtime.getManifest().version_name.includes('dev');
const baseUrl = isDev ? 'http://localhost:3000' : 'https://app.llmsecrets.com';

document.getElementById('getApiKeyButton').addEventListener('click', () => {
    const settingsUrl = `${baseUrl}/settings`;
    chrome.tabs.create({ url: settingsUrl });
});

document.getElementById('saveButton').addEventListener('click', () => {
    const apiKey = document.getElementById('apiKey').value;
    if (apiKey) {
        chrome.storage.local.set({ apiKey: apiKey }, () => {
            console.log('API Key saved to local storage');
        });
    } else {
        console.log('API Key is empty');
    }
});

// Fetch the API key on load and populate the input field
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['apiKey'], (result) => {
        if (result.apiKey) {
            document.getElementById('apiKey').value = result.apiKey;
            console.log('API Key loaded from local storage');
        } else {
            console.log('No API Key found in local storage');
        }
    });
});