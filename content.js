console.log("Content script loaded");

// Configuration
const LOG_LEVEL = 'DEBUG';
const MAX_SEND_ATTEMPTS = 1; // Only attempt once
const SEND_RETRY_DELAY = 2000; // in milliseconds
const SEND_ACTION_DELAY = 1000; // Delay before triggering send action (in milliseconds)
const MUTATION_DEBOUNCE_DELAY = 500; // in milliseconds
const ERROR_POPUP_TIMEOUT = 5000; // in milliseconds

// Logging Utility
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
function log(level, message, ...args) {
  if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(LOG_LEVEL)) {
    console[level.toLowerCase()](message, ...args);
  }
}

// Determine the environment and set the base URL accordingly
const isDev = chrome.runtime.getManifest().version_name.includes('dev');
console.log('isDev', isDev);
const baseUrl = isDev ? 'http://localhost:3000' : 'https://app.llmsecrets.com';

// Flags and variables
let isRedacting = false;
let currentTextarea = null;
let clickListenerAdded = false;
let isInitialized = false;
let observer = null;

// Function to initialize the redactor
async function initRedactor() {
  if (isInitialized) {
    log('INFO', "Redactor already initialized");
    return;
  }
  isInitialized = true;
  log('INFO', "Initializing redactor");

  let textarea;
  for (let i = 0; i < 3; i++) {
    textarea = document.querySelector('div#prompt-textarea.ProseMirror');
    if (textarea) {
      break;
    }
    log('DEBUG', "Textarea not found, retrying...");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds before retrying
  }

  if (!textarea) {
    log('ERROR', "Textarea not found after 3 attempts");
    showErrorPopup("Textarea not found. Please try again.");
    return;
  }

  currentTextarea = textarea;

  // Add event listeners
  addEventListeners(textarea);

  // Observe for changes in the textarea to reattach listeners if needed
  observeTextareaChanges();
}

// Function to add event listeners to textarea and send button
function addEventListeners(textarea) {
  if (!textarea) return;

  // Handle 'keydown' event for Enter key
  textarea.addEventListener('keydown', handleEnterKey, true); // Use capturing phase

  // Use event delegation for the send button
  if (!clickListenerAdded) {
    document.body.addEventListener('click', handleSendButtonClick, true);
    clickListenerAdded = true;
  }

  log('DEBUG', "Event listeners added");
}

// Function to remove event listeners from textarea and send button
function removeEventListeners(textarea) {
  if (!textarea) return;

  // Remove 'keydown' event listener
  textarea.removeEventListener('keydown', handleEnterKey, true);

  // Remove 'click' event listener from body if it was added
  if (clickListenerAdded) {
    document.body.removeEventListener('click', handleSendButtonClick, true);
    clickListenerAdded = false;
  }

  log('DEBUG', "Event listeners removed");
}

// Function to handle the Enter key press
function handleEnterKey(event) {
  if (isRedacting) return;

  if (event.key === 'Enter' && !event.shiftKey) {
    event.stopPropagation();
    event.preventDefault();
    log('INFO', "Enter key detected");
    initiateRedaction(event.target);
  }
}

// Function to handle the send button click
function handleSendButtonClick(event) {
  if (isRedacting) return;

  const sendButton = event.target.closest('button[data-testid="send-button"]');
  if (sendButton) {
    event.stopPropagation();
    event.preventDefault();
    log('INFO', "Send button clicked");
    const textarea = document.querySelector('div#prompt-textarea.ProseMirror');
    if (textarea) {
      initiateRedaction(textarea);
    }
  }
}

// Function to initiate the redaction process
function initiateRedaction(textarea) {
  if (!textarea) return;

  isRedacting = true;
  removeEventListeners(textarea);
  const formattedText = extractTextWithFormatting(textarea);
  scanAndRedact(formattedText, textarea)
    .then(() => {
      addEventListeners(textarea);
    })
    .catch((error) => {
      log('ERROR', "Redaction failed", error);
      showErrorPopup("Redaction failed. Continuing with original text.");
      addEventListeners(textarea);
      isRedacting = false;
      triggerSendAction(); // Continue with original text on error
    })
    .finally(() => {
      hideLoadingIndicator();
    });
}

// Function to extract text with formatting from the contenteditable div
function extractTextWithFormatting(textarea) {
  // Convert the HTML content to a string with newline characters
  const htmlContent = textarea.innerHTML;
  const textWithFormatting = htmlToPlainText(htmlContent);
  return textWithFormatting;
}

