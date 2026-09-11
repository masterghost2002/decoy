/**
 * The content scripts declare `all_frames`, so this document is patched exactly
 * like the top one. That is what this file proves.
 */
fetch('/pg/limit/frame-call')
  .then((response) => response.json())
  .then((body) => {
    parent.postMessage({ from: 'pg-frame', body }, '*');
  })
  .catch((error) => {
    parent.postMessage({ from: 'pg-frame', body: { error: String(error) } }, '*');
  });
