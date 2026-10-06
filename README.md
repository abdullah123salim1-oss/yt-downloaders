# yt-downloaders

TubeGrab — a small Express app that fetches YouTube video details and downloads the
selected video/audio format through `yt-dlp` (via `youtube-dl-exec`), with live
progress streamed to the browser over Server-Sent Events.

## Project structure

```
yt-downloaders/
├── server.js           # Express API + static file server
├── package.json
├── package-lock.json
├── README.md
├── .gitignore
└── public/             # Front-end served statically
    ├── index.html
    ├── style.css
    └── script.js
```

## Requirements

- Node.js 18+
- `ffmpeg` available on the system PATH (needed when video and audio tracks are merged)

## Getting started

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` (override with `PORT`).

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/video-info?url=<youtube-url>` | Returns title, thumbnail, duration and available formats. |
| `GET` | `/api/download-progress/:id` | SSE stream of progress events for a download id. |
| `GET` | `/download?url=<youtube-url>&itag=<format_id>&progressId=<id>` | Downloads and streams the chosen format back as a file. |

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `DOWNLOAD_TEMP_DIR` | OS temp dir | Preferred scratch directory; the server picks the drive with the most free space. |

## Notes

Downloads are written to a temporary directory, streamed to the client, then removed.
The server requires at least 100 MB of free space before starting a download and
responds with HTTP 507 when storage is insufficient.

This tool is for personal use only — respect YouTube's Terms of Service and copyright law.
