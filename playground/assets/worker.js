/**
 * A dedicated worker that fetches whatever url it is given and posts the body
 * back. It exists for one assertion: requests made here are not intercepted,
 * because the page-world patch is installed in the page's main world only.
 */
self.addEventListener('message', (event) => {
  fetch(event.data)
    .then((response) => response.json())
    .then((body) => {
      self.postMessage(body);
    })
    .catch((error) => {
      self.postMessage({ error: String(error) });
    });
});
