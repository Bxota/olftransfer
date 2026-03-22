const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const progressList = document.getElementById('progressList');

let files = [];

// ── Drag & drop ──────────────────────────────────────────────────────────────

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});

fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
document.getElementById('addMoreBtn').addEventListener('click', () => fileInput.click());

function addFiles(newFiles) {
  files = [...files, ...newFiles];
  renderFileList();
  showSections();
}

function showSections() {
  const hasFiles = files.length > 0;
  document.getElementById('file-list-section').classList.toggle('hidden', !hasFiles);
  document.getElementById('options-section').classList.toggle('hidden', !hasFiles);
  document.getElementById('action-section').classList.toggle('hidden', !hasFiles);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function renderFileList() {
  fileList.innerHTML = files.map((f, i) => `
    <li class="file-item">
      <div class="file-type-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <div class="file-info">
        <div class="file-name">${f.name}</div>
        <div class="file-size">${formatSize(f.size)}</div>
      </div>
      <button class="file-remove" data-index="${i}" title="Retirer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </li>
  `).join('');

  fileList.querySelectorAll('.file-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      files.splice(parseInt(btn.dataset.index), 1);
      renderFileList();
      showSections();
    });
  });
}

// ── Send ─────────────────────────────────────────────────────────────────────

document.getElementById('sendBtn').addEventListener('click', send);
// Afficher le lien admin si admin
fetch('/auth/me').then(r => r.json()).then(user => {
  if (user.is_admin) {
    const actions = document.getElementById('headerActions');
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.className = 'btn btn-ghost btn-sm';
    adminLink.textContent = 'Admin';
    actions.insertBefore(adminLink, actions.firstChild);
  }
}).catch(() => {});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

document.getElementById('newTransferBtn').addEventListener('click', () => {
  files = [];
  renderFileList();
  showSections();
  document.getElementById('step-select').classList.remove('hidden');
  document.getElementById('step-done').classList.add('hidden');
});

async function send() {
  const errorEl = document.getElementById('error');
  errorEl.classList.add('hidden');

  if (files.length === 0) return;

  const expiresIn = parseInt(document.getElementById('expiry').value);
  const maxDownloads = document.getElementById('maxDownloads').value || null;
  const password = document.getElementById('password').value || null;

  document.getElementById('sendBtn').disabled = true;

  try {
    // 1. Créer le transfert
    const res = await fetch('/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: files.map(f => ({ filename: f.name, size_bytes: f.size, mime_type: f.type || null })),
        expires_in_hours: expiresIn,
        max_downloads: maxDownloads ? parseInt(maxDownloads) : null,
        password,
      }),
    });

    if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur');

    const transfer = await res.json();

    // 2. Afficher la progression
    document.getElementById('step-select').classList.add('hidden');
    document.getElementById('step-uploading').classList.remove('hidden');
    renderProgressList();

    // 3. Uploader chaque fichier
    for (let i = 0; i < files.length; i++) {
      const { upload_url } = transfer.uploads[i];
      await uploadFile(files[i], upload_url, i);
    }

    // 4. Afficher le lien
    document.getElementById('step-uploading').classList.add('hidden');
    document.getElementById('step-done').classList.remove('hidden');
    const linkEl = document.getElementById('shareLink');
    linkEl.textContent = transfer.share_url;
    linkEl.href = transfer.share_url;

  } catch (err) {
    document.getElementById('step-select').classList.remove('hidden');
    document.getElementById('step-uploading').classList.add('hidden');
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

function renderProgressList() {
  progressList.innerHTML = files.map((f, i) => `
    <li class="file-item" id="prog-${i}">
      <div class="file-type-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <div class="file-info">
        <div class="file-name">${f.name}</div>
        <div class="progress"><div class="progress-bar" id="bar-${i}"></div></div>
      </div>
      <span class="file-status" id="status-${i}">En attente</span>
    </li>
  `).join('');
}

function uploadFile(file, url, index) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (file.type) xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById(`bar-${index}`).style.width = `${pct}%`;
        document.getElementById(`status-${index}`).textContent = `${pct}%`;
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        document.getElementById(`bar-${index}`).style.width = '100%';
        const s = document.getElementById(`status-${index}`);
        s.textContent = 'Envoyé';
        s.className = 'file-status done';
        resolve();
      } else {
        reject(new Error(`Erreur upload: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Erreur réseau'));
    xhr.send(file);
  });
}

// ── Copier le lien ────────────────────────────────────────────────────────────

document.getElementById('copyBtn').addEventListener('click', () => {
  const link = document.getElementById('shareLink').textContent;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copié !';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copier'; btn.classList.remove('copied'); }, 2000);
  });
});
