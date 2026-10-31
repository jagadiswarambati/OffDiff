/**
 * @file tailwind.config.js
 * @description Tailwind CSS configuration for OffDiff dashboard.
 * - Scans pages, components, and app directory for Tailwind classes.
 * - Enforces dark mode class strategy (`class`).
 * - Defines GitHub-dark styled custom palette tokens (`offdark-900` through `offdark-500`).
 * - Configures crisp monospace font stacks for diff code snippets.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // High-contrast dark theme colors matching developer tools and GitHub dark mode
        offdark: {
          900: '#0d1117',
          800: '#161b22',
          700: '#21262d',
          600: '#30363d',
          500: '#484f58',
        },
      },
      fontFamily: {
        // Monospace font stack for diff hunks, code snippets, and CLI terminal views
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

