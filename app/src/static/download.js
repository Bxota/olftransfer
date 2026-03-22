const token = window.location.pathname.split('/').pop();
let transferData = null;
let passwordValue = null;

function show(id) {
  ['state-loading', 'state-password', 'state-error', 'state-ready'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Charger les infos du transfert ───────────────────────────────────────────

async function loadTransfer() {
  try {
    const res = await fetch(`/transfers/${token}`);

    if (res.status === 404 || res.status === 410) {
      const data = await res.json();
      document.getElementById('error-title').textContent =
        res.status === 410 ? 'Transfert expiré' : 'Transfert introuvable';
      document.getElementById('error-msg').textContent = data.detail;
      show('state-error');
      return;
    }

    if (!res.ok) throw new Error();

    transferData = await res.json();
    renderTransfer();

  } catch {
    document.getElementById('error-title').textContent = 'Erreur';
    document.getElementById('error-msg').textContent = 'Impossible de charger ce transfert.';
    show('state-error');
  }
}

function renderTransfer() {
  const { files, expires_at, download_count, max_downloads } = transferData;

  document.getElementById('transfer-title').textContent =
    `${files.length} fichier${files.length > 1 ? 's' : ''}`;

  document.getElementById('meta-count').textContent =
    files.map(f => formatSize(f.size_bytes)).reduce((a, b) => `${a}, ${b}`);
  document.getElementById('meta-expiry').textContent = `Expire le ${formatDate(expires_at)}`;

  if (max_downloads) {
    document.getElementById('meta-downloads').textContent =
      `${download_count}/${max_downloads} téléchargements`;
  }

  document.getElementById('downloadList').innerHTML = files.map((f, i) => `
    <li class="download-item">
      <div class="file-type-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <div class="file-info">
        <div class="file-name">${f.filename}</div>
        <div class="file-size">${formatSize(f.size_bytes)}</div>
      </div>
      <button class="btn btn-outline btn-sm download-btn" data-index="${i}">
        Télécharger
      </button>
    </li>
  `).join('');

  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadFile(parseInt(btn.dataset.index)));
  });

  show('state-ready');
}

// ── Téléchargement ────────────────────────────────────────────────────────────

async function getDownloadUrls() {
  const params = passwordValue ? `?password=${encodeURIComponent(passwordValue)}` : '';
  const res = await fetch(`/transfers/${token}/download${params}`);

  if (res.status === 401) {
    show('state-password');
    return null;
  }
  if (res.status === 403) {
    document.getElementById('pw-error').textContent = 'Mot de passe incorrect.';
    document.getElementById('pw-error').classList.remove('hidden');
    show('state-password');
    return null;
  }
  if (!res.ok) {
    const data = await res.json();
    document.getElementById('error-title').textContent = 'Erreur';
    document.getElementById('error-msg').textContent = data.detail;
    show('state-error');
    return null;
  }

  return (await res.json()).files;
}

async function downloadFile(index) {
  const files = await getDownloadUrls();
  if (!files) return;
  triggerDownload(files[index].download_url, files[index].filename);
}

async function downloadAll() {
  const files = await getDownloadUrls();
  if (!files) return;
  for (const f of files) {
    triggerDownload(f.download_url, f.filename);
    await new Promise(r => setTimeout(r, 200));
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Mot de passe ──────────────────────────────────────────────────────────────

document.getElementById('unlockBtn').addEventListener('click', async () => {
  passwordValue = document.getElementById('passwordInput').value;
  document.getElementById('pw-error').classList.add('hidden');

  // Re-charger les infos du transfert avec le mot de passe
  const res = await fetch(`/transfers/${token}`);
  if (res.ok) {
    transferData = await res.json();
    renderTransfer();
  }
});

document.getElementById('passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('unlockBtn').click();
});

// ── Tout télécharger ──────────────────────────────────────────────────────────

document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);

// ── Init ──────────────────────────────────────────────────────────────────────

loadTransfer();
