/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure native server execution works cleanly for local analysis
  serverExternalPackages: ['@google/genai']
};

export default nextConfig;

