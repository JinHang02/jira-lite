# E2E checklist (manual or Playwright)

Run against the mock, never the real Jira: `python3 tests/e2e/mock_jira.py --port 9900 --app-port 8900`, open
http://localhost:8900. You are **Sam Rivera**; project **DEMO** (40 issues). `POST http://127.0.0.1:9900/__mock/reset`
restores the seed; `GET /__mock/requests` shows what the app sent. Every step: **zero console errors**.

Seed landmarks: DEMO-4 (story, rich description, 3 sub-tasks, your comment), DEMO-6 (code block, your rich
comment), DEMO-14 (attachments), DEMO-39 (>100 changelog entries), DEMO-24 (unassigned), DEMO-1/2/3 (epics),
DEMO-7 and DEMO-26 (Blocked, overdue).

## List
- [ ] First load shows skeleton rows, then "My issues 11" grouped In Progress › In Review › Blocked › To Do › Backlog.
- [ ] Row: priority icon, key, status icon, title, sub-issue badge (DEMO-4 "1/3"), up to 2 label pills + "+N", due chip (red overdue, amber ≤2 days, "Today"/"Tomorrow"), avatar, updated date.
- [ ] Click a group header → collapses (count stays); reload → still collapsed. Enter/Space on a focused header toggles it.
- [ ] Row buttons: priority / status / assignee open menus anchored to the button; picking one writes and the row updates.
- [ ] `j`/`k`/↑/↓ move the cursor; `Enter`/`o` opens the issue; `Esc` closes the panel.

## Display menu (grouping / ordering / options)
- [ ] Display › Grouping: Assignee (Unassigned last), Priority (Highest…Lowest, No priority last), No grouping (flat list).
- [ ] Ordering: Last updated, Priority (Highest first, ties by updated), Created (newest first) — applies within groups.
- [ ] Show completed → Done/Canceled groups appear and the list scrolls to them; off → they disappear.
- [ ] Show sub-issue progress off → no "1/3" badges. All four settings survive a reload.
- [ ] On the board, Grouping is disabled with "The board's columns are statuses".

## Filter
- [ ] `/` focuses Filter; typing "signup" narrows to matching key/title/assignee; count shows "N / 11"; Enter moves the cursor to the first hit.
- [ ] No match → "No issues match …" with Clear filter. `Esc` clears; second `Esc` blurs.

## Sidebar
- [ ] My issues / All issues switch the list and the title; People lists Alice, Bob, Carol, Sam (not "Automation for Jira").
- [ ] Clicking a person shows their issues; title = their name; empty person view says "No open issues assigned to …".
- [ ] People header collapses the section (selected person stays visible); state survives reload.
- [ ] `[` or the header toggle collapses/expands the sidebar (remembered). `?` button opens the shortcuts dialog.

## Board + drag
- [ ] ⌘B (or Board) shows columns Backlog › To Do › In Progress › Blocked › In Review (+Done/Canceled when shown); "+N empty" chip expands empty columns, "Hide empty" folds them.
- [ ] Drag DEMO-9 (To Do) to In Progress → toast "DEMO-9 → In Progress", card moves; mock got `POST …/DEMO-9/transitions {"transition":{"id":"31"}}`.
- [ ] Drag a To Do card to Done → error toast "can't move from To Do to Done directly in this workflow"; nothing sent.
- [ ] "Show completed" lane chip reloads with Done columns.

## Detail panel
- [ ] Click DEMO-4: URL hash `#DEMO-4`, breadcrumb, copy key / copy link (toast), Open in Jira → mock browse page.
- [ ] Parent link "DEMO-1 · Customer onboarding revamp" opens the epic.
- [ ] Description renders headings, ordered + bullet lists, italic, @mention, emoji, attachment chip; DEMO-1 table and link; DEMO-6 code block with language label and copy button. Rich ones show "Edit in Jira ↗".
- [ ] Plain description (DEMO-5): Edit → textarea → ⌘↵ saves (toast, re-render); Esc cancels.
- [ ] Title click → edit; Enter saves (`PUT {"fields":{"summary":…}}`), Esc cancels, blur saves.
- [ ] Status / priority / assignee chips and `s` / `p` / `a` open the same menus; status menu lists only workflow transitions (DEMO-5 To Do: Backlog, In Progress, Canceled).
- [ ] Sub-issues list with progress "1/3 done"; status button on a child changes it; clicking a child opens it.
- [ ] Reload the page with `#DEMO-4` → panel reopens.

