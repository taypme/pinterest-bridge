# Bridge Server (`./js`)

## Run the server

```bash
npm run server
```

This starts:
- HTTP: `http://127.0.0.1:18374`
- WebSocket: `ws://127.0.0.1:18373`

The bridge writes each scraped pin to `../json/<pinId>.json`.

## Commands

```bash
npm run scrape <url>
npm run sync
```

`scrape` asks the extension to collect pins only from the specific Pinterest board or user URL you provide.

`sync` asks the extension to ensure every JSON pin in `../json` is quick-saved to the logged-in Pinterest profile without choosing a board.
