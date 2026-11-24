"use strict";

const byId = id => document.getElementById(id);
const priorities = ["Срочно", "Важно", "Обычный"];
const storageKey = "pulse-day-v1";
const plannerKey = "pulse-day-calendar-v2";
const minute = text => text.split(":").reduce((hours, next) => hours * 60 + Number(next));
const clock = value => [Math.floor(value / 60), value % 60].map(part => String(part).padStart(2, "0")).join(":");
const dayDate = () => {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, "0")).join("-");
};
const durationLabel = value => value >= 60
  ? Math.floor(value / 60) + " ч" + (value % 60 ? " " + value % 60 + " мин" : "")
  : value + " мин";
const task = (name, duration, priority, project = "", after = "") => ({ id: newId(), name, duration, priority, project, after, done: false });
const fixed = (name, start, end) => ({ id: newId(), name, start, end });
function newId() {
  return crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2);
}

function demo(date) {
  const slides = task("Собрать презентацию для урока", 75, 0, "Курс Codex");
  return {
    date, start: 540, end: 1080, planned: true,
    fixed: [
      fixed("Командный созвон", 630, 660),
      fixed("Обед и прогулка", 780, 840),
      fixed("Встреча с редактором", 930, 960)
    ],
    tasks: [
      slides,
      task("Сверить примеры для вебинара", 60, 0, "Вебинар по промптингу"),
      task("Написать скрипт к уроку", 90, 1, "Курс Codex", slides.id),
      task("Разобрать правки к конспекту", 45, 1, "Китайские нейросети"),
      task("Подготовить файлы для показа", 60, 2, "Вебинар по промптингу"),
      task("Разобрать папку «Входящие»", 55, 2, "Личное")
    ]
  };
}

const emptyDay = date => ({ date, start: 540, end: 1080, fixed: [], tasks: [], planned: false });
function loadBook() {
  try {
    const saved = JSON.parse(localStorage.getItem(plannerKey));
    if (saved?.days?.[saved.selected]) return saved;
    const legacy = JSON.parse(localStorage.getItem(storageKey));
    if (legacy?.date) return { selected: legacy.date, days: { [legacy.date]: legacy } };
  } catch {
    // A blocked or damaged store starts with an empty day.
  }
  const date = dayDate();
  return { selected: date, days: { [date]: emptyDay(date) } };
}

function save() {
  try {
    book.days[state.date] = state;
    book.selected = state.date;
    localStorage.setItem(plannerKey, JSON.stringify(book));
    byId("storage").textContent = "План сохраняется в этом браузере.";
  } catch {
    byId("storage").textContent = "Сохранение браузером недоступно. Скачайте план перед закрытием.";
  }
}

function availability(day) {
  const ranges = [];
  let cursor = day.start;
  for (const fixedBlock of busyBlocks(day)) {
    const block = { start: Math.max(day.start, fixedBlock.start), end: Math.min(day.end, fixedBlock.end) };
    if (block.end <= block.start) continue;
    if (cursor < block.start) ranges.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < day.end) ranges.push({ start: cursor, end: day.end });
  return ranges;
}

const blockKey = entry => [entry.start, entry.end, entry.name.trim().toLocaleLowerCase("ru")].join("|");
const sourceLabel = entry => entry.source === "google" ? "Google Календарь" : entry.source ? "Импорт из файла" : "Фиксированный блок";
const timeLabel = entry => entry.start === 0 && entry.end === 1440 ? "Весь день" : clock(entry.start) + "–" + clock(entry.end);

