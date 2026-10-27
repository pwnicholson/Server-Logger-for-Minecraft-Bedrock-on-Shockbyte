const SETUP_PAGE = 'setup.html';
const HEADER_ROW = ['Timestamp (UTC)', 'Event Type', 'Server Name', 'Server Address', 'Location', 'Server Version', 'Player Slots', 'Player Name'];
const VERBATIM_HEADER_ROW = ['Timestamp (UTC)', 'Verbatim Line'];
const DEFAULT_SHEET_TITLE = 'ServerLogs';
const VERBATIM_SHEET_TITLE = 'Verbatim';
const DEFAULT_EVENT_TYPES = ['server_start', 'server_stop', 'player_join', 'player_leave'];
const EVENT_SIGNATURES_KEY = 'loggedEventSignatures';
const MAX_EVENT_SIGNATURES = 5000;
const inFlightEventSignatures = new Set();
const sheetEventSignatures = new Map();
const sheetSignatureLoadCallbacks = new Map();
const recentJoinSourceClaims = [];
const JOIN_SOURCE_PAIR_WINDOW_MS = 15_000;
const MAX_RECENT_JOIN_SOURCE_CLAIMS = 500;

function openSetupPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL(SETUP_PAGE) });
}

function formatTimestamp(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getChromeAccessToken(callback) {
  chrome.identity.getAuthToken({ interactive: false }, (result) => {
    const token = typeof result === 'string' ? result : result?.token;
    const error = chrome.runtime.lastError;
    callback(token || null, error?.message || null);
  });
}

function getStoredState(callback) {
  chrome.storage.local.get(['sheetId', 'enabledEventTypes', 'verboseLoggingEnabled'], (result) => {
    const enabledEventTypes = result.enabledEventTypes || DEFAULT_EVENT_TYPES;
    const verboseLoggingEnabled = !!result.verboseLoggingEnabled;
    chrome.storage.sync.get(['sheetId'], (syncResult) => {
      const syncError = chrome.runtime.lastError;
      const sheetId = !syncError && syncResult.sheetId ? syncResult.sheetId : result.sheetId;

      if (!syncError && !syncResult.sheetId && result.sheetId) {
        chrome.storage.sync.set({ sheetId }, () => {
          if (!chrome.runtime.lastError) chrome.storage.local.remove('sheetId');
        });
      } else if (syncResult.sheetId && result.sheetId) {
        chrome.storage.local.remove('sheetId');
      }

      getChromeAccessToken((accessToken) => {
        callback({ accessToken, sheetId, enabledEventTypes, verboseLoggingEnabled });
      });
    });
  });
}

function buildRowForEvent(event) {
  return [
    formatTimestamp(event.timestamp || new Date().toISOString()),
    event.type || '',
    event.serverName || '',
    event.serverAddress || '',
    event.serverLocation || '',
    event.serverVersion || '',
    event.playerSlots || '',
    event.playerName || ''
  ];
}

function buildRawRow(timestamp, line) {
  return [formatTimestamp(timestamp), line || ''];
}

function getEventSignature(event) {
  return JSON.stringify([
    formatTimestamp(event.timestamp || new Date().toISOString()),
    normalizeFilterKey(event.type || event.logType),
    String(event.playerName || '').trim().toLowerCase()
  ]);
}

function getEventSignatureFromRow(row, columns) {
  if (!row?.[columns.timestamp] || !row?.[columns.eventType]) return '';
  return JSON.stringify([
    String(row[columns.timestamp]).trim(),
    normalizeFilterKey(row[columns.eventType]),
    String(row[columns.playerName] || '').trim().toLowerCase()
  ]);
}

function rememberEventSignatures(sheetId, events, callback = () => {}) {
  const storageKey = `${EVENT_SIGNATURES_KEY}:${sheetId || 'unconfigured'}`;
  const newSignatures = events.map(getEventSignature);
  const inMemorySignatures = sheetEventSignatures.get(sheetId);
  if (inMemorySignatures) newSignatures.forEach((signature) => inMemorySignatures.add(signature));
  chrome.storage.local.get({ [storageKey]: [] }, (result) => {
    const signatures = new Set(result[storageKey] || []);
    newSignatures.forEach((signature) => signatures.add(signature));
    chrome.storage.local.set({ [storageKey]: Array.from(signatures).slice(-MAX_EVENT_SIGNATURES) }, callback);
  });
}

function loadSheetEventSignatures(accessToken, sheetId, sheetTitle, callback) {
  if (sheetEventSignatures.has(sheetId)) {
    callback();
    return;
  }

  const waitingCallbacks = sheetSignatureLoadCallbacks.get(sheetId);
  if (waitingCallbacks) {
    waitingCallbacks.push(callback);
    return;
  }
  sheetSignatureLoadCallbacks.set(sheetId, [callback]);

  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${sheetRange(sheetTitle, 'A1:I')}`;
  fetchJson(accessToken, valuesUrl).then((result) => {
    if (!result.ok) {
      console.warn('Could not read existing log rows for duplicate checking:', result.data);
      return;
    }

    const rows = result.data.values || [];
    const header = rows[0] || [];
    const timestampColumn = header.findIndex((value) => String(value).trim() === 'Timestamp (UTC)');
    const eventTypeColumn = header.findIndex((value) => String(value).trim() === 'Event Type');
    const playerNameColumn = header.findIndex((value) => String(value).trim() === 'Player Name');
    const columns = {
      timestamp: timestampColumn >= 0 ? timestampColumn : 0,
      eventType: eventTypeColumn >= 0 ? eventTypeColumn : 1,
      playerName: playerNameColumn >= 0 ? playerNameColumn : 7
    };
    const signatures = new Set(rows.slice(1).map((row) => getEventSignatureFromRow(row, columns)).filter(Boolean));
    sheetEventSignatures.set(sheetId, signatures);
    const storageKey = `${EVENT_SIGNATURES_KEY}:${sheetId}`;
    chrome.storage.local.set({ [storageKey]: Array.from(signatures).slice(-MAX_EVENT_SIGNATURES) });
  }).catch((error) => {
    console.warn('Could not load existing log rows for duplicate checking:', error);
  }).finally(() => {
    const callbacks = sheetSignatureLoadCallbacks.get(sheetId) || [];
    sheetSignatureLoadCallbacks.delete(sheetId);
    callbacks.forEach((next) => next());
  });
}

function claimJoinSource(sheetId, event, callback) {
  const playerName = String(event.playerName || '').trim().toLowerCase();
  const timestamp = Date.parse(event.timestamp);
  if (event.logType !== 'player_join' || !event.joinSource || !playerName || !Number.isFinite(timestamp)) {
    callback(true);
    return;
  }

  const storageKey = `recentJoinSources:${sheetId || 'unconfigured'}`;
  const claim = { playerName, source: event.joinSource, timestamp };
  const isPairedSource = (records) => records.some((record) => (
    record.playerName === playerName
    && record.source !== event.joinSource
    && Math.abs(record.timestamp - timestamp) <= JOIN_SOURCE_PAIR_WINDOW_MS
  ));

  if (isPairedSource(recentJoinSourceClaims)) {
    callback(false);
    return;
  }

  recentJoinSourceClaims.push(claim);
  recentJoinSourceClaims.splice(0, recentJoinSourceClaims.length - MAX_RECENT_JOIN_SOURCE_CLAIMS);

  chrome.storage.local.get({ [storageKey]: [] }, (result) => {
    const records = result[storageKey] || [];
    if (isPairedSource(records)) {
      callback(false);
      return;
    }

    const updatedRecords = [...records, claim].slice(-MAX_RECENT_JOIN_SOURCE_CLAIMS);
    chrome.storage.local.set({ [storageKey]: updatedRecords }, () => callback(true));
  });
}

function claimEventSignature(sheetId, event, callback) {
  const signature = getEventSignature(event);
  const storageKey = `${EVENT_SIGNATURES_KEY}:${sheetId || 'unconfigured'}`;
  const inFlightKey = `${storageKey}:${signature}`;
  if (inFlightEventSignatures.has(inFlightKey)) {
    callback(false);
    return;
  }

  inFlightEventSignatures.add(inFlightKey);
  chrome.storage.local.get({ [storageKey]: [], events: [] }, (result) => {
    const signatures = result[storageKey] || [];
    const sheetSignatures = sheetEventSignatures.get(sheetId);
    const isPending = (result.events || []).some((pendingEvent) => getEventSignature(pendingEvent) === signature);
    if (signatures.includes(signature) || sheetSignatures?.has(signature) || isPending) {
      inFlightEventSignatures.delete(inFlightKey);
      callback(false, () => {});
      return;
    }

    claimJoinSource(sheetId, event, (shouldWriteJoin) => {
      if (!shouldWriteJoin) {
        inFlightEventSignatures.delete(inFlightKey);
        callback(false, () => {});
        return;
      }

      callback(true, (writeSucceeded) => {
        if (!writeSucceeded) {
          inFlightEventSignatures.delete(inFlightKey);
          return;
        }

        rememberEventSignatures(sheetId, [event], () => {
          inFlightEventSignatures.delete(inFlightKey);
        });
      });
    });
  });
}

function sheetRange(sheetTitle, range) {
  return `${encodeURIComponent(sheetTitle)}!${range}`;
}

function fetchJson(accessToken, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }).then((response) => response.json().then((data) => ({ status: response.status, ok: response.ok, data })));
}

function writeHeaderRow(accessToken, sheetId, sheetTitle, headerRow, callback) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${sheetRange(sheetTitle, 'A1')}?valueInputOption=RAW`;
  fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [headerRow] })
  }).then((response) => {
    if (!response.ok) {
      console.warn('Could not write header row:', response.status, response.statusText);
    }
    callback();
  }).catch((error) => {
    console.warn('Could not write header row:', error);
    callback();
  });
}

