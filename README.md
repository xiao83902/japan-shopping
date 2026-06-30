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

## Features

- Trip date range setup for travel-period expense tracking
- Japanese receipt OCR using Tesseract.js in the browser
- Store, item, and amount extraction
- Collapsible transaction detail lists
- Daily spending totals and trip summaries
- Trip/date/keyword search filters
- CSV export
- Responsive mobile and desktop UI
