# Japan Shopping Receipt Tracker

A mobile-first travel expense tracker for Japan trips. Take or upload a receipt photo, run OCR in the browser, parse store/item/amount details, archive receipts by trip date range, and review daily totals.

## Live URL

Planned custom domain:

https://japan-shopping.0902.one/

GitHub Pages fallback after deployment:

https://xiao83902.github.io/japan-shopping/

## DNS setup for 0902.one

Create this DNS record in Cloudflare for the custom domain:

- Type: `CNAME`
- Name: `japan-shopping`
- Target: `xiao83902.github.io`
- Proxy status: DNS only

GitHub Pages will issue the HTTPS certificate after DNS resolves.

## Features

- Trip date range setup for travel-period expense tracking
- Japanese receipt OCR using Tesseract.js in the browser
- Store, item, and amount extraction
- Collapsible transaction detail lists
- Daily spending totals and trip summaries
- Trip/date/keyword search filters
- CSV export
- Responsive mobile and desktop UI
