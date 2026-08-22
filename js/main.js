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
