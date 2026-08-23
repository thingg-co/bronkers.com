// Site-wide behaviour: active nav link, mobile nav panel.

(function() {
    'use strict';

    // Mark the nav link for the current section. Links are root-relative
    // clean URLs ("/", "/app", "/docs/whitepaper"); pages may be served with
    // or without ".html". Matching is by first path segment, so every page
    // under /docs lights up "The Paper".
    const section = (path) => {
        const clean = path.replace(/\.html$/, '').replace(/\/index$/, '/');
        return clean.split('/')[1] || '';
    };
    const updateActiveNav = () => {
        const here = section(window.location.pathname);
        document.querySelectorAll('.nav-links a').forEach((link) => {
            link.classList.toggle('active', section(link.getAttribute('href') || '') === here);
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateActiveNav);
    } else {
        updateActiveNav();
    }
})();

// First visit: an alpha notice, acknowledged once per browser.
(function() {
    'use strict';
    const KEY = 'brokners.alpha.ack';
    let seen = false;
    try { seen = localStorage.getItem(KEY) === '1'; } catch {}
    if (seen || !document.body) return;
    const close = () => {
        try { localStorage.setItem(KEY, '1'); } catch {}
        back.remove();
        document.documentElement.classList.remove('modal-open');
    };
    const back = document.createElement('div');
    back.className = 'alpha-backdrop';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'alphaTitle');
    back.innerHTML =
        '<div class="alpha-modal">' +
        '<p class="alpha-eyebrow">Alpha · research prototype</p>' +
        '<h2 id="alphaTitle">Brok<span class="typo-n">n</span>ers is alpha software on a test network.</h2>' +
        '<ul>' +
        '<li>Everything here runs on public testnets with mock tokens. There is no real money, no token, and no deposits are taken.</li>' +
        '<li>The contracts are tested; the enclave the design depends on is not yet a hardware enclave. The trust gap is listed on the front page and in the paper.</li>' +
        '<li>Nothing on this site is an offer of securities or any investment product. Expect rough edges and breaking changes.</li>' +
        '</ul>' +
        '<div class="alpha-actions"><button type="button" class="btn primary" id="alphaOk">Understood, show me the brains</button></div>' +
        '</div>';
    document.body.appendChild(back);
    document.documentElement.classList.add('modal-open');
    back.querySelector('#alphaOk').addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    back.querySelector('#alphaOk').focus();
})();

// Mobile nav: hamburger toggle for the dropdown panel
(function() {
    'use strict';
    const nav = document.querySelector('.nav');
    const burger = document.getElementById('navBurger');
    if (!nav || !burger) return;

    const close = () => {
        nav.classList.remove('nav-open');
        burger.setAttribute('aria-expanded', 'false');
    };

    burger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = nav.classList.toggle('nav-open');
        burger.setAttribute('aria-expanded', String(open));
    });

    nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.addEventListener('click', (e) => { if (!nav.contains(e.target)) close(); });
})();
