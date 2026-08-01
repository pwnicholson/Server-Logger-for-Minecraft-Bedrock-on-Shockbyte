const observedLines = new Set();
const seenEventSignatures = new Set();
let customKeywords = [];
let verboseLoggingEnabled = false;
let serverMetadata = {
  serverName: '',
  serverAddress: '',
  serverLocation: '',
  serverVersion: '',
  playerSlots: '',
  playersOnline: ''
};

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanMetadataValue(text) {
  return normalizeText(text)
    .replace(/\s+(copy|transfer edit|edit|transfer|server type|manage plan|quick tasks|view all active)$/i, '')
    .trim();
}

function findLabelValue(labels) {
  const lowerLabels = labels.map((label) => normalizeText(label).toLowerCase());
  const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => el.childElementCount === 0 && el.textContent && el.textContent.trim().length > 0);

  for (const el of candidates) {
    const raw = normalizeText(el.textContent);
    const lower = raw.toLowerCase();

    for (const label of lowerLabels) {
      if (lower === label) {
        const next = normalizeText(el.nextElementSibling?.textContent || el.parentElement?.nextElementSibling?.textContent || '');
        if (next) return cleanMetadataValue(next);
      }

      if (lower.startsWith(label + ':')) {
        return cleanMetadataValue(raw.slice(label.length + 1));
      }

      if (lower.includes(label + ':')) {
        const match = raw.match(new RegExp(`${escapeRegExp(label)}\s*[:\-]?\s*(.+)`, 'i'));
        if (match && match[1]) return cleanMetadataValue(match[1]);
      }
    }
  }

  return '';
}

function extractMetadataFromPage() {
  const metadata = {};
  metadata.serverName = findLabelValue(['Server Name', 'Server']);
  metadata.serverAddress = findLabelValue(['Server Address', 'Address', 'Host']);
  metadata.serverLocation = findLabelValue(['Location', 'Server Location']);
  metadata.serverVersion = findLabelValue(['Version', 'Server Version']);
  metadata.playersOnline = findLabelValue(['Players Online', 'Players online']);
  metadata.playerSlots = findLabelValue(['Players', 'Slots']);

  if (!metadata.playersOnline) {
    const match = normalizeText(document.body?.innerText || document.body?.textContent || '').match(/players\s+online\s*[:\-]?\s*([0-9]+)\s*\/\s*([0-9]+)/i);
    if (match) {
      metadata.playersOnline = normalizeText(match[1]);
      metadata.playerSlots = normalizeText(match[2]);
    }
  }

  return metadata;
}

function parseServerFields() {
  return {};
}

function mergeMetadata(existing, parsed) {
  return {
    serverName: parsed.serverName || existing.serverName,
    serverAddress: parsed.serverAddress || existing.serverAddress,
    serverLocation: parsed.serverLocation || existing.serverLocation,
    serverVersion: parsed.serverVersion || existing.serverVersion,
    playerSlots: parsed.playerSlots || existing.playerSlots,
    playersOnline: parsed.playersOnline || existing.playersOnline
  };
}

