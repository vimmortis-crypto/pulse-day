"use strict";

const importDialog = byId("calendar-editor");
const exportDialog = byId("export-editor");
const googleScope = "https://www.googleapis.com/auth/calendar.events.readonly";
const googleClientKey = "pulse-day-google-client-id";
let pendingImport = null;
let googleToken = null;
let googleScriptRequested = false;
let previewGeneration = 0;
const zoneFormats = new Map();

function setImportStatus(message, failed = false) {
  byId("import-status").textContent = message;
  byId("import-status").classList.toggle("failed", failed);
}

function clearPreview() {
  previewGeneration++;
  pendingImport = null;
  byId("import-review").hidden = true;
  byId("import-preview").replaceChildren();
  setImportStatus("");
}

function importPeriod() {
  return { start: state.date, end: offsetDate(state.date, Number(byId("import-range").value)) };
}

function canonicalDate(value) {
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  const date = dotted ? dotted[3] + "-" + dotted[2] + "-" + dotted[1] : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const stamp = new Date(date + "T00:00:00Z");
  return Number.isFinite(stamp.valueOf()) && stamp.toISOString().slice(0, 10) === date ? date : null;
}

function tabularRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && (quoted || !cell)) {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === delimiter || char === "\n")) {
      row.push(cell.trim());
      cell = "";
      if (char === "\n") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("В таблице открыта кавычка. Проверьте заголовки встреч и повторите.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function meetingList(text, period) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const first = normalized.split("\n")[0];
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const simpleTime = /^(?:(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})\s+)?(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s+(.+)$/;
  let rows = [];
  let invalid = 0;
  if (simpleTime.test(first)) {
    for (const line of normalized.split("\n").filter(line => line.trim())) {
      const match = simpleTime.exec(line.trim());
      if (match) rows.push([match[1] || period.start, match[2], match[3], match[4]]);
      else invalid++;
    }
  } else {
    const table = tabularRows(normalized, delimiter);
    const header = table.shift() ?? [];
    const labels = header.map(cell => cell.toLowerCase());
    const columns = [
      ["дата", "date"], ["начало", "start"], ["конец", "окончание", "end"], ["название", "встреча", "title", "название встречи"]
    ].map(options => labels.findIndex(label => options.includes(label)));
    if (columns.some(index => index < 0)) {
      throw new Error("Для таблицы нужны столбцы «Дата», «Начало», «Конец», «Название». Можно скачать шаблон CSV.");
    }
    rows = table.map(row => columns.map(index => row[index]));
  }
  const events = [];
  const isClock = value => /^([01]?\d|2[0-3]):[0-5]\d$/.test(value ?? "");
  for (const [value, begin, finish, title] of rows) {
    const date = canonicalDate(value ?? "");
    if (!date || !isClock(begin) || (!isClock(finish) && finish !== "24:00") || !title || minute(begin) >= minute(finish)) {
      invalid++;
      continue;
    }
    if (date >= period.start && date < period.end) {
      events.push({ date, start: minute(begin), end: minute(finish), name: title });
    }
  }
  return { events, invalid };
}

function dayLocal(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function appendSpan(target, period, begin, finish, name, wholeDay = false) {
  const start = new Date(begin);
  const end = new Date(finish);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) return;
  const first = dayLocal(start);
  const last = dayLocal(end);
  for (let date = first > period.start ? first : period.start; date < period.end && date <= last; date = offsetDate(date, 1)) {
    const lower = date === first ? start.getHours() * 60 + start.getMinutes() : 0;
    const upper = date === last ? end.getHours() * 60 + end.getMinutes() + (end.getSeconds() || end.getMilliseconds() ? 1 : 0) : 1440;
    if (lower < upper) target.push({ date, start: lower, end: upper, name: name || (wholeDay ? "Занято весь день" : "Встреча") });
  }
}

function calendarDate(time, zoneId) {
  if (time.isDate) return time.toString() + "T00:00:00";
  if (!zoneId || time.zone.tzid !== "floating") return time.toJSDate();
  if (!zoneFormats.has(zoneId)) {
    zoneFormats.set(zoneId, new Intl.DateTimeFormat("en", {
      timeZone: zoneId, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }));
  }
  const format = zoneFormats.get(zoneId);
  const wanted = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  let estimate = wanted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(format.formatToParts(estimate).map(part => [part.type, Number(part.value)]));
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    if (seen === wanted) break;
    estimate += wanted - seen;
  }
  return new Date(estimate);
}

