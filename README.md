# Japan Shopping Receipt Tracker

A mobile-first travel expense tracker for Japan trips. Take or upload a receipt photo, run OCR in the browser, parse store/item/amount details, archive receipts by trip date range, and review daily totals.

## Live URL

https://japan-shopping.0902.one/

## Deployment

This repository is published with GitHub Pages from the `main` branch at `/ (root)`.

The custom domain is configured by:

- `CNAME` in this repository: `japan-shopping.0902.one`
- Cloudflare DNS: `CNAME japan-shopping -> xiao83902.github.io`
- Cloudflare proxy status: DNS only
- GitHub Pages HTTPS enforcement enabled

## Cloud Sync

Cross-device sync is powered by a Cloudflare Worker and D1 database.

- API URL: `https://japan-shopping-sync.0902.one`
- Worker: `japan-shopping-sync`
- D1 database: `japan-shopping-sync`
- D1 database ID: `1e29f475-88f3-4c6b-976b-564db6b33c4e`
- DNS: `CNAME japan-shopping-sync -> japan-shopping-sync.mute-glade-452a.workers.dev`
- Cloudflare proxy status: Proxied

Use the same sync code on each device to read and write the same trip data. The sync code is hashed in the browser before requests are sent to the API.

## Features

- Trip date range setup for travel-period expense tracking
- Japanese receipt OCR using Tesseract.js in the browser
- Store, item, and amount extraction
- Collapsible transaction detail lists
- Daily spending totals and trip summaries
- Trip/date/keyword search filters
- Cross-device sync through Cloudflare D1
- CSV export
- Responsive mobile and desktop UI
