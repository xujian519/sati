---
name: legal-employment-internal-investigation
description: "Reference: shared framework for managing internal investigations from intake through final memo — privileged investigation log, document processing with needle-finding, source coverage tracking, Q&A against the log, memo drafting, and audience summaries. Loaded by /legal-employment-investigation-open, /legal-employment-investigation-add, /legal-employment-investigation-query, /legal-employment-investigation-memo, and /legal-employment-investigation-summary; not invoked directly."
user-invocable: false
---

# Internal Investigation Skill

> **法域门禁：** 本文件保留上游美国法域调查参考，含 work-product、Weingarten、Garrity 等美国程序。中国大陆事项不得按下文美国程序、特权标签或期限直接执行；改用本领域已本地化的 `legal-employment-investigation-open`、`legal-employment-investigation-add`、`legal-employment-investigation-query`、`legal-employment-investigation-memo`、`legal-employment-investigation-summary` 及目标工作区规则。仅在用户明确指定美国法域且负责律师确认适用性后，才把下文作为比较或当地律师复核材料。标注“保密”不创造中国法上的独立工作成果特权。

## Matter context

**案件上下文。** 读取 `./.legal/active-matter`。文件不存在或为空时，询问："这是哪个案件的？运行 `/legal-matter new <slug>`，或说 `practice-level`。" 有活动案件时，加载 `matters/<slug>/matter.md`，把输出写入 `matters/<slug>/`。除非用户明确要求跨案比较，不读取其他案件的文件。

---

## Output header

Prepend the work-product header from `./.legal/practice/employment-legal.md` → `## Outputs` (it differs by user role — see `## Who's using this`). Every file, log, memo, and summary produced by this skill opens with that header.

