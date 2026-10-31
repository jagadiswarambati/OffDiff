/**
 * @file next.config.mjs
 * @description Next.js 15 application configuration for OffDiff dashboard.
 * - Enables React strict mode for robust lifecycle checking.
 * - Declares `@google/genai` under `serverExternalPackages` so that native Node.js
 *   modules and child process APIs execute cleanly on the server without Webpack bundling issues.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure server-only packages execute natively in Node.js runtime without Webpack client bundling
  serverExternalPackages: ['@google/genai'],
};

export default nextConfig;

