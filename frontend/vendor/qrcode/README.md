# Vendored qrcode (node-qrcode)

Pinned browser bundle for Configuration → Channels **Quick Deploy** QR codes.
Vendored so field Pis without WAN can still share Meshtastic channel URLs.

## Files

| File            | Source                                                      | Bytes |
|-----------------|-------------------------------------------------------------|------:|
| `qrcode.min.js` | https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js     | 23738 |

## Version

- `qrcode` 1.5.1 (jsdelivr `build/qrcode.min.js` bundle; exposes global `QRCode`)

## Why vendored

The dashboard previously loaded `qrcode@1.5.4/build/qrcode.min.js` from jsdelivr — that
path returns **404**. The working browser bundle lives at `/npm/qrcode/build/qrcode.min.js`
(without a patch pin on the build artifact).

## License

MIT — https://github.com/soldair/node-qrcode

## Refresh procedure

```bash
curl -fsSLo frontend/vendor/qrcode/qrcode.min.js \
  https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js
```

Update the byte count in the table above after refresh.
