// Jade: a jade root's groups and apps, live beside Herdr's spaces and agents.
//
// Each group is a card: its apps with branch, changes and drift from
// `jade status --json`, and the agents working in it right now. A card opens
// the group as a Herdr space (a root tab plus one tab per app), or goes to it
// when it's already open. Shows as a pane or tab (`tab.new {mod: "jade"}`)
// or a popup (`mod.open {name: "jade"}`).
//
// Props (all optional): root (a jade root; default: the one the focused
// terminal is in), bin (the jade program; default "jade" on PATH).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, run, props, theme, spaces, panes, agents, focused, home, shared, setShared, notify, closeOverlay, pickFolder } from "herdr";
import {
  agentsIn,
  appState,
  inside,
  isTicket,
  mostUrgent,
  orderGroups,
  placeOf,
  problems,
  spaceForGroup,
  summary,
  tilde,
  validGroupName,
} from "./model.js";

const ICON = (name) => `mods/jade/icons/${name}.svg`;
// Data, not drawing: git state changes outside Herdr too (a commit in an editor).
const REFRESH_MS = 20000;
const PAD = 12;
const GAP = 10;
const MIN_CARD = 380;
const POPUP_LIST_MAX = 620;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The last line a jade command printed that says something (clack draws boxes).
function lastWords(text) {
  const lines = (text ?? "").replace(ANSI, "").split("\n").map((l) => l.replace(/^[\s│┌└◇◆●■▲✔✖•-]+/u, "").trim());
  return lines.filter(Boolean).pop() ?? "";
}

