const form = document.getElementById('setup-form');
const clientIdInput = document.getElementById('client-id');
const sheetIdInput = document.getElementById('sheet-id');
const statusEl = document.getElementById('status');
const redirectUriEl = document.getElementById('redirect-uri');
const authorizeButton = document.getElementById('authorize-button');
const copyRedirectButton = document.getElementById('copy-redirect');
const authStatusEl = document.getElementById('auth-status');
const redirectWarningEl = document.getElementById('redirect-warning');
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

function setRedirectWarning(message) {
  redirectWarningEl.textContent = message;
  redirectWarningEl.style.color = '#b15918';
}

function parseHashParams(url) {
  const hash = url.split('#')[1] || '';
  return hash.split('&').reduce((acc, pair) => {
    const [key, value] = pair.split('=');
    if (key) acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
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
  chrome.storage.local.get(['googleClientId', 'sheetId', 'googleAccessToken', 'tokenExpiry', 'enabledEventTypes', 'customKeywords', 'verboseLoggingEnabled'], (result) => {
    if (result.googleClientId) clientIdInput.value = result.googleClientId;
    if (result.sheetId) sheetIdInput.value = result.sheetId;

    const enabledEventTypes = result.enabledEventTypes || ['server_start', 'server_stop', 'server_update', 'player_join', 'player_leave'];
    eventTypeCheckboxes.forEach((checkbox) => {
      checkbox.checked = enabledEventTypes.includes(checkbox.value);
    });

    verboseLoggingCheckbox.checked = !!result.verboseLoggingEnabled;

    if (result.customKeywords) {
      customKeywordsInput.value = result.customKeywords;
    }

    if (result.googleAccessToken && result.tokenExpiry && Date.now() < result.tokenExpiry) {
      setAuthStatus('Google is authorized. You may now open the Shockbyte console.');
    } else if (result.googleAccessToken) {
      setAuthStatus('Saved authorization token expired. Please authorize again.', true);
    } else {
      setAuthStatus('No Google authorization found. Click Authorize Google once settings are saved.');
    }
  });

  if (chrome.identity && typeof chrome.identity.getRedirectURL === 'function') {
    const redirect = chrome.identity.getRedirectURL();
    redirectUriEl.textContent = redirect;
    setRedirectWarning('Copy this exact redirect URI into your OAuth client settings if you see redirect_uri_mismatch.');
    copyRedirectButton.disabled = false;
  } else {
    redirectUriEl.textContent = 'Chrome identity API unavailable. Reload the extension or open setup from the extension action.';
    setRedirectWarning('Google sign-in will not work until this is loaded from the extension UI.');
    authorizeButton.disabled = true;
    copyRedirectButton.disabled = true;
  }
}

function authorizeGoogle() {
  const googleClientId = clientIdInput.value.trim();
  if (!googleClientId) {
    setStatus('Please save a Google OAuth client ID before authorizing.', true);
    return;
  }

  if (!chrome.identity || typeof chrome.identity.getRedirectURL !== 'function') {
    setStatus('Chrome identity API is unavailable. Reload the extension and open this page from the extension menu.', true);
    return;
  }

  const redirectUri = chrome.identity.getRedirectURL();
  if (!redirectUri) {
    setStatus('Could not determine the redirect URI. Reload the extension and try again.', true);
    return;
  }

  setStatus('Opening Google sign-in...', false);

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(googleClientId)}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('https://www.googleapis.com/auth/spreadsheets')}&prompt=consent&include_granted_scopes=true`;

  chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
    if (chrome.runtime.lastError || !redirectUrl) {
      setStatus(chrome.runtime.lastError?.message || 'Authorization failed or was cancelled.', true);
      return;
    }

    const params = parseHashParams(redirectUrl);
    const accessToken = params.access_token;
    const expiresIn = parseInt(params.expires_in || '3600', 10);

    if (!accessToken) {
      setStatus('Could not obtain an access token from Google.', true);
      return;
    }

    const tokenExpiry = Date.now() + expiresIn * 1000;
    chrome.storage.local.set({ googleAccessToken: accessToken, tokenExpiry }, () => {
      setStatus('Settings saved locally.');
      setAuthStatus('Google is authorized. Access token saved locally.');
    });
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const googleClientId = clientIdInput.value.trim();
  const sheetId = extractSpreadsheetId(sheetIdInput.value);
  const enabledEventTypes = eventTypeCheckboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  const customKeywords = customKeywordsInput.value.split(',').map((keyword) => keyword.trim()).filter(Boolean).join(', ');
  const verboseLoggingEnabled = verboseLoggingCheckbox.checked;

  if (!googleClientId || !sheetId) {
    setStatus('Enter a Google OAuth client ID and a valid Google Spreadsheet URL or ID.', true);
    return;
  }

  chrome.storage.local.get(['googleClientId', 'googleAccessToken', 'tokenExpiry'], (result) => {
    const clientIdChanged = result.googleClientId !== googleClientId;
    chrome.storage.local.set({ googleClientId, sheetId, enabledEventTypes, customKeywords, verboseLoggingEnabled }, () => {
      const finishSave = () => {
        setStatus('Settings saved locally.');
        if (clientIdChanged) {
          setAuthStatus('OAuth client ID changed. Click Authorize Google to connect with the new client.', true);
        } else if (result.googleAccessToken && Date.now() < (result.tokenExpiry || 0)) {
          setAuthStatus('Google authorization is still active; settings changes do not require reauthorization.');
        } else {
          setAuthStatus('Google authorization is missing or expired. Click Authorize Google to connect.', true);
        }
      };

      if (clientIdChanged) {
        chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry'], finishSave);
      } else {
        finishSave();
      }
    });
  });
});

authorizeButton.addEventListener('click', authorizeGoogle);
copyRedirectButton.addEventListener('click', () => {
  const redirectText = redirectUriEl.textContent;
  navigator.clipboard.writeText(redirectText).then(() => {
    setRedirectWarning('Redirect URI copied to clipboard. Paste it into your OAuth client settings.');
  }).catch(() => {
    setRedirectWarning('Could not copy automatically; please select and copy the redirect URI manually.');
  });
});
window.addEventListener('DOMContentLoaded', loadSettings);
