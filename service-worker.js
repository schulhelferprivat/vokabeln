const VERSION = 23;
const CACHE_NAME = `vokabeln-v${VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./service-worker.js",
  "./icon-32x32.png",
  "./icon-192x192.png",
  "./icon-512x512.png"
];
const BADGE_DB_NAME = "vokabeln-badge-db";
const BADGE_DB_STORE = "badge";
const BADGE_CARDS_KEY = "cards";
const BADGE_DUE_KEY = "due";
const BADGE_SYNC_TAG = "vokabeln-badge-refresh";
const DEFAULT_OPEN_URL = "./";

function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BADGE_DB_STORE)) {
        db.createObjectStore(BADGE_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB failed."));
  });
}

async function badgeDbSet(key, value) {
  const db = await openBadgeDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(BADGE_DB_STORE, "readwrite");
    tx.objectStore(BADGE_DB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted."));
  });
  db.close();
}

async function badgeDbGet(key) {
  const db = await openBadgeDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(BADGE_DB_STORE, "readonly");
    const req = tx.objectStore(BADGE_DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("IndexedDB read failed."));
  });
  db.close();
  return value;
}

function normalizeBadgeCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map((card) => ({
      id: String((card && card.id) || ""),
      dueAt: Number(card && card.dueAt) || 0
    }))
    .filter((card) => card.id);
}

function countDueCards(cards, timestamp = Date.now()) {
  if (!Array.isArray(cards)) return 0;
  return cards.filter((card) => (Number(card.dueAt) || 0) <= timestamp).length;
}

async function applyBadgeCount(dueCount) {
  const count = Math.max(0, Math.floor(Number(dueCount) || 0));
  try {
    if ("setAppBadge" in self.registration) {
      await self.registration.setAppBadge(count);
      return;
    }
    if ("clearAppBadge" in self.registration && count === 0) {
      await self.registration.clearAppBadge();
    }
  } catch (e) {
    // ignore
  }
}

async function recomputeBadgeFromStoredCards() {
  try {
    const cards = normalizeBadgeCards(await badgeDbGet(BADGE_CARDS_KEY));
    const dueCount = countDueCards(cards, Date.now());
    await badgeDbSet(BADGE_DUE_KEY, dueCount);
    await applyBadgeCount(dueCount);
    return dueCount;
  } catch (e) {
    const storedDue = Number(await badgeDbGet(BADGE_DUE_KEY)) || 0;
    await applyBadgeCount(storedDue);
    return storedDue;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : Promise.resolve()));
    self.clients.claim();
    await recomputeBadgeFromStoredCards();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const type = typeof data === "string" ? data : String(data.type || "");

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (type === "BADGE_STATE_SYNC") {
    event.waitUntil((async () => {
      const cards = normalizeBadgeCards(data.cards);
      const dueCount = Number.isFinite(Number(data.dueCount))
        ? Math.max(0, Math.floor(Number(data.dueCount)))
        : countDueCards(cards, Date.now());
      await badgeDbSet(BADGE_CARDS_KEY, cards);
      await badgeDbSet(BADGE_DUE_KEY, dueCount);
      await applyBadgeCount(dueCount);
    })());
    return;
  }

  if (type === "BADGE_SET_DUE") {
    event.waitUntil((async () => {
      const dueCount = Math.max(0, Math.floor(Number(data.dueCount) || 0));
      await badgeDbSet(BADGE_DUE_KEY, dueCount);
      await applyBadgeCount(dueCount);
    })());
    return;
  }

  if (type === "BADGE_RECOMPUTE") {
    event.waitUntil(recomputeBadgeFromStoredCards());
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== BADGE_SYNC_TAG) return;
  event.waitUntil(recomputeBadgeFromStoredCards());
});

self.addEventListener("sync", (event) => {
  if (event.tag !== BADGE_SYNC_TAG) return;
  event.waitUntil(recomputeBadgeFromStoredCards());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      // Opportunistic cache for same-origin requests
      const url = new URL(req.url);
      if (url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // Offline fallback to app shell
      const fallback = await caches.match("./index.html");
      return fallback || new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
