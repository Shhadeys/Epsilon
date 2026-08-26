(function () {
    // Chat backend is Firebase (Auth + Firestore) -- see js/firebase-config.js for setup
    // and firestore.rules for the server-side rules that make DMs/rooms actually private.
    const MAX_MESSAGE_LENGTH = 1000;
    const SEND_COOLDOWN_MS = 1200;
    const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
    const PSEUDO_EMAIL_DOMAIN = 'epsilon.local';
    const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const NOTIF_PREF_KEY = 'chatNotificationsEnabled';

    let app = null;
    let auth = null;
    let db = null;

    const state = {
        uid: null,
        username: null,
        usernameLower: null,
        view: 'public', // 'public' | 'dm' | 'room'
        activeId: null,
        activeLabel: '',
        lastSendAt: 0,
        unsubMessages: null,
        unsubDmList: null,
        unsubRoomList: null,
        // While true, onAuthStateChanged ignores sign-ins -- set during handleSignup so its
        // own profile-creation writes can't race the listener's "does a profile exist yet?"
        // check (that race was signing brand-new accounts right back out, intermittently).
        suppressAuthHandler: false,
        lastDmDocs: [],
        lastRoomDocs: [],
        notificationsEnabled: true,
    };

    function $(id) {
        return document.getElementById(id);
    }

    function setStatus(text, cls) {
        const el = $('chatStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'chat-status' + (cls ? ' ' + cls : '');
    }

    function setSendEnabled(enabled) {
        const btn = $('chatSendBtn');
        if (btn) btn.disabled = !enabled;
    }

    function pseudoEmail(usernameLower) {
        return usernameLower + '@' + PSEUDO_EMAIL_DOMAIN;
    }

    function dmId(uidA, uidB) {
        return [uidA, uidB].sort().join('_');
    }

    function authErrorMessage(err) {
        switch (err && err.code) {
            case 'auth/email-already-in-use':
                return 'That username is already taken.';
            case 'auth/weak-password':
                return 'Password must be at least 6 characters.';
            case 'auth/invalid-email':
                return 'Usernames can only contain letters, numbers, and underscores.';
            case 'auth/wrong-password':
            case 'auth/user-not-found':
            case 'auth/invalid-credential':
                return 'Incorrect username or password.';
            case 'auth/too-many-requests':
                return 'Too many attempts. Try again later.';
            default:
                return (err && err.message) || 'Something went wrong.';
        }
    }

    // ---------- Notifications ----------

    function loadNotifPref() {
        const raw = localStorage.getItem(NOTIF_PREF_KEY);
        return raw === null ? true : raw === '1';
    }

    function saveNotifPref(enabled) {
        localStorage.setItem(NOTIF_PREF_KEY, enabled ? '1' : '0');
    }

    function tsMillis(ts) {
        return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
    }

    function lastReadKey(threadKey) {
        return 'chatLastRead:' + state.uid + ':' + threadKey;
    }

    function getLastRead(threadKey) {
        const raw = localStorage.getItem(lastReadKey(threadKey));
        return raw ? parseInt(raw, 10) : 0;
    }

    function markRead(threadKey) {
        localStorage.setItem(lastReadKey(threadKey), String(Date.now()));
    }

    function isThreadUnread(threadKey, updatedAtMillis, isActive, lastSenderUid) {
        if (!state.notificationsEnabled || isActive || !updatedAtMillis) return false;
        // Never flag a thread as unread over your own message -- relying on timestamps
        // alone is a race (a server-assigned updatedAt can land after your own local
        // read-marker if you send and immediately switch away), so check the sender too.
        if (lastSenderUid && lastSenderUid === state.uid) return false;
        return updatedAtMillis > getLastRead(threadKey);
    }

    function isChatTabActive() {
        const btn = document.querySelector('.tab-btn[data-tab="chat"]');
        return !!btn && btn.classList.contains('active');
    }

    function anyThreadUnread() {
        const dmHit = state.lastDmDocs.some((d) => {
            const data = d.data();
            return isThreadUnread('dm:' + d.id, tsMillis(data.updatedAt), state.view === 'dm' && state.activeId === d.id, data.lastSenderUid);
        });
        if (dmHit) return true;
        return state.lastRoomDocs.some((d) => {
            const data = d.data();
            return isThreadUnread('room:' + d.id, tsMillis(data.updatedAt), state.view === 'room' && state.activeId === d.id, data.lastSenderUid);
        });
    }

    function updateGlobalNotifBadge() {
        const badge = $('chatGlobalNotif');
        if (!badge) return;
        badge.style.display = state.notificationsEnabled && anyThreadUnread() && !isChatTabActive() ? '' : 'none';
    }

    // ---------- Auth ----------

    function switchAuthTab(tab) {
        document.querySelectorAll('.chat-subtab-btn[data-authtab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.authtab === tab);
        });
        $('chatLoginForm').style.display = tab === 'login' ? '' : 'none';
        $('chatSignupForm').style.display = tab === 'signup' ? '' : 'none';
    }

    function setFormBusy(form, busy, busyText) {
        const btn = form.querySelector('button[type="submit"]');
        if (!btn) return;
        if (busy) {
            if (btn.dataset.idleText === undefined) btn.dataset.idleText = btn.textContent;
            btn.textContent = busyText;
            btn.disabled = true;
        } else {
            btn.textContent = btn.dataset.idleText || btn.textContent;
            btn.disabled = false;
        }
    }

    async function handleSignup(e) {
        e.preventDefault();
        const errorEl = $('signupError');
        errorEl.textContent = '';

        const usernameRaw = ($('signupUsername').value || '').trim();
        const password = $('signupPassword').value || '';

        if (!USERNAME_RE.test(usernameRaw)) {
            errorEl.textContent = 'Username must be 3-20 characters: letters, numbers, underscores.';
            return;
        }
        if (password.length < 6) {
            errorEl.textContent = 'Password must be at least 6 characters.';
            return;
        }

        const usernameLower = usernameRaw.toLowerCase();
        let cred = null;
        state.suppressAuthHandler = true;
        setFormBusy(e.target, true, 'Creating account…');
        try {
            cred = await auth.createUserWithEmailAndPassword(pseudoEmail(usernameLower), password);

            // usernames/{usernameLower} can only be created once (see firestore.rules),
            // so this is what actually reserves the name -- if someone already holds
            // it, this write is rejected and we roll back the auth account we just made.
            try {
                await db.collection('usernames').doc(usernameLower).set({
                    uid: cred.user.uid,
                    username: usernameRaw,
                });
            } catch (reserveErr) {
                await cred.user.delete();
                errorEl.textContent = 'That username is already taken.';
                return;
            }

            await db.collection('users').doc(cred.user.uid).set({
                username: usernameRaw,
                usernameLower,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });

            // Profile now exists -- safe to enter directly instead of waiting on
            // onAuthStateChanged, which we've been suppressing this whole time.
            await enterAsUser(cred.user.uid);
        } catch (err) {
            errorEl.textContent = authErrorMessage(err);
        } finally {
            state.suppressAuthHandler = false;
            setFormBusy(e.target, false);
        }
    }

    async function handleLogin(e) {
        e.preventDefault();
        const errorEl = $('loginError');
        errorEl.textContent = '';

        const usernameRaw = ($('loginUsername').value || '').trim();
        const password = $('loginPassword').value || '';
        if (!usernameRaw || !password) return;

        setFormBusy(e.target, true, 'Logging in…');
        try {
            await auth.signInWithEmailAndPassword(pseudoEmail(usernameRaw.toLowerCase()), password);
        } catch (err) {
            errorEl.textContent = authErrorMessage(err);
        } finally {
            setFormBusy(e.target, false);
        }
    }

    function handleLogout() {
        auth.signOut();
    }

    // ---------- View switching ----------

    function teardownActiveThread() {
        if (state.unsubMessages) {
            state.unsubMessages();
            state.unsubMessages = null;
        }
        const messages = $('chatMessages');
        if (messages) messages.innerHTML = '';
    }

    // "Public Wall" reflects the actually-open thread. "New DM"/"Manage Rooms" are just
    // panel toggles (their own .expanded state) -- they never claim to be the open thread,
    // which is what made it unclear what you were looking at after opening a DM/room.
    function setPublicActive(isActive) {
        const btn = document.querySelector('.chat-subtab-btn[data-view="public"]');
        if (btn) btn.classList.toggle('active', isActive);
    }

    function setPanelExpanded(view, expanded) {
        const btn = document.querySelector('.chat-subtab-btn[data-view="' + view + '"]');
        const panel = $('chatPanel-' + view);
        if (btn) btn.classList.toggle('expanded', expanded);
        if (panel) panel.style.display = expanded ? '' : 'none';
    }

    function togglePanelExpanded(view) {
        const panel = $('chatPanel-' + view);
        setPanelExpanded(view, !panel || panel.style.display === 'none');
    }

    function openPublic() {
        teardownActiveThread();
        state.view = 'public';
        state.activeId = null;
        state.activeLabel = 'Public Wall';
        $('chatThreadHeader').textContent = 'Public Wall';
        setPublicActive(true);
        setPanelExpanded('dms', false);
        setPanelExpanded('rooms', false);
        subscribeMessages(db.collection('publicMessages').orderBy('ts', 'asc').limitToLast(100));
        renderDmList(state.lastDmDocs || []);
        renderRoomList(state.lastRoomDocs || []);
    }

    function openDm(id, otherName) {
        teardownActiveThread();
        state.view = 'dm';
        state.activeId = id;
        state.activeLabel = 'DM with ' + otherName;
        $('chatThreadHeader').textContent = 'Direct Message · ' + otherName;
        setPublicActive(false);
        subscribeMessages(db.collection('dms').doc(id).collection('messages').orderBy('ts', 'asc').limitToLast(100));
        renderDmList(state.lastDmDocs || []);
        renderRoomList(state.lastRoomDocs || []);
    }

    function openRoom(id, name) {
        teardownActiveThread();
        state.view = 'room';
        state.activeId = id;
        state.activeLabel = 'Room: ' + name;
        $('chatThreadHeader').textContent = 'Room · ' + name;
        setPublicActive(false);
        subscribeMessages(db.collection('rooms').doc(id).collection('messages').orderBy('ts', 'asc').limitToLast(100));
        renderDmList(state.lastDmDocs || []);
        renderRoomList(state.lastRoomDocs || []);
    }

    // ---------- Messages ----------

    function appendMessageEl(container, { name, text, ts, mine }) {
        const item = document.createElement('div');
        item.className = 'chat-message' + (mine ? ' own' : '');

        const meta = document.createElement('div');
        meta.className = 'chat-message-meta';

        const nameEl = document.createElement('span');
        nameEl.className = 'chat-message-name';
        nameEl.textContent = name || 'Unknown';
        meta.appendChild(nameEl);

        if (ts) {
            const timeEl = document.createElement('span');
            timeEl.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            meta.appendChild(timeEl);
        }

        const textEl = document.createElement('div');
        textEl.className = 'chat-message-text';
        textEl.textContent = text;

        item.appendChild(meta);
        item.appendChild(textEl);
        container.appendChild(item);
    }

    function renderMessageDocs(docs) {
        const container = $('chatMessages');
        if (!container) return;
        container.innerHTML = '';
        docs.forEach((d) => {
            const data = d.data();
            if (!data || typeof data.text !== 'string') return;
            appendMessageEl(container, {
                name: data.name,
                text: data.text,
                ts: data.ts && typeof data.ts.toMillis === 'function' ? data.ts.toMillis() : null,
                mine: data.uid === state.uid,
            });
        });
        container.scrollTop = container.scrollHeight;

        // Viewing this thread counts as reading it -- refresh the read marker and
        // let the sidebar/global badges re-evaluate now that it's up to date.
        if (state.view === 'dm' && state.activeId) {
            markRead('dm:' + state.activeId);
            renderDmList(state.lastDmDocs);
        } else if (state.view === 'room' && state.activeId) {
            markRead('room:' + state.activeId);
            renderRoomList(state.lastRoomDocs);
        }
    }

    function subscribeMessages(query) {
        state.unsubMessages = query.onSnapshot(
            (snap) => renderMessageDocs(snap.docs),
            (err) => console.error('Chat message subscription failed', err)
        );
    }

    async function sendMessage(rawText) {
        const now = Date.now();
        if (now - state.lastSendAt < SEND_COOLDOWN_MS) return;
        const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!text || !state.uid) return;

        state.lastSendAt = now;
        const payload = {
            uid: state.uid,
            name: state.username,
            text,
            ts: firebase.firestore.FieldValue.serverTimestamp(),
        };

        try {
            if (state.view === 'public') {
                await db.collection('publicMessages').add(payload);
            } else if (state.view === 'dm' && state.activeId) {
                await db.collection('dms').doc(state.activeId).collection('messages').add(payload);
                await db.collection('dms').doc(state.activeId).update({
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastSenderUid: state.uid,
                });
            } else if (state.view === 'room' && state.activeId) {
                await db.collection('rooms').doc(state.activeId).collection('messages').add(payload);
                await db.collection('rooms').doc(state.activeId).update({
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastSenderUid: state.uid,
                });
            }
        } catch (err) {
            console.error('Failed to send message', err);
        }
    }

    // ---------- DMs ----------

    function renderDmList(docs) {
        state.lastDmDocs = docs;
        const el = $('chatDmList');
        if (el) {
            el.innerHTML = '';
            docs.forEach((d) => {
                const data = d.data();
                if (!data || !Array.isArray(data.members)) return;
                const otherUid = data.members.find((m) => m !== state.uid);
                const otherName = (data.memberNames && data.memberNames[otherUid]) || 'Unknown';
                const isActive = state.view === 'dm' && state.activeId === d.id;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chat-list-item' + (isActive ? ' active' : '');

                const label = document.createElement('span');
                label.className = 'chat-list-item-label';
                label.textContent = otherName;
                btn.appendChild(label);

                if (isThreadUnread('dm:' + d.id, tsMillis(data.updatedAt), isActive, data.lastSenderUid)) {
                    const dot = document.createElement('span');
                    dot.className = 'chat-unread-dot';
                    btn.appendChild(dot);
                }

                btn.addEventListener('click', () => openDm(d.id, otherName));
                el.appendChild(btn);
            });
        }
        updateGlobalNotifBadge();
    }

    function subscribeDmList() {
        // No orderBy here on purpose: combining array-contains with orderBy on a
        // different field needs a Firestore composite index, which isn't set up by
        // default -- that missing index was silently failing this whole query. Sort
        // client-side instead, same as the room list already does.
        state.unsubDmList = db
            .collection('dms')
            .where('members', 'array-contains', state.uid)
            .onSnapshot(
                (snap) => {
                    const docs = snap.docs.slice().sort((a, b) => tsMillis(b.data().updatedAt) - tsMillis(a.data().updatedAt));
                    renderDmList(docs);
                },
                (err) => console.error('DM list subscription failed', err)
            );
    }

    async function startDm(targetUsernameRaw) {
        const errorEl = $('chatDmSearchError');
        errorEl.textContent = '';
        const targetLower = targetUsernameRaw.trim().toLowerCase();
        if (!targetLower) return;
        if (targetLower === state.usernameLower) {
            errorEl.textContent = "That's you!";
            return;
        }

        try {
            const snap = await db.collection('users').where('usernameLower', '==', targetLower).limit(1).get();
            if (snap.empty) {
                errorEl.textContent = 'No user with that username.';
                return;
            }
            const otherDoc = snap.docs[0];
            const otherUid = otherDoc.id;
            const otherName = otherDoc.data().username;
            const id = dmId(state.uid, otherUid);

            await db
                .collection('dms')
                .doc(id)
                .set(
                    {
                        members: [state.uid, otherUid].sort(),
                        memberNames: { [state.uid]: state.username, [otherUid]: otherName },
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

            setPanelExpanded('dms', false);
            openDm(id, otherName);
        } catch (err) {
            errorEl.textContent = 'Could not start that DM.';
            console.error(err);
        }
    }

    // ---------- Rooms ----------

    function genRoomCode() {
        // 10 chars from a 32-char alphabet is ~50 bits of entropy -- enough that
        // guessing a code by brute-force `get()` calls isn't practical.
        let code = '';
        for (let i = 0; i < 10; i++) {
            code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
        }
        return code;
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    }

    function renderRoomList(docs) {
        state.lastRoomDocs = docs;
        const el = $('chatRoomList');
        if (el) {
            el.innerHTML = '';
            docs.forEach((d) => {
                const data = d.data();
                if (!data) return;
                const isActive = state.view === 'room' && state.activeId === d.id;

                const item = document.createElement('div');
                item.className = 'chat-list-item' + (isActive ? ' active' : '');

                const nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'chat-room-name-btn';
                nameBtn.textContent = data.name || 'Room';
                nameBtn.addEventListener('click', () => openRoom(d.id, data.name || 'Room'));
                item.appendChild(nameBtn);

                if (isThreadUnread('room:' + d.id, tsMillis(data.updatedAt), isActive, data.lastSenderUid)) {
                    const dot = document.createElement('span');
                    dot.className = 'chat-unread-dot';
                    item.appendChild(dot);
                }

                if (data.code) {
                    const codeBtn = document.createElement('button');
                    codeBtn.type = 'button';
                    codeBtn.className = 'chat-room-code-btn';
                    codeBtn.textContent = data.code;
                    codeBtn.title = 'Copy invite code';
                    codeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        copyText(data.code);
                    });
                    item.appendChild(codeBtn);
                }

                el.appendChild(item);
            });
        }
        updateGlobalNotifBadge();
    }

    function subscribeRoomList() {
        state.unsubRoomList = db
            .collection('rooms')
            .where('members', 'array-contains', state.uid)
            .onSnapshot(
                (snap) => renderRoomList(snap.docs),
                (err) => console.error('Room list subscription failed', err)
            );
    }

    async function createRoom(nameRaw) {
        const errorEl = $('chatRoomError');
        errorEl.textContent = '';
        const name = nameRaw.trim().slice(0, 40);
        if (!name) return;

        try {
            const code = genRoomCode();
            const ref = await db.collection('rooms').add({
                name,
                code,
                ownerUid: state.uid,
                members: [state.uid],
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            await db.collection('roomCodes').doc(code).set({ roomId: ref.id });

            $('chatRoomInfo').textContent = 'Room created! Share this code to invite people: ' + code;
            setPanelExpanded('rooms', false);
            openRoom(ref.id, name);
        } catch (err) {
            errorEl.textContent = 'Could not create room.';
            console.error(err);
        }
    }

    async function joinRoomByCode(codeRaw) {
        const errorEl = $('chatRoomError');
        errorEl.textContent = '';
        const code = codeRaw.trim().toUpperCase();
        if (!code) return;

        try {
            const codeDoc = await db.collection('roomCodes').doc(code).get();
            if (!codeDoc.exists) {
                errorEl.textContent = 'Invalid room code.';
                return;
            }
            const { roomId } = codeDoc.data();

            try {
                await db
                    .collection('rooms')
                    .doc(roomId)
                    .update({ members: firebase.firestore.FieldValue.arrayUnion(state.uid) });
            } catch (joinErr) {
                // Likely already a member -- fall through and just open the room.
            }

            const roomDoc = await db.collection('rooms').doc(roomId).get();
            if (!roomDoc.exists) {
                errorEl.textContent = 'Room not found.';
                return;
            }
            setPanelExpanded('rooms', false);
            openRoom(roomId, roomDoc.data().name || 'Room');
        } catch (err) {
            errorEl.textContent = 'Could not join that room.';
            console.error(err);
        }
    }

    // ---------- Auth state ----------

    function showAuthUi() {
        $('chatAuthPanel').style.display = '';
        $('chatMain').style.display = 'none';
        setStatus('Sign in to chat');
        setSendEnabled(false);
    }

    function showChatUi() {
        $('chatAuthPanel').style.display = 'none';
        $('chatMain').style.display = '';
        $('chatMyName').textContent = state.username;
        setStatus('Connected as ' + state.username, 'connected');
        setSendEnabled(true);
    }

    function teardownUserSubscriptions() {
        if (state.unsubDmList) {
            state.unsubDmList();
            state.unsubDmList = null;
        }
        if (state.unsubRoomList) {
            state.unsubRoomList();
            state.unsubRoomList = null;
        }
        teardownActiveThread();
    }

    async function enterAsUser(uid) {
        try {
            const profileDoc = await db.collection('users').doc(uid).get();
            if (!profileDoc.exists) {
                // Auth account exists but the profile write failed/never happened; sign back out.
                await auth.signOut();
                return;
            }
            const profile = profileDoc.data();
            state.uid = uid;
            state.username = profile.username;
            state.usernameLower = profile.usernameLower;

            showChatUi();
            subscribeDmList();
            subscribeRoomList();
            openPublic();
        } catch (err) {
            console.error('Failed to load chat profile', err);
            setStatus('Chat error', 'error');
        }
    }

    function onAuthStateChanged(user) {
        // A signup in progress drives its own transition via enterAsUser() once it has
        // actually finished writing the profile -- ignore the interim sign-in event here.
        if (state.suppressAuthHandler) return;

        if (!user) {
            state.uid = null;
            state.username = null;
            state.usernameLower = null;
            state.lastDmDocs = [];
            state.lastRoomDocs = [];
            teardownUserSubscriptions();
            showAuthUi();
            updateGlobalNotifBadge();
            return;
        }

        enterAsUser(user.uid);
    }

    // ---------- Init ----------

    function initFirebase() {
        const config = window.FIREBASE_CONFIG;
        if (typeof firebase === 'undefined' || !config || String(config.apiKey || '').startsWith('YOUR_')) {
            setStatus('Chat unavailable', 'error');
            return false;
        }
        app = firebase.initializeApp(config);
        auth = firebase.auth();
        db = firebase.firestore();
        return true;
    }

    function wirePasswordToggles() {
        document.querySelectorAll('.chat-password-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = $(btn.dataset.target);
                if (!input) return;
                const nowShowing = input.type === 'password';
                input.type = nowShowing ? 'text' : 'password';
                btn.textContent = nowShowing ? 'Hide' : 'Show';
                btn.setAttribute('aria-label', nowShowing ? 'Hide password' : 'Show password');
            });
        });
    }

    function wireNotifications() {
        state.notificationsEnabled = loadNotifPref();

        const toggle = $('chatNotifToggle');
        if (toggle) {
            toggle.checked = state.notificationsEnabled;
            toggle.addEventListener('change', () => {
                state.notificationsEnabled = toggle.checked;
                saveNotifPref(toggle.checked);
                renderDmList(state.lastDmDocs);
                renderRoomList(state.lastRoomDocs);
            });
        }

        const globalBadge = $('chatGlobalNotif');
        if (globalBadge) {
            globalBadge.addEventListener('click', () => {
                const chatTabBtn = document.querySelector('.tab-btn[data-tab="chat"]');
                if (chatTabBtn) chatTabBtn.click();
            });
        }

        // Re-check the global badge whenever the active top-level tab changes (it should
        // only ever show while the user isn't already looking at the chat tab).
        const tabNav = document.querySelector('.tab-nav');
        if (tabNav) {
            tabNav.addEventListener('click', (e) => {
                if (e.target.matches('.tab-btn')) updateGlobalNotifBadge();
            });
        }
    }

    function wireUpUi() {
        wirePasswordToggles();
        wireNotifications();

        document.querySelectorAll('.chat-subtab-btn[data-authtab]').forEach((btn) => {
            btn.addEventListener('click', () => switchAuthTab(btn.dataset.authtab));
        });
        document.querySelectorAll('.chat-subtab-btn[data-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.view === 'public') openPublic();
                else togglePanelExpanded(btn.dataset.view);
            });
        });

        $('chatLoginForm').addEventListener('submit', handleLogin);
        $('chatSignupForm').addEventListener('submit', handleSignup);
        $('chatLogoutBtn').addEventListener('click', handleLogout);

        $('chatForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('chatTextInput');
            if (!input) return;
            sendMessage(input.value);
            input.value = '';
            input.focus();
        });

        $('chatDmSearchForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('chatDmSearchInput');
            startDm(input.value);
            input.value = '';
        });

        $('chatRoomCreateForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('chatRoomNameInput');
            createRoom(input.value);
            input.value = '';
        });

        $('chatRoomJoinForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('chatRoomCodeInput');
            joinRoomByCode(input.value);
            input.value = '';
        });
    }

    window.addEventListener('load', () => {
        wireUpUi();
        if (!initFirebase()) return;
        auth.onAuthStateChanged(onAuthStateChanged);
    });
})();
