import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OffDiff — AI Coding Agent Completion Claim Verifier',
  description: 'Evidence-based verification of AI coding agent completion claims against git diffs and codebase AST graphs.',
};

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