export default class Jade extends View {
  init(_props, cx) {
    this.root = undefined; // undefined: looking; null: not in a jade root
    this.version = "";
    this.org = null;
    this.reports = []; // jade status --json per group, in display order
    this.loading = false;
    this.busy = {}; // action key -> what it's doing
    this.width = 400;
    this.input = InputState.new({ value: "", placeholder: "new group: a branch name" });
    this.input.on("change", (_e, cx) => {
      this.inputError = "";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.addGroup(cx));
    this.inputError = "";
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx, { quiet: true }));
  }

  bin() {
    return props()?.bin || shared("jade.bin") || "jade";
  }

  async jade(args, cwd, timeout = 120000) {
    const r = await exec(this.bin(), args, { cwd: cwd ?? this.root ?? home(), timeout });
    return { ok: r.code === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  // Where to look for a root: the props, the focused terminal, the shown space, the last one used.
  candidates() {
    const ps = panes();
    const shown = spaces().find((s) => s.active);
    return [props()?.root, focused()?.cwd, shown && placeOf(shown, ps), shared("jade.root")].filter(Boolean);
  }

  async findRoot() {
    for (const dir of [...new Set(this.candidates())]) {
      try {
        const r = await this.jade(["status", "--root", "--json"], dir, 15000);
        if (!r.ok) continue;
        const view = JSON.parse(r.out);
        if (view.view === "root") return view;
      } catch {}
    }
    return null;
  }

  refresh(cx, { quiet = false } = {}) {
    if (this.loading) return;
    this.loading = !quiet;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const view = await this.findRoot();
        if (!view) {
          this.root = null;
          this.reports = [];
          return;
        }
        if (view.root !== this.root) {
          this.root = view.root;
          if (shared("jade.root") !== view.root) setShared("jade.root", view.root);
        }
        this.version = view.version ?? "";
        this.org = view.orgUrl ?? null;
        const reports = await Promise.all(
          orderGroups(view.groups ?? []).map(async (name) => {
            const r = await this.jade(["status", name, "--json"], this.root, 30000).catch(() => null);
            try {
              return r?.ok ? JSON.parse(r.out) : { workspace: name, apps: [], attention: [], failed: lastWords(r?.err || r?.out) };
            } catch {
              return { workspace: name, apps: [], attention: [], failed: "unreadable status" };
            }
          })
        );
        this.reports = reports.map((r) => ({ ...r, path: r.path ?? `${this.root}/${r.workspace === "main" ? "main" : `workspace/${r.workspace}`}` }));
      } catch (error) {
        if (!quiet) notify({ title: "Jade", body: String(error?.message ?? error), level: "error" });
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Runs a jade command for a button: busy while it runs, a toast when it fails, then a fresh read.
  act(cx, key, label, args, done) {
    if (this.busy[key]) return;
    this.busy[key] = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.jade(args);
        if (r.ok) {
          const said = lastWords(r.out);
          if (said) notify({ title: label.replace(/…$/, ""), body: said, level: "success", timeout: 4000 });
          done?.();
        } else {
          notify({ title: `jade ${args[0]} failed`, body: lastWords(r.err || r.out) || "see the terminal", level: "error" });
        }
      } catch (error) {
        notify({ title: `jade ${args[0]} failed`, body: String(error?.message ?? error), level: "error" });
      } finally {
        delete this.busy[key];
        cx.notify();
        this.refresh(cx, { quiet: true });
      }
    });
  }

  closeIfPopup() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // The space named after a group, once Herdr lists it (a moment after space.new, at most).
  async madeSpace(name, cx) {
    for (let i = 0; i < 40; i++) {
      const made = spaces().find((s) => s.named && s.name === name && !s.machine);
      if (made) return made;
      await cx.sleep(25);
    }
    return null;
  }

  // A group as a Herdr space: a root tab (agents there see every app), then a tab per app.
  // Resolves with the space.
  async openGroup(report, cx) {
    const there = spaceForGroup({ name: report.workspace, path: report.path }, spaces(), panes());
    this.closeIfPopup();
    if (there) {
      run("space.select", { id: there.id });
      return there;
    }
    run("space.new", { name: report.workspace, folder: report.path, tab: report.workspace });
    const made = await this.madeSpace(report.workspace, cx);
    if (!made) return null;
    for (const app of report.apps ?? []) {
      if (app.present) run("tab.new", { space: made.id, name: app.name, folder: app.path });
    }
    run("tab.select", { index: 1 });
    return made;
  }

  // An app: its tab in the group's space (opening the group first), else a new tab there.
  async openApp(report, app, cx) {
    if (!app.present) return;
    const space = await this.openGroup(report, cx);
    if (!space) return;
    const fresh = spaces().find((s) => s.id === space.id) ?? space;
    const ps = panes();
    const tab = (fresh.tabs ?? []).find((t) => ps.some((p) => p.tab === t.id && inside(p.cwd, app.path)));
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { space: fresh.id, name: app.name, folder: app.path });
  }

  addGroup(cx) {
    const name = this.input.value().trim();
    if (!name) return;
    if (!validGroupName(name)) {
      this.inputError = "Letters, digits, . _ - only, and not main.";
      return cx.notify();
    }
    if (this.reports.some((r) => r.workspace === name)) {
      this.inputError = `${name} already exists.`;
      return cx.notify();
    }
    this.act(cx, "new", `Creating ${name}…`, ["workspace", "add", name, "--all"], () => {
      this.input.set_value("");
    });
  }

  // ---- drawing ----

  button(id, icon, label, action, { primary = false, busy = null, tip = null } = {}) {
    const t = theme();
    return h_flex()
      .id(id)
      .flex_none()
      .h(26)
      .px(label ? 9 : 0)
      .when(!label, (el) => el.w(26).justify_center())
      .gap(6)
      .items_center()
      .rounded(7)
      .text_size(12)
      .cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!busy) action(cx);
      })
      .child(busy ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON(icon)).size(13))
      .when(Boolean(label), (el) => el.child(busy ?? label));
  }

  // One agent status, drawn the way Herdr's agents list draws it.
  statusMark(status, t, size = 12) {
    if (status === "working") return svg(ICON("spinner")).size(size).flex_none().text_color(t.working).spin(900);
    if (status === "blocked")
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(t.blocked + "26")
        .text_size(10.5)
        .font_semibold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .loop("opacity", { from: 0.55, to: 1, period: 1400 })
        .child("Needs you");
    if (status === "done") return div().size(7).mx(2).flex_none().rounded_full().bg(t.done);
    if (status === "idle") return div().size(7).mx(2).flex_none().rounded_full().border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  pill(text, fg, bg) {
    return div().flex_none().px(6).h(17).rounded(5).bg(bg).text_size(10.5).font_medium().text_color(fg).flex().items_center().child(text);
  }

  appRow(report, app, i, ctx) {
    const { t, ps, ags } = ctx;
    const state = appState(app);
    const here = app.present ? agentsIn(app.path, ags, ps) : [];
    const status = mostUrgent(here.map((a) => a.status));
    const glyph = {
      clean: svg(ICON("check")).size(12).text_color(t.dim),
      dirty: div().size(7).mx(2.5).rounded_full().bg(t.ansi3),
      drift: svg(ICON("alert")).size(12).text_color(t.blocked),
      detached: svg(ICON("alert")).size(12).text_color(t.blocked),
      error: svg(ICON("alert")).size(12).text_color(t.blocked),
      missing: div().size(7).mx(2.5).rounded_full().border(1.5).border_color(t.dim),
    }[state.kind];
    const narrow = this.width < 330;
    return h_flex()
      .id(`app-${report.workspace}-${i}`)
      .h(30)
      .px(12)
      .gap(9)
      .items_center()
      .text_size(12.5)
      .when(app.present, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.spawn(async (cx) => this.openApp(report, app, cx))))
      .when(Boolean(state.label), (el) => el.tooltip(state.label))
      .child(h_flex().w(16).flex_none().justify_center().child(glyph))
      .child(
        div()
          .flex_none()
          .w(narrow ? 70 : 96)
          .truncate()
          .font_medium()
          .text_color(app.present ? t.foreground : t.dim)
          .child(app.name)
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .text_color(state.kind === "drift" || state.kind === "detached" ? t.blocked : t.muted)
          .when(app.present && !narrow, (el) => el.child(svg(ICON("branch")).size(11).flex_none().text_color(t.dim)))
          .child(div().min_w(0).truncate().child(app.present ? (app.branch ?? "—") : "missing"))
      )
      .when(state.kind === "dirty", (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi3).child(state.label)))
      .when(app.present && app.published === false, (el) => el.child(this.pill("local", t.muted, t.raised)))
      .when(Boolean(status), (el) => el.child(this.statusMark(status, t, 11)));
  }

  card(report, ctx, width) {
    const { t, ps, ags, shownSpace } = ctx;
    const group = { name: report.workspace, path: report.path };
    const space = spaceForGroup(group, ctx.spaceList, ps);
    const here = agentsIn(report.path, ags, ps);
    const status = mostUrgent(here.map((a) => a.status));
    const fixes = problems(report);
    const shown = Boolean(space && shownSpace && space.id === shownSpace.id);
    const kind = isTicket(report.workspace) ? "review" : null;
    const stripe = status === "blocked" ? t.blocked : status === "working" ? t.working : fixes.length ? t.ansi3 : space ? t.accent : t.border;
    const fixKey = `fix-${report.workspace}`;
    return h_flex()
      .id(`card-${report.workspace}`)
      .flex_none()
      .w(width)
      .rounded(10)
      .overflow_hidden()
      .border(1)
      .border_color(shown ? t.accent : t.border)
      .bg(t.surface)
      .child(div().w(3).flex_none().h_full().bg(stripe))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            h_flex()
              .id(`head-${report.workspace}`)
              .h(40)
              .pl(12)
              .pr(8)
              .gap(8)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => cx.spawn(async (cx) => this.openGroup(report, cx)))
              .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(report.workspace))
              .when(Boolean(kind), (el) => el.child(this.pill(kind, kind === "review" ? t.accent : t.muted, kind === "review" ? t.accent + "22" : t.raised)))
              .child(div().flex_1())
              .when(Boolean(status), (el) => el.child(this.statusMark(status, t)))
              .when(here.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${here.length} agents`)))
              .child(
                this.button(`open-${report.workspace}`, space ? "chevron" : "open", space ? (shown ? "Shown" : "Go") : "Open", (cx) => cx.spawn(async (cx) => this.openGroup(report, cx)), {
                  tip: space ? `Go to the ${space.name} space` : "Open as a space: a root tab and one per app",
                })
              )
          )
          .when(Boolean(report.failed), (el) => el.child(div().px(12).pb(10).text_size(12).text_color(t.blocked).child(report.failed)))
          .when(!report.failed && (report.apps ?? []).length === 0, (el) =>
            el.child(div().px(12).pb(8).text_size(12).text_color(t.dim).child("No apps yet: jade add <repo>, or jade create <name> for a new one."))
          )
          .children((report.apps ?? []).map((app, i) => this.appRow(report, app, i, ctx)))
          .when(fixes.length > 0, (el) =>
            el.child(
              h_flex()
                .mt(4)
                .px(12)
                .py(8)
                .gap(8)
                .items_center()
                .border_t(1)
                .border_color(t.border)
                .bg(t.ansi3 + "12")
                .child(svg(ICON("alert")).size(12).flex_none().text_color(t.ansi3))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .text_color(t.muted)
                    .tooltip(fixes.map((f) => `${f.app}: ${f.message}  →  ${f.fix}`).join("\n"))
                    .child(fixes.length === 1 ? `${fixes[0].app}: ${fixes[0].message}` : `${fixes.length} things to fix`)
                )
                .child(
                  this.button(fixKey, "wrench", "Fix", (cx) => this.act(cx, fixKey, "Fixing…", ["doctor", report.workspace]), {
                    busy: this.busy[fixKey] ?? null,
                    tip: "jade doctor: fixes drift, detached HEADs and missing .env files",
                  })
                )
            )
          )
          .child(div().h(4))
      );
  }

  header(t) {
    const s = summary(this.reports);
    const stat = (n, word, color) =>
      h_flex()
        .gap(4)
        .items_baseline()
        .child(div().text_size(13).font_semibold().text_color(n && color ? color : t.foreground).child(String(n)))
        .child(div().text_size(11.5).text_color(t.dim).child(word));
    return v_flex()
      .gap(10)
      .px(16)
      .pt(14)
      .pb(12)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(
            div()
              .size(28)
              .flex_none()
              .rounded(8)
              .bg(t.ansi2 + "22")
              .flex()
              .items_center()
              .justify_center()
              .child(svg(ICON("jade")).size(16).text_color(t.ansi2))
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(h_flex().gap(6).items_baseline().child(div().text_size(15).font_semibold().text_color(t.foreground).child("jade")).when(Boolean(this.version), (el) => el.child(div().text_size(11).text_color(t.dim).child(`v${this.version}`))))
              .child(div().truncate().text_size(11.5).text_color(t.muted).child(this.root ? tilde(this.root, home()) + (this.org ? `  ·  ${this.org}` : "") : ""))
          )
          .child(
            this.button("update", "pull", this.width < 330 ? "" : "Update", (cx) => this.act(cx, "update", "Updating…", ["update"]), {
              busy: this.busy.update ?? null,
              tip: "jade update: pull every app's default branch in main/",
            })
          )
          .child(
            div()
              .id("refresh")
              .size(26)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(7)
              .cursor_pointer()
              .text_color(t.muted)
              .hover((st) => st.bg(t.hover).text_color(t.foreground))
              .tooltip("Read again")
              .on_click((_e, cx) => this.refresh(cx))
              .child(this.loading ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON("refresh")).size(13))
          )
      )
      .when(this.reports.length > 0, (el) =>
        el.child(
          h_flex()
            .gap(14)
            .child(stat(s.apps, s.apps === 1 ? "app" : "apps"))
            .child(stat(s.groups, s.groups === 1 ? "group" : "groups"))
            .child(stat(s.dirty, "with changes", t.ansi3))
            .child(stat(s.needs, s.needs === 1 ? "needs fixing" : "need fixing", t.blocked))
        )
      );
  }

  footer(t) {
    return v_flex()
      .gap(6)
      .px(12)
      .py(10)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            Input.new(this.input)
              .flex_1()
              .h(30)
              .px(10)
              .items_center()
              .rounded(7)
              .border(1)
              .border_color(this.inputError ? t.blocked : t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground)
          )
          .child(
            this.button("new", "plus", "New group", (cx) => this.addGroup(cx), {
              primary: true,
              busy: this.busy.new ?? null,
              tip: "jade workspace add <name> --all: a worktree of every app on branch <name>",
            })
          )
      )
      .when(Boolean(this.inputError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.inputError)));
  }

  empty(t) {
    const looking = this.root === undefined;
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(12)
      .p(24)
      .child(svg(ICON("jade")).size(34).text_color(looking ? t.dim : t.ansi2).when(looking, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(looking ? "Looking for a jade root…" : "Not in a jade root"))
      .when(!looking, (el) =>
        el
          .child(div().text_size(12.5).text_color(t.muted).child("Focus a terminal inside one, or pick its folder (the one with .bare/ and jade.json)."))
          .child(
            this.button("pick", "open", "Choose folder", (cx) =>
              cx.spawn(async (cx) => {
                const dir = await pickFolder({ prompt: "Use this root" });
                if (!dir) return;
                setShared("jade.root", dir);
                this.refresh(cx);
              }), { primary: true })
          )
      );
  }

  render(cx) {
    const t = theme();
    const ctx = { t, ps: panes(), ags: agents(), spaceList: spaces() };
    ctx.shownSpace = ctx.spaceList.find((s) => s.active) ?? null;
    const base = v_flex()
      .id("root")
      .size_full()
      .bg(t.canvas ?? t.background)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      });
    if (!this.root) return base.child(this.empty(t));
    // Columns of cards about 380px wide, as many as fit.
    const inner = Math.max(0, this.width - PAD * 2);
    const columns = Math.max(1, Math.min(this.reports.length || 1, Math.floor((inner + GAP) / (MIN_CARD + GAP))));
    const cardWidth = Math.floor((inner - GAP * (columns - 1)) / columns);
    const list = div()
      .id("jade-groups")
      .overflow_y_scroll()
      .p(PAD)
      .flex()
      .flex_row()
      .flex_wrap()
      .items_start()
      .content_start()
      .gap(GAP)
      .children(this.reports.map((r) => this.card(r, ctx, cardWidth)))
      .when(this.reports.length === 0 && !this.loading, (el) => el.child(div().p(12).text_color(t.dim).child("No groups yet.")));
    // A popup is as tall as its content (up to its height), so there the list sizes to
    // its cards; in a pane or tab it fills what the header and footer leave.
    const body = props()?.overlay
      ? div().relative().max_h(POPUP_LIST_MAX).child(list.max_h(POPUP_LIST_MAX)).child(Scrollbar.vertical("jade-groups").absolute().inset_0())
      : div().relative().flex_1().min_h(0).child(list.size_full()).child(Scrollbar.vertical("jade-groups").absolute().inset_0());
    return base.child(this.header(t)).child(body).child(this.footer(t));
  }
}