function busyBlocks(day) {
  const unique = new Map();
  for (const block of [...day.fixed, ...(day.external ?? [])]) {
    const key = blockKey(block);
    if (!block.ignored && !unique.has(key)) unique.set(key, block);
  }
  return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

function makePlan(day = state) {
  const free = availability(day);
  const slots = busyBlocks(day).map(entry => ({ ...entry, type: "fixed" }));
  const outside = [];
  const capacity = free.reduce((sum, block) => sum + block.end - block.start, 0);
  const pending = [...day.tasks].sort((a, b) => a.priority - b.priority);
  const byTask = new Map(day.tasks.map(entry => [entry.id, entry]));
  const scheduled = new Map();
  while (pending.length) {
    const index = pending.findIndex(entry => !entry.after || !pending.some(other => other.id === entry.after));
    if (index < 0) {
      outside.push(...pending.map(entry => ({ ...entry, reason: "Проверьте порядок связанных задач." })));
      break;
    }
    const [entry] = pending.splice(index, 1);
    const before = byTask.get(entry.after);
    const previous = scheduled.get(entry.after);
    if (before && !before.done && !previous) {
      outside.push({ ...entry, reason: "Сначала нужно выполнить «" + before.name + "»." });
      continue;
    }
    const earliest = previous?.end ?? day.start;
    const gapIndex = free.findIndex(block => block.end - Math.max(block.start, earliest) >= entry.duration);
    if (gapIndex < 0) {
      outside.push({ ...entry, reason: "Нужен непрерывный блок на " + durationLabel(entry.duration) + "." });
      continue;
    }
    const gap = free[gapIndex];
    const start = Math.max(gap.start, earliest);
    const end = start + entry.duration;
    const remainder = [];
    if (gap.start < start) remainder.push({ start: gap.start, end: start });
    if (end < gap.end) remainder.push({ start: end, end: gap.end });
    free.splice(gapIndex, 1, ...remainder);
    const placed = { ...entry, start, end, type: "task" };
    slots.push(placed);
    scheduled.set(entry.id, placed);
  }
  const reserve = free.filter(block => block.end > block.start);
  for (const block of reserve) slots.push({ ...block, name: "Свободное время", type: "free" });
  return { capacity, slots: slots.sort((a, b) => a.start - b.start), outside, reserve };
}

function offsetDate(date, amount) {
  const parts = date.split("-").map(Number);
  const value = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + amount));
  return value.toISOString().slice(0, 10);
}

function switchDay(date) {
  save();
  state = book.days[date] ?? emptyDay(date);
  selectedProject = "";
  render();
}

function moveToTomorrow(entry) {
  const ids = new Set([entry.id]);
  let size;
  do {
    size = ids.size;
    for (const candidate of state.tasks.filter(item => !item.done)) {
      if (ids.has(candidate.after) || state.tasks.some(other => ids.has(other.id) && other.after === candidate.id)) {
        ids.add(candidate.id);
      }
    }
  } while (ids.size > size);
  const moved = state.tasks.filter(item => ids.has(item.id)).map(item => ({
    ...item, after: ids.has(item.after) ? item.after : ""
  }));
  if (moved.length > 1 && !confirm("Перенести на завтра связанные задачи (" + moved.length + ")?")) return;
  state.tasks = state.tasks.filter(item => !ids.has(item.id));
  const date = offsetDate(state.date, 1);
  const next = book.days[date] ?? emptyDay(date);
  next.tasks.push(...moved);
  book.days[date] = next;
  changePlan(moved.length === 1 ? "Задача перенесена на завтра." : "Связанные задачи перенесены на завтра.");
}

function node(tag, text, css) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (css) element.className = css;
  return element;
}

