/*
 * Timesheet, host side. The UI lives in index.html, and the app adds its
 * sidebar entry (an iFrame plugin gets one named and iconed from the
 * manifest). This file saves files the view produces (CSV exports, JSON
 * backups): the plugin iframe is sandboxed without downloads, so it posts the
 * file here and this code saves it from the app.
 */
const PLUGIN_ID = 'sp-timesheet';
const MAX_EXPORT_CHARS = 20 * 1024 * 1024;
const EXPORT_NAME_RE = /^[\w.-]{1,120}\.(csv|json)$/;
const EXPORT_TYPES = { csv: 'text/csv;charset=utf-8', json: 'application/json' };

// Super Productivity renders plugin views with srcdoc and tags each iframe
// with data-plugin-id. The iframe is same-origin, so the sender's frameElement
// tells us whether a message really came from this plugin's own view and not
// from another plugin's.
const isOwnView = (source) => {
  try {
    const frame = source && source.frameElement;
    return !!frame && frame.getAttribute('data-plugin-id') === PLUGIN_ID;
  } catch {
    return false;
  }
};

const saveFile = async (filename, data) => {
  if (typeof PluginAPI.downloadFile === 'function') {
    await PluginAPI.downloadFile(filename, data);
    return;
  }
  // Hosts without downloadFile: a regular download from the app window.
  const type = EXPORT_TYPES[filename.split('.').pop()] || 'text/plain';
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const onMessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'SP_TIMESHEET_DOWNLOAD' || !isOwnView(event.source)) return;
  const reply = (ok, error) => event.source.postMessage(
    { type: 'SP_TIMESHEET_DOWNLOAD_RESULT', requestId: msg.requestId, ok, error },
    '*',
  );
  if (typeof msg.data !== 'string' || msg.data.length > MAX_EXPORT_CHARS || !EXPORT_NAME_RE.test(String(msg.filename))) {
    reply(false, 'Rejected export: bad file name or content');
    return;
  }
  // Received; saving can take a while if the app asks where to save.
  event.source.postMessage({ type: 'SP_TIMESHEET_DOWNLOAD_ACK', requestId: msg.requestId }, '*');
  try {
    await saveFile(msg.filename, msg.data);
    reply(true);
  } catch (err) {
    console.error('[Timesheet] export failed', err);
    reply(false, String((err && err.message) || err));
  }
};

window.addEventListener('message', onMessage);

// plugin.js runs inside the app, so the listener would outlive a disabled or
// reloaded plugin unless removed.
if (typeof PluginAPI.onUnload === 'function') {
  PluginAPI.onUnload(() => window.removeEventListener('message', onMessage));
}
