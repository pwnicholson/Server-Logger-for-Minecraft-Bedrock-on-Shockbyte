const SETUP_PAGE = 'setup.html';
const HEADER_ROW = ['Timestamp (UTC)', 'Event Type', 'Server Name', 'Server Address', 'Location', 'Server Version', 'Player Slots', 'Player Name'];
const VERBATIM_HEADER_ROW = ['Timestamp (UTC)', 'Verbatim Line'];
const DEFAULT_SHEET_TITLE = 'ServerLogs';
const VERBATIM_SHEET_TITLE = 'Verbatim';
const DEFAULT_EVENT_TYPES = ['server_start', 'server_stop', 'player_join', 'player_leave'];
const EVENT_SIGNATURES_KEY = 'loggedEventSignatures';
const MAX_EVENT_SIGNATURES = 5000;
const inFlightEventSignatures = new Set();
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

function getStoredState(callback) {
  chrome.storage.local.get(['googleAccessToken', 'tokenExpiry', 'sheetId', 'enabledEventTypes', 'logSheetTitle', 'verboseLoggingEnabled'], (result) => {
    const accessToken = result.googleAccessToken;
    const tokenExpiry = result.tokenExpiry || 0;
    const sheetId = result.sheetId;
    const enabledEventTypes = result.enabledEventTypes || DEFAULT_EVENT_TYPES;
    const logSheetTitle = result.logSheetTitle;
    const verboseLoggingEnabled = !!result.verboseLoggingEnabled;
    const validToken = accessToken && Date.now() < tokenExpiry ? accessToken : null;
    callback({ accessToken: validToken, sheetId, enabledEventTypes, logSheetTitle, verboseLoggingEnabled });
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
    String(event.logType || '').trim().toLowerCase(),
    String(event.type || '').trim().toLowerCase(),
    String(event.playerName || '').trim().toLowerCase(),
    String(event.keyword || '').trim().toLowerCase()
  ]);
}

