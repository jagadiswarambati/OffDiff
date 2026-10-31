/**
 * @file layout.tsx
 * @description Next.js Root Layout for OffDiff dashboard.
 * Configures HTML root metadata, typography, and dark theme background for the application.
 */

import type { Metadata } from 'next';
import './globals.css';

/**
 * OffDiff dashboard metadata definition.
 */
export const metadata: Metadata = {
  title: 'OffDiff — AI Coding Agent Completion Claim Verifier',
  description: 'Evidence-based verification of AI coding agent completion claims against git diffs and codebase AST graphs.',
};

/**
 * RootLayout component wrapping all dashboard views with standard theme styling and viewport configuration.
 *
 * @param props.children React subcomponents to render within the body
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}