function icon(name) {
  const element = node("i", undefined, "icon");
  element.dataset.icon = name;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function proposalForDay() {
  if (stagedMeeting?.date !== state.date) return null;
  const { entry } = stagedMeeting;
  return { ...state, fixed: [...state.fixed.filter(block => block.id !== entry.id), entry] };
}

function renderProposal(proposal, current, proposed) {
  byId("plan-proposal").hidden = !proposal;
  if (!proposal) return;
  const list = byId("proposal-changes");
  list.replaceChildren();
  byId("proposal-title").textContent = /звонок|созвон/i.test(stagedMeeting.entry.name) ? "После созвона" : "После встречи";
  byId("proposal-caption").textContent = stagedMeeting.entry.name + " · " + timeLabel(stagedMeeting.entry);
  const before = new Map(current.slots.filter(slot => slot.type === "task").map(slot => [slot.id, slot]));
  const after = new Map(proposed.slots.filter(slot => slot.type === "task").map(slot => [slot.id, slot]));
  for (const task of state.tasks) {
    const oldTime = before.get(task.id)?.start;
    const newTime = after.get(task.id)?.start;
    if (oldTime === newTime) continue;
    const line = node("li");
    const revised = node("span", undefined, "proposal-times");
    revised.append(node("small", oldTime === undefined ? "Вне плана" : clock(oldTime)),
      node("span", "→"), node("strong", newTime === undefined ? "Вне плана" : clock(newTime)));
    line.append(icon("change"), node("span", task.name), revised);
    list.append(line);
  }
  if (!list.children.length) list.append(node("li", "Время задач остаётся прежним.", "proposal-empty"));
}

function renderTimeline(timeline, plan, animate) {
  timeline.classList.toggle("is-reflowing", animate && state.planned);
  timeline.replaceChildren();
  if (!state.planned) {
    timeline.append(node("p", "Добавьте задачи и соберите расписание.", "empty"));
    return;
  }
  const hours = node("div", undefined, "hour-grid");
  const daySlots = plan.slots.filter(entry => entry.start !== 0 || entry.end !== 1440);
  for (const entry of plan.slots.filter(entry => entry.start === 0 && entry.end === 1440)) {
    const row = node("div", undefined, "all-day");
    row.append(icon("calendar"), node("span", entry.name), node("small", "Весь день"));
    timeline.append(row);
  }
  const from = Math.max(0, Math.floor(Math.min(state.start - 60, ...daySlots.map(slot => slot.start)) / 60) * 60);
  const to = Math.ceil(Math.max(state.end, ...daySlots.map(slot => slot.end)) / 60) * 60;
  const percent = minutes => 100 * minutes / (to - from) + "%";
  hours.style.setProperty("--grid-height", Math.max(535, (to - from) * .91) + "px");
  hours.style.setProperty("--tick-step", percent(10));
  for (let time = from; time <= to; time += 60) {
    const tick = node("div", undefined, "hour");
    tick.style.top = percent(time - from);
    tick.append(node("time", clock(time)));
    hours.append(tick);
  }
  let group = [];
  let lanes = [];
  let groupEnd = -1;
  const paint = () => {
    for (const { entry, lane, index } of group) {
      const compact = entry.end - entry.start < 45;
      const slot = node("div", undefined, ["slot", entry.type, entry.done && "done", compact && "compact"].filter(Boolean).join(" "));
      slot.style.setProperty("--slot-order", Math.min(index, 10));
      slot.style.setProperty("--lane", lane);
      slot.style.setProperty("--lanes", lanes.length);
      slot.style.top = percent(entry.start - from);
      slot.style.height = percent(entry.end - entry.start);
      slot.title = timeLabel(entry) + " · " + entry.name;
      slot.setAttribute("aria-label", slot.title);
      const symbol = entry.type === "fixed" ? (/созвон|звонок/i.test(entry.name) ? "phone" : "calendar")
        : entry.type === "free" ? "clock" : /презентац/i.test(entry.name) ? "slides" : "file";
      const copy = node("div", undefined, "slot-detail");
      copy.append(node("strong", entry.name), node("span", timeLabel(entry)));
      slot.append(icon(symbol), copy);
      hours.append(slot);
    }
  };
  for (const [index, entry] of daySlots.entries()) {
    if (entry.start >= groupEnd) {
      paint();
      lanes = [];
      group = [];
      groupEnd = -1;
    }
    let lane = lanes.findIndex(end => end <= entry.start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = entry.end;
    groupEnd = Math.max(groupEnd, entry.end);
    group.push({ entry, lane, index });
  }
  paint();
  timeline.append(hours);
}

function renderList(target, entries, kind) {
  const list = byId(target);
  list.replaceChildren();
  if (!entries.length) {
    list.append(node("p", kind === "task" ? "Добавьте задачу и оцените её длительность." : "Добавьте встречу или перерыв.", "empty"));
  }
  for (const entry of entries) {
    const row = node("div", undefined, "item" + (entry.done ? " done" : ""));
    if (kind === "task") {
      const check = node("input", undefined, "check");
      check.type = "checkbox";
      check.checked = entry.done;
      check.setAttribute("aria-label", "Выполнено: " + entry.name);
      check.addEventListener("change", () => {
        entry.done = check.checked;
        render();
        const replacement = [...byId(target).querySelectorAll("input")].find(input => input.getAttribute("aria-label") === check.getAttribute("aria-label"));
        replacement?.focus();
      });
      row.append(check);
    }
    const copy = node("div", undefined, "item-copy");
    copy.append(node("strong", entry.name), node("span", kind === "fixed"
      ? [timeLabel(entry), entry.source && (entry.ignored ? "Не учитывается" : sourceLabel(entry))].filter(Boolean).join(" · ")
      : [entry.project, durationLabel(entry.duration), priorities[entry.priority]].filter(Boolean).join(" · ")));
    const action = entry.source ? (entry.ignored ? "Учитывать" : "Исключить") : "Изменить";
    const edit = node("button", action, "quiet edit");
    edit.setAttribute("aria-label", action + ": " + entry.name);
    edit.addEventListener("click", () => {
      if (!entry.source) return openEditor(kind, entry);
      const key = blockKey(entry);
      const ignored = !entry.ignored;
      for (const block of state.external) if (blockKey(block) === key) block.ignored = ignored;
      render();
    });
    row.append(copy, edit);
    list.append(row);
  }
}

function render(animatePlan = false) {
  save();
  byId("work-date").value = state.date;
  byId("today").textContent = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long", day: "numeric", month: "long"
  }).format(new Date(state.date + "T12:00:00"));
  byId("day-start").value = clock(state.start);
  byId("day-end").value = clock(state.end);
  const projects = [...new Set(state.tasks.map(entry => entry.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  if (!projects.includes(selectedProject)) selectedProject = "";
  byId("project-filter").replaceChildren(new Option("Все проекты", ""), ...projects.map(project => new Option(project, project)));
  byId("project-filter").value = selectedProject;
  byId("project-options").replaceChildren(...projects.map(project => new Option(project, project)));
  const imported = new Map();
  const manualKeys = new Set(state.fixed.map(blockKey));
  for (const block of state.external ?? []) {
    const key = blockKey(block);
    if (!manualKeys.has(key) && (!imported.has(key) || (imported.get(key).ignored && !block.ignored))) imported.set(key, block);
  }
  renderList("fixed-list", [...state.fixed, ...imported.values()].sort((a, b) => a.start - b.start), "fixed");
  renderList("task-list", state.tasks.filter(entry => !selectedProject || entry.project === selectedProject), "task");
  const proposal = proposalForDay();
  const accepted = makePlan();
  const plan = proposal ? makePlan(proposal) : accepted;
  renderProposal(proposal, accepted, plan);
  const blocks = plan.slots.filter(slot => slot.type !== "free");
  const planned = blocks.filter(slot => slot.type === "task");
  const completed = planned.filter(slot => slot.done).length;
  const reserve = plan.reserve.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  byId("free-time").textContent = durationLabel(plan.capacity);
  byId("planned-count").textContent = state.planned ? planned.length + " / " + state.tasks.length : "—";
  byId("planned-meta").textContent = state.planned && completed ? "Выполнено " + completed + " из " + planned.length : "задач в плане";
  byId("remaining-time").textContent = state.planned ? durationLabel(reserve) : "—";
  byId("over-count").textContent = state.planned ? plan.outside.length : "—";
  byId("calendar").disabled = !state.planned || !blocks.some(slot => !slot.source);
  byId("open-export").disabled = !state.planned || Boolean(proposal);
  byId("open-export").title = proposal ? "Сначала примите или отмените новый план" : "";
  byId("plan-caption").textContent = proposal ? "Предпросмотр · " + clock(state.start) + "–" + clock(state.end)
    : state.planned ? clock(state.start) + "–" + clock(state.end) : "Задачи и встречи на выбранный день";
  const timeline = byId("timeline");
  renderTimeline(timeline, plan, animatePlan);
  const overflow = byId("overflow");
  overflow.hidden = !state.planned || Boolean(proposal) || !plan.outside.length;
  overflow.replaceChildren();
  if (!overflow.hidden) {
    const largest = Math.max(0, ...plan.reserve.map(gap => gap.end - gap.start));
    const list = node("ul");
    for (const entry of plan.outside) {
      const item = node("li");
      item.append(node("strong", entry.name), node("span", entry.reason));
      if (!entry.done) {
        const move = node("button", "Перенести на завтра", "outline");
        move.setAttribute("aria-label", "Перенести на завтра: " + entry.name);
        move.addEventListener("click", () => moveToTomorrow(entry));
        item.append(move);
      }
      list.append(item);
    }
    overflow.append(node("h3", "Не поместилось в расписание"),
      node("p", "Самое длинное свободное окно — " + durationLabel(largest) + "."), list);
  }
}

let book = loadBook();
let state = book.days[book.selected];
let selectedProject = "";
let active = null;
let stagedMeeting = null;
let notification;
function notify(text) {
  clearTimeout(notification);
  byId("notice").textContent = text;
  notification = setTimeout(() => { byId("notice").textContent = ""; }, 3900);
}

function changePlan(message) {
  render(true);
  notify(message);
}

function openEditor(kind, entry) {
  active = { kind, entry };
  const isTask = kind === "task";
  byId("entry-error").textContent = "";
  byId("dialog-title").textContent = entry ? (isTask ? "Изменить задачу" : "Изменить блок") : (isTask ? "Новая задача" : "Новая встреча или перерыв");
  byId("entry-name").value = entry?.name ?? "";
  byId("task-fields").hidden = !isTask;
  byId("fixed-fields").hidden = isTask;
  byId("duration").disabled = !isTask;
  byId("priority").disabled = !isTask;
  byId("entry-start").disabled = isTask;
  byId("entry-end").disabled = isTask;
  byId("duration").value = entry?.duration ?? 45;
  byId("priority").value = entry?.priority ?? 1;
  byId("project-name").disabled = !isTask;
  byId("project-name").value = entry?.project ?? (isTask ? selectedProject : "");
  byId("dependency").disabled = !isTask;
  byId("dependency").replaceChildren(new Option("Без зависимости", ""),
    ...state.tasks.filter(item => item.id !== entry?.id).map(item => new Option(item.name, item.id)));
  byId("dependency").value = entry?.after ?? "";
  byId("entry-start").value = clock(entry?.start ?? state.start);
  byId("entry-end").value = clock(entry?.end ?? Math.min(state.end, state.start + 30));
  byId("delete-entry").hidden = !entry;
  byId("editor").showModal();
  byId("entry-name").focus();
}

function invalidEntry(message) {
  byId("entry-error").textContent = message;
}

byId("entry-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = byId("entry-name").value.trim();
  if (!name) return invalidEntry("Введите название.");
  const isTask = active.kind === "task";
  const entries = isTask ? state.tasks : state.fixed;
  let entry;
  if (isTask) {
    const after = byId("dependency").value;
    const visited = new Set(active.entry ? [active.entry.id] : []);
    let cursor = after;
    while (cursor) {
      if (visited.has(cursor)) return invalidEntry("Задачи не могут ждать друг друга. Измените порядок.");
      visited.add(cursor);
      cursor = state.tasks.find(item => item.id === cursor)?.after;
    }
    entry = task(name, Number(byId("duration").value), Number(byId("priority").value), byId("project-name").value.trim(), after);
  } else {
    const start = minute(byId("entry-start").value);
    const end = minute(byId("entry-end").value);
    if (end <= start || start < state.start || end > state.end) {
      return invalidEntry("Выберите интервал внутри границ дня. Конец должен быть позже начала.");
    }
    const crossing = entries.find(other => other.id !== active.entry?.id && start < other.end && end > other.start);
    if (crossing) return invalidEntry("Этот интервал пересекается с блоком «" + crossing.name + "».");
    entry = fixed(name, start, end);
  }
  if (active.entry) {
    entry.id = active.entry.id;
    if (isTask) entry.done = active.entry.done;
  }
  if (!isTask && state.planned) {
    stagedMeeting = { date: state.date, entry };
    byId("editor").close();
    render(true);
    byId("accept-plan").focus({ preventScroll: true });
    byId("plan-proposal").scrollIntoView({ block: "nearest" });
    return;
  }
  if (active.entry) {
    entries.splice(entries.indexOf(active.entry), 1, entry);
  } else {
    entries.push(entry);
  }
  byId("editor").close();
  changePlan(state.planned ? "Сохранено. План обновлён." : "Сохранено.");
});

byId("delete-entry").addEventListener("click", () => {
  const entries = active.kind === "task" ? state.tasks : state.fixed;
  if (stagedMeeting?.date === state.date && stagedMeeting.entry.id === active.entry.id) stagedMeeting = null;
  for (const entry of state.tasks) if (entry.after === active.entry.id) entry.after = "";
  entries.splice(entries.indexOf(active.entry), 1);
  byId("editor").close();
  changePlan(state.planned ? "Удалено. План обновлён." : "Удалено.");
});

byId("hours-form").addEventListener("submit", event => {
  event.preventDefault();
  const start = minute(byId("day-start").value);
  const end = minute(byId("day-end").value);
  if (end <= start || (proposalForDay() ?? state).fixed.some(block => block.start < start || block.end > end)) {
    notify("Конец дня должен быть позже начала. Все встречи и перерывы должны помещаться в выбранный интервал.");
    return;
  }
  state.start = start;
  state.end = end;
  changePlan(state.planned ? "Границы дня обновлены. План пересчитан." : "Границы дня обновлены.");
});

byId("work-date").addEventListener("change", event => {
  if (event.target.value && event.target.validity.valid) {
    switchDay(event.target.value);
  }
});
byId("previous-day").addEventListener("click", () => switchDay(offsetDate(state.date, -1)));
byId("next-day").addEventListener("click", () => switchDay(offsetDate(state.date, 1)));
byId("project-filter").addEventListener("change", event => {
  selectedProject = event.target.value;
  render();
  byId("project-filter").focus();
});
byId("load-demo").addEventListener("click", () => {
  if ((state.fixed.length || state.tasks.length) && !confirm("Заменить текущий план примером?")) return;
  state = { ...demo(state.date), external: state.external };
  if (stagedMeeting?.date === state.date) stagedMeeting = null;
  selectedProject = "";
  changePlan("Пример загружен.");
});
byId("add-lesson").addEventListener("click", () => {
  byId("lesson-project").value = selectedProject;
  byId("lesson-error").textContent = "";
  byId("lesson-editor").showModal();
  byId("lesson-project").focus();
});
byId("close-lesson").addEventListener("click", () => byId("lesson-editor").close());
byId("lesson-form").addEventListener("submit", event => {
  event.preventDefault();
  const project = byId("lesson-project").value.trim();
  if (!project) {
    byId("lesson-error").textContent = "Введите название проекта.";
    return;
  }
  const slides = task("Подготовить презентацию", 75, 1, project);
  const script = task("Написать скрипт", 90, 1, project, slides.id);
  const recording = task("Записать урок", 70, 1, project, script.id);
  const notes = task("Собрать конспект", 60, 1, project, recording.id);
  state.tasks.push(slides, script, recording, notes);
  selectedProject = project;
  byId("lesson-editor").close();
  changePlan("Четыре этапа урока добавлены.");
});
byId("close-dialog").addEventListener("click", () => byId("editor").close());
byId("add-task").addEventListener("click", () => openEditor("task"));
byId("add-fixed").addEventListener("click", () => openEditor("fixed"));
byId("build").addEventListener("click", () => {
  if (proposalForDay()) {
    byId("accept-plan").focus();
    return;
  }
  state.planned = true;
  changePlan("Расписание собрано.");
});
byId("accept-plan").addEventListener("click", () => {
  const proposal = proposalForDay();
  if (!proposal) return;
  const { entry } = stagedMeeting;
  stagedMeeting = null;
  if (entry.start < state.start || entry.end > state.end ||
    state.fixed.some(other => other.id !== entry.id && entry.start < other.end && entry.end > other.start)) {
    changePlan("Расписание изменилось. Выберите новое время для встречи.");
    return;
  }
  state.fixed = proposal.fixed;
  changePlan("Новый план принят.");
  byId("build").focus({ preventScroll: true });
});
byId("cancel-plan").addEventListener("click", () => {
  stagedMeeting = null;
  changePlan("Предложение отменено.");
  byId("build").focus({ preventScroll: true });
});

function escapeCalendar(value) {
  return value.replace(/[\\,;\n]/g, char => char === "\n" ? "\\n" : "\\" + char);
}

function foldCalendar(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let part = "";
  let width = 0;
  for (const char of line) {
    const length = encoder.encode(char).length;
    if (width + length > 75) {
      parts.push(part);
      part = " ";
      width = 1;
    }
    width += length;
    part += char;
  }
  parts.push(part);
  return parts.join("\r\n");
}

function downloadFile(blob, name) {
  const source = URL.createObjectURL(blob);
  const download = node("a");
  download.href = source;
  download.download = name;
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(source), 5000);
}

function validBackup(file) {
  const data = file?.book;
  if (file?.version !== 1 || !data?.days || !Object.hasOwn(data.days, data.selected)) return false;
  const validTime = number => Number.isInteger(number) && number >= 0 && number < 1440;
  const validEntry = entry => entry && typeof entry.id === "string" && typeof entry.name === "string";
  return Object.entries(data.days).every(([date, day]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || day.date !== date || !Number.isFinite(Date.parse(date))
      || !validTime(day.start) || !validTime(day.end) || day.start >= day.end
      || !Array.isArray(day.tasks) || !Array.isArray(day.fixed) || typeof day.planned !== "boolean") return false;
    const tasksOk = day.tasks.every(entry => validEntry(entry) && Number.isInteger(entry.duration)
      && entry.duration >= 5 && entry.duration <= 720 && [0, 1, 2].includes(entry.priority) && typeof entry.done === "boolean"
      && (entry.project === undefined || typeof entry.project === "string") && (entry.after === undefined || typeof entry.after === "string"));
    const fixedOk = day.fixed.every(entry => validEntry(entry) && validTime(entry.start) && validTime(entry.end)
      && entry.start >= day.start && entry.end <= day.end && entry.start < entry.end);
    const externalOk = day.external === undefined || (Array.isArray(day.external) && day.external.every(entry => validEntry(entry)
      && validTime(entry.start) && (validTime(entry.end) || entry.end === 1440) && entry.start < entry.end
      && ["google", "file"].includes(entry.source) && typeof entry.ignored === "boolean"));
    if (!tasksOk || !fixedOk || !externalOk) return false;
    const blocks = [...day.fixed].sort((a, b) => a.start - b.start);
    return blocks.every((entry, index) => !index || entry.start >= blocks[index - 1].end)
      && new Set([...day.tasks, ...day.fixed].map(entry => entry.id)).size === day.tasks.length + day.fixed.length;
  });
}

