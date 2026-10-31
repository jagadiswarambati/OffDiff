# OffDiff Live Demonstration Guide

This guide provides everything needed to demonstrate **OffDiff** live at a hackathon or presentation, including verification steps, expected results, CLI commands, dashboard walkthrough, and a 2-minute presentation script.

---

## 1. Prerequisites and Setup

- **Node.js**: v18+ (tested on Node v24)
- **Python**: 3.10+ (Tree-sitter runtime for Graphify)
- **Git**: 2.30+

### One-Time Environment Verification

1. Install project dependencies:
   ```bash
   npm install
   ```
2. Ensure Graphify AST engine is available:
   ```bash
   python -m graphify --help
   # If not installed: python -m pip install graphifyy
   ```
3. Check `.env.local` for optional Gemma 4 AI integration:
   ```bash
   # Contains GEMINI_API_KEY (kept secure, never exposed or committed)
   # OFFDIFF_AI_MODEL=gemma-4-26b-a4b-it
   ```

---

## 2. Starting the Application

### Option A: Web Dashboard (Interactive UI)

Start the production server:
```bash
npm run build
npm start
```
*Or during development:*
```bash
npm run dev
```

Open **`http://localhost:3000`** in your browser.

### Option B: CLI Verification Gate (Terminal)

The CLI gate is accessible via `node offdiff.js`:
```bash
node offdiff.js check --help
```

---

## 3. How to Check AI and Graphify Integration

### Graphify AST Verification
To see Graphify independently parse the sample repository:
```bash
python -m graphify update demo-repo --no-cluster
```
Output confirms:
`[graphify watch] Rebuilt (no clustering): 5 nodes, 7 edges`
`graph.json updated in demo-repo\graphify-out`

To query affected callers via Graphify CLI directly:
```bash
python -m graphify affected "get_price" --graph demo-repo/graphify-out/graph.json
```
Output:
```text
Affected nodes for get_price()
- invoice_total() [calls] pricing.py:L5
- export_total() [calls] pricing.py:L8
- receipt_total() [calls] pricing.py:L11
```

### Gemma 4 AI Verification
To test live inference with Gemma 4 (`gemma-4-26b-a4b-it`):
```bash
node offdiff.js check --repo demo-repo --base HEAD~1 --summary "No breaking changes" --ai
```
Output:
```text
✔ Graphify AST Graph: 5 nodes, 7 edges
--- Claims & Verdicts ---
 CONTRADICTED  "No breaking changes"
   [Gemma 4 Investigation] The signature of the function 'get_price' was changed from 'get_price(sku)' to 'get_price(sku, currency)' at pricing.py:1. This is a breaking change because any caller providing only one argument will now fail. Specifically, the function 'receipt_total' at pricing.py:11 calls 'get_price(sku)', which will now raise a TypeError.
   ↳ Location: pricing.py:1 [DETERMINISTIC]
   ↳ Location: pricing.py:1 [AI]
```

---

## 4. Scenario A: Incomplete Refactor (Missed Caller)

### Problem
An AI agent refactors `get_price(sku)` to `get_price(sku, currency)`. It updates `invoice_total` and `export_total`, but **silently misses `receipt_total`**.
The agent claims:
> *"Updated all callers of get_price to pass the currency."*

### Execution

```bash
# Ensure demo-repo is on main branch (incomplete refactor)
node offdiff.js check --repo demo-repo --base HEAD~1 --summary "Updated all callers of get_price to pass the currency."
```

### Expected Output
```text
🔍 OffDiff Claim Verification Gate
   Repository: C:\Users\srija\Desktop\offdiff\demo-repo
   Base Rev:   HEAD~1
   Summary:    "Updated all callers of get_price to pass the currency."

✔ Graphify AST Graph: 5 nodes, 7 edges

--- Verification Statistics ---
Claims Checked:     1
Verified Claims:    0
Contradicted:       1
Untouched Callers:  1
At Risk / Warn:     0

--- Claims & Verdicts ---
 CONTRADICTED  "Updated all callers of get_price to pass the currency."
   Contradicted: Found 1 untouched caller(s) of 'get_price' that were not updated in this change.
   ↳ Location: pricing.py:11 [DETERMINISTIC]
     Caller: receipt_total
     Snippet:
        def receipt_total(sku): 
            return get_price(sku) 

🚨 Untouched Code Detected (Missed Callers):
  • Function 'receipt_total' calls 'get_price' at pricing.py:11
    Evidence: def receipt_total(sku):     return get_price(sku) 

========================================
 GATE STATUS: FAILED (CLAIMS CONTRADICTED) 
========================================
```
- **Verdict**: `CONTRADICTED`
- **Untouched Caller**: `receipt_total` at `pricing.py:11`
- **CLI Exit Code**: `1` (Blocks CI/CD deployment!)