> **Distribution discipline.** Every file this skill creates — log entries, memo drafts, audience summaries, document notes — inherits the privilege and confidentiality status of the underlying investigation. Distribution beyond the privilege circle (forwarding to non-attorneys outside the investigation team, cc'ing HR without scoping, handing to the business side) can waive privilege over the entire investigation. Store these files where privileged materials live, label per the work-product header, and make every distribution decision deliberately.

## ⚠️ Privilege notice — read before proceeding

**Marking does not create privilege.** The header above reflects the intended
protection and is important to include — but it does not itself establish
privilege. Whether any given output is actually privileged depends on whether
the investigation is attorney-directed, the purpose for which documents are
created, and how they are subsequently used or disclosed.

**Before opening a matter, confirm:** Is this investigation attorney-directed?
If it is not — if HR is running it with legal in an advisory role, or if it was
not initiated at the direction of counsel for the purpose of obtaining legal advice —
the privilege analysis changes materially and this skill's default labeling may
be misleading. Flag that question to the attorney before creating any log or file.

If there is any doubt about privilege applicability, the attorney should resolve it
before investigation files are created. Improperly labeled materials can create
problems in discovery if privilege is later challenged.

---

## Purpose

Internal investigations fail in two ways: coverage gaps (sources that were
never gathered) and synthesis gaps (evidence that was gathered but never
connected). This skill handles both — it tracks what has and hasn't been
gathered, processes document dumps to surface what matters without burying
the attorney, and maintains a structured log that can be turned into a
privileged memo at any point.

## Privilege note

All files created by this skill carry the privilege marking above.
See the notice at the top of this skill for the full caveat on what that
marking does and does not do.

## Load context

Read `./.legal/practice/employment-legal.md` → escalation table, any investigation protocols noted.

---

## Mode 1: Open a new matter

Triggered by `/legal-employment-investigation-open` or "open an investigation"
or "start an investigation into".

### Step 1 — Intake

Ask the following in a single block:

> To open the investigation log I need a few things:
>
> **The matter**
> - What is the allegation or concern in plain terms?
> - Who is the complainant (or what triggered this — complaint, tip, audit,
>   manager observation)?
> - Who is the respondent or subject?
> - What is the approximate timeframe the alleged conduct occurred?
> - Is this attorney-directed? Record the role and purpose; do not infer privilege solely from attorney involvement. Ask the responsible lawyer to assess confidentiality under the applicable law.
>
> **Investigation type** (helps me suggest the right sources checklist)
> - HR: harassment / discrimination / retaliation
> - Financial misconduct: expense fraud / procurement irregularities / embezzlement
> - Executive misconduct: COI / undisclosed relationships / governance failures
> - Whistleblower: retaliation for protected activity
> - Other: describe briefly
>
> **Representation and employer status** (surfaces parallel legal frameworks
> that change interview procedure)
> - Is the respondent, the complainant, or any anticipated witness represented
>   by a union or covered by a collective bargaining agreement? (If yes, flag
>   for Weingarten research — representational rights at investigatory
>   interviews may apply and change the interview protocol.)
> - Is the company a public employer (government entity, public university,
>   state or municipal agency) or otherwise acting under color of state law?
>   (If yes, flag for Garrity research — compelled statements in public-sector
>   investigations have special use-immunity consequences and change how
>   interviews must be conducted and documented.)

If either flag fires, research the applicable rules (NLRA / state
public-sector labor statutes for Weingarten; 5th Amendment and the Garrity
line of cases, plus any state analogs) before conducting interviews. Cite
primary sources. Verify currency. Do not interview until the protocol is
adjusted.

### Step 2 — Create the matter directory and files

Create the following files:

`./.legal/employment-legal/investigation-[matter-slug]/log.yaml`:

```yaml
# [WORK-PRODUCT HEADER — per mode's practice profile ## Outputs — differs by role; see `## Who's using this`]
matter: "[matter name]"
matter_slug: "[slug]"
opened: "[ISO date]"
attorney_directed: [true/false]
allegation: "[plain-language summary]"
complainant: "[name/role or anonymous]"
respondent: "[name/role]"
conduct_timeframe: "[approximate dates]"
investigation_type: "[HR/financial/executive/whistleblower/other]"
status: open
last_updated: "[ISO date]"

issues:
  - "[Issue 1 — derived from allegation, e.g. 'alleged hostile work environment']"
  - "[Issue 2 if applicable]"

entries: []

evidentiary_gaps: []
```

`./.legal/employment-legal/investigation-[matter-slug]/sources-checklist.yaml`:

Generated from the investigation type. See sources checklist templates below.

`./.legal/employment-legal/investigation-[matter-slug]/documents-reviewed.yaml`:

```yaml
# [WORK-PRODUCT HEADER — per mode's practice profile ## Outputs — differs by role; see `## Who's using this`]
matter: "[matter name]"
total_reviewed: 0
total_surfaced: 0
last_updated: "[ISO date]"
documents: []
```

### Step 3 — Sources checklist

Generate the appropriate checklist based on investigation type. Present it
to the attorney and ask: "Does this fit your matter? Let me know if any items
are not applicable (I'll mark them N/A) or if there are additional sources
specific to this situation."

**HR investigation sources (harassment/discrimination/retaliation):**
```yaml
sources:
  - id: 1
    source: "Complainant interview"
    status: open
    notes: ""
  - id: 2
    source: "Respondent interview"
    status: open
    notes: ""
  - id: 3
    source: "Witness interviews — identify from complainant and respondent accounts"
    status: open
    notes: ""
  - id: 4
    source: "Email/messaging review — parties, relevant date range"
    status: open
    notes: ""
  - id: 5
    source: "HR records — respondent's performance history, prior complaints,
             prior discipline"
    status: open
    notes: ""
  - id: 6
    source: "Prior complaints — any prior complaints against respondent in
             HR system"
    status: open
    notes: ""
  - id: 7
    source: "Comparator data — how were similar situations handled"
    status: open
    notes: ""
  - id: 8
    source: "Relevant policies — harassment, code of conduct, reporting
             procedures (version in effect at time of alleged conduct)"
    status: open
    notes: ""
  - id: 9
    source: "Org chart and reporting relationships at time of alleged conduct"
    status: open
    notes: ""
  - id: 10
    source: "Calendar records — any meetings or events mentioned in accounts"
    status: open
    notes: ""
  - id: 11
    source: "Upjohn warning documentation — confirm interviews were preceded
             by Upjohn warnings and documented"
    status: open
    notes: ""
```

**Financial misconduct sources:**
```yaml
sources:
  - id: 1
    source: "Expense reports — subject, relevant period"
    status: open
    notes: ""
  - id: 2
    source: "Approval records — who approved the expenses or transactions"
    status: open
    notes: ""
  - id: 3
    source: "Vendor/contractor records — contracts, invoices, payment records"
    status: open
    notes: ""
  - id: 4
    source: "Financial system records — AP, GL entries for relevant accounts"
    status: open
    notes: ""
  - id: 5
    source: "Email/messaging review — subject, approvers, counterparties"
    status: open
    notes: ""
  - id: 6
    source: "Subject interview"
    status: open
    notes: ""
  - id: 7
    source: "Approver interviews"
    status: open
    notes: ""
  - id: 8
    source: "Counterparty/vendor interviews (if accessible)"
    status: open
    notes: ""
  - id: 9
    source: "Audit logs — system access logs for relevant accounts/systems"
    status: open
    notes: ""
  - id: 10
    source: "Prior audits or reviews covering the relevant period"
    status: open
    notes: ""
  - id: 11
    source: "Upjohn warning documentation"
    status: open
    notes: ""
```

**Executive misconduct sources:**
```yaml
sources:
  - id: 1
    source: "Subject interview"
    status: open
    notes: ""
  - id: 2
    source: "Board/compensation committee records — relevant resolutions,
             minutes, approvals"
    status: open
    notes: ""
  - id: 3
    source: "Employment agreement and any amendments"
    status: open
    notes: ""
  - id: 4
    source: "Equity records — grants, exercises, vesting"
    status: open
    notes: ""
  - id: 5
    source: "Expense reports and approval records"
    status: open
    notes: ""
  - id: 6
    source: "Email/messaging review — subject, relevant counterparties"
    status: open
    notes: ""
  - id: 7
    source: "Conflict of interest disclosures (or absence thereof)"
    status: open
    notes: ""
  - id: 8
    source: "Outside business activity records"
    status: open
    notes: ""
  - id: 9
    source: "Witness interviews — direct reports, peers, board members"
    status: open
    notes: ""
  - id: 10
    source: "Prior complaints or concerns raised about subject"
    status: open
    notes: ""
  - id: 11
    source: "Upjohn warning documentation"
    status: open
    notes: ""
```

**Whistleblower sources:**
```yaml
sources:
  - id: 1
    source: "Complainant interview"
    status: open
    notes: ""
  - id: 2
    source: "Original complaint or tip — written form if exists"
    status: open
    notes: ""
  - id: 3
    source: "Records related to the underlying allegation (the thing
             complainant blew the whistle on)"
    status: open
    notes: ""
  - id: 4
    source: "Records related to any adverse action taken against complainant
             after the protected activity"
    status: open
    notes: ""
  - id: 5
    source: "Decision-maker interviews — who made the adverse action decision"
    status: open
    notes: ""
  - id: 6
    source: "Comparator data — treatment of similarly situated employees
             who did not engage in protected activity"
    status: open
    notes: ""
  - id: 7
    source: "Email/messaging review — decision-makers, relevant timeframe"
    status: open
    notes: ""
  - id: 8
    source: "Timing analysis — proximity of protected activity to adverse
             action"
    status: open
    notes: ""
  - id: 9
    source: "Respondent/decision-maker interviews"
    status: open
    notes: ""
  - id: 10
    source: "Upjohn warning documentation"
    status: open
    notes: ""
```

After presenting the checklist, write it to
`./.legal/employment-legal/investigation-[slug]/sources-checklist.yaml`.

---


## 后续模式与模板

The remaining modes (add data, query, memo draft/update, audience summary, the
consequential-action gate) and their templates live in
`references/investigation-modes.md`; read them before running Mode 2 or later.

## Sati tool wiring

- In this project, retrieve statutory text with `law_search` (level filters plus current/superseded labels) before citing, and run `law_verify` over the finished draft to check each citation.
- If `law_search` / `law_verify` is unavailable or misses, mark the gap as "not found / not form-verified" instead of filling statute text from model memory.