// Function to convert HTML content to plain text with formatting preserved
function htmlToPlainText(html) {
  // Create a temporary div to parse the HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Function to traverse the DOM and extract text with formatting
  function traverse(node) {
    let text = '';
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') {
          text += '\n';
        } else if (child.tagName === 'P') {
          text += traverse(child) + '\n';
        } else {
          text += traverse(child);
        }
      }
    });
    return text;
  }

  const plainText = traverse(tempDiv);
  return plainText.trim();
}

// Function to observe for changes to the textarea element
function observeTextareaChanges() {
  log('INFO', "Observing textarea changes");
  observer = new MutationObserver(debounce(() => {
    const newTextarea = document.querySelector('div#prompt-textarea.ProseMirror');
    if (newTextarea && newTextarea !== currentTextarea) {
      log('INFO', "Detected new textarea element");
      currentTextarea = newTextarea;
      addEventListeners(newTextarea);
    }
  }, MUTATION_DEBOUNCE_DELAY));

  if ('MutationObserver' in window) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  } else {
    log('ERROR', "MutationObserver is not supported in this browser.");
    showErrorPopup("MutationObserver is not supported in this browser.");
  }
}

// Debounce utility function
function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Function to scan and redact text
async function scanAndRedact(text, textarea) {
  if (!text) {
    log('WARN', "No text to redact");
    isRedacting = false;
    triggerSendAction(); // Continue with empty text
    return;
  }
  log('INFO', "Scanning started");
  showLoadingIndicator();
  try {
    const { apiKey, anonymousId } = await getApiKeyOrAnonymousId();
    let url, headers, body;

    if (apiKey) {
      url = `${baseUrl}/api/secrets`;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      body = { text };
    } else if (anonymousId) {
      // Check anonymous usage count
      const anonymousUsageCount = await getAnonymousUsageCount();
      if (anonymousUsageCount >= 5) {
        showAnonymousUsageLimitPopup("You have reached your free limit of 5 redactions. Continuing withithout protection.");
        isRedacting = false;
        triggerSendAction(); // Continue with original text when limit reached
        return;
      }
      url = `${baseUrl}/api/anon/secrets`;
      headers = {
        'Content-Type': 'application/json',
      };
      
      // Get or generate user ID
      const userId = await getUserId();
      body = { 
        text,
        id: userId
      };
    } else {
      log('ERROR', "No API key or anonymous ID available");
      showErrorPopup("No API key or anonymous ID available. Continuing with original text.");
      isRedacting = false;
      triggerSendAction(); // Continue with original text when no credentials
      return;
    }

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, MAX_SEND_ATTEMPTS);

    if (response.ok) {
      const data = await response.json();
      if (data.redactedText) {
        // Use the formatting function
        const formattedText = formatTextForDiv(data.redactedText);
        textarea.innerHTML = formattedText;
        // Dispatch input event to notify React of the change
        const inputEvent = new Event('input', { bubbles: true });
        textarea.dispatchEvent(inputEvent);
        log('INFO', "Redaction completed, triggering send action");

        // Introduce a delay before triggering send action
        await new Promise(resolve => setTimeout(resolve, SEND_ACTION_DELAY));

        // If using anonymous ID, increment usage count
        if (anonymousId) {
          await incrementAnonymousUsageCount();
        }

        // Trigger send action after delay
        triggerSendAction();
        isRedacting = false;
      } else {
        log('WARN', "No redactedText found in the response");
        showErrorPopup("No redacted text found in the response. Continuing with original text.");
        isRedacting = false;
        triggerSendAction(); // Continue with original text when no redacted text
      }
    } else if (response.status === 403) {
      if (anonymousId) {
        log('ERROR', "Anonymous usage limit reached. Continuing with original text.");
        showAnonymousUsageLimitPopup("You have reached your free limit of 5 secrets. Continuing with original text.");
      } else {
        log('ERROR', "Access forbidden. Continuing with original text.");
        showErrorPopup("Access forbidden. Continuing with original text.");
      }
      isRedacting = false;
      triggerSendAction(); // Continue with original text on 403
    } else {
      log('ERROR', `Error in scanning API call: ${response.status} ${response.statusText}`);
      showErrorPopup("Redaction failed. Continuing with original text.");
      isRedacting = false;
      triggerSendAction(); // Continue with original text on other errors
    }
  } catch (error) {
    log('ERROR', "Error in scanning API call", error);
    showErrorPopup("An error occurred during redaction. Continuing with original text.");
    isRedacting = false;
    triggerSendAction(); // Continue with original text on exception
  }
}

