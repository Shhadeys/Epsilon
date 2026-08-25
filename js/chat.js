(function () {
    // A public, unauthenticated MQTT-over-websockets relay -- anyone who knows this topic can read/write it.
    // There's no server here, no history, no accounts. Good for casual chat, not for anything sensitive.
    const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';
    const CHAT_TOPIC = 'epsilon-unblocked-site/chat/lobby/v1';
    const MAX_MESSAGE_LENGTH = 500;
    const MAX_NAME_LENGTH = 24;
    const SEND_COOLDOWN_MS = 1200;
    const MAX_RENDERED_MESSAGES = 200;

    const clientId = 'ep-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const seenIds = new Set();
    let client = null;
    let lastSendAt = 0;

    function $(id) {
        return document.getElementById(id);
    }

    function getStoredName() {
        let name = localStorage.getItem('chatName');
        if (!name) {
            name = 'Guest' + Math.floor(1000 + Math.random() * 9000);
            localStorage.setItem('chatName', name);
        }
        return name;
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

    function appendMessage({ id, name, text, ts, mine, system }) {
        const messages = $('chatMessages');
        if (!messages) return;
        if (id) {
            if (seenIds.has(id)) return;
            seenIds.add(id);
        }

        const item = document.createElement('div');
        item.className = 'chat-message' + (mine ? ' own' : '') + (system ? ' system' : '');

        if (system) {
            item.textContent = text;
        } else {
            const meta = document.createElement('div');
            meta.className = 'chat-message-meta';

            const nameEl = document.createElement('span');
            nameEl.className = 'chat-message-name';
            nameEl.textContent = name || 'Guest';
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
        }

        const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
        messages.appendChild(item);
        while (messages.children.length > MAX_RENDERED_MESSAGES) {
            messages.removeChild(messages.firstChild);
        }
        if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
    }

    function connectChat() {
        if (typeof mqtt === 'undefined') {
            setStatus('Chat unavailable', 'error');
            return;
        }

        setStatus('Connecting…');
        client = mqtt.connect(BROKER_URL, {
            clientId,
            reconnectPeriod: 3000,
            connectTimeout: 8000,
        });

        client.on('connect', () => {
            setStatus('Connected', 'connected');
            setSendEnabled(true);
            client.subscribe(CHAT_TOPIC, { qos: 0 });
        });

        client.on('reconnect', () => {
            setStatus('Reconnecting…');
            setSendEnabled(false);
        });

        client.on('close', () => {
            setStatus('Disconnected');
            setSendEnabled(false);
        });

        client.on('offline', () => {
            setStatus('Offline');
            setSendEnabled(false);
        });

        client.on('error', () => {
            setStatus('Connection error', 'error');
            setSendEnabled(false);
        });

        client.on('message', (topic, payload) => {
            if (topic !== CHAT_TOPIC) return;
            let data;
            try {
                data = JSON.parse(payload.toString());
            } catch (e) {
                return;
            }
            if (!data || typeof data.text !== 'string' || !data.text.trim()) return;

            appendMessage({
                id: typeof data.id === 'string' ? data.id : undefined,
                name: String(data.name || 'Guest').slice(0, MAX_NAME_LENGTH),
                text: String(data.text).slice(0, MAX_MESSAGE_LENGTH),
                ts: typeof data.ts === 'number' ? data.ts : undefined,
                mine: data.from === clientId,
            });
        });
    }

    function sendMessage(rawText) {
        const now = Date.now();
        if (now - lastSendAt < SEND_COOLDOWN_MS) return;
        if (!client || !client.connected) return;

        const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!text) return;

        const nameInput = $('chatNameInput');
        let name = ((nameInput && nameInput.value) || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) name = getStoredName();
        localStorage.setItem('chatName', name);

        const payload = {
            id: clientId + '-' + now,
            from: clientId,
            name,
            text,
            ts: now,
        };

        client.publish(CHAT_TOPIC, JSON.stringify(payload), { qos: 0 });
        lastSendAt = now;
    }

    window.addEventListener('load', () => {
        const nameInput = $('chatNameInput');
        if (nameInput) nameInput.value = getStoredName();

        appendMessage({
            system: true,
            text: "This chat is public and not saved. You'll only see messages sent while this tab is open. (very very in progress)",
        });

        connectChat();

        const form = $('chatForm');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const textInput = $('chatTextInput');
                if (!textInput) return;
                sendMessage(textInput.value);
                textInput.value = '';
                textInput.focus();
            });
        }
    });
})();
