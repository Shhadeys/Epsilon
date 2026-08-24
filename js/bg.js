let inGame = false;
let particleNetwork = null;

function initParticles() {
    const container = document.getElementById('particle-canvas');
    if (!container) return;
    container.innerHTML = '';

    const colorSettings = JSON.parse(localStorage.getItem('colorSettings')) || {};
    const bg = colorSettings['bg'] || '#202020';
    const particleColor = colorSettings['particle-color'] || '#888888';

    particleNetwork = new ParticleNetwork(container, {
        particleColor,
        background: bg,
        interactive: true,
        speed: 'slow',
        density: 12000,
    });
}

function changeTitleColor() {
    const el = document.getElementById('title');
    if (!el) return;
    const colorSettings = JSON.parse(localStorage.getItem('colorSettings')) || {};
    const particleColor = colorSettings['particle-color'] || '#888888';
    el.style.backgroundImage = `linear-gradient(135deg, #ffffff, ${particleColor})`;
}

window.addEventListener('load', () => {
    initParticles();
    changeTitleColor();
});