byId("backup").addEventListener("click", () => {
  save();
  const contents = JSON.stringify({ version: 1, book }, null, 2);
  downloadFile(new Blob([contents], { type: "application/json" }), "pulse-day-backup.json");
  notify("Копия планов скачана.");
});
byId("restore").addEventListener("click", () => byId("backup-file").click());
byId("backup-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!validBackup(data)) throw new Error("Invalid backup");
    const hasPlans = Object.values(book.days).some(day => day.tasks.length || day.fixed.length || day.external?.length);
    if (hasPlans && !confirm("Заменить текущие планы данными из копии?")) return;
    book = data.book;
    state = book.days[book.selected];
    stagedMeeting = null;
    selectedProject = "";
    changePlan("Планы восстановлены.");
  } catch {
    notify("Не удалось прочитать файл. Выберите копию планов, сохранённую в «Пульсе дня».");
  }
});

byId("calendar").addEventListener("click", () => {
  const date = state.date.replaceAll("-", "");
  const icsDate = value => value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const calendarTime = value => icsDate(new Date(state.date + "T" + clock(value) + ":00"));
  const stamp = icsDate(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pulse Day//Planner//RU", "CALSCALE:GREGORIAN"];
  for (const slot of makePlan().slots.filter(entry => entry.type !== "free" && !entry.source)) {
    lines.push("BEGIN:VEVENT", "UID:" + slot.id + "-" + date + "@pulse-day.local", "DTSTAMP:" + stamp,
      "DTSTART:" + calendarTime(slot.start), "DTEND:" + calendarTime(slot.end),
      "SUMMARY:" + escapeCalendar(slot.name), "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  const blob = new Blob([lines.map(foldCalendar).join("\r\n")], { type: "text/calendar;charset=utf-8" });
  downloadFile(blob, "pulse-day-" + state.date + ".ics");
  byId("export-editor").close();
  notify("Файл календаря скачан.");
});
render(true);
