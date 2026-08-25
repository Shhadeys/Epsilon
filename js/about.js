const CHANGELOG_RAW_URL = 'https://raw.githubusercontent.com/Shhadeys/Epsilon/main/CHANGELOG.md';
const REPO_ISSUES_URL = 'https://github.com/Shhadeys/Epsilon/issues/new';

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

fetch(CHANGELOG_RAW_URL)
    .then((res) => {
        if (!res.ok) throw new Error('Changelog not found');
        return res.text();
    })
    .then((markdown) => {
        document.getElementById('changelogContent').innerHTML = renderChangelog(markdown);
    })
    .catch(() => {
        document.getElementById('changelogContent').innerHTML =
            '<p>Could not load the changelog right now. <a href="https://github.com/Shhadeys/Epsilon/commits/main" target="_blank" rel="noopener noreferrer">View recent commits on GitHub</a> instead.</p>';
    });

/**
 * Opens a prefilled GitHub issue for a suggestion or bug report.
 *
 * @param {string} inputId
 * @param {string} label
 * @param {string} titlePrefix
 * @return {void}
 */
function submitFeedback(inputId, label, titlePrefix) {
    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if (!text) return;

    const title = `${titlePrefix}: ${text.slice(0, 60)}`;
    const url = `${REPO_ISSUES_URL}?labels=${encodeURIComponent(label)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
    input.value = '';
}

document.getElementById('suggestionSubmit').addEventListener('click', () => {
    submitFeedback('suggestionInput', 'enhancement', 'Suggestion');
});

document.getElementById('bugSubmit').addEventListener('click', () => {
    submitFeedback('bugInput', 'bug', 'Bug');
});
