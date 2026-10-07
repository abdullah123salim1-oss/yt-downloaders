const form = document.getElementById('video-form');
const urlInput = document.getElementById('video-url');
const startButton = document.getElementById('fetch-btn');
const errorMessage = document.getElementById('error-msg');
const resultContainer = document.getElementById('result-container');
const formatList = document.getElementById('format-list');
const menuToggle = document.getElementById('menu-toggle');
const navigation = document.getElementById('site-navigation');
let activeProgressStream = null;

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

function clearError() {
    errorMessage.textContent = '';
    errorMessage.style.display = 'none';
}

function isYoutubeUrl(value) {
    try {
        const url = new URL(value);
        const supportedHosts = [
            'youtube.com',
            'www.youtube.com',
            'm.youtube.com',
            'music.youtube.com',
            'youtu.be',
            'www.youtu.be',
        ];
        return ['http:', 'https:'].includes(url.protocol) &&
            supportedHosts.includes(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function setMenuOpen(isOpen) {
    navigation.classList.toggle('is-open', isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
    menuToggle.innerHTML = `<i class="fa-solid fa-${isOpen ? 'xmark' : 'bars'}" aria-hidden="true"></i>`;
}

menuToggle.addEventListener('click', () => {
    setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
});

navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenuOpen(false);
});

document.getElementById('paste-btn').addEventListener('click', async () => {
    clearError();
    try {
        urlInput.value = await navigator.clipboard.readText();
        if (urlInput.value.trim()) form.requestSubmit();
    } catch {
        showError('Clipboard access is unavailable here. Paste the link into the box manually.');
        urlInput.focus();
    }
});

function formatDuration(seconds) {
    const totalSeconds = Math.floor(Number(seconds));
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
        : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function addFormats(formats, videoUrl) {
    for (const format of formats) {
        if (!format.itag || !format.type || !format.quality || !format.container) continue;
        const link = document.createElement('a');
        link.className = 'dl-option';
        link.href = `/download?url=${encodeURIComponent(videoUrl)}&itag=${encodeURIComponent(format.itag)}`;
        link.textContent = `${format.type} ${format.quality} (${format.container})`;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            startDownload(link.href);
        });
        formatList.appendChild(link);
    }
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    resultContainer.style.display = 'none';
    formatList.replaceChildren();

    const videoUrl = urlInput.value.trim();
    if (!isYoutubeUrl(videoUrl)) {
        showError('Enter a valid YouTube video or Shorts URL.');
        urlInput.focus();
        return;
    }

    startButton.disabled = true;
    startButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Checking...';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
        const response = await fetch(`/api/video-info?url=${encodeURIComponent(videoUrl)}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(data.error || 'Could not retrieve video information.');

        const thumbnail = document.getElementById('video-thumb');
        thumbnail.src = data.thumbnail || '';
        thumbnail.hidden = !data.thumbnail;
        document.getElementById('video-title').textContent = data.title || 'Video ready';
        document.getElementById('video-author').textContent = data.duration
            ? `Duration: ${formatDuration(data.duration)}`
            : 'Video ready';

        addFormats(Array.isArray(data.formats) ? data.formats : [], videoUrl);
        if (!formatList.childElementCount) {
            throw new Error('No downloadable formats were found for this video.');
        }

        resultContainer.style.display = 'block';
        resultContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        showError(error.name === 'AbortError'
            ? 'The request took too long. YouTube may be limiting requests right now; wait a little and try again.'
            : error.message || 'Could not communicate with the video service.');
    } finally {
        clearTimeout(timeout);
        startButton.disabled = false;
        startButton.innerHTML = '<i class="fa-solid fa-bolt" aria-hidden="true"></i> Start';
    }
});

function createDownloadId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

function startDownload(downloadUrl) {
    const progressBox = document.getElementById('download-progress');
    const progressMessage = document.getElementById('download-progress-message');
    const progressDetails = document.getElementById('download-progress-details');
    const progressBar = document.getElementById('download-progress-bar');
    const formatLinks = document.querySelectorAll('.dl-option');

    activeProgressStream?.close();
    const downloadId = createDownloadId();
    const url = new URL(downloadUrl, window.location.href);
    url.searchParams.set('progressId', downloadId);

    progressBox.hidden = false;
    progressMessage.textContent = 'Starting download...';
    progressDetails.textContent = '';
    progressBar.value = 0;
    formatLinks.forEach((link) => link.setAttribute('aria-disabled', 'true'));

    const progressStream = new EventSource(`/api/download-progress/${downloadId}`);
    activeProgressStream = progressStream;
    progressStream.onmessage = (event) => {
        try {
            const progress = JSON.parse(event.data);
            progressMessage.textContent = progress.message || 'Download in progress.';
            progressBar.value = Number(progress.percent) || 0;
            progressDetails.textContent = [
                progress.speed && `Speed: ${progress.speed}`,
                progress.eta && `Time left: ${progress.eta}`,
            ].filter(Boolean).join(' · ');

            if (progress.status === 'complete' || progress.status === 'error') {
                progressStream.close();
                activeProgressStream = null;
                formatLinks.forEach((link) => link.removeAttribute('aria-disabled'));
            }
        } catch {
            progressMessage.textContent = 'Received an unreadable progress update. Please try again.';
        }
    };
    progressStream.onerror = () => {
        if (progressStream.readyState === EventSource.CLOSED) {
            progressStream.close();
            if (activeProgressStream === progressStream) activeProgressStream = null;
            progressMessage.textContent = 'Progress connection lost. Check whether the download completed.';
            formatLinks.forEach((link) => link.removeAttribute('aria-disabled'));
        }
    };

    const downloadLink = document.createElement('a');
    downloadLink.href = url.toString();
    downloadLink.target = 'download-frame';
    downloadLink.hidden = true;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
}