function createSheet(accessToken, sheetId, sheetTitle, headerRow, callback) {
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`;
  const batchBody = {
    requests: [{ addSheet: { properties: { title: sheetTitle } } }]
  };

  fetchJson(accessToken, batchUrl, { method: 'POST', body: JSON.stringify(batchBody) }).then((createResult) => {
    if (createResult.ok) {
      writeHeaderRow(accessToken, sheetId, sheetTitle, headerRow, () => callback(sheetTitle));
    } else {
      console.warn('Could not create sheet:', createResult.data);
      callback(sheetTitle);
    }
  }).catch((error) => {
    console.warn('Could not create sheet:', error);
    callback(sheetTitle);
  });
}

function ensureSheetWithHeader(accessToken, sheetId, sheetTitle, headerRow, callback) {
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${sheetRange(sheetTitle, 'A1:1')}`;
  fetchJson(accessToken, valuesUrl).then((result) => {
    if (result.ok) {
      const values = result.data.values || [];
      if (values.length && values[0].some(Boolean)) {
        callback(sheetTitle);
        return;
      }
      writeHeaderRow(accessToken, sheetId, sheetTitle, headerRow, () => callback(sheetTitle));
      return;
    }

    createSheet(accessToken, sheetId, sheetTitle, headerRow, callback);
  }).catch((error) => {
    console.warn('Could not ensure sheet header:', error);
    createSheet(accessToken, sheetId, sheetTitle, headerRow, callback);
  });
}