function parseConsoleTimestamp(text) {
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }

  const localMatch = text.match(/\b(\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}\s*(?:AM|PM))/i);
  if (localMatch) {
    const parsed = new Date(localMatch[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function parseConsoleLine(text, explicitTimestamp) {
  const normalizedText = normalizeText(text).replace(/^\[+|\]+$/g, '');
  const lower = normalizedText.toLowerCase();
  const timestamp = explicitTimestamp || parseConsoleTimestamp(normalizedText);
  const eventFields = mergeMetadata(serverMetadata, {});

  if (text.includes('Starting Server')) {
    return { logType: 'server_start', type: 'Starting Server', timestamp, details: text, ...eventFields };
  }

  if (text.includes('Server Started')) {
    return { logType: 'server_start', type: 'Server Started', timestamp, details: text, ...eventFields };
  }

  if (lower.includes('server stop requested')) {
    return { logType: 'server_stop', type: 'Server Stop Requested', timestamp, details: text, ...eventFields };
  }

  if (lower.includes('server has stopped')) {
    return { logType: 'server_stop', type: 'Server Stopped', timestamp, details: text, ...eventFields };
  }

  const difficultyMatch = text.match(/set game difficulty to\s+([a-z]+)/i);
  if (difficultyMatch) {
    return {
      logType: 'difficulty_change',
      type: `Difficulty Change: ${difficultyMatch[1].toUpperCase()}`,
      timestamp,
      details: text,
      ...eventFields
    };
  }

  const allowlistMatch = normalizedText.match(/added\s+(.+?)\s+to the allowlist/i);
  if (allowlistMatch) {
    return {
      logType: 'allowlist_added',
      type: `Added ${allowlistMatch[1]} to the allowlist`,
      timestamp,
      details: normalizedText,
      ...eventFields
    };
  }

  if (lower.includes('player spawned:')) {
    const spawnedMatch = normalizedText.match(/player spawned:\s*([^\s]+)/i);
    return {
      logType: 'player_join',
      type: 'Player joined',
      playerName: spawnedMatch ? normalizeText(spawnedMatch[1]) : '',
      timestamp,
      details: normalizedText,
      ...eventFields
    };
  }

  if (lower.includes('player connected:')) {
    const playerConnectedMatch = normalizedText.match(/player connected:\s*([^,\n]+)/i);
    return {
      logType: 'player_join',
      type: 'Player joined',
      playerName: playerConnectedMatch ? normalizeText(playerConnectedMatch[1]) : '',
      timestamp,
      details: normalizedText,
      ...eventFields
    };
  }

  const playerDisconnectedMatch = normalizedText.match(/player disconnected:\s*([^,\n]+)/i);
  if (playerDisconnectedMatch) {
    return {
      logType: 'player_leave',
      type: 'Player left',
      playerName: normalizeText(playerDisconnectedMatch[1]),
      timestamp,
      details: normalizedText,
      ...eventFields
    };
  }

  if (lower.includes('player left:')) {
    const playerLeftMatch = normalizedText.match(/player left:\s*([^,\n]+)/i);
    return {
      logType: 'player_leave',
      type: 'Player left',
      playerName: playerLeftMatch ? normalizeText(playerLeftMatch[1]) : '',
      timestamp,
      details: normalizedText,
      ...eventFields
    };
  }

  if (lower.includes('warning')) {
    const warningText = normalizeText(text.replace(/^.*?warning\s*[:\-]?\s*/i, ''));
    return { logType: 'warning', type: warningText ? `Warning: ${warningText}` : 'Warning', timestamp, details: text, ...eventFields };
  }

  if (lower.includes('error')) {
    const errorText = normalizeText(text.replace(/^.*?error\s*[:\-]?\s*/i, ''));
    return { logType: 'error', type: errorText ? `Error: ${errorText}` : 'Error', timestamp, details: text, ...eventFields };
  }

  for (const keyword of customKeywords) {
    if (keyword && lower.includes(keyword)) {
      return { logType: 'custom_keyword', type: 'Custom Keyword', keyword, timestamp, details: text, ...eventFields };
    }
  }

  return null;
}

function getConsoleLines() {
  try {
    const rows = [];
    const timeElements = Array.from(document.querySelectorAll('time[datetime]'));
    for (const timeEl of timeElements) {
      const row = timeEl.closest('div');
      if (!row) continue;

      const timestamp = timeEl.getAttribute('datetime');
      const text = normalizeText(row.innerText.replace(timeEl.textContent, '')).replace(/^[\s"\[\]]+|[\s"\[\]]+$/g, '');
      if (!text || !timestamp) continue;
      rows.push({ timestamp, text });
    }

    if (rows.length) {
      const unique = new Map();
      for (const row of rows) {
        unique.set(`${row.timestamp}|${row.text}`, row);
      }
      return Array.from(unique.values());
    }

    const selectors = [
      '#console',
      '.console',
      '.console-output',
      '.console-lines',
      '.log-output',
      '[data-console]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const directLines = Array.from(element.querySelectorAll(':scope > div, :scope > p, :scope > li, :scope > span')).map((el) => ({ text: normalizeText(el.innerText), timestamp: '' })).filter((item) => item.text);
        if (directLines.length) return Array.from(new Map(directLines.map((item) => [item.text, item])).values());

        const fallbackLines = Array.from(element.querySelectorAll('div, span, p, li')).map((el) => ({ text: normalizeText(el.innerText), timestamp: '' })).filter((item) => item.text);
        if (fallbackLines.length) return Array.from(new Map(fallbackLines.map((item) => [item.text, item])).values());
      }
    }

    const pageLines = Array.from(document.querySelectorAll('div, span, p, li')).map((el) => ({ text: normalizeText(el.innerText), timestamp: '' })).filter((item) => item.text);
    return Array.from(new Map(pageLines.map((item) => [item.text, item])).values());
  } catch (error) {
    stopScanning();
    return [];
  }
}

let scanInterval = null;
let scanActive = true;
let observer = null;

function stopScanning() {
  scanActive = false;
  if (observer) {
    observer.disconnect();
  }
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

function isExtensionContextValid() {
  return !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage && chrome.storage);
}

function loadSettings() {
  if (!scanActive || !isExtensionContextValid()) {
    stopScanning();
    return;
  }

  try {
    chrome.storage.local.get(['customKeywords', 'verboseLoggingEnabled'], (result) => {
      try {
        if (!scanActive) return;
        const raw = result.customKeywords || '';
        customKeywords = raw.split(',').map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
        verboseLoggingEnabled = !!result.verboseLoggingEnabled;
      } catch (callbackError) {
        stopScanning();
      }
    });
  } catch (error) {
    stopScanning();
  }
}

function sendEventToBackground(message) {
  if (!scanActive || !isExtensionContextValid()) {
    stopScanning();
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      try {
        if (!scanActive) return;
        if (chrome.runtime.lastError && chrome.runtime.lastError.message && chrome.runtime.lastError.message.includes('Extension context invalidated')) {
          stopScanning();
        }
      } catch (callbackError) {
        stopScanning();
      }
    });
  } catch (error) {
    if (error && error.message && error.message.includes('Extension context invalidated')) {
      stopScanning();
    } else {
      stopScanning();
    }
  }
}

