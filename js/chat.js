(function () {
    // Chat backend is Firebase (Auth + Firestore) -- see js/firebase-config.js for setup
    // and firestore.rules for the server-side rules that make DMs/rooms actually private.
    const MAX_MESSAGE_LENGTH = 1000;
    const SEND_COOLDOWN_MS = 1200;
    const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
    const PSEUDO_EMAIL_DOMAIN = 'epsilon.local';
    const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

    // ---------- Auth ----------

    function switchAuthTab(tab) {
        document.querySelectorAll('.chat-subtab-btn[data-authtab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.authtab === tab);
        });
        $('chatLoginForm').style.display = tab === 'login' ? '' : 'none';
        $('chatSignupForm').style.display = tab === 'signup' ? '' : 'none';
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
        } catch (err) {
            errorEl.textContent = authErrorMessage(err);
        }
    }

    async function handleLogin(e) {
        e.preventDefault();
        const errorEl = $('loginError');
        errorEl.textContent = '';

        const usernameRaw = ($('loginUsername').value || '').trim();
        const password = $('loginPassword').value || '';
        if (!usernameRaw || !password) return;

        try {
            await auth.signInWithEmailAndPassword(pseudoEmail(usernameRaw.toLowerCase()), password);
        } catch (err) {
            errorEl.textContent = authErrorMessage(err);
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

    function switchSidebarView(view) {
        document.querySelectorAll('.chat-subtab-btn[data-view]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        $('chatPanel-dms').style.display = view === 'dms' ? '' : 'none';
        $('chatPanel-rooms').style.display = view === 'rooms' ? '' : 'none';
        if (view === 'public') openPublic();
    }

    function openPublic() {
        teardownActiveThread();
        state.view = 'public';
        state.activeId = null;
        state.activeLabel = 'Public Wall';
        $('chatThreadHeader').textContent = 'Public Wall';
        subscribeMessages(db.collection('publicMessages').orderBy('ts', 'asc').limitToLast(100));
        renderDmList(state.lastDmDocs || []);
        renderRoomList(state.lastRoomDocs || []);
    }

    function openDm(id, otherName) {
        teardownActiveThread();
        state.view = 'dm';
        state.activeId = id;
        state.activeLabel = 'DM with ' + otherName;
        $('chatThreadHeader').textContent = 'DM with ' + otherName;
        subscribeMessages(db.collection('dms').doc(id).collection('messages').orderBy('ts', 'asc').limitToLast(100));
        renderDmList(state.lastDmDocs || []);
        renderRoomList(state.lastRoomDocs || []);
    }

    function openRoom(id, name) {
        teardownActiveThread();
        state.view = 'room';
        state.activeId = id;
        state.activeLabel = 'Room: ' + name;
        $('chatThreadHeader').textContent = 'Room: ' + name;
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
                });
            } else if (state.view === 'room' && state.activeId) {
                await db.collection('rooms').doc(state.activeId).collection('messages').add(payload);
            }
        } catch (err) {
            console.error('Failed to send message', err);
        }
    }

    // ---------- DMs ----------

    function renderDmList(docs) {
        state.lastDmDocs = docs;
        const el = $('chatDmList');
        if (!el) return;
        el.innerHTML = '';
        docs.forEach((d) => {
            const data = d.data();
            if (!data || !Array.isArray(data.members)) return;
            const otherUid = data.members.find((m) => m !== state.uid);
            const otherName = (data.memberNames && data.memberNames[otherUid]) || 'Unknown';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chat-list-item' + (state.view === 'dm' && state.activeId === d.id ? ' active' : '');
            btn.textContent = otherName;
            btn.addEventListener('click', () => openDm(d.id, otherName));
            el.appendChild(btn);
        });
    }

    function subscribeDmList() {
        state.unsubDmList = db
            .collection('dms')
            .where('members', 'array-contains', state.uid)
            .orderBy('updatedAt', 'desc')
            .onSnapshot(
                (snap) => renderDmList(snap.docs),
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

            switchSidebarView('dms');
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
        if (!el) return;
        el.innerHTML = '';
        docs.forEach((d) => {
            const data = d.data();
            if (!data) return;

            const item = document.createElement('div');
            item.className = 'chat-list-item' + (state.view === 'room' && state.activeId === d.id ? ' active' : '');

            const nameBtn = document.createElement('button');
            nameBtn.type = 'button';
            nameBtn.className = 'chat-room-name-btn';
            nameBtn.textContent = data.name || 'Room';
            nameBtn.addEventListener('click', () => openRoom(d.id, data.name || 'Room'));
            item.appendChild(nameBtn);

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
            });
            await db.collection('roomCodes').doc(code).set({ roomId: ref.id });

            $('chatRoomInfo').textContent = 'Room created! Share this code to invite people: ' + code;
            switchSidebarView('rooms');
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
            switchSidebarView('rooms');
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

    async function onAuthStateChanged(user) {
        if (!user) {
            state.uid = null;
            state.username = null;
            state.usernameLower = null;
            teardownUserSubscriptions();
            showAuthUi();
            return;
        }

        try {
            const profileDoc = await db.collection('users').doc(user.uid).get();
            if (!profileDoc.exists) {
                // Auth account exists but the profile write failed/never happened; sign back out.
                await auth.signOut();
                return;
            }
            const profile = profileDoc.data();
            state.uid = user.uid;
            state.username = profile.username;
            state.usernameLower = profile.usernameLower;

            showChatUi();
            subscribeDmList();
            subscribeRoomList();
            switchSidebarView('public');
        } catch (err) {
            console.error('Failed to load chat profile', err);
            setStatus('Chat error', 'error');
        }
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

    function wireUpUi() {
        document.querySelectorAll('.chat-subtab-btn[data-authtab]').forEach((btn) => {
            btn.addEventListener('click', () => switchAuthTab(btn.dataset.authtab));
        });
        document.querySelectorAll('.chat-subtab-btn[data-view]').forEach((btn) => {
            btn.addEventListener('click', () => switchSidebarView(btn.dataset.view));
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
