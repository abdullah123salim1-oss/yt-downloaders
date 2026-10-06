const cors = require('cors');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const youtubeDl = require('youtube-dl-exec');

const app = express();
const port = process.env.PORT || 3000;
const supportedYoutubeHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const downloadProgress = new Map();
const minimumDownloadSpace = 100 * 1024 * 1024;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isYoutubeUrl(value) {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && supportedYoutubeHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function getDownloadableFormats(info) {
  const formats = info.formats || [];
  const videoFormatsByHeight = new Map();
  const audioFormats = formats.filter((format) =>
    format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none')
  );

  for (const format of formats) {
    if (!format.vcodec || format.vcodec === 'none' || !format.height) continue;

    const existing = videoFormatsByHeight.get(format.height);
    const score = (format.protocol === 'https' ? 4 : 0) +
      (format.ext === 'mp4' ? 2 : 0) +
      (format.vcodec.startsWith('avc1') ? 1 : 0);
    const existingScore = existing
      ? (existing.protocol === 'https' ? 4 : 0) +
        (existing.ext === 'mp4' ? 2 : 0) +
        (existing.vcodec.startsWith('avc1') ? 1 : 0)
      : -1;

    if (!existing || score > existingScore) {
      videoFormatsByHeight.set(format.height, format);
    }
  }

  const videoChoices = [...videoFormatsByHeight.values()]
    .sort((first, second) => second.height - first.height)
    .map((format) => ({
      itag: format.format_id,
      quality: format.format_note || `${format.height}p`,
      container: !format.acodec || format.acodec === 'none' ? 'mkv' : format.ext,
      type: 'Video',
      needsAudioMerge: !format.acodec || format.acodec === 'none',
    }));
  const audioChoices = audioFormats.map((format) => ({
    itag: format.format_id,
    quality: format.format_note || 'Audio only',
    container: format.ext,
    type: 'Audio',
    needsAudioMerge: false,
  }));

  return [...videoChoices, ...audioChoices];
}

async function getVideoInfo(videoUrl) {
  const tempDir = await createDownloadTempDir();
  try {
    return await youtubeDl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      jsRuntimes: 'node',
    }, {
      env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir },
      windowsHide: true,
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function getErrorDetails(error) {
  const details = error.stderr || error.message || 'Unknown extractor error';
  return details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ')
    .slice(0, 400);
}

function getDownloadProgress(id) {
  let progress = downloadProgress.get(id);
  if (!progress) {
    progress = { status: 'queued', message: 'Waiting for download to start.', percent: 0, clients: new Set() };
    downloadProgress.set(id, progress);
  }
  return progress;
}

function updateDownloadProgress(id, update) {
  const progress = getDownloadProgress(id);
  Object.assign(progress, update);
  const event = `data: ${JSON.stringify({
    status: progress.status,
    message: progress.message,
    percent: progress.percent,
    speed: progress.speed,
    eta: progress.eta,
    details: progress.details,
  })}\n\n`;
  for (const client of progress.clients) {
    client.write(event);
  }

  if (progress.status === 'complete' || progress.status === 'error') {
    setTimeout(() => {
      if (downloadProgress.get(id) === progress) {
        downloadProgress.delete(id);
      }
    }, 60_000).unref();
  }
}

async function createDownloadTempDir(requiredBytes = minimumDownloadSpace) {
  const candidates = new Set([
    process.env.DOWNLOAD_TEMP_DIR,
    os.tmpdir(),
  ].filter(Boolean));

  if (process.platform === 'win32') {
    for (let letter = 65; letter <= 90; letter += 1) {
      candidates.add(`${String.fromCharCode(letter)}:\\`);
    }
  }

  const availableLocations = [];
  for (const candidate of candidates) {
    try {
      const stats = await fs.promises.statfs(candidate);
      const availableBytes = stats.bavail * stats.bsize;
      if (availableBytes >= requiredBytes) {
        availableLocations.push({ path: candidate, availableBytes });
      }
    } catch {
      // A drive may not be mounted or accessible.
    }
  }

  availableLocations.sort((first, second) => second.availableBytes - first.availableBytes);
  for (const location of availableLocations) {
    try {
      return await fs.promises.mkdtemp(path.join(location.path, 'yt-downloader-'));
    } catch {
      // Try the next writable location.
    }
  }

  const error = new Error('No writable drive has enough free space for this download. Free up space or connect another drive.');
  error.code = 'INSUFFICIENT_STORAGE';
  throw error;
}

app.get('/api/video-info', async (req, res) => {
  const videoUrl = req.query.url;

  if (!isYoutubeUrl(videoUrl)) {
    return res.status(400).json({ error: 'Enter a valid YouTube video URL.' });
  }

  try {
    const info = await getVideoInfo(videoUrl);
    const formats = getDownloadableFormats(info);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail || '',
      duration: info.duration,
      formats,
    });
  } catch (error) {
    const details = getErrorDetails(error);
    console.error('Failed to fetch YouTube video details:', details);
    res.status(502).json({
      error: 'Could not fetch video details. The video may be unavailable or YouTube may be temporarily blocking requests.',
      details,
    });
  }
});

app.get('/api/download-progress/:id', (req, res) => {
  if (!/^[\w-]{16,64}$/.test(req.params.id)) {
    return res.status(400).end();
  }

  const progress = getDownloadProgress(req.params.id);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  progress.clients.add(res);
  res.write(`data: ${JSON.stringify({
    status: progress.status,
    message: progress.message,
    percent: progress.percent,
    speed: progress.speed,
    eta: progress.eta,
    details: progress.details,
  })}\n\n`);

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    progress.clients.delete(res);
  });
});

