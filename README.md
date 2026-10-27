# Shockbyte Server Logger for Minecraft Bedrock

Version 0.0.6

A Chrome extension that reads Shockbyte console pages, parses server events, and prepares data for Google Sheets.

## What is included

- `manifest.json`: Chrome extension manifest (Manifest V3)
- `background.js`: opens the setup screen on install and when the icon is clicked
- `content-script.js`: scans the Shockbyte console page for new messages and parses events
- `setup.html` / `setup.js`: setup flow, OAuth authorization, and configuration UI
- `style.css`: simple styling for the setup page

## How to use

1. Clone this repo to your local machine.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click `Load unpacked` and select this folder.
5. In the setup screen, enter the Google Spreadsheet URL or ID you want to write to.
6. Choose which event types to log.
7. Optionally enter custom keywords, separated by commas, to log any console lines that contain those phrases.
8. Click `Save settings`.
9. Click `Authorize Google` and sign in to your Google account.
10. Open the Shockbyte console at `https://panel.shockbyte.com/` and keep it open.

Parsed events are always written to the `ServerLogs` tab. The extension creates that tab if it is missing; other tabs such as `Summary` are left untouched.

The spreadsheet URL is saved in Chrome Sync, so it is available on other computers where you use the same Chrome profile with Sync enabled. OAuth authorization is managed separately by Chrome and may need to be granted once on each computer.

## Google Cloud setup

1. In the [Google Cloud Console](https://console.cloud.google.com/), select the project that contains the OAuth client.
2. To enable Sheets access, open `APIs & Services` > `Library`, search for `Google Sheets API`, open it, and click `Enable`.
3. To review test users or publishing status, open `Google Auth Platform` > `Audience`. For a personal Gmail account, use the `External` audience and add your account under `Test users` while the app is in Testing.
4. When ready for broader use, change `Publishing status` to `In production`. Google may require OAuth verification for the Sheets scope; until approval, users may see an unverified-app warning and user limits may apply.

The OAuth client ID is configured in the extension manifest. Users don't need to enter it. Chrome manages short-lived access tokens and refreshes them when needed; this is separate from the consent screen's Testing or In production status.

## What happens next

- The extension watches the Shockbyte console page for matching log lines.
- If the console reports a disconnection, the extension automatically refreshes the page, waiting at least 30 seconds between attempts and stopping after three attempts until the error clears.
- Parsed events are automatically sent to Google Sheets once authorization is complete.
- Before writing, the extension checks existing rows in `ServerLogs` and skips events already recorded there.
- Recently logged events are remembered locally to prevent repeat rows after refresh. A `player connected` and `player spawned` pair for the same player within 15 seconds is treated as one join.
- Events are written as rows with separate columns for:
  - timestamp
  - event type
  - server name
  - server address
  - location
  - server version
  - player slots
  - player name
  - keyword or extra details
- If verbose logging is enabled, the extension creates a `Verbatim` tab in the selected spreadsheet and copies unique console lines there, including when verbose logging is enabled after changing spreadsheets.
- If the extension is not yet authorized or the sheet is not configured, matching events are saved locally and uploaded later.

## Notes

- The extension stores configuration locally in Chrome storage. Chrome manages the OAuth access-token cache and renews tokens when needed.
- This repo does not include any private Google Cloud secrets.
- The extension uses OAuth to connect to Google Sheets without storing a password.
