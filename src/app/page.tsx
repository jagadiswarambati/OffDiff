/**
 * @file page.tsx
 * @description Main interactive web dashboard for OffDiff.
 * Allows users to inspect local Git repositories or remote GitHub repositories,
 * specify base Git revisions (e.g. HEAD~1, commit SHA), formulate agent completion
 * claims (or auto-detect them from the latest commit), execute deterministic and AI
 * verification gates, and review granular evidence across AST call graphs and git diffs.
 */

'use client';

import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  GitBranch,
  FileCode2,
  Search,
  Sparkles,
  ShieldCheck,
  RefreshCw,
  Clock,
  Layers,
  Terminal,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Code2,
  Cpu,
} from 'lucide-react';
import type { VerificationResult, FindingEvidence } from '@/core/types';

/**
 * Main interactive Dashboard component for OffDiff.
 */
export default function Dashboard() {
  // Input form state: repository path, base Git revision, completion claim text
  const [repoPath, setRepoPath] = useState('demo-repo');
  const [baseRevision, setBaseRevision] = useState('HEAD~1');
  const [summary, setSummary] = useState('Updated all callers of get_price to pass the currency.');
  const [strict, setStrict] = useState(false);
  const [useAi, setUseAi] = useState(false);

  // Execution & UI state
  const [loading, setLoading] = useState(false);
  const [settingDemo, setSettingDemo] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'claims' | 'dependencies' | 'untouched' | 'git' | 'raw'>('claims');
  const [selectedEvidence, setSelectedEvidence] = useState<FindingEvidence | null>(null);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [detectingClaim, setDetectingClaim] = useState(false);

  // Automatically run initial verification against demo repo on mount
  useEffect(() => {
    runVerification();
  }, []);

  /**
   * Queries /api/repo-info to inspect repository commit metadata and diff,
   * automatically setting the summary claim to match the latest commit.
   *
   * @param targetRepo Optional repository path override
   * @param targetBase Optional base Git revision override
   */
  async function autoDetectClaim(targetRepo?: string, targetBase?: string) {
    const r = targetRepo || repoPath;
    const b = targetBase || baseRevision;
    setDetectingClaim(true);
    try {
      const res = await fetch(`/api/repo-info?repo=${encodeURIComponent(r)}&base=${encodeURIComponent(b)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.suggestedClaim) {
          setSummary(data.suggestedClaim);
        }
      }
    } catch {
      // ignore
    } finally {
      setDetectingClaim(false);
    }
  }

  /**
   * Dispatches verification request to POST /api/verify with current settings.
   *
   * @param overrideSummary Optional summary claim string override
   * @param overrideBase Optional base revision string override
   */
  async function runVerification(overrideSummary?: string, overrideBase?: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath,
          baseRevision: overrideBase || baseRevision,
          summary: overrideSummary || summary,
          strict,
          useAi,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Verification request failed');
      }

      setResult(data);
      if (data.findings && data.findings.length > 0) {
        setSelectedEvidence(data.findings[0]);
      } else {
        setSelectedEvidence(null);
      }
    } catch (err: unknown) {
      const e = err as Error;
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Pre-loads one of the three mandatory evaluation scenarios into the demo repo.
   *
   * @param scenario 'incomplete' | 'complete' | 'breaking'
   */
  async function loadScenario(scenario: 'incomplete' | 'complete' | 'breaking') {
    setSettingDemo(true);
    setError(null);
    try {
      if (scenario === 'incomplete') {
        await fetch('/api/demo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: 'incomplete' }),
        });
        const newSummary = 'Updated all callers of get_price to pass the currency.';
        setSummary(newSummary);
        setBaseRevision('HEAD~1');
        await runVerification(newSummary, 'HEAD~1');
      } else if (scenario === 'complete') {
        await fetch('/api/demo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: 'complete' }),
        });
        const newSummary = 'Updated all callers of get_price to pass the currency.';
        setSummary(newSummary);
        setBaseRevision('HEAD~1');
        await runVerification(newSummary, 'HEAD~1');
      } else {
        const newSummary = 'No breaking changes.';
        setSummary(newSummary);
        setBaseRevision('HEAD~1');
        await runVerification(newSummary, 'HEAD~1');
      }
    } catch (err: unknown) {
      const e = err as Error;
      setError(e.message);
    } finally {
      setSettingDemo(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0d1117] text-slate-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-[#161b22] px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            OD
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-tight">OffDiff</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                v0.1.0
              </span>
            </div>
            <p className="text-xs text-slate-400">Verifying AI agent claims against real code diffs & Graphify AST</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-xs font-mono bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-md text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>CLI Gate Active:</span>
            <code className="text-emerald-400">offdiff check</code>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Quick Demo Pre-sets */}
        <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>Mandatory Demo Scenarios (One-Click Setup)</span>
            </div>
            <span className="text-xs text-slate-400">Real git repository created dynamically in demo-repo</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button
              onClick={() => loadScenario('incomplete')}
              disabled={loading || settingDemo}
              className="text-left p-3 rounded-lg border border-red-900/60 bg-red-950/20 hover:bg-red-950/40 transition group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-red-300 group-hover:text-red-200">
                  Load Incomplete Refactor Demo
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/80 text-red-200 font-mono">
                  CONTRADICTED
                </span>
              </div>
              <p className="text-xs text-slate-400 line-clamp-2">
                receipt_total left untouched when get_price(sku, currency) updated. Missed caller detected.
              </p>
            </button>

            <button
              onClick={() => loadScenario('complete')}
              disabled={loading || settingDemo}
              className="text-left p-3 rounded-lg border border-emerald-900/60 bg-emerald-950/20 hover:bg-emerald-950/40 transition group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-emerald-300 group-hover:text-emerald-200">
                  Load Complete Refactor Demo
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/80 text-emerald-200 font-mono">
                  VERIFIED
                </span>
              </div>
              <p className="text-xs text-slate-400 line-clamp-2">
                All callers (invoice, export, receipt) updated. Zero false alarms generated.
              </p>
            </button>

            <button
              onClick={() => loadScenario('breaking')}
              disabled={loading || settingDemo}
              className="text-left p-3 rounded-lg border border-amber-900/60 bg-amber-950/20 hover:bg-amber-950/40 transition group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-amber-300 group-hover:text-amber-200">
                  Load Breaking Changes Check
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/80 text-amber-200 font-mono">
                  AT RISK / AI
                </span>
              </div>
              <p className="text-xs text-slate-400 line-clamp-2">
                Evaluates claim "No breaking changes" against function signature parameter additions.
              </p>
            </button>
          </div>
        </div>

        {/* Verification Form */}
        <div className="bg-[#161b22] border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300 flex items-center space-x-2">
              <Search className="w-4 h-4 text-indigo-400" />
              <span>Verification Input</span>
            </h2>
            <div className="flex items-center space-x-4 text-xs">
              <label className="flex items-center space-x-2 cursor-pointer text-slate-300">
                <input
                  type="checkbox"
                  checked={strict}
                  onChange={e => setStrict(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                />
                <span>Strict Mode</span>
              </label>
              <label className="flex items-center space-x-2 cursor-pointer text-slate-300">
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={e => setUseAi(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                />
                <span>Enable Gemma 4 AI</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Repository Path or GitHub URL</label>
              <input
                type="text"
                value={repoPath}
                onChange={e => setRepoPath(e.target.value)}
                className="w-full bg-[#0d1117] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:border-indigo-500 focus:outline-none"
                placeholder="demo-repo or https://github.com/owner/repo"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-400">Base Git Revision</label>
                <span className="text-[10px] text-slate-400 font-mono">e.g. HEAD~1, HEAD~2, main</span>
              </div>
              <input
                type="text"
                value={baseRevision}
                onChange={e => setBaseRevision(e.target.value)}
                className="w-full bg-[#0d1117] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:border-indigo-500 focus:outline-none"
                placeholder="HEAD~1 (or main, HEAD~2, commit SHA)"
              />
            </div>

            <div className="flex items-end">
              <button
                onClick={() => runVerification()}
                disabled={loading || settingDemo}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 text-white font-medium px-4 py-2 rounded-lg text-sm flex items-center justify-center space-x-2 transition shadow-lg shadow-indigo-600/20"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Analyzing Git & AST...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    <span>Run Verification Gate</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-400">
                Coding Agent Completion Summary (Claims)
              </label>
              <button
                type="button"
                onClick={() => autoDetectClaim()}
                disabled={detectingClaim}
                className="text-xs text-indigo-300 hover:text-indigo-200 flex items-center space-x-1.5 font-mono py-1 px-2.5 rounded bg-indigo-950/80 border border-indigo-700/80 hover:bg-indigo-900/80 transition"
                title="Inspect repository git commit and diff to generate claim"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>{detectingClaim ? 'Detecting from commit...' : '⚡ Auto-Detect Claim from Commit'}</span>
              </button>
            </div>
            <textarea
              rows={2}
              value={summary}
              onChange={e => setSummary(e.target.value)}
              className="w-full bg-[#0d1117] border border-slate-700 rounded-lg p-3 text-sm text-slate-200 font-mono focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. feat: update callers of foo, or leave empty to auto-detect from repository commit"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-xs flex items-center space-x-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Verification Result Banner & Suggested Action */}
        {result && (
          <div className="space-y-6">
            {/* Prominent Overall Verdict Banner */}
            <div
              className={`p-5 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                result.overallVerdict === 'PASSED'
                  ? 'bg-emerald-950/30 border-emerald-800/80 text-emerald-200'
                  : result.overallVerdict === 'FAILED'
                  ? 'bg-red-950/30 border-red-800/80 text-red-200'
                  : 'bg-amber-950/30 border-amber-800/80 text-amber-200'
              }`}
            >
              <div className="flex items-start space-x-3">
                {result.overallVerdict === 'PASSED' ? (
                  <CheckCircle2 className="w-7 h-7 text-emerald-400 flex-shrink-0 mt-0.5" />
                ) : result.overallVerdict === 'FAILED' ? (
                  <XCircle className="w-7 h-7 text-red-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-7 h-7 text-amber-400 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-lg tracking-wide">
                      GATE VERDICT: {result.overallVerdict === 'PASSED' ? 'PASSED (VERIFIED)' : result.overallVerdict === 'FAILED' ? 'FAILED (CONTRADICTED)' : 'WARNING (AT RISK)'}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded font-mono bg-black/40 border border-current">
                      Exit Code: {result.overallVerdict === 'FAILED' ? '1' : result.overallVerdict === 'WARNING' && result.strict ? '2' : '0'}
                    </span>
                  </div>
                  <p className="text-xs opacity-90 mt-1">
                    Compared working tree vs base revision <code className="font-mono underline">{result.baseRevision}</code> in <code className="font-mono">{result.repoPath}</code>
                  </p>
                  {result.commitInfo?.subject && (
                    <div className="mt-1.5 flex items-center space-x-2 text-xs">
                      <span className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-700/60 font-mono text-[11px] text-slate-300">
                        Commit: {result.commitInfo.subject}
                      </span>
                      {result.commitInfo.author && (
                        <span className="text-slate-400 text-[11px]">by {result.commitInfo.author}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-2 text-xs font-mono">
                <Clock className="w-3.5 h-3.5 opacity-70" />
                <span>{new Date(result.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>

            {/* Suggested Next Action Callout */}
            {result.suggestedAction && (
              <div className="bg-indigo-950/30 border border-indigo-900/60 rounded-xl p-4 flex items-start space-x-3">
                <ArrowRight className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="text-xs font-semibold text-indigo-300 uppercase tracking-wider block">
                    Suggested Next Action:
                  </span>
                  <p className="text-sm text-slate-200 mt-0.5 font-medium">{result.suggestedAction}</p>
                </div>
              </div>
            )}

            {/* Metrics Overview Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3.5">
                <span className="text-xs text-slate-400 block mb-1">Total Claims</span>
                <span className="text-2xl font-bold font-mono text-slate-100">{result.stats.totalClaims}</span>
              </div>

              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3.5">
                <span className="text-xs text-emerald-400 block mb-1">Verified Claims</span>
                <span className="text-2xl font-bold font-mono text-emerald-400">{result.stats.verified}</span>
              </div>

              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3.5">
                <span className="text-xs text-red-400 block mb-1">Contradicted</span>
                <span className="text-2xl font-bold font-mono text-red-400">{result.stats.contradicted}</span>
              </div>

              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3.5">
                <span className="text-xs text-red-300 block mb-1">Untouched Callers</span>
                <div className="flex items-center space-x-2">
                  <span className={`text-2xl font-bold font-mono ${result.stats.untouchedCallers > 0 ? 'text-red-400' : 'text-slate-400'}`}>
                    {result.stats.untouchedCallers}
                  </span>
                  {result.stats.untouchedCallers > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-950 text-red-400 border border-red-800 font-mono">
                      MISSED
                    </span>
                  )}
                </div>
              </div>

              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3.5 col-span-2 sm:col-span-1">
                <span className="text-xs text-slate-400 block mb-1">Graphify AST Graph</span>
                {result.graphify.executed ? (
                  <div>
                    <span className="text-sm font-semibold text-emerald-400 block">
                      {result.graphify.nodeCount} nodes, {result.graphify.edgeCount} edges
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono truncate block">
                      {result.graphify.graphJsonPath || 'graph.json'}
                    </span>
                  </div>
                ) : (
                  <div>
                    <span className="text-xs font-medium text-amber-400 block">Fallback AST</span>
                    <span className="text-[10px] text-slate-500">Partial coverage</span>
                  </div>
                )}
              </div>
            </div>

            {/* Changed Functions Bar (if any) */}
            {result.changedFunctions.length > 0 && (
              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4">
                <div className="flex items-center space-x-2 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  <Code2 className="w-4 h-4 text-indigo-400" />
                  <span>Changed Functions Detected in Git Diff ({result.changedFunctions.length}):</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {result.changedFunctions.map((fn, idx) => (
                    <div key={idx} className="bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-mono">
                      <span className="text-indigo-400 font-bold">{fn.name}()</span>
                      <span className="text-slate-500 ml-2">at {fn.file}:{fn.line}</span>
                      {fn.newSignature && <span className="text-emerald-400 ml-2">→ {fn.newSignature}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Missed Callers Alert Callout */}
            {result.untouchedCallers.length > 0 && (
              <div className="bg-red-950/20 border border-red-900 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-2 text-red-400 font-semibold text-sm">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>All Discovered Untouched Code Problems ({result.untouchedCallers.length} Missed Callers):</span>
                  </div>
                  <span className="text-xs font-mono bg-red-950 px-2 py-0.5 rounded text-red-300 border border-red-800">
                    {result.untouchedCallers.length} Problem{result.untouchedCallers.length > 1 ? 's' : ''} Detected
                  </span>
                </div>
                <div className="space-y-2">
                  {result.untouchedCallers.map((caller, i) => (
                    <div
                      key={i}
                      className="bg-[#0d1117] border border-red-900/60 rounded-lg p-3 flex flex-col md:flex-row md:items-center justify-between gap-2"
                    >
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold text-red-300 font-mono">
                            Function `{caller.caller}()`
                          </span>
                          <span className="text-xs text-slate-400">calls `{caller.symbol}`</span>
                          <span className="text-xs font-mono text-slate-400 underline">
                            {caller.file}:{caller.line}
                          </span>
                          <span className="text-[10px] bg-red-950 text-red-300 px-1.5 py-0.5 rounded border border-red-800 uppercase font-mono">
                            UNTOUCHED
                          </span>
                        </div>
                        <pre className="mt-1 text-xs font-mono text-slate-300 bg-slate-950 p-2 rounded border border-slate-800">
                          {caller.snippet}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tabbed Navigation */}
            <div className="border-b border-slate-800 flex items-center space-x-6">
              <button
                onClick={() => setActiveTab('claims')}
                className={`pb-3 text-sm font-medium transition border-b-2 flex items-center space-x-2 ${
                  activeTab === 'claims'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>Claims & Evidence ({result.claims.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('dependencies')}
                className={`pb-3 text-sm font-medium transition border-b-2 flex items-center space-x-2 ${
                  activeTab === 'dependencies'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers className="w-4 h-4" />
                <span>Dependency Analysis ({result.dependencyRelationships.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('untouched')}
                className={`pb-3 text-sm font-medium transition border-b-2 flex items-center space-x-2 ${
                  activeTab === 'untouched'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <AlertTriangle className="w-4 h-4" />
                <span>Untouched Code ({result.untouchedCallers.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('git')}
                className={`pb-3 text-sm font-medium transition border-b-2 flex items-center space-x-2 ${
                  activeTab === 'git'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitBranch className="w-4 h-4" />
                <span>Git Changes ({result.gitChanges.length} files)</span>
              </button>

              <button
                onClick={() => setActiveTab('raw')}
                className={`pb-3 text-sm font-medium transition border-b-2 flex items-center space-x-2 ${
                  activeTab === 'raw'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Terminal className="w-4 h-4" />
                <span>Raw JSON Output</span>
              </button>
            </div>

            {/* Tab 1: Claims & Evidence */}
            {activeTab === 'claims' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 space-y-4">
                  {result.claims.map(claim => (
                    <div
                      key={claim.id}
                      className="bg-[#161b22] border border-slate-800 rounded-xl p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center space-x-2 mb-1">
                            <span
                              className={`text-xs px-2 py-0.5 rounded font-mono font-bold ${
                                claim.status === 'VERIFIED'
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                  : claim.status === 'CONTRADICTED'
                                  ? 'bg-red-950 text-red-300 border border-red-800'
                                  : 'bg-amber-950 text-amber-300 border border-amber-800'
                              }`}
                            >
                              {claim.status}
                            </span>
                            <span className="text-xs text-slate-400 font-mono">
                              Type: {claim.type}
                            </span>
                          </div>
                          <h3 className="font-semibold text-slate-100 text-base">"{claim.rawText}"</h3>
                        </div>
                      </div>

                      <p className="text-xs text-slate-300 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
                        {claim.explanation}
                      </p>

                      {claim.evidence && claim.evidence.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-slate-800">
                          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                            Supporting Evidence ({claim.evidence.length})
                          </span>
                          {claim.evidence.map(ev => (
                            <button
                              key={ev.id}
                              onClick={() => setSelectedEvidence(ev)}
                              className={`w-full text-left p-3 rounded-lg border transition ${
                                selectedEvidence?.id === ev.id
                                  ? 'border-indigo-500 bg-indigo-950/20'
                                  : 'border-slate-800 bg-[#0d1117] hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="font-mono text-indigo-400 underline">
                                  {ev.filePath}:{ev.lineNumber}
                                </span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 uppercase font-mono">
                                  {ev.source}
                                </span>
                              </div>
                              <p className="text-xs text-slate-300 line-clamp-1">{ev.explanation}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Evidence Details Panel */}
                <div className="lg:col-span-5">
                  <div className="bg-[#161b22] border border-slate-800 rounded-xl p-5 sticky top-24 space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div className="flex items-center space-x-2">
                        <FileCode2 className="w-4 h-4 text-indigo-400" />
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
                          Evidence Inspector
                        </h3>
                      </div>
                      {selectedEvidence && (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono">
                          Source Validated
                        </span>
                      )}
                    </div>

                    {selectedEvidence ? (
                      <div className="space-y-4">
                        <div>
                          <span className="text-xs text-slate-400 block mb-1">Target Location</span>
                          <div className="font-mono text-sm bg-slate-900 px-3 py-2 rounded-lg border border-slate-800 text-indigo-300">
                            {selectedEvidence.filePath}:{selectedEvidence.lineNumber}
                          </div>
                        </div>

                        <div>
                          <span className="text-xs text-slate-400 block mb-1">Verified Source Snippet</span>
                          <pre className="font-mono text-xs bg-slate-950 p-3 rounded-lg border border-slate-800 text-slate-200 overflow-x-auto">
                            {selectedEvidence.snippet}
                          </pre>
                        </div>

                        <div>
                          <span className="text-xs text-slate-400 block mb-1">Explanation</span>
                          <p className="text-xs text-slate-300 bg-slate-900/60 p-3 rounded-lg border border-slate-800 leading-relaxed">
                            {selectedEvidence.explanation}
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                            <span className="text-slate-500 block text-[10px]">Verification Origin</span>
                            <span className="font-mono font-medium text-slate-300 uppercase">
                              {selectedEvidence.source}
                            </span>
                          </div>
                          <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                            <span className="text-slate-500 block text-[10px]">Confidence</span>
                            <span className="font-mono font-medium text-slate-300">
                              {(selectedEvidence.confidence * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="py-12 text-center text-slate-500 text-xs">
                        Select a claim evidence item to inspect its source snippet and file location.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Tab 2: Visible Dependency Analysis Section (Phase 3 requirement) */}
            {activeTab === 'dependencies' && (
              <div className="space-y-4">
                <div className="bg-[#161b22] border border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div className="flex items-center space-x-2">
                      <Layers className="w-5 h-5 text-indigo-400" />
                      <div>
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
                          Graphify Dependency Analysis
                        </h3>
                        <p className="text-xs text-slate-400">
                          Knowledge graph extracted via Tree-sitter AST parser
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center space-x-3 text-xs font-mono">
                      <span className="bg-slate-900 border border-slate-700 px-2.5 py-1 rounded text-slate-300">
                        {result.graphify.nodeCount || 0} nodes / {result.graphify.edgeCount || 0} edges
                      </span>
                      <span className={`px-2 py-0.5 rounded font-bold ${
                        result.graphify.executed ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'
                      }`}>
                        {result.graphify.executed ? 'GRAPHIFY ACTIVE' : 'FALLBACK AST'}
                      </span>
                    </div>
                  </div>

                  {/* Coverage warnings if any */}
                  {result.graphify.coverageWarning && (
                    <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800 text-amber-200 text-xs">
                      {result.graphify.coverageWarning}
                    </div>
                  )}

                  {/* Caller-callee relationships table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-900/80 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">Caller Function</th>
                          <th className="py-2.5 px-3">Target Callee</th>
                          <th className="py-2.5 px-3">Relation</th>
                          <th className="py-2.5 px-3">Source Location</th>
                          <th className="py-2.5 px-3">Git Diff Status</th>
                          <th className="py-2.5 px-3">Origin</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono">
                        {result.dependencyRelationships.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-6 text-center text-slate-500">
                              No caller-callee relationships detected in the analyzed scope.
                            </td>
                          </tr>
                        ) : (
                          result.dependencyRelationships.map((rel, idx) => (
                            <tr key={idx} className="hover:bg-slate-900/50">
                              <td className="py-2.5 px-3 font-semibold text-slate-200">{rel.caller}()</td>
                              <td className="py-2.5 px-3 text-indigo-400">{rel.callee}()</td>
                              <td className="py-2.5 px-3 text-slate-400">{rel.relation}</td>
                              <td className="py-2.5 px-3 text-slate-400 underline">{rel.file}:{rel.line}</td>
                              <td className="py-2.5 px-3">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  rel.status === 'CHANGED'
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                    : 'bg-red-950 text-red-300 border border-red-800'
                                }`}>
                                  {rel.status}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-[10px] text-slate-500 uppercase">{rel.source}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800">
                    <span>Graph output location: <code className="text-slate-300">{result.graphify.graphJsonPath || 'demo-repo/graphify-out/graph.json'}</code></span>
                    <span>Analyzed Revision: <code className="text-slate-300">{result.baseRevision} → {result.headRevision}</code></span>
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Untouched Code */}
            {activeTab === 'untouched' && (
              <div className="space-y-3">
                {result.untouchedCallers.length === 0 ? (
                  <div className="bg-[#161b22] border border-slate-800 rounded-xl p-8 text-center text-slate-400 text-sm">
                    <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                    <span>No untouched callers detected. All affected call-sites were refactored in the git diff.</span>
                  </div>
                ) : (
                  result.untouchedCallers.map((item, i) => (
                    <div
                      key={i}
                      className="bg-[#161b22] border border-red-900/50 rounded-xl p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <span className="text-sm font-bold font-mono text-red-300">
                            {item.caller}()
                          </span>
                          <span className="text-xs text-slate-400">
                            calls target `{item.symbol}`
                          </span>
                        </div>
                        <span className="text-xs font-mono text-slate-400 bg-slate-900 px-2 py-1 rounded border border-slate-800">
                          {item.file}:{item.line}
                        </span>
                      </div>
                      <pre className="text-xs font-mono bg-slate-950 p-3 rounded-lg border border-slate-800 text-slate-200">
                        {item.snippet}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Tab 4: Git Changes */}
            {activeTab === 'git' && (
              <div className="space-y-4">
                {result.gitChanges.map((change, i) => (
                  <div key={i} className="bg-[#161b22] border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-mono font-bold text-slate-200">{change.path}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-mono bg-slate-800 text-slate-300">
                          {change.status}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 text-xs font-mono">
                        <span className="text-emerald-400">+{change.insertions}</span>
                        <span className="text-red-400">-{change.deletions}</span>
                      </div>
                    </div>

                    {change.diffHunks.map((hunk, hIdx) => (
                      <pre
                        key={hIdx}
                        className="text-xs font-mono bg-[#0d1117] p-3 rounded-lg border border-slate-800 text-slate-300 overflow-x-auto"
                      >
                        {hunk.content}
                      </pre>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Tab 5: Raw JSON */}
            {activeTab === 'raw' && (
              <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4">
                <pre className="text-xs font-mono text-slate-300 overflow-x-auto bg-[#0d1117] p-4 rounded-lg border border-slate-800 max-h-[600px]">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            )}

            {/* Expandable Technical Details Section */}
            <div className="border border-slate-800 rounded-xl overflow-hidden bg-[#161b22]">
              <button
                onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                className="w-full px-5 py-3.5 flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider hover:bg-slate-900/60 transition"
              >
                <div className="flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-indigo-400" />
                  <span>Technical Diagnostics & Engine Metadata</span>
                </div>
                {showTechnicalDetails ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>

              {showTechnicalDetails && (
                <div className="p-5 border-t border-slate-800 space-y-4 text-xs font-mono text-slate-300 bg-[#0d1117]">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 space-y-1">
                      <span className="text-slate-500 font-bold block mb-1">Graphify Execution:</span>
                      <div>CLI Command: <code>python -m graphify</code></div>
                      <div>Exit Code: <code>{result.graphify.exitCode ?? 0}</code></div>
                      <div>Graph Output: <code>{result.graphify.graphJsonPath || 'None'}</code></div>
                      {result.graphify.stdout && (
                        <div className="mt-2 text-[11px] text-slate-400 whitespace-pre-wrap">
                          Stdout: {result.graphify.stdout}
                        </div>
                      )}
                    </div>

                    <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 space-y-1">
                      <span className="text-slate-500 font-bold block mb-1">AI Engine Status:</span>
                      <div>Used: <code>{result.aiStatus.used ? 'true' : 'false'}</code></div>
                      <div>Model: <code>{result.aiStatus.model || 'gemma-4-26b-a4b-it'}</code></div>
                      <div>Notes: <code>{result.aiStatus.notes}</code></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-[#161b22] px-6 py-4 text-xs text-slate-500 flex items-center justify-between">
        <span>OffDiff — Deterministic AST Graph & Evidence-Based Verification</span>
        <div className="flex items-center space-x-4">
          <span>Powered by Tree-sitter & Graphify</span>
          <span>Google GenAI / Gemma 4</span>
        </div>
      </footer>
    </div>
  );
}