function calendarFile(content, period) {
  if (!window.ICAL) throw new Error("Файл календаря не удалось прочитать. Проверьте папку vendor.");
  const root = new ICAL.Component(ICAL.parse(content.replace(/^\uFEFF/, "")));
  if (root.name !== "vcalendar") throw new Error("Выберите календарь в формате ICS.");
  ICAL.TimezoneService.reset();
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    const id = zone.getFirstPropertyValue("tzid");
    if (id) ICAL.TimezoneService.register(new ICAL.Timezone({ component: zone, tzid: id }));
  }
  const events = [];
  const components = root.getAllSubcomponents("vevent");
  const seriesById = new Map(components.filter(component => !component.hasProperty("recurrence-id"))
    .map(component => [component.getFirstPropertyValue("uid"), component]));
  const zoneOf = (item, key) => item?.component.getFirstProperty(key)?.getParameter("tzid");
  const append = (item, start, end, series) => {
    const status = item.component.getFirstPropertyValue("status") ?? series?.component.getFirstPropertyValue("status");
    const transparent = item.component.getFirstPropertyValue("transp") ?? series?.component.getFirstPropertyValue("transp");
    if (String(status).toUpperCase() === "CANCELLED" || String(transparent).toUpperCase() === "TRANSPARENT") return;
    if (start && end) {
      const startZone = zoneOf(item, "dtstart") ?? zoneOf(series, "dtstart");
      const endZone = zoneOf(item, "dtend") ?? startZone;
      appendSpan(events, period, calendarDate(start, startZone), calendarDate(end, endZone), item.summary || series?.summary, start.isDate);
    }
  };
  let invalid = 0;
  for (const component of components) {
    try {
      const item = new ICAL.Event(component);
      if (!item.startDate) {
        if (!item.isRecurrenceException()) invalid++;
        continue;
      }
      if (item.isRecurrenceException() || !item.isRecurring()) {
        const parent = item.isRecurrenceException() && seriesById.get(item.uid);
        append(item, item.startDate, item.endDate, parent ? new ICAL.Event(parent) : null);
        continue;
      }
      const iterator = item.iterator();
      const limit = new Date(period.end + "T00:00:00");
      for (let count = 0; count < 50000; count++) {
        const occurrence = iterator.next();
        if (!occurrence || new Date(calendarDate(occurrence, zoneOf(item, "dtstart"))) >= limit) break;
        const detail = item.getOccurrenceDetails(occurrence);
        append(detail.item, detail.startDate, detail.endDate, item);
        if (count === 49999) throw new Error("Слишком частые повторы в календаре.");
      }
    } catch {
      invalid++;
    }
  }
  return { events, invalid };
}

function preview(events, period, source, invalid = 0) {
  pendingImport = { events: [], period, source };
  const visited = new Set();
  for (const event of events.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)) {
    event.name = event.name.trim().slice(0, 180) || "Встреча";
    const key = event.date + "|" + blockKey(event);
    if (!visited.has(key)) pendingImport.events.push(event);
    visited.add(key);
  }
  const count = pendingImport.events.length;
  const list = byId("import-preview");
  list.replaceChildren();
  for (const event of pendingImport.events.slice(0, 25)) {
    list.append(node("li", event.date + " · " + timeLabel(event) + " · " + event.name));
  }
  if (count > 25) list.append(node("li", "Ещё " + (count - 25) + " в выбранном периоде"));
  const suffix = invalid ? " Пропущено строк или событий с ошибками: " + invalid + "." : "";
  setImportStatus((count ? "Найдено встреч: " + count + "." : "Встреч в этом периоде нет.") + suffix);
  byId("apply-import").textContent = source === "google" ? "Обновить встречи Google" : "Добавить в план";
  byId("import-review").hidden = !count && source !== "google";
  list.hidden = !count;
}

function applyImport() {
  if (!pendingImport) return;
  const { events, period, source } = pendingImport;
  save();
  if (source === "google") {
    for (const day of Object.values(book.days)) {
      if (day.date >= period.start && day.date < period.end) {
        day.previousGoogle = new Map((day.external ?? []).filter(event => event.source === source).map(event => [blockKey(event), event]));
        day.external = (day.external ?? []).filter(event => event.source !== source);
      }
    }
  }
  const keys = new Map();
  let count = 0;
  for (const { date, ...event } of events) {
    const day = book.days[date] ??= emptyDay(date);
    day.external ??= [];
    if (!keys.has(date)) keys.set(date, new Set([...day.fixed, ...day.external.filter(item => item.source === source)].map(blockKey)));
    const key = blockKey(event);
    if (!keys.get(date).has(key)) {
      const existing = day.previousGoogle?.get(key);
      day.external.push({ ...event, id: existing?.id ?? newId(), source, ignored: existing?.ignored ?? false });
      keys.get(date).add(key);
      count++;
    }
  }
  for (const day of Object.values(book.days)) delete day.previousGoogle;
  state = book.days[state.date];
  importDialog.close();
  clearPreview();
  changePlan(source === "google" ? "Встречи Google обновлены. Добавлено в план: " + count + "." : "Добавлено встреч: " + count + ".");
}

