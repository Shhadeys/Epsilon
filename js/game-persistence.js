/**
 * Auto-persistence safety net for game saves.
 *
 * Games loaded into #page-loader iframe are same-origin, so their save data
 * already lives in this page's localStorage right alongside Epsilon's own
 * settings -- nothing special has to be done to make progress "count".
 * What this file adds is a background copy of that data (kept in IndexedDB,
 * not cookies -- a single game save can easily blow past the ~4KB-per-cookie
 * limit) that gets restored automatically if localStorage ever comes back
 * empty (private window, manual "clear site data", school device wipe, etc).
 *
 * This is a best-effort backup, not a substitute for the "Download/Upload
 * Game Data" buttons in Settings -- a full browser/profile wipe clears
 * IndexedDB right along with localStorage, so the only thing that survives
 * that is a save file the user downloaded themselves.
 */
(function () {
    if (!('indexedDB' in window)) return;

    var DB_NAME = 'epsilon-game-backup';
    var STORE = 'snapshots';
    var RECORD_ID = 'latest';
    var AUTOSAVE_INTERVAL_MS = 20000;

    function openDb() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                req.result.createObjectStore(STORE, { keyPath: 'id' });
            };
            req.onsuccess = function () {
                resolve(req.result);
            };
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    function snapshotNow() {
        var entries;
        try {
            entries = Object.entries(localStorage);
        } catch (e) {
            return Promise.resolve();
        }
        if (!entries.length) return Promise.resolve();

        return openDb()
            .then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).put({ id: RECORD_ID, entries: entries, savedAt: Date.now() });
                    tx.oncomplete = resolve;
                    tx.onerror = function () {
                        reject(tx.error);
                    };
                });
            })
            .catch(function () {});
    }

    function restoreMissing() {
        return openDb()
            .then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx = db.transaction(STORE, 'readonly');
                    var req = tx.objectStore(STORE).get(RECORD_ID);
                    req.onsuccess = function () {
                        resolve(req.result);
                    };
                    req.onerror = function () {
                        reject(req.error);
                    };
                });
            })
            .then(function (record) {
                if (!record || !record.entries) return;
                // Only fill in keys localStorage is currently missing -- never
                // clobber data that's already there with an older backup.
                record.entries.forEach(function ([key, value]) {
                    if (localStorage.getItem(key) === null) {
                        try {
                            localStorage.setItem(key, value);
                        } catch (e) {}
                    }
                });
            })
            .catch(function () {});
    }

    restoreMissing();
    setInterval(snapshotNow, AUTOSAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) snapshotNow();
    });
    window.addEventListener('pagehide', snapshotNow);

    window.GamePersistence = { snapshotNow: snapshotNow };
})();