// Function to get or generate user ID
async function getUserId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['userId'], (result) => {
      if (result.userId) {
        log('DEBUG', "Retrieved user ID");
        resolve(result.userId);
      } else {
        const userId = generateUUID();
        chrome.storage.local.set({ userId }, () => {
          log('DEBUG', "Generated and stored new user ID");
          resolve(userId);
        });
      }
    });
  });
}

// Function to format text for insertion into a contenteditable div
function formatTextForDiv(text) {
  if (!text) return '';
  // Escape HTML special characters to prevent XSS
  const div = document.createElement('div');
  div.textContent = text;
  let escapedText = div.innerHTML;

  // Split text into lines and wrap each line in a <p> tag
  const lines = escapedText.split('\n');
  const formattedHTML = lines.map(line => `<p>${line || '<br>'}</p>`).join('');

  return formattedHTML;
}

// Function to trigger the original send action
function triggerSendAction() {
  let attempts = 0;
  function attemptClick() {
    const sendButton = document.querySelector('button[data-testid="send-button"]');
    if (sendButton) {
      sendButton.click();
      log('INFO', "Send button clicked programmatically");
    } else if (attempts < MAX_SEND_ATTEMPTS) {
      attempts++;
      log('WARN', `Send button not found, retrying (${attempts}/${MAX_SEND_ATTEMPTS})...`);
      setTimeout(attemptClick, SEND_RETRY_DELAY);
    } else {
      log('ERROR', "Failed to find send button after multiple attempts");
      showErrorPopup("Unable to send the message automatically. Please try sending manually.");
    }
  }
  attemptClick();
}

// Function to get the API key or anonymous ID
async function getApiKeyOrAnonymousId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey'], async (result) => {
      if (result.apiKey && validateApiKey(result.apiKey)) {
        log('DEBUG', "Retrieved API key");
        resolve({ apiKey: result.apiKey });
      } else {
        const anonymousId = await getAnonymousId();
        resolve({ anonymousId });
      }
    });
  });
}

// Function to get or generate the anonymous ID
function getAnonymousId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['anonymousId'], (result) => {
      if (result.anonymousId) {
        log('DEBUG', "Retrieved anonymous ID");
        resolve(result.anonymousId);
      } else {
        const anonymousId = generateUUID();
        chrome.storage.local.set({ anonymousId }, () => {
          log('DEBUG', "Generated and stored new anonymous ID");
          resolve(anonymousId);
        });
      }
    });
  });
}

// Function to generate a UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Function to get anonymous usage count
function getAnonymousUsageCount() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['anonymousUsageCount'], (result) => {
      const count = result.anonymousUsageCount || 0;
      resolve(count);
    });
  });
}

// Function to increment anonymous usage count and show total used secrets
async function incrementAnonymousUsageCount() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['anonymousUsageCount'], (result) => {
      let count = result.anonymousUsageCount || 0;
      count += 1;
      chrome.storage.local.set({ anonymousUsageCount: count }, () => {
        log('INFO', `Anonymous usage count updated: ${count}`);
        if (count >= 5) {
          showAnonymousUsageLimitPopup("You have reached your free limit of 5 secrets. Please get an API key to continue using the extension.");
        } else {
          showAnonymousUsagePopup(`You have used ${count} out of 5 free requests.`);
        }
        resolve();
      });
    });
  });
}

// Function to validate the API key format
function validateApiKey(key) {
  // Implement your validation logic, e.g., length, character set
  return typeof key === 'string' && key.length > 10;
}

// Utility function for fetch with retries
async function fetchWithRetry(url, options, retries) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok && attempt < retries) {
        log('WARN', `Attempt ${attempt} failed. Retrying in ${SEND_RETRY_DELAY}ms...`);
        await new Promise(res => setTimeout(res, SEND_RETRY_DELAY));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === retries) throw error;
      log('WARN', `Attempt ${attempt} failed due to network error. Retrying in ${SEND_RETRY_DELAY}ms...`);
      await new Promise(res => setTimeout(res, SEND_RETRY_DELAY));
    }
  }
}