app.get('/download', async (req, res) => {
  const { url: videoUrl, itag, progressId } = req.query;
  const downloadId = typeof progressId === 'string' && /^[\w-]{16,64}$/.test(progressId)
    ? progressId
    : crypto.randomUUID();

  if (!isYoutubeUrl(videoUrl) || typeof itag !== 'string' || !itag) {
    updateDownloadProgress(downloadId, {
      status: 'error',
      message: 'A valid YouTube URL and format are required.',
      percent: 0,
    });
    return res.status(400).json({ error: 'A valid YouTube URL and format are required.' });
  }

  updateDownloadProgress(downloadId, { status: 'starting', message: 'Checking video and available storage.', percent: 0 });

  let tempDir;
  try {
    const info = await getVideoInfo(videoUrl);
    const selectedFormat = (info.formats || []).find((format) => format.format_id === itag);

    if (!selectedFormat) {
      updateDownloadProgress(downloadId, {
        status: 'error',
        message: 'That format is no longer available. Search for the video again.',
        percent: 0,
      });
      return res.status(400).json({ error: 'That format is no longer available. Search for the video again.' });
    }

    const isAudioOnly = selectedFormat.acodec !== 'none' &&
      (!selectedFormat.vcodec || selectedFormat.vcodec === 'none');
    const hasAudio = Boolean(selectedFormat.acodec && selectedFormat.acodec !== 'none');
    const formatSelector = isAudioOnly || hasAudio
      ? itag
      : `${itag}+bestaudio/best`;
    const selectedAudio = !isAudioOnly && !hasAudio
      ? (info.formats || [])
        .filter((format) => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'))
        .sort((first, second) => (second.filesize || second.filesize_approx || 0) - (first.filesize || first.filesize_approx || 0))[0]
      : null;
    const estimateSize = (format) => format?.filesize || format?.filesize_approx || 0;
    const estimatedBytes = estimateSize(selectedFormat) + estimateSize(selectedAudio);
    const requiredBytes = Math.max(
      minimumDownloadSpace,
      Math.ceil(estimatedBytes * 1.1) + 50 * 1024 * 1024,
    );

    updateDownloadProgress(downloadId, { status: 'preparing', message: 'Checking free space and preparing your download.', percent: 0 });
    tempDir = await createDownloadTempDir(requiredBytes);
    updateDownloadProgress(downloadId, {
      status: 'downloading',
      message: `Downloading video data using temporary storage on ${path.parse(tempDir).root}`,
      percent: 0,
    });
    const subprocess = youtubeDl.exec(videoUrl, {
      format: formatSelector,
      output: path.join(tempDir, 'download.%(ext)s'),
      noPlaylist: true,
      noWarnings: true,
      newline: true,
      jsRuntimes: 'node',
      mergeOutputFormat: 'mkv',
    }, {
      env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir },
      windowsHide: true,
    });
    let stderrBuffer = '';
    subprocess.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';

      for (const line of lines) {
        const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%.*?(?:at\s+(.+?))?(?:\s+ETA\s+(.+))?$/);
        if (match) {
          updateDownloadProgress(downloadId, {
            status: 'downloading',
            message: `Downloading video data: ${match[1]}%`,
            percent: Math.min(99, Number(match[1])),
            speed: match[2],
            eta: match[3],
          });
        } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
          updateDownloadProgress(downloadId, { status: 'merging', message: 'Combining video and audio tracks.', percent: 99 });
        }
      }
    });
    await subprocess;

    const files = await fs.promises.readdir(tempDir);
    const downloadedFile = files.find((file) => file.startsWith('download.') && !file.endsWith('.part'));
    if (!downloadedFile) {
      throw new Error('yt-dlp finished without producing a download file.');
    }

    const filename = `video${path.extname(downloadedFile) || '.mkv'}`;
    const filePath = path.join(tempDir, downloadedFile);
    const fileSize = (await fs.promises.stat(filePath)).size;
    let sentBytes = 0;
    let lastSentPercent = -1;
    updateDownloadProgress(downloadId, { status: 'sending', message: 'Sending file to your browser.', percent: 0 });
    res.attachment(filename);
    await pipeline(
      fs.createReadStream(filePath),
      new Transform({
        transform(chunk, _encoding, callback) {
          sentBytes += chunk.length;
          const percent = Math.min(100, Math.round((sentBytes / fileSize) * 100));
          if (percent !== lastSentPercent) {
            lastSentPercent = percent;
            updateDownloadProgress(downloadId, {
              status: 'sending',
              message: `Sending file to your browser: ${percent}%`,
              percent,
            });
          }
          callback(null, chunk);
        },
      }),
      res,
    );
    updateDownloadProgress(downloadId, { status: 'complete', message: 'Download complete.', percent: 100 });
  } catch (error) {
    const details = getErrorDetails(error);
    console.error('Failed to download YouTube video:', details);
    if (!res.headersSent) {
      const insufficientStorage = error.code === 'INSUFFICIENT_STORAGE' ||
        /errno 28|no space left on device|not enough space on the disk/i.test(details);
      const message = insufficientStorage
        ? 'There is not enough free disk space to prepare this download. Free up storage or connect another drive and try again.'
        : 'Could not download this format. Please try a different quality or try again later.';
      updateDownloadProgress(downloadId, { status: 'error', message, percent: 0, details });
      res.status(insufficientStorage ? 507 : 502).json({ error: message, details });
    } else if (!res.destroyed) {
      updateDownloadProgress(downloadId, {
        status: 'error',
        message: 'The file transfer was interrupted.',
        percent: 0,
        details,
      });
      res.destroy(error);
    }
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
