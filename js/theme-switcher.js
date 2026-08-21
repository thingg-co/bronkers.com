// Theme Switcher - Dark/Light Mode Toggle

(function() {
    'use strict';

    // Get theme from localStorage or default to light
    const getStoredTheme = () => localStorage.getItem('theme') || 'light';
    const setStoredTheme = (theme) => localStorage.setItem('theme', theme);

    // Apply theme to the document
    const applyTheme = (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon(theme);
    };

    // Update the theme toggle icon
    const updateThemeIcon = (theme) => {
        const themeIcon = document.querySelector('.theme-icon');
        if (themeIcon) {
            themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
    };

    // Toggle between light and dark theme
    const toggleTheme = () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        applyTheme(newTheme);
        setStoredTheme(newTheme);
    };

    // Initialize theme on page load
    const initTheme = () => {
        const storedTheme = getStoredTheme();
        applyTheme(storedTheme);

        // Add event listener to theme toggle button
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', toggleTheme);
        }
    };

    // Run initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTheme);
    } else {
        initTheme();
    }
})();
