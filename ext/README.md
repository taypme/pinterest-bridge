# Chrome Extension (`./ext`)

## Install and build

```bash
npm run setup
npm run build:ext
```

## Load into Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select `ext/dist`

The background service worker connects to `ws://127.0.0.1:18373`.

## Notes

- Source: `ext/src/background.js`
- Built file: `ext/dist/background.js`
- Manifest: `ext/dist/manifest.json`

Use a Chrome profile that is already logged into Pinterest.