// Function to inject CSS into the page
function injectLoadingIndicatorStyles() {
  if (document.getElementById('llmsecrets-loading-indicator-styles')) return; // Prevent duplicate styles

  const style = document.createElement('style');
  style.id = 'llmsecrets-loading-indicator-styles';
  style.textContent = `
    /* Loading Indicator Styles */
    #llmsecrets-loading-indicator {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
      background-color: rgba(75, 85, 99, 0.8); /* Equivalent to bg-gray-800 bg-opacity-40 */
      z-index: 10000; /* Ensure it's on top */
    }

    .llmsecrets-logo-animation .svg-elem-1,
    .llmsecrets-logo-animation .svg-elem-2,
    .llmsecrets-logo-animation .svg-elem-3,
    .llmsecrets-logo-animation .svg-elem-4 {
      fill: rgb(0, 0, 0);
    }

    /* Keyframe Animation */
    @keyframes fadeInOut {
      0% {
        fill: rgb(0, 0, 0);
      }
      50% {
        fill: transparent;
      }
      100% {
        fill: rgb(0, 0, 0);
      }
    }

    /* Apply the animation to each SVG element with staggered delays */
    .llmsecrets-logo-animation .svg-elem-1 {
      animation: fadeInOut 2s cubic-bezier(0.47, 0, 0.745, 0.715) 0s infinite;
    }

    .llmsecrets-logo-animation .svg-elem-2 {
      animation: fadeInOut 2s cubic-bezier(0.47, 0, 0.745, 0.715) 0.25s infinite;
    }

    .llmsecrets-logo-animation .svg-elem-3 {
      animation: fadeInOut 2s cubic-bezier(0.47, 0, 0.745, 0.715) 0.5s infinite;
    }

    .llmsecrets-logo-animation .svg-elem-4 {
      animation: fadeInOut 2s cubic-bezier(0.47, 0, 0.745, 0.715) 0.75s infinite;
    }
  `;
  document.head.appendChild(style);
}

// Function to show the standardized loading indicator
function showLoadingIndicator() {
  // Prevent multiple indicators
  if (document.getElementById('llmsecrets-loading-indicator')) return;

  // Inject the CSS styles
  injectLoadingIndicatorStyles();

  // Create the loading indicator container
  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'llmsecrets-loading-indicator';
  loadingIndicator.setAttribute('aria-live', 'polite');
  loadingIndicator.setAttribute('aria-busy', 'true');

  // Insert the SVG
  loadingIndicator.innerHTML = `
    <svg
      class="llmsecrets-logo-animation"
      width="86"
      height="108"
      viewBox="0 0 222 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Loading"
    >
      <g
        transform="translate(0,256) scale(0.1,-0.1)"
        stroke="none"
      >
        <path
          d="M1050 2520 c-25 -10 -139 -55 -255 -100 -116 -45 -311 -121 -435
          -169 -124 -49 -245 -96 -270 -105 l-45 -17 3 -527 3 -527 35 -105 c85 -257
          264 -500 484 -657 179 -128 468 -283 528 -283 23 0 264 117 367 178 144 86
          319 237 425 367 107 132 173 252 230 425 l30 88 0 526 c0 371 -3 526 -11 526
          -6 0 -117 41 -247 91 -130 50 -336 128 -457 174 -121 46 -246 95 -279 109 -32
          14 -59 26 -60 25 0 0 -21 -9 -46 -19z m107 -261 c111 -48 696 -270 743 -282
          l25 -6 -3 -393 c-3 -358 -5 -400 -24 -473 -80 -312 -315 -572 -688 -761 l-111
          -57 -47 18 c-214 79 -536 346 -646 533 -55 95 -98 201 -115 282 -6 33 -12 211
          -14 450 l-2 395 95 38 c79 32 451 175 660 255 69 26 69 26 127 1z"
          class="svg-elem-1"
        />
        <path
          d="M1100 1901 c0 -217 0 -220 -22 -232 -12 -7 -45 -33 -73 -59 -27 -25
          -81 -71 -120 -100 -38 -30 -132 -107 -207 -171 -75 -64 -161 -136 -191 -159
          l-55 -43 20 -58 20 -59 43 30 c24 17 47 35 50 40 3 5 90 80 193 167 103 87
          234 198 292 248 58 49 173 144 255 210 82 66 175 143 206 172 l57 51 -48 21
          c-27 12 -51 21 -55 21 -4 0 -274 105 -352 137 -10 4 -13 -43 -13 -216z"
          class="svg-elem-2"
        />
        <path
          d="M1670 1881 c0 -6 -30 -31 -67 -58 -72 -50 -149 -112 -299 -240 -103
          -88 -206 -175 -404 -342 -74 -62 -190 -163 -257 -223 l-121 -110 30 -43 31
          -44 76 62 c42 34 117 96 166 137 50 42 135 112 190 155 55 44 190 154 300 245
          110 91 243 200 295 242 52 42 104 85 114 97 11 11 25 21 31 21 29 0 35 86 8
          93 -48 13 -93 17 -93 8z"
          class="svg-elem-3"
        />
        <path
          d="M1638 1562 c-64 -53 -192 -162 -285 -243 -92 -80 -229 -192 -303
          -249 -74 -57 -195 -155 -268 -218 l-134 -114 38 -39 c-21 -22 42 -39 47 -39
          12 0 86 60 197 161 97 88 127 109 154 109 14 0 16 -30 16 -250 0 -137 4 -250
          8 -250 14 0 247 145 307 192 153 117 275 293 336 483 19 62 22 97 27 313 3 200
          2 242 -9 242 -8 0 -66 -44 -131 -98z"
          class="svg-elem-4"
        />
      </g>
    </svg>
  `;

  document.body.appendChild(loadingIndicator);
}

