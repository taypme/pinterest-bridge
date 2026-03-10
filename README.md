# Pinterest Bridge App

This project mirrors the structure of `./resume`:

- `./js`: local bridge server and CLI runners
- `./ext`: Chrome extension that connects to the bridge and drives Pinterest
- `./json`: one JSON file per pin, named `<pinId>.json`

## Setup

```bash
npm install
npm run setup
npm run build:ext
```

## Run

Start the bridge:

```bash
npm run server
```

Then use:

```bash
npm run scrape <url>
npm run sync
```

`scrape` collects pins only from the Pinterest board or user URL you provide and saves each pin to `./json/<pinId>.json`.

`sync` visits each saved pin and attempts to quick-save it to the currently logged-in Pinterest profile, without selecting a board.
