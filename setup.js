const form = document.getElementById('setup-form');
const sheetIdInput = document.getElementById('sheet-id');
const statusEl = document.getElementById('status');
const authorizeButton = document.getElementById('authorize-button');
const authStatusEl = document.getElementById('auth-status');
const customKeywordsInput = document.getElementById('custom-keywords');
const eventTypeCheckboxes = Array.from(document.querySelectorAll('input[name="event-type"]'));
const verboseLoggingCheckbox = document.getElementById('verbose-logging');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b11818' : '#1b5e20';
}

function setAuthStatus(message, isError = false) {
  authStatusEl.textContent = message;
  authStatusEl.style.color = isError ? '#b11818' : '#1b5e20';
}

function extractSpreadsheetId(value) {
  const input = value.trim();
  if (!input.includes('://')) {
    return /^[A-Za-z0-9_-]+$/.test(input) ? input : null;
  }

  try {
    const url = new URL(input);
    if (url.hostname !== 'docs.google.com') return null;
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

function loadSettings() {
  chrome.storage.local.get(['enabledEventTypes', 'customKeywords', 'verboseLoggingEnabled'], (result) => {
    const enabledEventTypes = result.enabledEventTypes || ['server_start', 'server_stop', 'server_update', 'player_join', 'player_leave'];
    eventTypeCheckboxes.forEach((checkbox) => {
      checkbox.checked = enabledEventTypes.includes(checkbox.value);
    });

    verboseLoggingCheckbox.checked = !!result.verboseLoggingEnabled;

    if (result.customKeywords) {
      customKeywordsInput.value = result.customKeywords;
    }

    chrome.storage.sync.get(['sheetId'], (syncResult) => {
      const syncError = chrome.runtime.lastError;
      const sheetId = !syncError && syncResult.sheetId ? syncResult.sheetId : null;
      if (sheetId) {
        sheetIdInput.value = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        if (result.sheetId) chrome.storage.local.remove('sheetId');
      } else if (result.sheetId) {
        sheetIdInput.value = `https://docs.google.com/spreadsheets/d/${result.sheetId}/edit`;
        chrome.storage.sync.set({ sheetId: result.sheetId }, () => {
          if (!chrome.runtime.lastError) chrome.storage.local.remove('sheetId');
        });
      }

      updateAuthStatus();
    });
  });
}

function getChromeAuthToken(interactive, callback) {
  chrome.identity.getAuthToken({ interactive }, (result) => {
    const token = typeof result === 'string' ? result : result?.token;
    callback(token || null, chrome.runtime.lastError?.message || null);
  });
}

function updateAuthStatus() {
  getChromeAuthToken(false, (token) => {
    if (token) {
      setAuthStatus('Google is authorized. Chrome will renew access tokens when needed.');
    } else {
      setAuthStatus('Google is not authorized. Click Authorize Google to connect.', true);
    }
  });
}

function authorizeGoogle() {
  setStatus('Opening Google sign-in...');
  getChromeAuthToken(true, (token, error) => {
    if (!token) {
      setStatus(error || 'Google authorization failed or was cancelled.', true);
      return;
    }

    chrome.storage.local.set({ googleAuthorizationUpdatedAt: Date.now() }, () => {
      setStatus('Google authorization is ready.');
      setAuthStatus('Google is authorized. Chrome will renew access tokens when needed.');
      chrome.runtime.sendMessage({ type: 'authorizationUpdated' }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const sheetId = extractSpreadsheetId(sheetIdInput.value);
  const enabledEventTypes = eventTypeCheckboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  const customKeywords = customKeywordsInput.value.split(',').map((keyword) => keyword.trim()).filter(Boolean).join(', ');
  const verboseLoggingEnabled = verboseLoggingCheckbox.checked;

  if (!sheetId) {
    setStatus('Enter a valid Google Spreadsheet URL or ID.', true);
    return;
  }

  chrome.storage.local.set({ enabledEventTypes, customKeywords, verboseLoggingEnabled }, () => {
    chrome.storage.sync.set({ sheetId }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not sync spreadsheet setting: ${chrome.runtime.lastError.message}`, true);
        return;
      }

      setStatus('Settings saved. Spreadsheet URL syncs with your Chrome profile.');
      updateAuthStatus();
      chrome.runtime.sendMessage({ type: 'settingsUpdated' }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
});

authorizeButton.addEventListener('click', authorizeGoogle);
window.addEventListener('DOMContentLoaded', loadSettings);