function chooseImportTab(google) {
  byId("file-panel").hidden = google;
  byId("google-panel").hidden = !google;
  for (const [key, selected] of [["google-tab", google], ["file-tab", !google]]) {
    byId(key).classList.toggle("selected-tab", selected);
    byId(key).setAttribute("aria-pressed", String(selected));
  }
  clearPreview();
  if (google) {
    const allowed = location.protocol === "https:" || (location.protocol === "http:" && location.hostname === "localhost");
    byId("google-origin").textContent = allowed ? location.origin : "http://localhost:8765";
    if (!byId("google-client-id").value) {
      try { byId("google-client-id").value = localStorage.getItem(googleClientKey) ?? ""; } catch {}
    }
    if (!allowed) {
      byId("google-load").disabled = true;
      setImportStatus("Для подключения откройте приложение по HTTPS или на localhost. Из файла можно импортировать календарь через ICS.");
    } else {
      primeGoogle();
    }
    byId("google-disconnect").hidden = !googleToken;
  }
}

function primeGoogle() {
  if (globalThis.google?.accounts?.oauth2) {
    byId("google-load").disabled = false;
    return;
  }
  if (googleScriptRequested) return;
  googleScriptRequested = true;
  byId("google-load").disabled = true;
  setImportStatus("Загружается вход Google…");
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.onload = () => {
    byId("google-load").disabled = false;
    setImportStatus("");
  };
  script.onerror = () => {
    googleScriptRequested = false;
    script.remove();
    setImportStatus("Вход Google недоступен в этой сети. Можно загрузить файл ICS.", true);
  };
  document.head.append(script);
}

async function googleEvents(token, period) {
  const events = [];
  const params = new URLSearchParams({
    singleEvents: "true", showDeleted: "false", maxResults: "2500",
    timeMin: new Date(period.start + "T00:00:00").toISOString(),
    timeMax: new Date(period.end + "T00:00:00").toISOString(),
    fields: "nextPageToken,items(summary,status,transparency,start,end)"
  });
  do {
    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + params, {
      headers: { Authorization: "Bearer " + token }
    });
    if (response.status === 401) {
      googleToken = null;
      throw new Error("Срок доступа истёк. Подключите Google Календарь снова.");
    }
    if (response.status === 403) throw new Error("Google не разрешил чтение. Проверьте, включён ли Calendar API и предоставлен ли доступ.");
    if (!response.ok) throw new Error("Не удалось загрузить встречи из Google.");
    const page = await response.json();
    for (const entry of page.items ?? []) {
      if (entry.status === "cancelled" || entry.transparency === "transparent") continue;
      const start = entry.start?.dateTime ?? (entry.start?.date && entry.start.date + "T00:00:00");
      const end = entry.end?.dateTime ?? (entry.end?.date && entry.end.date + "T00:00:00");
      if (start && end) appendSpan(events, period, start, end, entry.summary, Boolean(entry.start?.date));
    }
    params.delete("pageToken");
    if (page.nextPageToken) params.set("pageToken", page.nextPageToken);
  } while (params.has("pageToken"));
  return events;
}

async function synchronizeGoogle(period) {
  const generation = previewGeneration;
  byId("google-load").disabled = true;
  setImportStatus("Загружаются встречи…");
  try {
    const events = await googleEvents(googleToken, period);
    if (generation === previewGeneration && importDialog.open && !byId("google-panel").hidden) preview(events, period, "google");
  } catch (error) {
    if (generation === previewGeneration && importDialog.open && !byId("google-panel").hidden) setImportStatus(error.message || "Google Календарь недоступен.", true);
  } finally {
    byId("google-load").disabled = false;
    byId("google-load").textContent = googleToken ? "Загрузить встречи" : "Подключить и загрузить";
    byId("google-disconnect").hidden = !googleToken;
  }
}