## Activity
- [ ] Timeline oldest→newest: "created the issue", history lines (status, assignee, priority, labels, due date), comment cards interleaved.
- [ ] Runs of >3 history lines fold into "Show N more"; expanding survives auto-refresh.
- [ ] DEMO-39: "4 older changes in Jira ↗" right after "created the issue".
- [ ] After any edit, a new line appears ("changed status from To Do → In Progress · just now").

## Properties
- [ ] Labels: × removes one; + opens input, "a, b" + Enter adds both; a label with a space is split, not sent with a space.
- [ ] Due date: click → date picker; pick → saved, overdue dates red; × removes (`{"duedate":null}`).
- [ ] Shows Reporter, Fix versions, Components, Client (required custom field), Created, Updated.

## Comments
- [ ] `m` focuses the composer; ⌘↵ posts; new card at the bottom, panel scrolls down; mock got ADF from the text.
- [ ] Own plain comment: pencil → edit → ⌘↵ saves, card shows "· edited"; Esc cancels; empty text refuses with a message.
- [ ] Own rich comment (DEMO-6): pencil is an "edit in Jira" link. Others' comments have no tools.
- [ ] Trash → inline "Delete this comment?" → Cancel restores, Delete removes (`DELETE …/comment/{id}` → 204).
- [ ] Unsent comment text survives an auto-refresh.

## Create
- [ ] `c` / New issue: type, priority (Medium default), assignee (you) chips; "Required by Jira" shows Client and Fix versions (archived 2025.12 not offered).
- [ ] Create without Client → chips turn red, "Pick Client, Fix versions."; nothing sent.
- [ ] A Jira-side 400 is surfaced: a 300-character title → toast "Create failed: summary: Summary must be less than 255 characters."
- [ ] Valid → toast "Created DEMO-41", dialog closes, list syncs, DEMO-41 opens.
- [ ] "Create more" on → dialog stays, title clears, type/priority/assignee/required values kept; setting remembered.
- [ ] Close with text typed → reopen → draft restored. ⌘↵ creates; Enter in title moves to description.
- [ ] Sub-issue: DEMO-9 › "+ Add sub-issue" → only Sub-task type; Client/Fix versions preselected from the parent; created child appears under Sub-issues.
- [ ] From an epic (DEMO-2): "+ Add sub-issue" offers Task/Bug/Story (not Sub-task); child gets `parent: DEMO-2`.

## Command menu (⌘K)
- [ ] ⌘K opens; empty shows main commands; typing "group" shows grouping commands; ↑/↓ + Enter runs one.
- [ ] Typing "signup" lists local matches, then Jira full-text hits; "39" or "DEMO-39" looks up the key; unknown key shows nothing, no error.
- [ ] Person commands ("Alice Nguyen's issues") switch the view. ⌘K again or Esc closes.

## Shortcuts dialog
- [ ] `?` opens "Keyboard shortcuts" (⌘ on Mac, Ctrl elsewhere); `?` or Esc closes and focus returns.

## Auto-refresh
- [ ] Change an issue behind the app's back (curl a PUT to the mock) → within 60 s the row updates without a full reload (mock log shows `updated >= -Nm`).
- [ ] Refresh button / `r` does a full reload; tooltip says "Updated … · auto every 60 s".

## Phone width (390×844)
- [ ] Sidebar becomes a drawer: toggle slides it in, scrim or Esc closes it, picking a view closes it.
- [ ] Header labels collapse to icons; list rows fit without horizontal scroll; detail panel covers the list and closes with ×.
- [ ] Board scrolls horizontally per column; dialogs fit the screen.

## Light / dark
- [ ] Toggle the OS (or emulate `prefers-color-scheme`): all surfaces, menus, dialogs, code blocks, status/priority icons and due chips stay legible in both.

## OAuth mode: sign-in and expired session
Needs OAuth settings (`ATLASSIAN_CLIENT_ID`, …); the mock does not implement the Atlassian sign-in.
- [ ] Not signed in → full-screen "Sign in to jira-lite" card with project · site; button goes to `/oauth/login`.
- [ ] Session expires mid-use (any `/jira/*` answers 401 + `X-Jira-Lite-Auth: login`) → sign-in card replaces the app, auto-refresh stops; an unsent comment, create-dialog draft and the open issue come back after signing in.
- [ ] Sidebar footer shows the signed-in user and "Sign out" → sign-in card.
