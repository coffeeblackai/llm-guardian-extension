console.log("Content script loaded");

// Configuration
const LOG_LEVEL = 'DEBUG'; // Set to 'ERROR' in production
const MAX_SEND_ATTEMPTS = 3;
const SEND_RETRY_DELAY = 2000; // in milliseconds
const MUTATION_DEBOUNCE_DELAY = 500; // in milliseconds

// Logging Utility
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

function log(level, message, ...args) {
  if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(LOG_LEVEL)) {
    console[level.toLowerCase()](message, ...args);
  }
}

// Determine the environment and set the base URL accordingly
const isDev = chrome.runtime.getManifest().version_name.includes('dev');
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

  // Handle 'input' events if needed
  textarea.addEventListener('input', handleInput, true);

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

  // Remove 'input' event listener
  textarea.removeEventListener('input', handleInput, true);

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

// Function to handle input events (optional: implement auto-redact or other logic)
function handleInput(event) {
  if (isRedacting) return;
  // Implement additional logic if needed
  // For example, auto-redact after certain conditions
}

// Function to initiate the redaction process
function initiateRedaction(textarea) {
  if (!textarea) return;
  removeEventListeners(textarea);
  scanAndRedact(textarea.textContent, textarea)
    .then(() => {
      addEventListeners(textarea);
    })
    .catch((error) => {
      log('ERROR', "Redaction failed", error);
      addEventListeners(textarea);
    });
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
    // Implement fallback or notify the user
  }
}

// Debounce utility function
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Function to scan and redact text
async function scanAndRedact(text, textarea) {
  if (!text) {
    log('WARN', "No text to redact");
    return;
  }

  log('INFO', "Scanning started");
  isRedacting = true;
  showLoadingIndicator();

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      log('ERROR', "API key is missing or invalid");
      notifyUser("API key is missing. Please set your API key in the extension settings.");
      return;
    }

    const response = await fetchWithRetry(`${baseUrl}/api/secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ text }),
    }, 3); // Retry up to 3 times

    if (response.ok) {
      const data = await response.json();
      if (data.redactedText) {
        textarea.textContent = data.redactedText;
        // Dispatch input event to notify React of the change
        const inputEvent = new Event('input', { bubbles: true });
        textarea.dispatchEvent(inputEvent);
        log('INFO', "Redaction completed successfully");

        // Monitor the textarea for the replaced text before triggering the send action
        const observer = new MutationObserver((mutationsList, observer) => {
          for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.target.textContent === data.redactedText) {
              log('INFO', "Text replaced successfully, triggering send action");
              triggerSendAction();
              observer.disconnect();
              isRedacting = false;
              hideLoadingIndicator();
              break;
            }
          }
        });

        observer.observe(textarea, { childList: true });
      } else {
        log('WARN', "No redactedText found in the response");
        isRedacting = false;
        hideLoadingIndicator();
      }
    } else {
      log('ERROR', `Error in scanning API call: ${response.status} ${response.statusText}`);
      notifyUser("Redaction failed. Please try again.");
      isRedacting = false;
      hideLoadingIndicator();
    }
  } catch (error) {
    log('ERROR', "Error in scanning API call", error);
    notifyUser("An error occurred during redaction. Please try again.");
    isRedacting = false;
    hideLoadingIndicator();
  }
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
      notifyUser("Unable to send the redacted message automatically.");
    }
  }

  attemptClick();
}

// Function to get the API key from Chrome storage
function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey'], (result) => {
      if (result.apiKey && validateApiKey(result.apiKey)) {
        log('DEBUG', "Retrieved API key");
        resolve(result.apiKey);
      } else {
        log('WARN', "No valid API key found");
        resolve(null);
      }
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

// Function to show a loading indicator (implementation depends on your UI)
function showLoadingIndicator() {
  // Example: Inject a spinner element
  let spinner = document.getElementById('llmsecrets-spinner');
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.id = 'llmsecrets-spinner';
    spinner.style.position = 'fixed';
    spinner.style.top = '10px';
    spinner.style.right = '10px';
    spinner.style.width = '50px';
    spinner.style.height = '50px';
    spinner.style.border = '5px solid #f3f3f3';
    spinner.style.borderTop = '5px solid #3498db';
    spinner.style.borderRadius = '50%';
    spinner.style.animation = 'spin 2s linear infinite';
    spinner.style.zIndex = '10000';
    document.body.appendChild(spinner);

    // Add keyframes for spin animation
    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }
}

// Function to hide the loading indicator
function hideLoadingIndicator() {
  const spinner = document.getElementById('llmsecrets-spinner');
  if (spinner) {
    spinner.remove();
  }
}

// Function to notify the user (can be customized to use browser notifications or UI elements)
function notifyUser(message) {
  // Example: Use browser notifications
  if (chrome.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'LLMSSecrets Extension',
      message: message,
    });
  } else {
    // Fallback: Alert
    alert(message);
  }
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
