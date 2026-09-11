/**
 * What Decoy deliberately does not intercept, asserted rather than promised.
 *
 * Layer 1 patches `fetch` and `XMLHttpRequest` in the page's main world, and
 * nothing else. Every case here puts a rule on a url and then proves the real
 * resource still loaded -- so nobody debugs a documented limitation as if it
 * were a bug, and so the day a layer does cover one of these, the case turns
 * red and says so.
 */
import { assert, assertEqual, assertIncludes, sleep, suite } from '../harness.js';

const add = suite(
  'limits',
  'Known limits',
  'The request kinds layer 1 does not reach — proven, not promised.',
);

/** Loads a url through an element and resolves when it settles. */
function loadElement(element, parent = document.head) {
  return new Promise((resolve) => {
    element.addEventListener('load', () => resolve('load'), { once: true });
    element.addEventListener('error', () => resolve('error'), { once: true });
    parent.append(element);
  });
}

add('an image is not intercepted, even with a rule on its url', {
  rules: ['pg_limit_img'],
  doc: 'Images, media, stylesheets, fonts and documents need declarativeNetRequest — layer 2, which is designed for but not built. A rule on them is inert.',
  async run() {
    const image = new Image();
    image.src = `/pg/asset/pixel.png?cache=${String(Date.now())}`;
    const outcome = await loadElement(image, document.body);
    try {
      assertEqual(outcome, 'load', 'the real png loaded');
      assertEqual(image.naturalWidth, 1, 'it is the 1×1 pixel the server sends');
    } finally {
      image.remove();
    }
    return 'the 404 rule on this url changed nothing';
  },
});

add('a stylesheet is not intercepted either', {
  rules: ['pg_limit_css'],
  async run() {
    const probe = document.createElement('div');
    probe.id = 'pg-css-probe';
    document.body.append(probe);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/pg/asset/probe.css?cache=${String(Date.now())}`;
    const outcome = await loadElement(link);
    try {
      assertEqual(outcome, 'load', 'the real stylesheet loaded');
      assertEqual(
        getComputedStyle(probe).outlineColor,
        'rgb(1, 2, 3)',
        'the value came from the server, not from the rule',
      );
    } finally {
      link.remove();
      probe.remove();
    }
    return "the rule's body was never applied";
  },
});

add('EventSource is not intercepted, so a stream rule does not reach it', {
  rules: ['pg_limit_eventsource'],
  doc: 'The EventSource constructor goes through neither patch. A stream rule mocks an event stream read with fetch or XHR, but not one opened this way.',
  async run() {
    const source = new EventSource(`/pg/limit/eventsource?cache=${String(Date.now())}`);
    try {
      const message = await new Promise((resolve, reject) => {
        source.addEventListener('message', (event) => resolve(event.data), { once: true });
        source.addEventListener('error', () => reject(new Error('the event source failed')), {
          once: true,
        });
        setTimeout(() => reject(new Error('no event arrived within 3s')), 3000);
      });
      const payload = JSON.parse(message);
      assertEqual(payload.from, 'server', 'which side sent the event');
      return 'the real server stream arrived; the rule was inert';
    } finally {
      source.close();
    }
  },
});

add('a WebSocket connects and echoes despite a rule on its url', {
  rules: ['pg_limit_ws'],
  async run() {
    const socket = new WebSocket(`ws://${location.host}/pg/limit/ws`);
    try {
      const reply = await new Promise((resolve, reject) => {
        socket.addEventListener('open', () => socket.send('ping'), { once: true });
        socket.addEventListener('message', (event) => resolve(event.data), { once: true });
        socket.addEventListener('error', () => reject(new Error('the socket failed')), {
          once: true,
        });
        setTimeout(() => reject(new Error('no frame arrived within 3s')), 3000);
      });
      assertEqual(reply, 'echo:ping', 'what the real server sent back');
      return 'a real socket, untouched by the rule on its url';
    } finally {
      socket.close();
    }
  },
});

add('a request from a dedicated worker is not intercepted', {
  rules: ['pg_limit_worker'],
  doc: "The patch is installed in the page's main world only. A worker has its own global scope and its own fetch.",
  async run() {
    const worker = new Worker('/assets/worker.js');
    try {
      const body = await new Promise((resolve, reject) => {
        worker.addEventListener('message', (event) => resolve(event.data), { once: true });
        worker.addEventListener('error', () => reject(new Error('the worker failed')), {
          once: true,
        });
        setTimeout(() => reject(new Error('the worker did not answer within 3s')), 3000);
        worker.postMessage('/pg/limit/worker-call');
      });
      assertEqual(body.from, undefined, 'the mock did not answer');
      assertEqual(body.server, true, 'the real server did');
      return 'the same url, mocked in the page and real in the worker';
    } finally {
      worker.terminate();
    }
  },
});

add('navigator.sendBeacon is not intercepted', {
  rules: ['pg_limit_beacon'],
  doc: 'A separate platform API with no fetch or XHR underneath it. The fixture server records what it received, which is how the page can tell.',
  async run() {
    const marker = `beacon-${String(Date.now())}`;
    const sent = navigator.sendBeacon('/pg/limit/beacon', marker);
    assert(sent, 'sendBeacon should have been queued');

    // Fire-and-forget, so the only way to observe it is to ask the server.
    let received = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(100);
      received = (await (await fetch('/real/received')).json()).received;
      if (received.some((entry) => entry.body === marker)) break;
    }
    assert(
      received.some((entry) => entry.body === marker),
      'the server never received the beacon, so something intercepted it',
    );
    return 'the beacon reached the network with the rule in place';
  },
});

add('a same-origin iframe IS intercepted, because the scripts run in every frame', {
  rules: ['pg_frame_call'],
  doc: 'A capability rather than a limit, and the reason it sits here: the boundary is main-world-vs-worker, not top-document-vs-frame.',
  async run() {
    const frame = document.createElement('iframe');
    frame.src = '/assets/frame.html';
    frame.style.display = 'none';
    document.body.append(frame);
    try {
      const body = await new Promise((resolve, reject) => {
        const onMessage = (event) => {
          if (event.data?.from !== 'pg-frame') return;
          window.removeEventListener('message', onMessage);
          resolve(event.data.body);
        };
        window.addEventListener('message', onMessage);
        setTimeout(() => reject(new Error('the frame did not answer within 3s')), 3000);
      });
      assertEqual(body.frame, true, 'the mock answered inside the frame');
      assertEqual(body.from, 'decoy', 'and it was the rule, not the server');
      return 'the rule reached a nested browsing context';
    } finally {
      frame.remove();
    }
  },
});

add('a 1xx status cannot be mocked, and the schema stops before it', {
  rules: [],
  doc: 'The Fetch spec refuses to construct a Response below 200, and 1xx is not observable to fetch or XHR anyway, so the rule schema starts at 200.',
  async run() {
    let threw = false;
    try {
      void new Response('x', { status: 100 });
    } catch (error) {
      threw = true;
      assertIncludes(String(error), 'status', 'the platform explains why');
    }
    assert(threw, 'constructing a 1xx Response should throw');
    return "the limit is the platform's, which is why the schema mirrors it";
  },
});