// Function to hide the standardized loading indicator
function hideLoadingIndicator() {
  const loadingIndicator = document.getElementById('llmsecrets-loading-indicator');
  if (loadingIndicator) {
    loadingIndicator.remove();
  }
}

// Function to show an error popup
function showErrorPopup(message, showGetApiKeyButton = false) {
  // Prevent multiple popups
  if (document.getElementById('llmsecrets-error-popup')) return;

  // Create the error popup container
  const errorPopup = document.createElement('div');
  errorPopup.id = 'llmsecrets-error-popup';
  errorPopup.setAttribute('role', 'alert');
  errorPopup.setAttribute('aria-live', 'assertive');
  errorPopup.style.position = 'fixed';
  errorPopup.style.top = '20px';
  errorPopup.style.right = '20px';
  errorPopup.style.width = '20%';
  errorPopup.style.backgroundColor = '#fff';
  errorPopup.style.color = '#000';
  errorPopup.style.padding = '15px';
  errorPopup.style.borderRadius = '5px';
  errorPopup.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
  errorPopup.style.zIndex = '10001';
  errorPopup.style.display = 'flex';
  errorPopup.style.flexDirection = 'column';
  errorPopup.style.alignItems = 'stretch';

  // Create a container for message and close button
  const contentContainer = document.createElement('div');
  contentContainer.style.display = 'flex';
  contentContainer.style.flexDirection = 'row';
  contentContainer.style.justifyContent = 'space-between';
  contentContainer.style.alignItems = 'flex-start';

  // Create the close button
  const closeButton = document.createElement('button');
  closeButton.textContent = 'X';
  closeButton.style.backgroundColor = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.color = '#000';
  closeButton.style.cursor = 'pointer';
  closeButton.style.marginLeft = '10px';
  closeButton.style.alignSelf = 'flex-start';
  closeButton.addEventListener('click', () => {
    errorPopup.remove();
  });

  // Set the message
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  messageSpan.style.wordWrap = 'break-word';
  messageSpan.style.flex = '1';

  // Append message and close button to contentContainer
  contentContainer.appendChild(messageSpan);
  contentContainer.appendChild(closeButton);

  // Append contentContainer to errorPopup
  errorPopup.appendChild(contentContainer);

  // Add "Get API Key" button if needed
  if (showGetApiKeyButton) {
    const getApiKeyButton = document.createElement('button');
    getApiKeyButton.textContent = 'Get API Key';
    getApiKeyButton.style.backgroundColor = '#000';
    getApiKeyButton.style.color = '#fff';
    getApiKeyButton.style.border = 'none';
    getApiKeyButton.style.padding = '10px';
    getApiKeyButton.style.borderRadius = '5px';
    getApiKeyButton.style.cursor = 'pointer';
    getApiKeyButton.style.marginTop = '10px';
    getApiKeyButton.style.width = '100%';
    getApiKeyButton.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptionsPage' });
    });
    errorPopup.appendChild(getApiKeyButton);
  }

  // Append the error popup to the body
  document.body.appendChild(errorPopup);

  // Automatically remove the popup after a timeout
  setTimeout(() => {
    errorPopup.remove();
  }, ERROR_POPUP_TIMEOUT);
}