byId("open-import").addEventListener("click", () => {
  importDialog.showModal();
  chooseImportTab(Boolean(googleToken));
});
byId("open-export").addEventListener("click", () => exportDialog.showModal());
for (const button of document.querySelectorAll(".close-tools")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
byId("file-tab").addEventListener("click", () => chooseImportTab(false));
byId("google-tab").addEventListener("click", () => chooseImportTab(true));
for (const id of ["import-range", "meeting-file", "meeting-paste"]) {
  byId(id).addEventListener("input", clearPreview);
}
byId("preview-import").addEventListener("click", async () => {
  clearPreview();
  const generation = previewGeneration;
  const file = byId("meeting-file").files[0];
  const period = importPeriod();
  try {
    if (file && file.size > 12 * 1024 * 1024) throw new Error("Файл больше 12 МБ. Загрузите отдельный календарь или таблицу нужных встреч.");
    const content = file ? await file.text() : byId("meeting-paste").value;
    if (!content.trim()) throw new Error("Выберите файл или вставьте список встреч.");
    const result = (file?.name.toLowerCase().endsWith(".ics") || content.trimStart().startsWith("BEGIN:VCALENDAR"))
      ? calendarFile(content, period) : meetingList(content, period);
    if (generation === previewGeneration && importDialog.open) preview(result.events, period, "file", result.invalid);
  } catch (error) {
    if (generation === previewGeneration && importDialog.open) setImportStatus(error.message || "Не удалось прочитать встречи.", true);
  }
});
byId("apply-import").addEventListener("click", applyImport);

byId("google-load").addEventListener("click", () => {
  clearPreview();
  const generation = previewGeneration;
  const period = importPeriod();
  if (googleToken) {
    synchronizeGoogle(period);
    return;
  }
  const clientId = byId("google-client-id").value.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    setImportStatus("Введите OAuth Client ID веб-приложения из Google Cloud.", true);
    return;
  }
  try {
    try { localStorage.setItem(googleClientKey, clientId); } catch {}
    google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: googleScope, include_granted_scopes: false,
      callback: response => {
        if (!response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, googleScope)) {
          setImportStatus("Доступ на чтение не предоставлен.", true);
          return;
        }
        googleToken = response.access_token;
        if (generation === previewGeneration && importDialog.open && !byId("google-panel").hidden) synchronizeGoogle(period);
      },
      error_callback: () => setImportStatus("Вход Google не завершён. Проверьте настройки или откройте окно входа повторно.", true)
    }).requestAccessToken();
  } catch {
    setImportStatus("Не удалось открыть вход Google. Проверьте OAuth Client ID и разрешённый адрес.", true);
  }
});
byId("google-disconnect").addEventListener("click", () => {
  const token = googleToken;
  googleToken = null;
  if (token) google.accounts.oauth2.revoke(token, () => {});
  byId("google-disconnect").hidden = true;
  byId("google-load").textContent = "Подключить и загрузить";
  clearPreview();
  setImportStatus("Доступ Google отключён. Уже добавленные встречи остались в плане.");
});

function csvContents(rows) {
  const cell = value => {
    const text = String(value ?? "");
    const safe = /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
}

function planTable() {
  const { slots, outside } = makePlan();
  const rows = slots.filter(entry => entry.type !== "free").map(entry => [
    state.date, clock(entry.start), clock(entry.end), entry.name,
    entry.type === "fixed" ? sourceLabel(entry) : entry.done ? "Выполнено" : "В плане", entry.project ?? ""
  ]);
  rows.push(...outside.map(entry => [state.date, "", "", entry.name, entry.reason, entry.project ?? ""]));
  return [["Дата", "Начало", "Конец", "Название", "Статус", "Проект"], ...rows];
}

byId("csv-template").addEventListener("click", () => {
  const rows = [["Дата", "Начало", "Конец", "Название"], [state.date, "10:30", "11:15", "Встреча с редактором"]];
  downloadFile(new Blob([csvContents(rows)], { type: "text/csv;charset=utf-8" }), "pulse-day-meetings.csv");
});
byId("export-csv").addEventListener("click", () => {
  downloadFile(new Blob([csvContents(planTable())], { type: "text/csv;charset=utf-8" }), "pulse-day-" + state.date + ".csv");
  exportDialog.close();
  notify("Таблица дня скачана.");
});
byId("print-plan").addEventListener("click", () => {
  const table = node("table");
  const [header, ...rows] = planTable();
  const head = node("thead");
  const labels = node("tr");
  for (const label of header.slice(1)) labels.append(node("th", label));
  head.append(labels);
  table.append(head);
  const body = node("tbody");
  for (const row of rows) {
    const line = node("tr");
    for (const value of row.slice(1)) line.append(node("td", value));
    body.append(line);
  }
  table.append(body);
  byId("print-sheet").replaceChildren(node("h1", "Пульс дня"), node("p", "Расписание на " + state.date), table);
  exportDialog.close();
  window.print();
});
