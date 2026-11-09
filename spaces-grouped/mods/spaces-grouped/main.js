// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.drag = null;
    this.drop = null;
    this.editor = null;
    this.confirmDelete = null;
    this.groupInput = InputState.new({ placeholder: "群組名稱" });
    this.groupInput.on("submit", (_e, cx) => this.saveGroup(cx));
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  machineGrouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  groupState() {
    const state = shared("spaces-grouped.v1") ?? {};
    const groups = Array.isArray(state.groups) ? state.groups.filter(g => g && typeof g.id === "string" && typeof g.name === "string" && g.id !== "uncategorized") : [];
    return { groups, members: { ...(state.members ?? {}) }, folded: { ...(state.folded ?? {}) }, order: Array.isArray(state.order) ? [...state.order] : [] };
  }

  groupOf(id, state = this.groupState()) {
    const group = state.members[id];
    return state.groups.some(g => g.id === group) ? group : "uncategorized";
  }

  editGroup(id, cx) {
    this.editor = id;
    this.confirmDelete = null;
    this.groupError = "";
    this.groupInput.set_value(this.groupState().groups.find(g => g.id === id)?.name ?? "");
    this.groupInput.focus();
    cx.notify();
  }

  saveGroup(cx) {
    if (this.editor === null) return;
    const name = this.groupInput.value().trim();
    const state = this.groupState();
    if (!name || name === "\u672a\u5206\u985e" || state.groups.some(g => g.id !== this.editor && g.name === name)) {
      this.groupError = "\u8acb\u8f38\u5165\u4e0d\u91cd\u8907\u7684\u7fa4\u7d44\u540d\u7a31";
      cx.notify();
      return;
    }
    if (this.editor === "new") state.groups.push({ id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`, name });
    else state.groups = state.groups.map(g => g.id === this.editor ? { ...g, name } : g);
    setShared("spaces-grouped.v1", state);
    this.editor = null;
    cx.notify();
  }

  deleteGroup(id, cx) {
    const state = this.groupState();
    state.groups = state.groups.filter(g => g.id !== id);
    state.members = Object.fromEntries(Object.entries(state.members).filter(([, group]) => group !== id));
    delete state.folded[id];
    setShared("spaces-grouped.v1", state);
    this.confirmDelete = null;
    cx.notify();
  }

  beginDrag(kind, id, event) {
    this.drag = { kind, id, start: event.position, moved: false };
    this.drop = null;
  }

  hoverDrop(kind, id, event, cx) {
    if (!this.drag) return;
    // 拖曳群組時，群組內的 Space 也屬於該群組的放置區。
    const overSpace = this.drag.kind === "group" && kind === "space";
    if (overSpace) {
      kind = "group";
      id = this.groupOf(id);
    }
    const start = this.drag.start;
    if (!this.drag.moved && Math.hypot(event.position.x - start.x, event.position.y - start.y) < 5) return;
    this.drag.moved = true;
    const after = overSpace || (event.local_position?.y ?? 0) >= (event.bounds?.height ?? 29) / 2;
    if (this.drop?.kind !== kind || this.drop?.id !== id || this.drop?.after !== after) {
      this.drop = { kind, id, after };
      cx.notify();
    }
  }

  hoverEnd(event, cx) {
    if (!this.drag) return;
    const state = this.groupState();
    const group = this.groupOrder(state).slice(-1)[0];
    const rows = this.ordered().filter(r => this.groupOf(r.w.id, state) === group);
    const last = rows.slice(-1)[0];
    const kind = this.drag.kind === "space" && last ? "space" : "group";
    const id = kind === "space" ? last.w.id : group;
    // 下方空白區一律代表最後一組末尾，不依空白區的上下半部判斷。
    this.hoverDrop(kind, id, { ...event, local_position: { y: 1 }, bounds: { height: 1 } }, cx);
  }

  groupDropChangesPosition(id) {
    const sourceId = this.drag?.id;
    if (!sourceId || sourceId === id) return false;
    const order = this.groupOrder(this.groupState());
    const from = order.indexOf(sourceId);
    const remaining = order.filter(group => group !== sourceId);
    const to = remaining.indexOf(id);
    if (from < 0 || to < 0) return false;
    return to + (this.drop?.after ? 1 : 0) !== from;
  }

  spaceDropChangesPosition(id) {
    const sourceId = this.drag?.id;
    if (!sourceId || sourceId === id) return false;
    const state = this.groupState();
    const group = this.groupOf(id, state);
    if (this.groupOf(sourceId, state) !== group) return true;
    const rows = this.ordered().filter(r => this.groupOf(r.w.id, state) === group);
    const source = rows.find(r => r.w.id === sourceId)?.w;
    const destination = rows.find(r => r.w.id === id)?.w;
    if (!source || !destination || (source.machine ?? null) !== (destination.machine ?? null)) return false;
    // 移除來源後，插入位置若仍是原索引，就不顯示插入線。
    const from = rows.findIndex(r => r.w.id === sourceId);
    const remaining = rows.filter(r => r.w.id !== sourceId);
    const slot = remaining.findIndex(r => r.w.id === id) + (this.drop.after ? 1 : 0);
    return slot !== from;
  }

  finishDrag(kind, id, cx) {
    const drag = this.drag;
    const target = this.drop;
    if (drag?.kind === "group" && kind === "space") {
      kind = "group";
      id = this.groupOf(id);
    }
    this.drag = null;
    this.drop = null;
    if (!drag) return;
    if (!drag.moved) {
      if (drag.kind === kind && drag.id === id) {
        if (kind === "space") run("space.select", { id });
        else {
          const state = this.groupState();
          state.folded[id] = !state.folded[id];
          setShared("spaces-grouped.v1", state);
        }
      }
      cx.notify();
      return;
    }
    if (!target || target.kind !== kind || target.id !== id) { cx.notify(); return; }
    const state = this.groupState();
    if (drag.kind === "group" && kind === "group" && drag.id !== id) {
      // \u672a\u5206\u985e\u4e5f\u4fdd\u5b58\u6392\u5e8f\u4f4d\u7f6e\uff0c\u4f46\u4e0d\u53ef\u522a\u9664\u6216\u6539\u540d\u3002
      const order = this.groupOrder(state);
      const from = order.indexOf(drag.id), to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        order.splice(from, 1);
        const slot = order.indexOf(id) + (target.after ? 1 : 0);
        order.splice(slot, 0, drag.id);
        state.order = order;
      }
    } else if (drag.kind === "space") {
      const group = kind === "group" ? id : this.groupOf(id, state);
      if (group === "uncategorized") delete state.members[drag.id];
      else state.members[drag.id] = group;
      if (kind === "space" && drag.id !== id) {
        const all = spaces();
        const source = all.find(s => s.id === drag.id), destination = all.find(s => s.id === id);
        if (source && destination && (source.machine ?? null) === (destination.machine ?? null)) {
          // 先移除來源，再計算目標前後的插入位置，與提示線一致。
          const remaining = all.filter(s => s.id !== drag.id);
          const index = remaining.findIndex(s => s.id === id) + (target.after ? 1 : 0);
          run("space.move", { id: drag.id, index: index + 1 });
        }
      }
    }
    setShared("spaces-grouped.v1", state);
    cx.notify();
  }

  groupOrder(state) {
    const ids = ["uncategorized", ...state.groups.map(g => g.id)];
    const saved = shared("spaces-grouped.v1")?.order ?? [];
    return [...new Set([...saved.filter(id => ids.includes(id)), ...ids])];
  }

  groupButton(id, label, action, t) {
    return div().id(id).px(5).h(23).rounded(4).cursor_pointer().text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  groupIcon(id, label, path, action, t) {
    return div().id(id).size(23).flex_none().flex().items_center().justify_center()
      .rounded(4).cursor_pointer().text_color(t.dim).tooltip(label)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(path).size(13));
  }

  grouped(t, collapsed) {
    const rows = this.ordered();
    if (collapsed) return rows.map(r => this.compact(r, t));
    const state = this.groupState();
    const order = this.groupOrder(state);
    const groupDrop = this.drag?.kind === "group" && this.drag.moved && this.drop?.kind === "group"
      && this.groupDropChangesPosition(this.drop.id);
    const boundary = groupDrop ? order.indexOf(this.drop.id) + (this.drop.after ? 1 : 0) : -1;
    return order.flatMap((id, index) => {
      const group = state.groups.find(g => g.id === id);
      const name = group?.name ?? "\u672a\u5206\u985e";
      const mine = rows.filter(r => this.groupOf(r.w.id, state) === id);
      const folded = !!state.folded[id];
      const activeDrop = this.drag?.moved && this.drop?.kind === "group" && this.drop.id === id;
      const sorting = this.drag?.kind === "group";
      const insertBefore = boundary === index;
      const insertAtEnd = boundary === order.length && index === order.length - 1;
      const header = h_flex().id(`group-${id}`).h(29).flex_none().px(7).gap(5).items_center().rounded(5)
        .text_size(11.5).text_color(activeDrop && !sorting ? t.accent : t.muted).cursor_pointer()
        .bg(activeDrop && !sorting ? t.selected : t.chrome).hover(s => s.bg(t.hover))
        .when(this.drag?.kind === "group" && this.drag.id === id && this.drag.moved, el => el.opacity(0.5))
        .on_mouse_down("left", (e) => this.beginDrag("group", id, e))
        .on_mouse_move((e, cx) => this.hoverDrop("group", id, e, cx))
        .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.finishDrag("group", id, cx); })
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
        .child(div().id(`group-label-${id}`).flex_1().truncate()
          .tooltip("\u9ede\u64ca\u6536\u5408\uff1b\u62d6\u66f3\u6392\u5e8f\uff1b\u5c07 Space \u62d6\u5230\u6b64\u8655\u53ef\u79fb\u5165\u7fa4\u7d44").child(name))
        .child(div().text_size(10).text_color(t.dim).child(String(mine.length)))
        .when(!!group, el => el
          .child(this.groupIcon(`rename-${id}`, "\u91cd\u65b0\u547d\u540d\u7fa4\u7d44", "mods/workspace-chrome/square-pen.svg", cx => this.editGroup(id, cx), t))
          .child(this.groupIcon(`delete-${id}`, "\u522a\u9664\u7fa4\u7d44", "mods/spaces-grouped/trash.svg", cx => { this.confirmDelete = id; this.editor = null; cx.notify(); }, t)));
      const output = [header];
      if (this.confirmDelete === id) output.push(v_flex().px(7).py(5).gap(4).flex_none().text_size(11).text_color(t.foreground)
        .child("\u522a\u9664\u6b64\u7fa4\u7d44\uff1fSpace \u5c07\u79fb\u56de\u672a\u5206\u985e\u3002")
        .child(h_flex().gap(5)
          .child(this.groupButton(`confirm-${id}`, "\u78ba\u8a8d\u522a\u9664", cx => this.deleteGroup(id, cx), t))
          .child(this.groupButton(`cancel-${id}`, "\u53d6\u6d88", cx => { this.confirmDelete = null; cx.notify(); }, t))));
      if (!folded) {
        if (mine.length) {
          const spaceDrop = this.drag?.kind === "space" && this.drag.moved && this.drop?.kind === "space"
            && this.spaceDropChangesPosition(this.drop.id);
          const target = spaceDrop ? mine.findIndex(r => r.w.id === this.drop.id) : -1;
          const slot = target >= 0 ? target + (this.drop.after ? 1 : 0) : -1;
          // 相同落點共用下一列頂線；只有群組末尾使用最後一列底線。
          output.push(...mine.map((r, rowIndex) => this.row({ ...r, tree: null,
            insertBefore: slot === rowIndex,
            insertAtEnd: slot === mine.length && rowIndex === mine.length - 1 }, t)));
        }
        else output.push(div().id(`empty-${id}`).h(28).flex_none().px(22).text_size(11).text_color(t.dim)
          .on_mouse_move((e, cx) => this.hoverDrop("group", id, e, cx))
          .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.finishDrag("group", id, cx); })
          .child("\u62d6\u66f3 Space \u81f3\u6b64"));
      }
      // 同一落點統一畫在下一組頂端，避免前組底線與後組頂線相差線寬。
      const section = v_flex().id(`group-section-${id}`).relative().flex_none().children(output);
      if (insertBefore || insertAtEnd) section.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(insertAtEnd, line => line.bottom(0))
        .when(insertBefore, line => line.top(0)));
      return [section];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, insertBefore = false, insertAtEnd = false }, t) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.drag?.kind === "space" && this.drag.id === w.id && this.drag.moved, el => el.opacity(0.5))
      .when(insertBefore || insertAtEnd, el => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(insertAtEnd, line => line.bottom(0))
          .when(insertBefore, line => line.top(0))))
      .on_mouse_down("left", e => this.beginDrag("space", w.id, e))
      .on_mouse_move((e, cx) => this.hoverDrop("space", w.id, e, cx))
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.finishDrag("space", w.id, cx);
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child(div().flex_1().child("工作區"))
          .child(this.groupIcon("group-new", "新增群組", "mods/workspace-chrome/folder-plus.svg", cx => this.editGroup("new", cx), t)))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("新增 Space").on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .when(!collapsed && this.editor !== null, el => el.child(v_flex().px(12).pb(7).gap(4).flex_none()
        .child(Input.new(this.groupInput).h(30).px(7).rounded(5).border_1().border_color(t.accent).bg(t.background).text_color(t.foreground))
        .when(!!this.groupError, box => box.child(div().text_size(11).text_color(t.blocked).child(this.groupError)))
        .child(h_flex().gap(5)
          .child(this.groupButton("group-save", "儲存", cx => this.saveGroup(cx), t))
          .child(this.groupButton("group-cancel", "取消", cx => { this.editor = null; cx.notify(); }, t)))))
      .on_mouse_down_out((_e, cx) => { if (this.drag) { this.drag = null; this.drop = null; cx.notify(); } })
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .children(this.grouped(t, collapsed))
        .when(!collapsed, el => el.child(div().id("spaces-drop-end").min_h(28).flex_1()
          .on_mouse_move((e, cx) => this.hoverEnd(e, cx))
          .on_mouse_up("left", (e, cx) => {
            cx.stop_propagation();
            this.hoverEnd(e, cx);
            const target = this.drop;
            this.finishDrag(target?.kind, target?.id, cx);
          }))))
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) {
          this.drag = null;
          this.drop = null;
          cx.notify();
        }
      });
  }
}
