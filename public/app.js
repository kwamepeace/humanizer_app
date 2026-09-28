(() => {
  const form = document.getElementById('order-form');
  const fileInput = document.getElementById('file');
  const fileName = document.getElementById('file-name');
  const drop = document.getElementById('drop');
  const errorBox = document.getElementById('error');
  const button = document.getElementById('submit');
  const buttonLabel = button.textContent;
  const maxMb = Number(document.body.dataset.maxMb);
  const allowed = ['.doc', '.docx', '.pdf', '.odt', '.rtf', '.txt'];

  // Kept after upload so a cancelled payment can be resumed without re-uploading.
  let order = null;

  const support = document.getElementById('support');
  if (!support.querySelector('a').textContent.trim()) support.hidden = true;

  form.addEventListener('input', () => { order = null; });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileName.textContent = file ? file.name : 'Tap to choose your thesis';
    drop.classList.toggle('has-file', Boolean(file));
  });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, () => drop.classList.add('over')));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function setBusy(label) {
    button.disabled = Boolean(label);
    button.textContent = label || (order ? 'Complete payment' : buttonLabel);
  }

  function showResult(id, reference) {
    form.hidden = true;
    const panel = document.getElementById(id);
    panel.querySelector('[data-ref]').textContent = reference;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function validate() {
    const data = new FormData(form);
    if (!String(data.get('name')).trim()) return 'Please enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.get('email')).trim())) return 'Please enter a valid email address.';
    const file = fileInput.files[0];
    if (!file) return 'Please attach your document.';
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowed.includes(ext)) return 'Please upload a Word, PDF, ODT, RTF or TXT file.';
    if (file.size > maxMb * 1024 * 1024) return `File is too large. Maximum size is ${maxMb} MB.`;
    return '';
  }

  function uploadOrder() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/orders');
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setBusy(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`);
      };
      xhr.onload = () => {
        if (xhr.status === 200 && xhr.response) resolve(xhr.response);
        else reject(new Error((xhr.response && xhr.response.error) || 'Upload failed. Please try again.'));
      };
      xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
      xhr.send(new FormData(form));
    });
  }

  function pay(accessCode) {
    return new Promise((resolve, reject) => {
      if (typeof PaystackPop === 'undefined') {
        reject(new Error('Payment window could not load. Check your connection and refresh the page.'));
        return;
      }
      new PaystackPop().resumeTransaction(accessCode, {
        onSuccess: resolve,
        onCancel: () => reject(new Error('Payment cancelled. Your document has not been sent — tap the button when you are ready to pay.')),
        onError: (err) => reject(new Error((err && err.message) || 'Payment could not start. Please try again.')),
      });
    });
  }

  async function confirm(reference) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`/api/orders/${encodeURIComponent(reference)}/confirm`, { method: 'POST' }).catch(() => null);
      if (res && res.ok) return 'received';
      await new Promise((r) => setTimeout(r, 3000));
    }
    return 'pending';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const problem = validate();
    if (problem) return showError(problem);

    try {
      if (!order) {
        setBusy('Uploading…');
        order = await uploadOrder();
      }
      setBusy('Waiting for payment…');
      await pay(order.accessCode);
      setBusy('Confirming payment…');
      const status = await confirm(order.reference);
      showResult(status === 'received' ? 'success' : 'pending', order.reference);
    } catch (err) {
      showError(err.message);
      setBusy('');
    }
  });
})();
