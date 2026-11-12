# Google Authenticator Export Converter

A small static web app that converts a Google Authenticator **Transfer accounts** export
(`otpauth-migration://offline?data=…`) into standard `otpauth://` URIs and one QR code per
account, so the accounts can be imported into any other authenticator or password manager.

Everything runs locally in the browser. There is no server, no build step and no network
access — a Content-Security-Policy in `index.html` blocks all outgoing requests.

## Use

Open `index.html` in a browser (double-clicking the file works), or serve the folder:

```bash
python3 -m http.server 8000
```

Then add your export in any of these ways:

- choose, drop or paste (Ctrl/⌘+V) screenshots of the export QR codes
- scan the QR codes with a camera (needs `https://` or `localhost`)
- paste the `otpauth-migration://` URI as text

Large exports are split over several QR codes; add each one and the accounts accumulate.
For each account you get the `otpauth://` URI and a QR code, with buttons to copy, download
or print them.

> The output contains your secret keys. Treat it like a password.

## Files

- `index.html`, `style.css`, `app.js` — the UI
- `migration.js` — export decoder (protobuf → accounts → `otpauth://` URIs); also usable from Node
- `vendor/jsQR.js` — QR decoding ([jsQR](https://github.com/cozmo/jsQR), Apache-2.0)
- `vendor/qrcode.js` — QR generation ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT)

## Tests

```bash
node --test test/*.test.js
```
