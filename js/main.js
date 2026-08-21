// Main JavaScript - Form Handling and Utilities

(function() {
    'use strict';

    // Handle contact form submission
    const initContactForm = () => {
        const contactForm = document.getElementById('contactForm');
        const formSuccess = document.getElementById('formSuccess');

        if (!contactForm) return;

        // Check if we were redirected back after successful submission
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('success') === 'true') {
            contactForm.style.display = 'none';
            formSuccess.style.display = 'block';

            // Clean up URL
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    };

    // Mobile menu toggle (if needed in the future)
    const initMobileMenu = () => {
        // Placeholder for mobile menu functionality
        // Can be expanded when mobile hamburger menu is added
    };

    // Add active state to current page in navigation
    const updateActiveNav = () => {
        const currentPage = window.location.pathname.split('/').pop() || 'index.html';
        const navLinks = document.querySelectorAll('.nav-links a');

        navLinks.forEach(link => {
            const href = link.getAttribute('href');
            if (href === currentPage) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    };

    // Initialize all main functionality
    const init = () => {
        initContactForm();
        initMobileMenu();
        updateActiveNav();
    };

    // Run initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
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
