// Paste URL from Clipboard
async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            document.getElementById('video-url').value = text;
            processVideo();
        }
    } catch (err) {
        showError("Clipboard permission denied. Please paste manually.");
    }
}

function showError(msg) {
    const errDiv = document.getElementById('error-msg');
    errDiv.innerText = msg;
    errDiv.style.display = 'block';
}

function clearError() {
    const errDiv = document.getElementById('error-msg');
    errDiv.innerText = '';
    errDiv.style.display = 'none';
}

// Fetch real video info & show thumbnail
async function processVideo() {
    clearError();
    const urlInput = document.getElementById('video-url').value.trim();
    const resultBox = document.getElementById('result-container');
    const startBtn = document.getElementById('fetch-btn');
    resultBox.style.display = 'none';
    document.getElementById('format-list').replaceChildren();

    if (!urlInput) {
        showError('Please paste a valid YouTube video link first.');
        return;
    }

    startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    startBtn.disabled = true;

    try {
        const response = await fetch(`/api/video-info?url=${encodeURIComponent(urlInput)}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error([data.error, data.details].filter(Boolean).join(' ') || 'Unable to fetch video details.');
        }

        document.getElementById('video-thumb').src = data.thumbnail || '';
        document.getElementById('video-title').innerText = data.title;
        document.getElementById('video-author').innerHTML =
            `<i class="fa-solid fa-circle-check" style="color:var(--primary);"></i> ${data.duration ? `Duration: ${formatDuration(data.duration)}` : 'Video ready'}`;

        const formatList = document.getElementById('format-list');
        formatList.replaceChildren();
        for (const format of data.formats || []) {
            const link = document.createElement('a');
            link.className = 'dl-option';
            link.href = `/download?url=${encodeURIComponent(urlInput)}&itag=${encodeURIComponent(format.itag)}`;
            link.target = 'download-frame';
            link.addEventListener('click', (event) => {
                event.preventDefault();
                if (activeProgressStream) return;
                startDownload(link.href);
            });
            link.textContent = `${format.type} ${format.quality} (${format.container})`;
            formatList.appendChild(link);
        }

        if (!formatList.childElementCount) {
            throw new Error('No downloadable formats were found for this video.');
        }

        resultBox.style.display = 'block';
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } catch (err) {
        showError(err.message || 'Error communicating with YouTube services.');
    } finally {
        startBtn.innerHTML = `<i class="fa-solid fa-bolt"></i> Start`;
        startBtn.disabled = false;
    }
}

function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

let activeProgressStream = null;

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
    formatLinks.forEach((link) => { link.setAttribute('aria-disabled', 'true'); });

    const progressStream = new EventSource(`/api/download-progress/${downloadId}`);
    activeProgressStream = progressStream;
    progressStream.onmessage = (event) => {
        const progress = JSON.parse(event.data);
        progressMessage.textContent = progress.message;
        progressBar.value = progress.percent || 0;
        progressDetails.textContent = progress.details || [
            progress.speed && `Speed: ${progress.speed}`,
            progress.eta && `Time left: ${progress.eta}`,
        ].filter(Boolean).join(' · ');

        if (progress.status === 'complete' || progress.status === 'error') {
            progressStream.close();
            activeProgressStream = null;
            formatLinks.forEach((link) => { link.removeAttribute('aria-disabled'); });
        }
    };
    progressStream.onerror = () => {
        if (progressStream.readyState === EventSource.CLOSED) {
            progressStream.close();
            if (activeProgressStream === progressStream) activeProgressStream = null;
            progressMessage.textContent = 'Progress connection lost. Check whether the download completed.';
            formatLinks.forEach((link) => { link.removeAttribute('aria-disabled'); });
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

// Allow pressing Enter key in the search input
document.getElementById('video-url').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        processVideo();
    }
});
