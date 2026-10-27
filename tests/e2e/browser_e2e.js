// Browser regression pass for jira-lite against the mock Jira (never the real one).
//
// Run it: `make test-browser` (tests/e2e/run_browser.mjs starts the mock + app on 9900/8900 and runs this
// headless with Playwright). Or start `python3 tests/e2e/mock_jira.py --port 9900 --app-port 8900` and run
// this file with the Playwright MCP's run-code tool — it is one `async (page) => {...}` function. It resets
// the mock, clears the app's saved preferences, runs every check (a failure doesn't stop the rest) and
// returns a report: one "✔"/"✖" line per check plus unexpected console errors.
async (page) => {
  const APP = "http://localhost:8900", MOCK = "http://127.0.0.1:9900";
  const out = [], consoleErrors = [];
  const expected = [/issue\/DEMO-5 .*400|DEMO-5:0/, /status of 400 \(Bad Request\)/,  // the refused Task → Epic change
    /status of 401 \(Unauthorized\)/,  // the simulated end of a session
    /status of 503/, /status of 404 \(Not Found\)/];  // the ⌘K search failure / missing key checks
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const expect = (ok, msg) => { if (!ok) throw new Error(msg); };
  // Under run_browser.mjs: E2E_ONLY=<regex> runs only matching checks (plus "setup" ones);
  // E2E_SHOTS=<dir> saves a screenshot of every failed check there.
  const env = typeof process !== "undefined" ? process.env : {};
  const only = env.E2E_ONLY ? new RegExp(env.E2E_ONLY) : null;
  const check = async (name, fn) => {
    if (only && !only.test(name) && !/setup/.test(name)) return;
    try {
      const note = await fn();
      out.push("✔ " + name + (note ? " — " + note : ""));
    } catch (e) {
      out.push("✖ " + name + " — " + String((e && e.message) || e).split("\n")[0]);
      if (env.E2E_SHOTS) await page.screenshot({ path: env.E2E_SHOTS + "/fail-" + out.length + ".png" }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
  };
  const sleep = (ms) => page.waitForTimeout(ms);
  const until = (fn, arg, timeout = 6000) => page.waitForFunction(fn, arg, { timeout });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join(" | "));
  const requests = async () => (await (await page.request.get(MOCK + "/__mock/requests")).json()).requests;
  const writes = async () => (await requests()).filter((r) => r.method !== "GET" && !r.path.endsWith("search/jql"));
  const lastWrite = async (method, part) => (await writes()).filter((r) => r.method === method && r.path.includes(part)).pop();
  const open = async (key) => {
    await page.evaluate((k) => { location.hash = "#" + k; }, key);
    await page.waitForSelector('#detail .dscroll[data-key="' + key + '"] .pblock', { timeout: 8000 });
  };
  const closePanel = async () => { if (await page.locator("#detail:not([hidden])").count()) await page.click('#detail .dh button[aria-label="Close"]'); };
  const display = async (fn) => {
    await page.click("#displayBtn");
    await page.waitForSelector(".menu.pop");
    await fn(page.locator(".menu.pop"));
    await page.keyboard.press("Escape");
    await sleep(150);
  };
  const grouping = (v) => display((m) => m.locator("select").first().selectOption(v));
  const view = async (v) => { if (await page.locator("#v" + v + '[aria-pressed="false"]').count()) await page.click("#v" + v); await sleep(150); };
  // Sidebar entries; people's buttons also hold their initials ("AN Alice Nguyen"), so no exact match.
  const nav = async (name) => { await page.locator("#side").getByRole("button", { name }).first().click(); await sleep(400); };

  // ---- safety: only ever against the mock ----
  const cfg = await (await page.request.get(APP + "/config")).json();
  if (!String(cfg.site || "").startsWith(MOCK)) return "REFUSED: " + APP + " is not running against the mock (site=" + cfg.site + ")";
  expect((await page.request.post(MOCK + "/__mock/reset")).status() === 204, "mock reset failed");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(APP + "/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP + "/?e2e=" + Date.now());
  await page.waitForSelector("#list .row", { timeout: 10000 });

  // ---- list ----
  await check("list: My issues, status groups, type icons, parent hints", async () => {
    const r = await page.evaluate(() => ({
      title: document.querySelector("#title .tlabel").textContent, count: document.querySelector("#count").textContent,
      groups: [...document.querySelectorAll("#list .gh > span:not(.gcount)")].map((s) => s.textContent).filter(Boolean),
      type: document.querySelector('#list .row[data-key="DEMO-4"] .tbadge').title,
      hint: document.querySelector('#list .row[data-key="DEMO-4"] .phint').textContent,
      noProject: !/\bDEMO\b(?!-)/.test(document.querySelector("#side").textContent + document.title),
    }));
    expect(r.title === "My issues" && r.count === "11", "title/count " + r.title + " " + r.count);
    expect(r.groups.join() === "Backlog,To Do,In Progress,Blocked,In Review", "groups " + r.groups);  // workflow order, like the board
    expect(r.type === "Story" && r.hint.includes("DEMO-1"), "type/hint " + r.type + " " + r.hint);
    expect(r.noProject, "project key shown outside ticket keys");
  });
  await check("list: priority / status / assignee menus write", async () => {
    const row = '#list .row[data-key="DEMO-9"]';
    await page.click(row + " .ibtn");
    await page.locator(".menu .mi", { hasText: "Highest" }).click();
    await until((s) => document.querySelector(s + " .picon")?.dataset.prio === "highest", row);
    await page.click(row + " > .ibtn:nth-of-type(2)");
    await page.waitForSelector(".menu .mi");  // transitions are fetched first
    const moves = await page.locator(".menu .mi .grow").allTextContents();
    expect(moves.join() === "Backlog,In Progress,Canceled", "transitions " + moves);
    await page.locator(".menu .mi", { hasText: "In Progress" }).click();
    await until((s) => document.querySelector(s)?.closest("section")?.dataset.kind === "started", row);
    await page.click(row + " .rright .ibtn");
    await page.locator(".menu .mi", { hasText: "Bob" }).click();
    await until((s) => !document.querySelector(s), row);  // left "My issues"
    const w = await writes();
    expect(w.some((x) => x.path.endsWith("/DEMO-9/assignee")), "no assign request");
  });
  await check("list: filter, group collapse survives reload", async () => {
    await page.fill("#q", "signup");
    expect((await page.textContent("#count")) === "2 / 10", "filter count " + (await page.textContent("#count")));
    await page.fill("#q", "");
    await page.locator("#list .gh").first().click();
    await page.reload(); await page.waitForSelector("#list .gh");
    expect(await page.locator("#list .gh").first().evaluate((h) => h.classList.contains("closed")), "not collapsed after reload");
    await page.locator("#list .gh").first().click();
  });
  await check("keyboard: j/k, Enter opens, s opens status menu, Esc closes", async () => {
    await page.locator("body").click({ position: { x: 600, y: 880 } }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.keyboard.press("j"); await page.keyboard.press("j");
    const cur = await page.evaluate(() => document.querySelector("#list .row.cur")?.dataset.key);
    expect(cur, "no cursor");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#detail .dscroll[data-key="' + cur + '"]');
    await page.keyboard.press("s");
    await page.waitForSelector(".menu .mi");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    expect(await page.locator("#detail[hidden]").count(), "panel still open");
  });
  await check("command menu finds an issue by key", async () => {
    await page.keyboard.press("Meta+k");
    await page.fill(".palette .pinput", "DEMO-12");
    await until(() => document.querySelector(".palette .plist .mi")?.textContent.includes("DEMO-12"));
    await page.keyboard.press("Escape");
  });
  await check("sidebar: person and epic views", async () => {
    await nav("Alice Nguyen");
    expect((await page.textContent("#title .tlabel")) === "Alice Nguyen", "person title");
    expect(await page.locator("#title .av").count(), "no avatar in the title");
    await page.click("#title");
    await page.locator(".menu .msearch").fill("bob");
    await page.keyboard.press("Enter"); await sleep(400);
    expect((await page.textContent("#title .tlabel")) === "Bob Okafor", "title menu didn't switch person");
    await page.locator("#side").getByText("Billing v2").click(); await sleep(400);
    expect(await page.locator('#list .row[data-key="DEMO-11"]').count(), "epic view lacks DEMO-11");
    expect(!(await page.locator("#list .phint").count()), "parent hints shown inside the epic's own view");
    await nav("All issues");
    // An epic's "n/m" badge counts its child issues (like the sidebar), not only sub-tasks.
    await until(() => document.querySelector('#list .row[data-key="DEMO-1"] .badge'));
    const side = (await page.locator("#side").getByRole("button", { name: /Customer onboarding/ }).textContent()).match(/\d+\/\d+/)[0];
    expect((await page.textContent('#list .row[data-key="DEMO-1"] .badge')) === side, "epic badge differs from the sidebar " + side);
  });

  // ---- display ----
  await check("display: component grouping (list); switching to List hides a grouped board", async () => {
    await grouping("component");
    const g = await page.$$eval("#list .gh > span:not(.gcount)", (s) => s.map((x) => x.textContent).filter(Boolean));
    expect(g.join("|") === "API|API, Web|Mobile|Web|No component", "groups " + g.join("|"));
    await view("Board");
    expect(await page.locator("#board .swimlane").count() === 5, "board rows");
    await view("List");
    expect((await page.locator("#board").evaluate((b) => getComputedStyle(b).display)) === "none", "board visible in List view");
    await grouping("status");
  });
  await check("display: status ticks hide columns and issues; Show all; all hidden → empty state", async () => {
    await view("Board");
    await display(async (m) => { await m.locator(".dstat", { hasText: "Backlog" }).click(); await m.locator(".dstat", { hasText: "To Do" }).click(); });
    const cols = await page.$$eval("#board > .col .cname", (c) => c.map((x) => x.textContent));
    expect(!cols.includes("Backlog") && !cols.includes("To Do") && cols.length, "cols " + cols);
    await display(async (m) => { while (await m.locator('.dstat[aria-checked="true"]').count()) await m.locator('.dstat[aria-checked="true"]').first().click(); });
    expect((await page.textContent("#board .empty-state")).includes("hidden statuses"), "no hidden-statuses empty state");
    await page.getByRole("button", { name: "Show all statuses" }).click(); await sleep(200);
    expect((await page.locator("#board > .col").count()) >= 5, "columns not back");
  });
  await check("display: ticking Done fetches completed issues; unticking stops fetching", async () => {
    const lastJql = async () => (await requests()).filter((r) => r.path.endsWith("search/jql") && r.body && r.body.jql && !/updated >=/.test(r.body.jql)).pop().body.jql;
    // "Show all" in the previous check also ticked Done and Canceled (fetching completed issues): untick both.
    await display(async (m) => {
      for (const name of ["Done", "Canceled"]) { const d = m.locator('.dstat[aria-checked="true"]', { hasText: name }); if (await d.count()) await d.click(); }
    });
    await sleep(600);
    expect(/statusCategory != Done/.test(await lastJql()), "completed still fetched with Done unticked");
    expect(!(await page.locator('.menu.pop [role=switch]', { hasText: "Show completed" }).count()), "old switch still there");
    await display((m) => m.locator(".dstat", { hasText: "Done" }).click());
    await until(() => document.querySelector('#board .col[data-kind="done"], #list section[data-kind="done"]'));
    expect(!/statusCategory != Done/.test(await lastJql()), "Done ticked but not fetched");
    await display((m) => m.locator(".dstat", { hasText: "Done" }).click());
    await sleep(600);
    expect(/statusCategory != Done/.test(await lastJql()), "still fetching completed after unticking");
  });
  await check("display: show empty columns (board), no stray chips", async () => {
    await nav("Carol Schmidt");
    const off = await page.$$eval("#board > .col .cname", (c) => c.map((x) => x.textContent));
    await display((m) => m.locator('[role=switch]', { hasText: "Show empty columns" }).click());
    const on = await page.$$eval("#board > .col .cname", (c) => c.map((x) => x.textContent));
    const tops = await page.$$eval("#board > .col .colh", (h) => [...new Set(h.map((x) => Math.round(x.getBoundingClientRect().top)))]);
    expect(tops.length === 1, "empty columns' headers not level with the others: " + tops);
    await display((m) => m.locator('[role=switch]', { hasText: "Show empty columns" }).click());
    expect(on.length > off.length, "off " + off + " on " + on);
    expect(!(await page.locator(".lane-chip").count()), "stray chips on the board");
    await nav("My issues");
  });

  // ---- board ----
  await check("board: drag transitions; impossible move is refused", async () => {
    await view("Board");
    await page.locator('.tcard[data-key="DEMO-19"]').dragTo(page.locator('#board > .col[data-kind="started"] .cards'));
    await until(() => document.querySelector('.tcard[data-key="DEMO-19"]')?.closest(".col")?.dataset.kind === "started");
    await page.locator('.tcard[data-key="DEMO-23"]').dragTo(page.locator('#board > .col[data-kind="review"] .cards'));
    await until(() => /can't move/.test([...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join()));
    await view("List");
  });

  // ---- detail panel ----
  await check("detail: breadcrumb with type icons; sub-task chain", async () => {
    await open("DEMO-32");
    await until(() => document.querySelectorAll("#detail .dh .clink").length === 2);
    const c = await page.$$eval("#detail .dh .crumbs > *", (e) => e.map((x) => x.textContent));
    expect(c.join(" ") === "DEMO-1 › DEMO-4 › DEMO-32", "crumbs " + c.join(" "));
    await page.locator("#detail .dh .clink").first().click();
    await page.waitForSelector('#detail .dscroll[data-key="DEMO-1"]');
  });
  await check("detail: title, labels, due date", async () => {
    await open("DEMO-5");
    await page.click("#detail h1.dtitle");
    await page.fill("#detail textarea.dtitle", "Write welcome email copy v2"); await page.keyboard.press("Enter");
    await page.click("#detail .ladd"); await page.fill("#detail .linput", "alpha beta"); await page.keyboard.press("Enter");
    await until(() => document.querySelector('#detail .lx[aria-label="Remove label beta"]'));
    await page.click('#detail .lx[aria-label="Remove label alpha"]');
    await until(() => !document.querySelector('#detail .lx[aria-label="Remove label alpha"]'));
    await page.click("#detail .pdue"); await page.fill("#detail .dinput", "2026-12-24"); await page.keyboard.press("Enter");
    await until(() => document.querySelector("#detail .pdue")?.textContent.includes("Dec 24"));
    expect((await lastWrite("PUT", "/DEMO-5")).body.fields.duedate === "2026-12-24", "due PUT");
  });
  await check("detail: type change; a Task under an epic isn't offered Epic", async () => {
    await page.click("#tchip"); await page.locator(".menu .mi", { hasText: "Bug" }).click();
    await until(() => document.querySelector("#tchip")?.textContent === "Bug");
    await page.click("#tchip"); await page.locator(".menu .mi", { hasText: "Task" }).click();
    await until(() => document.querySelector("#tchip")?.textContent === "Task");
    await page.click("#tchip");
    const types = await page.locator(".menu .mi .grow").allTextContents();
    await page.keyboard.press("Escape");
    expect(!types.includes("Epic") && types.includes("Story"), "type menu " + types);
  });
  await check("detail: parent epic change and remove", async () => {
    await page.click("#detail .pparent .pset");
    await page.locator(".parentpick .mi", { hasText: "DEMO-2" }).click();
    await until(() => document.querySelector("#detail .pparent .pkey")?.textContent === "DEMO-2");
    await page.click("#detail .pparent .lx");
    await until(() => !document.querySelector("#detail .pparent .pkey"));
  });
  await check("detail: fix versions / components (one PUT on close), client, reporter", async () => {
    await page.click('#detail .pblock button[title="Change fix versions"]');
    const opts = await page.locator(".multipick .mi").allTextContents();
    expect(!opts.some((t) => t.includes("2025.12")), "archived version offered");
    await page.locator(".multipick .mi", { hasText: "2026.11" }).click();
    await page.keyboard.press("Escape"); await sleep(400);
    expect(JSON.stringify((await lastWrite("PUT", "/DEMO-5")).body.update.fixVersions) === '[{"add":{"id":"10201"}}]', "fixVersions PUT (add verb)");
    const n = (await writes()).length;
    await page.click('#detail .pblock button[title="Change components"]'); await page.keyboard.press("Escape"); await sleep(300);
    expect((await writes()).length === n, "closing an unchanged picker wrote");
    await page.click('#detail .pblock button[title="Change client"]');
    expect(!(await page.locator(".menu .mi", { hasText: "None" }).count()), "required Client offers None");
    await page.locator(".menu .mi", { hasText: "Globex" }).click(); await sleep(400);
    await page.click('#detail .pblock button[title="Change reporter"]');
    await page.fill(".menu .msearch", "car"); await page.keyboard.press("Enter"); await sleep(400);
    expect((await lastWrite("PUT", "/DEMO-5")).body.fields.reporter, "reporter PUT");
  });
  await check("description: double-click → Markdown; checklist + table + pasted image saved", async () => {
    await open("DEMO-1");
    const holder = page.locator("#detail .sec", { hasText: "Description" }).locator("xpath=following-sibling::div[1]");
    await holder.locator("p").first().dblclick();
    const ta = page.locator("#detail textarea.mdedit");
    const md = await ta.inputValue();
    expect(md.includes("| Milestone | Owner | Target |") && md.includes("| --- |"), "table not Markdown");
    await ta.evaluate((t) => { t.value = t.value.replace("| Welcome emails |", "| Welcome email series |") + "\n\n- [ ] legal review"; t.selectionStart = t.selectionEnd = t.value.length; });
    await ta.evaluate(async (t) => {
      const c = document.createElement("canvas"); c.width = 30; c.height = 20; c.getContext("2d").fillRect(0, 0, 30, 20);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "image.png", { type: "image/png" }));
      t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await until(() => /⟦\d+ · attachment: screenshot-/.test(document.querySelector("#detail textarea.mdedit").value));
    await ta.press("Meta+Enter");
    await page.waitForSelector("#detail .adf img[alt^='screenshot-']");
    const types = (await lastWrite("PUT", "/DEMO-1")).body.fields.description.content.map((b) => b.type);
    expect(types.includes("table") && types.includes("taskList") && types.includes("mediaSingle"), "saved " + types);
    expect((await page.textContent("#detail .adf table")).includes("Welcome email series"), "cell edit lost");
  });
  await check("image viewer: opens in page, arrows, zoom, Esc", async () => {
    await open("DEMO-4");
    const tabs = page.context().pages().length;
    await page.locator("#detail .adf a.adf-img").first().click();
    await page.waitForSelector(".viewer .vimg");
    expect((await page.textContent(".vw-name")) === "signup-step2.png", "viewer name");
    await page.locator(".viewer .vimg").click();
    expect(await page.locator(".vstage.zoomed").count(), "no zoom");
    await page.keyboard.press("Escape");
    expect(!(await page.locator(".viewer").count()) && page.context().pages().length === tabs, "viewer/tab state");
  });
  await check("comments: add, edit, delete", async () => {
    await page.fill("#cbox", "E2E comment"); await page.press("#cbox", "Meta+Enter");
    await until(() => document.querySelector("#detail").textContent.includes("E2E comment"));
    await page.locator('#detail button[aria-label="Edit comment"]').last().click();
    await page.evaluate(() => { const t = [...document.querySelectorAll("#detail textarea")].find((x) => x.value === "E2E comment"); t.value = "E2E comment edited"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    await until(() => document.querySelector("#detail").textContent.includes("E2E comment edited"));
    await page.locator('#detail button[aria-label="Delete comment"]').last().click();
    const confirm = page.locator("#detail button", { hasText: /^Delete$/ });
    if (await confirm.count()) await confirm.first().click();
    await until(() => !document.querySelector("#detail").textContent.includes("E2E comment edited"));
  });
  await check("sub-issues: status change, create one, upload attachment", async () => {
    await page.locator("#detail .subrow", { hasText: "DEMO-33" }).locator(".ibtn").click();
    await page.locator(".menu .mi", { hasText: "In Progress" }).click();
    await until(() => document.querySelector("#detail .subrow:nth-child(3) .ibtn")?.title.startsWith("In Progress"));
    await page.locator("#detail .link", { hasText: "Add sub-issue" }).click();
    await page.fill(".modal input[aria-label=Title]", "E2E sub-issue"); await sleep(500);
    await page.press(".modal input[aria-label=Title]", "Meta+Enter");
    await until(() => [...document.querySelectorAll("#detail .subrow")].some((r) => r.textContent.includes("E2E sub-issue")));
    // The "+ Attach" button opens this input's file picker; set the file on it directly (no OS dialog).
    await page.locator('#detail input[type=file][aria-label="Files to attach"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await until(() => document.querySelector("#detail").textContent.includes("notes.txt"));
  });
  await check("create issue with required fields and a Markdown description", async () => {
    await closePanel();
    await page.click("#newBtn");
    await page.waitForSelector('.modal select[aria-label^="Client"]');
    await page.fill(".modal input[aria-label=Title]", "E2E created issue");
    await page.fill(".modal textarea[aria-label=Description]", "## Plan\n- [ ] step one");
    await page.selectOption('.modal select[aria-label^="Client"]', { label: "Globex" });
    await page.selectOption('.modal select[aria-label^="Fix versions"]', { label: "2026.11" });
    // Assignee: a searchable menu of everyone (not the OS dropdown); Esc closes only the menu.
    await page.locator(".modal label.csel", { has: page.locator('select[aria-label="Assignee"]') }).click();
    const people = await page.locator(".menu .mi").allTextContents();
    expect(people.length >= 5 && people.some((t) => t.includes("Bob Okafor")), "assignee menu " + people);
    await page.keyboard.press("Escape");
    expect(await page.locator(".modal").count(), "Esc in the menu closed the dialog");
    await page.locator(".modal label.csel", { has: page.locator('select[aria-label="Assignee"]') }).click();
    await page.fill(".menu .msearch", "bob"); await page.keyboard.press("Enter");
    await page.press(".modal input[aria-label=Title]", "Meta+Enter");
    await until(() => /Created DEMO-\d+/.test([...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join()));
    const types = (await lastWrite("POST", "/rest/api/3/issue")).body.fields.description.content.map((b) => b.type);
    expect(types.join() === "heading,taskList", "description " + types);
    expect((await lastWrite("POST", "/rest/api/3/issue")).body.fields.assignee.accountId === "712020:5c3e1f0a-8d2b-4e6f-9a10-6d0e3b2c1a03", "assignee not Bob");
  });
  await check("delete: needs 'delete' typed; removes the issue and its sub-tasks", async () => {
    await open("DEMO-4");
    await page.click('#detail .dh button[aria-label="Delete issue…"]');
    await page.waitForSelector(".deldialog");
    expect(await page.locator(".deldialog .btn.danger").isDisabled(), "Delete enabled before typing");
    await page.fill(".deldialog .delinput", "delet"); await page.press(".deldialog .delinput", "Enter"); await sleep(200);
    expect(await page.locator(".deldialog").count(), "partial word deleted");
    await page.fill(".deldialog .delinput", "delete"); await page.press(".deldialog .delinput", "Enter");
    await until(() => /Deleted DEMO-4\b/.test([...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join()));
    expect((await lastWrite("DELETE", "/DEMO-4")).path.includes("deleteSubtasks=true"), "DELETE without deleteSubtasks");
  });
  await check("panel resize: drag, remembered, double-click resets", async () => {
    await open("DEMO-5");
    const h = await page.locator("#dsplit").boundingBox();
    const w0 = await page.locator("#detail").evaluate((d) => d.getBoundingClientRect().width);
    await page.mouse.move(h.x + 4, h.y + 200); await page.mouse.down(); await page.mouse.move(h.x - 150, h.y + 200, { steps: 6 }); await page.mouse.up();
    const w1 = await page.locator("#detail").evaluate((d) => d.getBoundingClientRect().width);
    expect(w1 > w0 + 100, "not wider " + w0 + " → " + w1);
    await page.reload(); await page.waitForSelector('#detail .dscroll[data-key="DEMO-5"]');
    expect(Math.abs((await page.locator("#detail").evaluate((d) => d.getBoundingClientRect().width)) - w1) < 2, "width not remembered");
    await page.locator("#dsplit").dblclick();
    expect(Math.abs((await page.locator("#detail").evaluate((d) => d.getBoundingClientRect().width)) - w0) < 2, "not reset");
  });

  await check("dialog mode: issue opens centred over the list; outside click / Esc close; header button docks it", async () => {
    await closePanel();
    await display((m) => m.locator('select[aria-label="Open issues in"]').selectOption("modal"));
    await open("DEMO-5");
    const b = await page.locator("#detail").boundingBox();
    expect(Math.abs(b.x + b.width / 2 - 720) < 4 && b.height > 600, "not centred " + JSON.stringify(b));
    expect((await page.locator("#dscrim").evaluate((x) => getComputedStyle(x).display)) === "block", "no backdrop");
    expect(!(await page.locator("#dsplit").isVisible()), "resize handle shown in dialog mode");
    await page.mouse.click(20, 450);
    expect(await page.locator("#detail[hidden]").count(), "outside click didn't close");
    await open("DEMO-5"); await page.keyboard.press("Escape");
    expect(await page.locator("#detail[hidden]").count(), "Esc didn't close");
    await open("DEMO-5");
    await page.click('#detail .dh button[title="Dock to the side"]');
    expect((await page.locator("#detail").evaluate((d) => getComputedStyle(d).position)) !== "fixed", "still a dialog");
    expect((await page.evaluate(() => localStorage.getItem("jl.detailMode"))) === "panel", "mode not remembered");
  });

  // ---- edge cases found by the multi-agent pass ----
  await check("edge: clicking a pick list's field again closes it and saves once", async () => {
    await open("DEMO-5");
    const btn = '#detail .pblock button[title="Change components"]';
    const n = (await writes()).length;
    await page.click(btn); await page.locator(".multipick .mi", { hasText: "Mobile" }).click();
    await page.click(btn); await sleep(500);
    expect(!(await page.locator(".multipick").count()), "list still open");
    const w = (await writes()).slice(n).filter((x) => x.method === "PUT");
    expect(w.length === 1 && JSON.stringify(w[0].body.update.components) === '[{"add":{"id":"10302"}}]', "PUTs " + JSON.stringify(w.map((x) => x.body)));
  });
  await check("edge: adding a label keeps one a colleague added meanwhile", async () => {
    await open("DEMO-5");
    // A colleague adds "theirs" straight in Jira; this panel still shows the old labels.
    const r = await page.request.put(MOCK + "/rest/api/3/issue/DEMO-5", { headers: { Authorization: "Basic colleague" }, data: { update: { labels: [{ add: "theirs" }] } } });
    expect(r.status() === 204, "colleague PUT " + r.status());
    await page.click("#detail .ladd"); await page.fill("#detail .linput", "ours"); await page.keyboard.press("Enter");
    await until(() => document.querySelector('#detail .lx[aria-label="Remove label ours"]'));
    const labels = (await (await page.request.get(MOCK + "/rest/api/3/issue/DEMO-5?fields=labels", { headers: { Authorization: "Basic x" } })).json()).fields.labels;
    expect(labels.includes("theirs") && labels.includes("ours"), "labels " + labels);
    expect(await page.locator('#detail .lx[aria-label="Remove label theirs"]').count(), "panel doesn't show the colleague's label");
  });
  await check("edge: pasted images — a '$' in the name stays literal; one over 25 MB is refused up front", async () => {
    await open("DEMO-5");
    await page.locator("#detail .sec .link", { hasText: /^(Edit|Add)$/ }).click();
    const ta = page.locator("#detail textarea.mdedit");
    await ta.fill("before\n\nafter");
    const paste = (name, bytes) => ta.evaluate(async (t, [name, bytes]) => {
      t.selectionStart = t.selectionEnd = "before\n".length;
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
      t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [name, bytes]);
    const n = (await writes()).length;
    await paste("huge.png", 26 * 1024 * 1024);
    await until(() => /Too large to attach here.*huge\.png/.test([...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join()));
    expect(!(await writes()).slice(n).some((w) => w.path.includes("/attachments")), "uploaded the oversized image");
    await paste("budget$'final.png", 64);
    await until(() => !document.querySelector("#detail textarea.mdedit").value.includes("uploading"));
    const v = await ta.inputValue();
    expect(v.includes("budget$'final.png") && v.split("after").length === 2 && v.startsWith("before"), "text garbled: " + JSON.stringify(v));
    await page.keyboard.press("Escape");
  });
  await check("edge: ⌘↵ twice in the description editor saves once", async () => {
    const n = (await writes()).length;
    await page.locator("#detail .sec .link", { hasText: /^(Edit|Add)$/ }).click();
    const ta = page.locator("#detail textarea.mdedit");
    await ta.fill((await ta.inputValue()) + "\n\nonce");
    await ta.press("Meta+Enter"); await ta.press("Meta+Enter").catch(() => {});
    await until(() => document.querySelector("#detail .adf")?.textContent.includes("once"));
    expect((await writes()).slice(n).filter((x) => x.method === "PUT").length === 1, "saved more than once");
  });
  await check("edge: a hash that isn't an issue key is ignored", async () => {
    const before = (await requests()).length;
    await page.evaluate(() => { location.hash = "#<img src=x>"; }); await sleep(500);
    const after = (await requests()).slice(before).filter((r) => /issue\/%3C|issue\/</.test(r.path));
    expect(!after.length, "fetched " + after.map((r) => r.path));
  });
  await check("edge: 'Show completed' from the command menu shows every completed status", async () => {
    await display((m) => m.locator(".dstat", { hasText: "Done" }).click());  // completed on, Canceled unticked
    await sleep(500);
    await page.keyboard.press("Meta+k"); await page.fill(".palette .pinput", "completed"); await page.keyboard.press("Enter"); await sleep(600);  // off
    await page.keyboard.press("Meta+k"); await page.fill(".palette .pinput", "completed"); await page.keyboard.press("Enter"); await sleep(600);  // on
    const canceled = await page.evaluate(() => [...JSON.parse(localStorage.getItem("jl.hiddenStatuses") || "[]")]);
    await page.click("#displayBtn"); await page.waitForSelector(".menu.pop .dstat");
    const ticks = await page.$$eval(".menu.pop .dstat", (b) => b.filter((x) => /Done|Canceled/.test(x.textContent)).map((x) => x.textContent + "=" + x.getAttribute("aria-checked")));
    await page.keyboard.press("Escape");
    expect(ticks.every((t) => t.endsWith("=true")), "ticks " + ticks + " hidden " + canceled);
    await display((m) => m.locator(".dstat", { hasText: "Done" }).click());
    await display((m) => m.locator(".dstat", { hasText: "Canceled" }).click());
  });
  await check("edge: deleting the epic the view shows resets the view; responses refuse framing", async () => {
    await page.locator("#side").getByText("Mobile app performance").click(); await sleep(400);
    await open("DEMO-3");
    await page.click('#detail .dh button[aria-label="Delete issue…"]');
    await page.fill(".deldialog .delinput", "delete"); await page.press(".deldialog .delinput", "Enter");
    await until(() => /Deleted DEMO-3/.test([...document.querySelectorAll(".toast, #toast, [role=status]")].map((e) => e.textContent).join()));
    await sleep(600);
    expect(!(await page.evaluate(() => localStorage.getItem("jl.epic"))), "still filtered on the deleted epic");
    const r = await page.request.get(APP + "/");
    expect(r.headers()["x-frame-options"] === "DENY", "no X-Frame-Options");
  });

  // ---- read-your-writes: every write shows at once, even while search still has old data ----
  // The mock's search trails writes by LAG ms (like Jira Cloud's index); each check must see its
  // write in well under that, and a manual full refresh (r) mustn't bring old data back.
  const LAG = 5000, FAST = 2000;
  const fast = (fn, arg) => until(fn, arg, FAST);
  const rowIn = (key) => document.querySelector('#list .row[data-key="' + key + '"]');
  const fullRefresh = async () => { await page.locator("body").click({ position: { x: 700, y: 880 } }).catch(() => {}); await page.keyboard.press("Escape"); await page.keyboard.press("r"); await sleep(800); };
  await check("fresh: setup — reset data, index lag " + LAG + " ms", async () => {
    expect((await page.request.post(MOCK + "/__mock/reset")).status() === 204, "reset");
    expect((await page.request.post(MOCK + "/__mock/config?indexLagMs=" + LAG)).status() === 204, "lag");
    await page.evaluate(() => localStorage.clear());
    await page.goto(APP + "/?fresh=" + Date.now());
    await page.waitForSelector("#list .row");
  });
  await check("fresh: board drag moves the card at once and it stays through a full refresh", async () => {
    await view("Board");
    await page.locator('.tcard[data-key="DEMO-23"]').dragTo(page.locator('#board > .col[data-kind="todo"] .cards'));
    await fast(() => document.querySelector('.tcard[data-key="DEMO-23"]')?.closest(".col")?.dataset.kind === "todo");
    await sleep(1200);  // the write has settled; search still says Backlog
    expect(await page.evaluate(() => document.querySelector('.tcard[data-key="DEMO-23"]')?.closest(".col")?.dataset.kind) === "todo", "card jumped back");
    await fullRefresh();
    expect(await page.evaluate(() => document.querySelector('.tcard[data-key="DEMO-23"]')?.closest(".col")?.dataset.kind) === "todo", "a full refresh brought the old status back");
    if (env.E2E_SHOTS) await page.screenshot({ path: env.E2E_SHOTS + "/fresh-board.png" });
    await view("List");
  });
  await check("fresh: new sub-issue shows in the open parent and the parent row's progress", async () => {
    await open("DEMO-19");
    await page.locator("#detail .link", { hasText: "Add sub-issue" }).click();
    await page.fill(".modal input[aria-label=Title]", "Fresh sub-issue"); await sleep(400);
    await page.press(".modal input[aria-label=Title]", "Meta+Enter");
    await fast(() => [...document.querySelectorAll("#detail .subrow")].some((r) => r.textContent.includes("Fresh sub-issue")));
    await fast(() => document.querySelector('#list .row[data-key="DEMO-19"] .badge')?.textContent === "0/2");
    if (env.E2E_SHOTS) await page.screenshot({ path: env.E2E_SHOTS + "/fresh-subissue.png" });
  });
  await check("fresh: a sub-issue's status change shows in the parent's list", async () => {
    await open("DEMO-19");
    await page.locator("#detail .subrow", { hasText: "DEMO-38" }).locator(".ibtn").click();
    await page.locator(".menu .mi", { hasText: "In Progress" }).click();
    await fast(() => [...document.querySelectorAll("#detail .subrow")].find((r) => r.textContent.includes("DEMO-38"))?.querySelector(".ibtn")?.title.startsWith("In Progress"));
  });
  await check("fresh: title edit updates the list row", async () => {
    await open("DEMO-19");
    await page.click("#detail h1.dtitle");
    await page.fill("#detail textarea.dtitle", "SSO configuration, fresh"); await page.keyboard.press("Enter");
    await fast(() => document.querySelector('#list .row[data-key="DEMO-19"]')?.textContent.includes("SSO configuration, fresh"));
    await closePanel();
  });
  await check("fresh: moving to Done or reassigning drops the row; it stays gone after a full refresh", async () => {
    const row = '#list .row[data-key="DEMO-6"]';  // In Review: Done is one step away
    await page.click(row + " > .ibtn:nth-of-type(2)");
    await page.locator(".menu .mi", { hasText: "Done" }).click();
    await fast((k) => !document.querySelector('#list .row[data-key="' + k + '"]'), "DEMO-6");
    await page.click('#list .row[data-key="DEMO-39"] .rright .ibtn');
    await page.locator(".menu .mi", { hasText: "Bob" }).click();
    await fast((k) => !document.querySelector('#list .row[data-key="' + k + '"]'), "DEMO-39");
    await fullRefresh();
    expect(!(await page.evaluate(rowIn, "DEMO-6")) && !(await page.evaluate(rowIn, "DEMO-39")), "rows came back after a full refresh");
  });
  await check("fresh: bulk priority updates every selected row", async () => {
    for (const k of ["DEMO-7", "DEMO-23"]) await page.click('#list .row[data-key="' + k + '"] .selbox', { force: true });
    await page.keyboard.press("p");
    await page.locator(".menu .mi", { hasText: "Lowest" }).click();
    await fast(() => ["DEMO-7", "DEMO-23"].every((k) => document.querySelector('#list .row[data-key="' + k + '"] .picon')?.dataset.prio === "lowest"));
    await page.keyboard.press("Escape");
  });
  await check("fresh: a created issue appears in the list; deleting it removes it for good", async () => {
    await nav("All issues");
    await page.click("#newBtn");
    await page.waitForSelector('.modal select[aria-label^="Client"]');
    await page.fill(".modal input[aria-label=Title]", "Fresh top-level issue");
    await page.selectOption('.modal select[aria-label^="Client"]', { label: "Globex" });
    await page.selectOption('.modal select[aria-label^="Fix versions"]', { label: "2026.11" });
    await page.press(".modal input[aria-label=Title]", "Meta+Enter");
    await fast(() => [...document.querySelectorAll("#list .row")].some((r) => r.textContent.includes("Fresh top-level issue")));
    const key = await page.evaluate(() => [...document.querySelectorAll("#list .row")].find((r) => r.textContent.includes("Fresh top-level issue")).dataset.key);
    await page.waitForSelector('#detail .dscroll[data-key="' + key + '"] .pblock');  // the new issue opened
    await page.click('#detail .dh button[aria-label="Delete issue…"]');
    await page.fill(".deldialog .delinput", "delete"); await page.press(".deldialog .delinput", "Enter");
    await fast((k) => !document.querySelector('#list .row[data-key="' + k + '"]'), key);
    await fullRefresh();
    expect(!(await page.evaluate(rowIn, key)), "deleted issue came back after a full refresh");
    await nav("My issues");
  });
  await check("fresh: once the index catches up, search data is used again", async () => {
    await sleep(LAG);
    await fullRefresh();
    expect(await page.evaluate(() => !document.querySelector('#list .row[data-key="DEMO-6"]') && !!document.querySelector('#list .row[data-key="DEMO-23"]')), "list wrong after catch-up");
    expect((await page.request.post(MOCK + "/__mock/config?indexLagMs=0")).status() === 204, "lag off");
  });
  await check("fresh: a colleague moving our just-edited issue out of the view isn't undone by a full refresh", async () => {
    await open("DEMO-23");
    await page.click("#detail h1.dtitle");
    await page.fill("#detail textarea.dtitle", "Edited, then unassigned elsewhere"); await page.keyboard.press("Enter");
    await fast(() => document.querySelector('#list .row[data-key="DEMO-23"]')?.textContent.includes("Edited, then unassigned"));
    const r = await page.request.put(MOCK + "/rest/api/3/issue/DEMO-23/assignee", { headers: { Authorization: "Basic colleague" }, data: { accountId: null } });
    expect(r.status() === 204, "colleague unassign " + r.status());
    await closePanel();
    await fullRefresh();
    await fast((k) => !document.querySelector('#list .row[data-key="' + k + '"]'), "DEMO-23");
  });

  await check("edge: session ends mid-edit — title, description and comment edits come back after signing in", async () => {
    await open("DEMO-4");
    await page.locator('#detail button[aria-label="Edit comment"]').first().click();
    await page.locator("#detail .cedit textarea").fill("Comment edit in progress");
    await page.locator("#detail .sec .link", { hasText: /^(Edit|Add)$/ }).click();
    const md = page.locator("#detail textarea.mdedit");
    await md.fill((await md.inputValue()) + "\n\nDescription edit in progress");
    // The next title save finds the session over: the server's "sign in again" 401.
    await page.route("**/jira/issue/DEMO-4", (r) => (r.request().method() === "PUT"
      ? r.fulfill({ status: 401, headers: { "X-Jira-Lite-Auth": "login", "Content-Type": "application/json" }, body: "{}" }) : r.continue()));
    await page.click("#detail h1.dtitle");
    await page.fill("#detail textarea.dtitle", "Title edit in progress"); await page.keyboard.press("Enter");
    await page.waitForSelector("#signin");
    await page.unroute("**/jira/issue/DEMO-4");
    await page.reload();  // back from Atlassian's sign-in
    await page.waitForSelector('#detail .dscroll[data-key="DEMO-4"] textarea.mdedit');
    const r = await page.evaluate(() => ({
      title: document.querySelector("#detail textarea.dtitle")?.value,
      desc: document.querySelector("#detail textarea.mdedit")?.value,
      comment: document.querySelector("#detail .cedit textarea")?.value,
      kept: !!sessionStorage.getItem("jl.editDrafts"),
    }));
    expect(r.title === "Title edit in progress", "title " + r.title);
    expect((r.desc || "").endsWith("Description edit in progress") && /⟦\d+ · /.test(r.desc), "description " + JSON.stringify(r.desc));
    expect(r.comment === "Comment edit in progress", "comment " + r.comment);
    expect(!r.kept, "drafts left in sessionStorage");
    expect(!(await writes()).some((w) => w.method === "PUT" && w.path.endsWith("/DEMO-4")), "a restored editor saved on its own");
    if (env.E2E_SHOTS) await page.screenshot({ path: env.E2E_SHOTS + "/drafts-restored.png" });
    await page.keyboard.press("Escape");
    await page.goto(APP + "/");
  });

  await check("edge: cut-off lists say so — '5+' issues, '1+' sub-issues, epic progress 'n+'", async () => {
    // Pages of 1: the list's 5-page load stops at 5 of 11, DEMO-4's first sub-issue page at 1 of 3,
    // and the epics' children search at 5 (each epic gets 6 more children first).
    expect((await page.request.post(MOCK + "/__mock/reset")).status() === 204, "reset");
    for (const epic of ["DEMO-1", "DEMO-2", "DEMO-3"]) {
      for (let n = 0; n < 6; n++) {
        const r = await page.request.post(MOCK + "/rest/api/3/issue", { headers: { Authorization: "Basic x" }, data: { fields: {
          project: { key: "DEMO" }, issuetype: { name: "Task" }, summary: "Child " + n + " of " + epic, parent: { key: epic },
          customfield_10050: { id: "10100" }, fixVersions: [{ id: "10201" }] } } });
        expect(r.status() === 201, "create child " + r.status() + " " + (await r.text()));
      }
    }
    expect((await page.request.post(MOCK + "/__mock/config?maxPage=1&indexLagMs=0")).status() === 204, "config");
    try {
      await page.goto(APP + "/?cut=" + Date.now() + "#DEMO-4");  // a real load (a hash-only change wouldn't reload)
      await page.waitForSelector('#detail .dscroll[data-key="DEMO-4"] .pblock');
      await until(() => document.querySelector("#count")?.textContent === "5+");
      expect(/most recently updated/.test(await page.getAttribute("#count", "title")), "no tooltip on the count");
      const subs = await page.locator("#detail .sec", { hasText: "Sub-issues" }).textContent();
      expect(/1\/1\+ done/.test(subs), "sub-issues header " + subs);
      await until(() => /\d+\/\d+\+/.test(document.querySelector("#side")?.textContent || ""));
      if (env.E2E_SHOTS) await page.screenshot({ path: env.E2E_SHOTS + "/cutoff-counts.png" });
    } finally {
      await page.request.post(MOCK + "/__mock/config?maxPage=100");
    }
    await page.goto(APP + "/?uncut=" + Date.now());
    await page.waitForSelector("#list .row");
    expect((await page.textContent("#count")) === "11", "count without a cut-off " + (await page.textContent("#count")));
  });
  await check("edge: ⌘K search shows a Jira failure instead of 'No results'; a missing key is just no match", async () => {
    await page.route("**/jira/search/jql", (r) => (/text ~/.test(r.request().postData() || "")
      ? r.fulfill({ status: 503, contentType: "application/json", body: '{"errorMessages":["Search is down"]}' }) : r.continue()));
    try {
      await page.keyboard.press("Meta+k");
      await page.fill(".palette .pinput", "zebra");
      await until(() => /Jira search failed: Search is down/.test(document.querySelector(".palette")?.textContent || ""));
      await page.fill(".palette .pinput", "DEMO-999");
      await until(() => /No results/.test(document.querySelector(".palette")?.textContent || ""));
      expect(!/failed/.test(await page.textContent(".palette")), "a missing key reported as a failure");
      await page.keyboard.press("Escape");
    } finally {
      await page.unroute("**/jira/search/jql");
    }
  });

  // ---- themes and sizes ----
  await check("dark mode and phone width render without sideways scroll", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    expect((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== "rgb(255, 255, 255)", "not dark");
    await page.emulateMedia({ colorScheme: "light" });
    await closePanel();
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    expect((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "sideways scroll on phone");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  const unexpected = consoleErrors.filter((t) => !expected.some((re) => re.test(t)));
  out.push((unexpected.length ? "✖" : "✔") + " console: " + (unexpected.length ? unexpected.slice(0, 5).join(" || ") : "no unexpected errors"));
  await page.evaluate(() => localStorage.clear());
  const failed = out.filter((l) => l.startsWith("✖")).length;
  return (failed ? failed + " FAILED" : "ALL PASSED") + " (" + out.length + " checks)\n" + out.join("\n");
}
