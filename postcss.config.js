/**
 * @file postcss.config.js
 * @description PostCSS configuration for OffDiff dashboard.
 * Processes Tailwind CSS utilities and applies browser vendor prefixes via Autoprefixer.
 */

module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