function getEventSignature(text, event) {
  return [
    event?.logType || '',
    normalizeText(text),
    normalizeText(event?.playerName || ''),
    normalizeText(event?.keyword || ''),
    normalizeText(event?.serverName || ''),
    normalizeText(event?.serverAddress || ''),
    normalizeText(event?.serverLocation || ''),
    normalizeText(event?.serverVersion || ''),
    normalizeText(event?.playerSlots || '')
  ].join('|');
}

function scanConsole() {
  if (!scanActive) return;

  try {
    const pageMetadata = extractMetadataFromPage();
    if (Object.values(pageMetadata).some(Boolean)) {
      serverMetadata = mergeMetadata(serverMetadata, pageMetadata);
    }

    const rows = getConsoleLines();
    for (const row of rows) {
      const normalizedLine = normalizeText(row.text);
      const lineKey = `${row.timestamp}|${normalizedLine}`;
      if (!normalizedLine || observedLines.has(lineKey)) continue;
      observedLines.add(lineKey);

      if (verboseLoggingEnabled) {
        sendEventToBackground({ type: 'rawConsoleLine', line: normalizedLine, timestamp: row.timestamp || new Date().toISOString() });
      }

      const parsedFields = parseServerFields();
      if (Object.values(parsedFields).some(Boolean)) {
        serverMetadata = mergeMetadata(serverMetadata, parsedFields);
      }

      const event = parseConsoleLine(normalizedLine, row.timestamp);
      if (event) {
        const signature = getEventSignature(normalizedLine, event);
        if (seenEventSignatures.has(signature)) {
          continue;
        }
        seenEventSignatures.add(signature);
        sendEventToBackground({ type: 'parsedEvent', event });
      }
    }
  } catch (error) {
    stopScanning();
  }
}

observer = new MutationObserver(() => {
  try {
    if (scanActive) scanConsole();
  } catch (error) {
    stopScanning();
  }
});

window.addEventListener('error', (event) => {
  const message = event.error?.message || event.message || '';
  if (message.includes('Extension context invalidated')) {
    stopScanning();
    event.preventDefault();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.message || event.reason || '';
  if (typeof reason === 'string' && reason.includes('Extension context invalidated')) {
    stopScanning();
    event.preventDefault();
  }
});

window.addEventListener('load', () => {
  loadSettings();
  scanConsole();
  observer.observe(document.body, { childList: true, subtree: true });
  scanInterval = setInterval(() => {
    if (!scanActive) return;
    loadSettings();
    scanConsole();
  }, 3000);
  window.addEventListener('unload', stopScanning);
});