function isHeaderRow(row, headerRow) {
  if (!Array.isArray(row) || row.length !== headerRow.length) return false;
  return row.every((cell, index) => String(cell || '').trim() === headerRow[index]);
}

function ensureLogSheet(accessToken, sheetId, callback) {
  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title))`;
  fetchJson(accessToken, metadataUrl).then((result) => {
    if (!result.ok) {
      console.warn('Could not verify the spreadsheet tabs:', result.data);
      ensureSheetWithHeader(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, callback);
      return;
    }

    const sheets = result.data.sheets || [];
    const logSheetExists = sheets.some((sheet) => sheet.properties?.title === DEFAULT_SHEET_TITLE);
    if (logSheetExists) {
      ensureSheetWithHeader(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, callback);
      return;
    }

    const signatureKey = `${EVENT_SIGNATURES_KEY}:${sheetId}`;
    chrome.storage.local.remove(signatureKey, () => {
      sheetEventSignatures.delete(sheetId);
      createSheet(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, callback);
    });
  }).catch((error) => {
    console.warn('Could not verify the spreadsheet tabs:', error);
    ensureSheetWithHeader(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, callback);
  });
}

function ensureVerbatimSheet(accessToken, sheetId, callback) {
  ensureSheetWithHeader(accessToken, sheetId, VERBATIM_SHEET_TITLE, VERBATIM_HEADER_ROW, callback);
}

function prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled) {
  flushPendingEvents(accessToken, sheetId);
  if (accessToken && sheetId && verboseLoggingEnabled) {
    ensureVerbatimSheet(accessToken, sheetId, () => {
      flushPendingRawLines(accessToken, sheetId, true);
    });
    return;
  }

  flushPendingRawLines(accessToken, sheetId, verboseLoggingEnabled);
}

function appendRowsToSheet(accessToken, sheetId, sheetTitle, rows) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${sheetRange(sheetTitle, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: rows })
  });
}

function savePendingEvent(event, callback) {
  chrome.storage.local.get({ events: [] }, (result) => {
    const events = result.events || [];
    events.push(event);
    chrome.storage.local.set({ events }, callback);
  });
}

function savePendingRawLine(rawLine, callback) {
  chrome.storage.local.get({ rawLines: [] }, (result) => {
    const rawLines = result.rawLines || [];
    rawLines.push(rawLine);
    chrome.storage.local.set({ rawLines }, callback);
  });
}

function flushPendingEvents(accessToken, sheetId) {
  if (!accessToken || !sheetId) return;

  chrome.storage.local.get({ events: [] }, (result) => {
    const events = result.events || [];
    if (!events.length) return;

    const uniqueEvents = [];
    const signatures = new Set();
    for (const event of events) {
      const signature = getEventSignature(event);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      uniqueEvents.push(event);
    }

    ensureLogSheet(accessToken, sheetId, (sheetTitle) => {
      loadSheetEventSignatures(accessToken, sheetId, sheetTitle, () => {
        const existingSignatures = sheetEventSignatures.get(sheetId) || new Set();
        const newEvents = uniqueEvents.filter((event) => !existingSignatures.has(getEventSignature(event)));
        if (!newEvents.length) {
          chrome.storage.local.remove('events');
          return;
        }

        const rows = newEvents.map(buildRowForEvent);
        appendRowsToSheet(accessToken, sheetId, sheetTitle, rows)
          .then((response) => {
            if (response.ok) {
              rememberEventSignatures(sheetId, newEvents, () => chrome.storage.local.remove('events'));
            } else {
              console.warn('Could not flush pending events:', response.status, response.statusText);
            }
          })
          .catch((error) => {
            console.warn('Network error while flushing pending events:', error);
          });
        });
    });
  });
}

function flushPendingRawLines(accessToken, sheetId, verboseLoggingEnabled) {
  if (!accessToken || !sheetId || !verboseLoggingEnabled) return;

  chrome.storage.local.get({ rawLines: [] }, (result) => {
    const rawLines = result.rawLines || [];
    if (!rawLines.length) return;

    ensureVerbatimSheet(accessToken, sheetId, (sheetTitle) => {
      const rows = rawLines.map((entry) => buildRawRow(entry.timestamp, entry.line));
      appendRowsToSheet(accessToken, sheetId, sheetTitle, rows)
        .then((response) => {
          if (response.ok) {
            chrome.storage.local.remove('rawLines');
          } else {
            console.warn('Could not flush pending raw lines:', response.status, response.statusText);
          }
        })
        .catch((error) => {
          console.warn('Network error while flushing pending raw lines:', error);
        });
    });
  });
}

function normalizeFilterKey(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized.includes('server_start') || normalized.includes('starting_server')) return 'server_start';
  if (normalized.includes('server_stop') || normalized.includes('server_stopped') || normalized.includes('server_stop_requested')) return 'server_stop';
  if (normalized.includes('player_join') || normalized.includes('player_joined')) return 'player_join';
  if (normalized.includes('player_leave') || normalized.includes('player_left')) return 'player_leave';
  if (normalized.includes('server_update')) return 'server_update';
  if (normalized.includes('custom_keyword')) return 'custom_keyword';
  return normalized;
}

function shouldLogEvent(event, enabledEventTypes) {
  if (!enabledEventTypes || !enabledEventTypes.length) return true;
  const candidateKeys = [normalizeFilterKey(event.logType), normalizeFilterKey(event.type)];
  return candidateKeys.some((key) => enabledEventTypes.includes(key));
}

function handleParsedEvent(event, senderUrl) {
  const savedEvent = Object.assign({ sourceUrl: senderUrl || null }, event);

  getStoredState(({ accessToken, sheetId, enabledEventTypes }) => {
    if (!shouldLogEvent(savedEvent, enabledEventTypes)) {
      return;
    }

    if (!accessToken || !sheetId) {
      claimEventSignature(sheetId, savedEvent, (isNewEvent, finishSignature) => {
        if (!isNewEvent) return;
        savePendingEvent(savedEvent, () => {
          finishSignature(false);
          console.log('Event saved locally until OAuth and sheet settings are configured.', savedEvent);
        });
      });
      return;
    }

    ensureLogSheet(accessToken, sheetId, (sheetTitle) => {
      loadSheetEventSignatures(accessToken, sheetId, sheetTitle, () => {
        claimEventSignature(sheetId, savedEvent, (isNewEvent, finishSignature) => {
          if (!isNewEvent) return;

          const row = buildRowForEvent(savedEvent);
          appendRowsToSheet(accessToken, sheetId, sheetTitle, [row])
            .then((response) => {
              if (response.ok) {
                finishSignature(true);
                return;
              }

              if (response.status === 401 || response.status === 403) {
                chrome.identity.removeCachedAuthToken({ token: accessToken }, () => {
                  savePendingEvent(savedEvent, () => {
                    finishSignature(false);
                    console.warn('Google rejected the cached token. It was cleared and the event saved locally; authorize again if prompted.');
                  });
                });
              } else {
                savePendingEvent(savedEvent, () => {
                  finishSignature(false);
                  console.warn('Failed to append event to Google Sheets. Saved locally.', response.status);
                });
              }
            })
            .catch((error) => {
              savePendingEvent(savedEvent, () => {
                finishSignature(false);
                console.warn('Network or Sheets API error. Saved event locally.', error);
              });
            });
        });
      });
    });
  });
}

function handleRawConsoleLine(line, timestamp) {
  if (!line) return;
  const rawLine = { line, timestamp: timestamp || new Date().toISOString() };

  getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
    if (!verboseLoggingEnabled) return;

    if (!accessToken || !sheetId) {
      savePendingRawLine(rawLine, () => {
        console.log('Raw console line saved locally until OAuth and sheet settings are configured.');
      });
      return;
    }

    ensureVerbatimSheet(accessToken, sheetId, (sheetTitle) => {
      appendRowsToSheet(accessToken, sheetId, sheetTitle, [buildRawRow(rawLine.timestamp, rawLine.line)])
        .then((response) => {
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              chrome.identity.removeCachedAuthToken({ token: accessToken }, () => {
                savePendingRawLine(rawLine, () => {
                  console.warn('Google rejected the cached token for verbose logging. The token was cleared and the raw line saved locally.');
                });
              });
            } else {
              savePendingRawLine(rawLine, () => {
                console.warn('Failed to append raw line to Google Sheets. Saved locally.', response.status);
              });
            }
          }
        })
        .catch((error) => {
          savePendingRawLine(rawLine, () => {
            console.warn('Network or Sheets API error. Saved raw line locally.', error);
          });
        });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry', 'googleClientId']);
  openSetupPage();
  getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
    prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled);
  });
});

chrome.runtime.onStartup.addListener(() => {
  getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
    prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled);
  });
});

chrome.action.onClicked.addListener(openSetupPage);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'authorizationUpdated') {
    getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
      prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled);
    });
  } else if (message.type === 'settingsUpdated') {
    getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
      prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled);
    });
  } else if (message.type === 'parsedEvent') {
    handleParsedEvent(message.event, sender.tab?.url);
  } else if (message.type === 'rawConsoleLine') {
    handleRawConsoleLine(message.line, message.timestamp);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' && area !== 'sync') return;

  if ((area === 'sync' && changes.sheetId) || (area === 'local' && changes.verboseLoggingEnabled)) {
    getStoredState(({ accessToken, sheetId, verboseLoggingEnabled }) => {
      if (accessToken && sheetId) {
        prepareConfiguredSheets(accessToken, sheetId, verboseLoggingEnabled);
      }
    });
  }
});
