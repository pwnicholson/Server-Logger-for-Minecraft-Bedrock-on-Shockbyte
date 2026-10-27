# Changelog

## 0.0.6

- Always write parsed events to a `ServerLogs` tab, creating it when needed.
- Check existing log rows to avoid adding duplicate events after changing extension IDs or spreadsheet settings.
- Use Chrome's managed OAuth token cache for access-token renewal.