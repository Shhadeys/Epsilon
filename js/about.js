/**
 * Escapes HTML-sensitive characters in a string.
 *
 * @param {string} str
 * @return {string}
 */
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders a minimal subset of Markdown (## headings, - lists, paragraphs) to HTML.
 *
 * @param {string} markdown
 * @return {string}
 */
function renderChangelog(markdown) {
    const lines = markdown.split('\n');
    let html = '';
    let inList = false;

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^#\s+/.test(line)) {
            continue; // skip the top-level document title
        } else if (/^#{2,3}\s+/.test(line)) {
            if (inList) { html += '</ul>'; inList = false; }
            html += `<h6 class="changelog-version">${escapeHtml(line.replace(/^#{2,3}\s+/, ''))}</h6>`;
        } else if (/^[-*]\s+/.test(line)) {
            if (!inList) { html += '<ul>'; inList = true; }
            html += `<li>${escapeHtml(line.replace(/^[-*]\s+/, ''))}</li>`;
        } else if (line.trim() === '') {
            if (inList) { html += '</ul>'; inList = false; }
        } else {
            if (inList) { html += '</ul>'; inList = false; }
            html += `<p>${escapeHtml(line)}</p>`;
        }
    }
    if (inList) html += '</ul>';

    return html || '<p>Changelog is empty.</p>';
}

// CHANGELOG_MARKDOWN comes from js/changelog-data.js, which is regenerated from
// CHANGELOG.md by scripts/build-changelog.js (wired up as a pre-commit hook) --
// baked in at commit time instead of fetched from GitHub on every page load.
if (typeof window.CHANGELOG_MARKDOWN === 'string') {
    document.getElementById('changelogContent').innerHTML = renderChangelog(window.CHANGELOG_MARKDOWN);
} else {
    document.getElementById('changelogContent').innerHTML =
        '<p>Changelog data is missing. Run <code>node scripts/build-changelog.js</code> and reload.</p>';
}

/**
 * Submits a suggestion or bug report to Firestore instead of opening a GitHub issue.
 * Uses the same Firebase app js/chat.js sets up; works without being signed into chat.
 *
 * @param {string} inputId
 * @param {string} type
 * @param {string} statusId
 * @return {void}
 */
function submitFeedback(inputId, type, statusId) {
    const input = document.getElementById(inputId);
    const statusEl = document.getElementById(statusId);
    const text = input.value.trim();
    if (!text) return;

    if (typeof firebase === 'undefined' || !firebase.apps.length) {
        if (statusEl) statusEl.textContent = 'Feedback is unavailable right now.';
        return;
    }

    const currentUser = firebase.auth().currentUser;
    if (statusEl) statusEl.textContent = 'Sending…';

    firebase
        .firestore()
        .collection('feedback')
        .add({
            type,
            text: text.slice(0, 1000),
            uid: currentUser ? currentUser.uid : null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        })
        .then(() => {
            input.value = '';
            if (statusEl) statusEl.textContent = 'Thanks, sent!';
        })
        .catch((err) => {
            console.error('Failed to submit feedback', err);
            if (statusEl) statusEl.textContent = 'Could not send right now, try again later.';
        });
}

document.getElementById('suggestionSubmit').addEventListener('click', () => {
    submitFeedback('suggestionInput', 'suggestion', 'suggestionStatus');
});

document.getElementById('bugSubmit').addEventListener('click', () => {
    submitFeedback('bugInput', 'bug', 'bugStatus');
});