---

## 5. Scenario B: Complete Refactor (All Callers Updated)

### Problem
The agent correctly updates all callers (`invoice_total`, `export_total`, `receipt_total`) to pass the currency parameter.
OffDiff must verify the claim without false alarms.

### Execution

```bash
# Compare against the base revision before the refactor began
node offdiff.js check --repo demo-repo --base main~1 --summary "Updated all callers of get_price to pass the currency."
```

*(Or on the web dashboard: click the **"2. Complete Refactor"** preset button).*

### Expected Output
```text
✔ Graphify AST Graph: 5 nodes, 7 edges

--- Verification Statistics ---
Claims Checked:     1
Verified Claims:    1
Contradicted:       0
Untouched Callers:  0
At Risk / Warn:     0

--- Claims & Verdicts ---
 VERIFIED  "Updated all callers of get_price to pass the currency."
   Verified: All 3 caller(s) of 'get_price' were updated in git diff. No untouched callers remain.
   ↳ Location: pricing.py:5 [DETERMINISTIC]
     Caller: invoice_total

========================================
 GATE STATUS: PASSED (ALL CLAIMS VERIFIED) 
========================================
```
- **Verdict**: `VERIFIED`
- **Untouched Callers**: `0` (Zero false alarms)
- **CLI Exit Code**: `0` (Gate passes!)

---

## 6. Machine-Readable JSON Output

In CI/CD pipelines, use `--json` to integrate with GitHub Actions, GitLab CI, or pre-commit hooks:

```bash
node offdiff.js check --repo demo-repo --base HEAD~1 --summary "Updated all callers of get_price to pass the currency." --json
```

Output conforms strictly to the Zod `VerificationResultSchema`.

---

## 7. Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| `Port 3000 in use` | Another process is occupying port 3000 | Run on port 3005: `npx next start -p 3005` or kill the stale process: `Stop-Process -Name "node" -Force` |
| `Graphify not found` | Python package not installed | Run `python -m pip install graphifyy` |
| `Gemma model 404` | Generic model name passed | Ensure `OFFDIFF_AI_MODEL=gemma-4-26b-a4b-it` in `.env.local` |
| `Strict mode exit 2` | Coverage warning or AT RISK findings | Run without `--strict` or resolve unverified signature modifications |

---

## 8. Two-Minute Live Presentation Script

> **[0:00 - The Problem]**  
> *"Hello judges. Autonomous AI coding agents are writing massive amounts of code today. They refactor APIs, delete legacy code, and claim: 'I updated all callers', 'No breaking changes', or 'Removed every reference'.  
> But here's the catch: standard Git diffs only show lines that changed. If an AI agent refactors 2 callers and misses the 3rd, that untouched caller never appears in the pull request diff. It slips silently into production, causing runtime crashes."*

> **[0:35 - The Solution]**  
> *"This is why we built **OffDiff**. OffDiff is the first evidence-based verification gate specifically engineered to catch what AI agents claim versus what they actually changed.  
> Instead of merely scanning the diff lines, OffDiff combines Git commit histories with Tree-sitter and Graphify AST code graphs. It queries the knowledge graph to discover every caller of the changed symbol, compares them against the diff, and flags untouched code with exact file and line precision."*

> **[1:05 - The Live Demo]**  
> *"Let's see it live. Here in our sample repository, an agent refactored `get_price` to accept a currency argument. It updated `invoice_total` and `export_total`, but missed `receipt_total`. The agent claimed: 'Updated all callers of get_price to pass the currency.'  
> When we run `offdiff check`, OffDiff immediately builds the Graphify AST, investigates the call graph, and issues a `CONTRADICTED` verdict. It highlights `receipt_total` at `pricing.py:11` as an untouched caller and exits with code 1, automatically blocking the CI/CD pipeline.  
> When we switch to the complete refactor, OffDiff confirms all 3 callers were updated, reporting `VERIFIED` with zero false alarms and exit code 0."*

> **[1:40 - Gemma 4 AI Investigation & Evidence]**  
> *"For complex semantic claims like 'No breaking changes', OffDiff integrates Google GenAI with Gemma 4 (`gemma-4-26b-a4b-it`). Gemma investigates the AST changes, detects that adding a required parameter without defaults breaks single-argument callers, and validates every quote against actual source files before presenting it as evidence.  
> OffDiff turns unverified AI claims into verifiable source truth. Thank you!"*