// Function to show a popup with total used secrets during anonymous usage
function showAnonymousUsagePopup(message) {
  // Prevent multiple popups
  if (document.getElementById('llmsecrets-anonymous-usage-popup')) return;

  // Create the popup container
  const usagePopup = document.createElement('div');
  usagePopup.id = 'llmsecrets-anonymous-usage-popup';
  usagePopup.setAttribute('role', 'alert');
  usagePopup.setAttribute('aria-live', 'assertive');
  usagePopup.style.position = 'fixed';
  usagePopup.style.top = '20px';
  usagePopup.style.right = '20px';
  usagePopup.style.width = '20%';
  usagePopup.style.backgroundColor = '#fff';
  usagePopup.style.color = '#000';
  usagePopup.style.padding = '15px';
  usagePopup.style.borderRadius = '5px';
  usagePopup.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
  usagePopup.style.zIndex = '10001';
  usagePopup.style.display = 'flex';
  usagePopup.style.flexDirection = 'column';
  usagePopup.style.alignItems = 'stretch';

  // Create a container for message and close button
  const contentContainer = document.createElement('div');
  contentContainer.style.display = 'flex';
  contentContainer.style.flexDirection = 'row';
  contentContainer.style.justifyContent = 'space-between';
  contentContainer.style.alignItems = 'flex-start';

  // Create the close button
  const closeButton = document.createElement('button');
  closeButton.textContent = 'X';
  closeButton.style.backgroundColor = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.color = '#000';
  closeButton.style.cursor = 'pointer';
  closeButton.style.marginLeft = '10px';
  closeButton.style.alignSelf = 'flex-start';
  closeButton.addEventListener('click', () => {
    usagePopup.remove();
  });

  // Set the message
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  messageSpan.style.wordWrap = 'break-word';
  messageSpan.style.flex = '1';

  // Append message and close button to contentContainer
  contentContainer.appendChild(messageSpan);
  contentContainer.appendChild(closeButton);

  // Append contentContainer to usagePopup
  usagePopup.appendChild(contentContainer);

  // Append the popup to the body
  document.body.appendChild(usagePopup);

  // Automatically remove the popup after a timeout
  setTimeout(() => {
    usagePopup.remove();
  }, ERROR_POPUP_TIMEOUT);
}

// Function to show a popup when anonymous usage limit is reached
function showAnonymousUsageLimitPopup(message) {
  // Prevent multiple popups
  if (document.getElementById('llmsecrets-anonymous-usage-limit-popup')) return;

  // Create the popup container
  const limitPopup = document.createElement('div');
  limitPopup.id = 'llmsecrets-anonymous-usage-limit-popup';
  limitPopup.setAttribute('role', 'alert');
  limitPopup.setAttribute('aria-live', 'assertive');
  limitPopup.style.position = 'fixed';
  limitPopup.style.top = '20px';
  limitPopup.style.right = '20px';
  limitPopup.style.width = '20%';
  limitPopup.style.backgroundColor = '#fff';
  limitPopup.style.color = '#000';
  limitPopup.style.padding = '15px';
  limitPopup.style.borderRadius = '5px';
  limitPopup.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
  limitPopup.style.zIndex = '10001';
  limitPopup.style.display = 'flex';
  limitPopup.style.flexDirection = 'column';
  limitPopup.style.alignItems = 'stretch';

  // Create a container for message and close button
  const contentContainer = document.createElement('div');
  contentContainer.style.display = 'flex';
  contentContainer.style.flexDirection = 'row';
  contentContainer.style.justifyContent = 'space-between';
  contentContainer.style.alignItems = 'flex-start';

  // Create the close button
  const closeButton = document.createElement('button');
  closeButton.textContent = 'X';
  closeButton.style.backgroundColor = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.color = '#000';
  closeButton.style.cursor = 'pointer';
  closeButton.style.marginLeft = '10px';
  closeButton.style.alignSelf = 'flex-start';
  closeButton.addEventListener('click', () => {
    limitPopup.remove();
  });

  // Set the message
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  messageSpan.style.wordWrap = 'break-word';
  messageSpan.style.flex = '1';

  // Append message and close button to contentContainer
  contentContainer.appendChild(messageSpan);
  contentContainer.appendChild(closeButton);

  // Append contentContainer to limitPopup
  limitPopup.appendChild(contentContainer);

  // Add "Get API Key" button
  const getApiKeyButton = document.createElement('button');
  getApiKeyButton.textContent = 'Get API Key';
  getApiKeyButton.style.backgroundColor = '#000';
  getApiKeyButton.style.color = '#fff';
  getApiKeyButton.style.border = 'none';
  getApiKeyButton.style.padding = '10px';
  getApiKeyButton.style.borderRadius = '5px';
  getApiKeyButton.style.cursor = 'pointer';
  getApiKeyButton.style.marginTop = '10px';
  getApiKeyButton.style.width = '100%';
  getApiKeyButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openOptionsPage' });
  });
  limitPopup.appendChild(getApiKeyButton);

  // Append the popup to the body
  document.body.appendChild(limitPopup);
}