function rememberEventSignatures(sheetId, events, callback = () => {}) {
  const storageKey = `${EVENT_SIGNATURES_KEY}:${sheetId || 'unconfigured'}`;
  const newSignatures = events.map(getEventSignature);
  chrome.storage.local.get({ [storageKey]: [] }, (result) => {
    const signatures = new Set(result[storageKey] || []);
    newSignatures.forEach((signature) => signatures.add(signature));
    chrome.storage.local.set({ [storageKey]: Array.from(signatures).slice(-MAX_EVENT_SIGNATURES) }, callback);
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
    const isPending = (result.events || []).some((pendingEvent) => getEventSignature(pendingEvent) === signature);
    if (signatures.includes(signature) || isPending) {
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

function setLogSheetTitle(title, callback) {
  chrome.storage.local.set({ logSheetTitle: title }, callback);
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

function ensureLogSheet(accessToken, sheetId, storedTitle, callback) {
  if (storedTitle) {
    const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title))`;
    fetchJson(accessToken, metadataUrl).then((result) => {
      if (result.ok) {
        const sheets = result.data.sheets || [];
        const storedSheetExists = sheets.some((sheet) => sheet.properties?.title === storedTitle);
        if (!storedSheetExists) {
          const signatureKey = `${EVENT_SIGNATURES_KEY}:${sheetId}`;
          chrome.storage.local.remove(signatureKey, () => {
            createSheet(accessToken, sheetId, storedTitle, HEADER_ROW, (sheetTitle) => {
              setLogSheetTitle(sheetTitle, () => callback(sheetTitle));
            });
          });
          return;
        }
      }

      ensureSheetWithHeader(accessToken, sheetId, storedTitle, HEADER_ROW, callback);
    }).catch((error) => {
      console.warn('Could not verify the log sheet exists:', error);
      ensureSheetWithHeader(accessToken, sheetId, storedTitle, HEADER_ROW, callback);
    });
    return;
  }

  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title))`;
  fetchJson(accessToken, metadataUrl).then((result) => {
    if (!result.ok) {
      console.warn('Could not read spreadsheet metadata:', result.data);
      createSheet(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, (sheetTitle) => {
        setLogSheetTitle(sheetTitle, () => callback(sheetTitle));
      });
      return;
    }

    const sheets = result.data.sheets || [];
    const firstSheetTitle = sheets[0]?.properties?.title || DEFAULT_SHEET_TITLE;
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${sheetRange(firstSheetTitle, 'A1:1')}`;

    fetchJson(accessToken, valuesUrl).then((valuesResult) => {
      if (valuesResult.ok) {
        const values = valuesResult.data.values || [];
        if (values.length && isHeaderRow(values[0], HEADER_ROW)) {
          setLogSheetTitle(firstSheetTitle, () => callback(firstSheetTitle));
          return;
        }
        if (!values.length || !values[0].some(Boolean)) {
          writeHeaderRow(accessToken, sheetId, firstSheetTitle, HEADER_ROW, () => {
            setLogSheetTitle(firstSheetTitle, () => callback(firstSheetTitle));
          });
          return;
        }
      }

      const newTitle = `${DEFAULT_SHEET_TITLE}-${Date.now()}`;
      createSheet(accessToken, sheetId, newTitle, HEADER_ROW, (sheetTitle) => {
        setLogSheetTitle(sheetTitle, () => callback(sheetTitle));
      });
    }).catch((error) => {
      console.warn('Could not read header row:', error);
      createSheet(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, (sheetTitle) => {
        setLogSheetTitle(sheetTitle, () => callback(sheetTitle));
      });
    });
  }).catch((error) => {
    console.warn('Could not ensure log sheet:', error);
    createSheet(accessToken, sheetId, DEFAULT_SHEET_TITLE, HEADER_ROW, (sheetTitle) => {
      setLogSheetTitle(sheetTitle, () => callback(sheetTitle));
    });
  });
}

function ensureVerbatimSheet(accessToken, sheetId, callback) {
  ensureSheetWithHeader(accessToken, sheetId, VERBATIM_SHEET_TITLE, VERBATIM_HEADER_ROW, callback);
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

function flushPendingEvents(accessToken, sheetId, storedTitle) {
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

    ensureLogSheet(accessToken, sheetId, storedTitle, (sheetTitle) => {
      const rows = uniqueEvents.map(buildRowForEvent);
      appendRowsToSheet(accessToken, sheetId, sheetTitle, rows)
        .then((response) => {
          if (response.ok) {
            rememberEventSignatures(sheetId, uniqueEvents, () => chrome.storage.local.remove('events'));
          } else {
            console.warn('Could not flush pending events:', response.status, response.statusText);
          }
        })
        .catch((error) => {
          console.warn('Network error while flushing pending events:', error);
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

  getStoredState(({ accessToken, sheetId, enabledEventTypes, logSheetTitle }) => {
    if (!shouldLogEvent(savedEvent, enabledEventTypes)) {
      return;
    }

    claimEventSignature(sheetId, savedEvent, (isNewEvent, finishSignature) => {
      if (!isNewEvent) return;

      if (!accessToken || !sheetId) {
        savePendingEvent(savedEvent, () => {
          finishSignature(false);
          console.log('Event saved locally until OAuth and sheet settings are configured.', savedEvent);
        });
        return;
      }

      ensureLogSheet(accessToken, sheetId, logSheetTitle, (sheetTitle) => {
        const row = buildRowForEvent(savedEvent);
        appendRowsToSheet(accessToken, sheetId, sheetTitle, [row])
          .then((response) => {
            if (response.ok) {
              finishSignature(true);
              return;
            }

            if (response.status === 401 || response.status === 403) {
              chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry'], () => {
                savePendingEvent(savedEvent, () => {
                  finishSignature(false);
                  console.warn('Authorization failed. Saved event locally and cleared expired token. Re-authorize in setup.');
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
              chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry'], () => {
                savePendingRawLine(rawLine, () => {
                  console.warn('Authorization failed for verbose logging. Saved raw line locally. Re-authorize in setup.');
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
  openSetupPage();
  getStoredState(({ accessToken, sheetId, logSheetTitle, verboseLoggingEnabled }) => {
    flushPendingEvents(accessToken, sheetId, logSheetTitle);
    flushPendingRawLines(accessToken, sheetId, verboseLoggingEnabled);
  });
});

chrome.runtime.onStartup.addListener(() => {
  getStoredState(({ accessToken, sheetId, logSheetTitle, verboseLoggingEnabled }) => {
    flushPendingEvents(accessToken, sheetId, logSheetTitle);
    flushPendingRawLines(accessToken, sheetId, verboseLoggingEnabled);
  });
});

chrome.action.onClicked.addListener(openSetupPage);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'parsedEvent') {
    handleParsedEvent(message.event, sender.tab?.url);
  } else if (message.type === 'rawConsoleLine') {
    handleRawConsoleLine(message.line, message.timestamp);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.googleAccessToken || changes.tokenExpiry || changes.sheetId || changes.verboseLoggingEnabled) {
    chrome.storage.local.get(['googleAccessToken', 'tokenExpiry', 'sheetId', 'logSheetTitle', 'verboseLoggingEnabled'], (result) => {
      const accessToken = result.googleAccessToken;
      const tokenExpiry = result.tokenExpiry || 0;
      const sheetId = result.sheetId;
      const logSheetTitle = result.logSheetTitle;
      const verboseLoggingEnabled = !!result.verboseLoggingEnabled;
      if (accessToken && sheetId && Date.now() < tokenExpiry) {
        flushPendingEvents(accessToken, sheetId, logSheetTitle);
        flushPendingRawLines(accessToken, sheetId, verboseLoggingEnabled);
      }
    });
  }
});