// Function to show a subscription popup
function showSubscriptionPopup(message) {
  // Prevent multiple popups
  if (document.getElementById('llmsecrets-subscription-popup')) return;

  // Create the subscription popup container
  const subscriptionPopup = document.createElement('div');
  subscriptionPopup.id = 'llmsecrets-subscription-popup';
  subscriptionPopup.setAttribute('role', 'alert');
  subscriptionPopup.setAttribute('aria-live', 'assertive');
  subscriptionPopup.style.position = 'fixed';
  subscriptionPopup.style.top = '20px';
  subscriptionPopup.style.right = '20px';
  subscriptionPopup.style.width = '20%';
  subscriptionPopup.style.backgroundColor = '#fff';
  subscriptionPopup.style.color = '#000';
  subscriptionPopup.style.padding = '15px';
  subscriptionPopup.style.borderRadius = '5px';
  subscriptionPopup.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
  subscriptionPopup.style.zIndex = '10001';
  subscriptionPopup.style.display = 'flex';
  subscriptionPopup.style.flexDirection = 'column';
  subscriptionPopup.style.alignItems = 'stretch';

  // Create a container for message and close button
  const contentContainer = document.createElement('div');
  contentContainer.style.display = 'flex';
  contentContainer.style.flexDirection = 'row';
  contentContainer.style.justifyContent = 'space-between';
  contentContainer.style.alignItems = 'flex-start';

  // Create the close button
  const closeButton = document.createElement('button');
  closeButton.textContent = 'X';
  closeButton.style.backgroundColor = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.color = '#000';
  closeButton.style.cursor = 'pointer';
  closeButton.style.marginLeft = '10px';
  closeButton.style.alignSelf = 'flex-start';
  closeButton.addEventListener('click', () => {
    subscriptionPopup.remove();
  });

  // Set the message
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  messageSpan.style.wordWrap = 'break-word';
  messageSpan.style.flex = '1';

  // Append message and close button to contentContainer
  contentContainer.appendChild(messageSpan);
  contentContainer.appendChild(closeButton);

  // Append contentContainer to subscriptionPopup
  subscriptionPopup.appendChild(contentContainer);

  // Add "Subscribe" button
  const subscribeButton = document.createElement('button');
  subscribeButton.textContent = 'Subscribe';
  subscribeButton.style.backgroundColor = '#000';
  subscribeButton.style.color = '#fff';
  subscribeButton.style.border = 'none';
  subscribeButton.style.padding = '10px';
  subscribeButton.style.borderRadius = '5px';
  subscribeButton.style.cursor = 'pointer';
  subscribeButton.style.marginTop = '10px';
  subscribeButton.style.width = '100%';
  subscribeButton.addEventListener('click', () => {
    window.location.href = `${baseUrl}/login`;
  });
  subscriptionPopup.appendChild(subscribeButton);

  // Append the subscription popup to the body
  document.body.appendChild(subscriptionPopup);
}

// Function to clean up observers and listeners
function cleanup() {
  if (currentTextarea) {
    removeEventListeners(currentTextarea);
  }
  if (observer) {
    observer.disconnect();
    log('INFO', "MutationObserver disconnected");
  }
  log('INFO', "Cleaned up redactor");
}

// Initialize the script once the DOM is ready
function checkAndInitialize() {
  log('DEBUG', "Checking and initializing");
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initRedactor();
  } else {
    document.addEventListener('DOMContentLoaded', initRedactor);
  }
}

// Listen for unload event to clean up
window.addEventListener('beforeunload', cleanup);

// Start the initialization
checkAndInitialize();
