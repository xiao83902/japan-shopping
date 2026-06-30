const $ = (s) => document.querySelector(s),
  storeKey = "jp-trip-expenses.v1",
  tripKey = "jp-trip.current.v1",
  deletedKey = "jp-trip.deleted.v1",
  syncApiBase = "https://japan-shopping-sync.0902.one",
  ocrPaths = {
    workerPath:
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
    corePath:
      "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js",
    langPath: "https://tessdata.projectnaptha.com/4.0.0/",
  };
let records = loadJson(storeKey, []),
  trip = loadJson(tripKey, null),
  deletedIds = new Set(loadJson(deletedKey, [])),
  syncState = null,
  syncBusy = false,
  syncTimer = 0,
  draftImg = "";
const sample = () =>
  `株式会社サンプルマート\n新宿南口店\n${jpDate()} 18:42\nおにぎり 鮭 138\n緑茶 600ml 129\n牛乳 218\nチョコレート 198\nメロンパン 158\nヨーグルト 128\n小計 969\n消費税 78\n合計 ¥1,047`;
function iso(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4)
    .toISOString()
    .slice(0, 10);
}
function jpDate() {
  let d = iso().split("-");
  return `${d[0]}年${d[1]}月${d[2]}日`;
}
function yen(n) {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(+n || 0);
}
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}
function bind(s, prop, handler) {
  let el = $(s);
  if (el) el[prop] = handler;
}
function loadJson(key, fallback) {
  try {
    let parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
function saveDeletedLS() {
  localStorage.setItem(deletedKey, JSON.stringify([...deletedIds]));
}
function persistLocalOnly() {
  localStorage.setItem(storeKey, JSON.stringify(records));
  saveDeletedLS();
  trip
    ? localStorage.setItem(tripKey, JSON.stringify(trip))
    : localStorage.removeItem(tripKey);
}
function saveLS() {
  localStorage.setItem(storeKey, JSON.stringify(records));
  queueSync();
}
function saveTripLS() {
  trip
    ? localStorage.setItem(tripKey, JSON.stringify(trip))
    : localStorage.removeItem(tripKey);
  queueSync();
}
function inTrip(d, t = trip) {
  return t && t.id && d >= t.start && d <= t.end;
}
function tripRecs() {
  return trip ? records.filter((r) => r.tripId === trip.id) : records;
}
function attach(r) {
  return inTrip(r.date)
    ? {
        ...r,
        tripId: trip.id,
        tripName: trip.name,
        tripStart: trip.start,
        tripEnd: trip.end,
        archivedAt: r.archivedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    : r;
}
function setStatus(s) {
  let el = $("#status");
  if (el) el.textContent = s;
}
function progress(v, s) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  if ($("#fill")) $("#fill").style.width = v + "%";
  if ($("#pct")) $("#pct").textContent = v + "%";
  if (s) setStatus(s);
}
function recordStamp(record = {}) {
  return record.updatedAt || record.archivedAt || record.createdAt || "";
}
function cloudRecord(record) {
  let { image, ...rest } = record;
  return rest;
}
function makeSyncCode(start = iso()) {
  let bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  let suffix = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `jp-${start.replaceAll("-", "")}-${suffix}`;
}
function tripCloud(t = trip) {
  return t
    ? {
        id: t.id,
        name: t.name,
        start: t.start,
        end: t.end,
        syncCode: t.syncCode || syncState?.code || "",
        updatedAt: t.updatedAt || new Date().toISOString(),
      }
    : null;
}
function alignRecordToTrip(record, t) {
  return {
    ...record,
    tripId: t.id,
    tripName: t.name,
    tripStart: t.start,
    tripEnd: t.end,
    archivedAt: record.archivedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}
function scopedTripRecords(t = trip) {
  if (!t?.id) return [];
  return records.filter(
    (r) => r.tripId === t.id || (!r.tripId && inTrip(r.date, t)),
  );
}
function scopedRecordsForTrips(trips) {
  let usableTrips = trips.filter((t) => t?.id),
    seen = new Set();
  if (!usableTrips.length) return [];
  return records.filter((record) => {
    let matched = usableTrips.some(
      (t) =>
        record.tripId === t.id || (!record.tripId && inTrip(record.date, t)),
    );
    if (!matched || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}
function currentSnapshot() {
  let activeTrip = tripCloud();
  return {
    version: 2,
    scope: "trip",
    records: activeTrip
      ? scopedTripRecords(trip).map((r) => cloudRecord(alignRecordToTrip(r, activeTrip)))
      : [],
    trip: activeTrip,
    deletedIds: [...deletedIds],
    updatedAt: new Date().toISOString(),
  };
}
function normalizeSnapshot(payload = {}) {
  return {
    records: Array.isArray(payload.records) ? payload.records : [],
    trip: payload.trip && payload.trip.id ? payload.trip : null,
    deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
  };
}
function mergeRecords(localRecords, remoteRecords, deleted) {
  let merged = new Map();
  [...localRecords, ...remoteRecords].forEach((record) => {
    if (!record || !record.id || deleted.has(record.id)) return;
    let previous = merged.get(record.id);
    if (!previous) {
      merged.set(record.id, record);
      return;
    }
    let next =
      recordStamp(record).localeCompare(recordStamp(previous)) >= 0
        ? record
        : previous;
    if (!next.image && (record.image || previous.image)) {
      next = { ...next, image: record.image || previous.image };
    }
    merged.set(record.id, next);
  });
  return [...merged.values()].sort((a, b) =>
    (b.date + recordStamp(b)).localeCompare(a.date + recordStamp(a)),
  );
}
function newerTrip(localTrip, remoteTrip) {
  if (!localTrip) return remoteTrip;
  if (!remoteTrip) return localTrip;
  return String(remoteTrip.updatedAt || "").localeCompare(
    String(localTrip.updatedAt || ""),
  ) >= 0
    ? remoteTrip
    : localTrip;
}
function mergedTrip(localTrip, remoteTrip, code) {
  let winner = newerTrip(localTrip, remoteTrip);
  if (!winner) return null;
  return {
    ...winner,
    id: remoteTrip?.id || winner.id || localTrip?.id || crypto.randomUUID(),
    syncCode:
      code || winner.syncCode || localTrip?.syncCode || remoteTrip?.syncCode || "",
    updatedAt: winner.updatedAt || new Date().toISOString(),
  };
}
function applyRemoteSnapshot(payload) {
  let remote = normalizeSnapshot(payload);
  let code = syncState?.code || trip?.syncCode || remote.trip?.syncCode || "",
    localTrip = trip,
    remoteTrip = remote.trip
      ? { ...remote.trip, syncCode: remote.trip.syncCode || code }
      : null,
    nextTrip = mergedTrip(localTrip, remoteTrip, code);

  if (!nextTrip) {
    render();
    return;
  }

  let localScoped = scopedRecordsForTrips([localTrip, nextTrip]),
    localAligned = localScoped.map((r) => alignRecordToTrip(r, nextTrip)),
    remoteAligned = remote.records.map((r) => alignRecordToTrip(r, nextTrip)),
    oldTripIds = new Set(
      [localTrip?.id, remoteTrip?.id, nextTrip.id].filter(Boolean),
    ),
    scopedIds = new Set(
      [...localScoped, ...localAligned, ...remoteAligned].map((r) => r.id),
    );

  deletedIds = new Set([...deletedIds, ...remote.deletedIds]);
  let otherRecords = records.filter(
    (r) => !oldTripIds.has(r.tripId) && !scopedIds.has(r.id),
  );
  records = mergeRecords(
    [...otherRecords, ...localAligned],
    remoteAligned,
    deletedIds,
  );
  trip = nextTrip;
  persistLocalOnly();
  render();
}
async function sha256Hex(value) {
  let bytes = new TextEncoder().encode(value);
  let hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function buildSyncState(code) {
  let normalized = code.trim();
  if (normalized.length < 6) {
    throw new Error("同步代碼至少需要 6 個字元");
  }
  let spaceId = await sha256Hex(`jp-trip-space:${normalized}`);
  let authToken = await sha256Hex(`jp-trip-auth:${normalized}`);
  return {
    spaceId,
    authToken,
    code: normalized,
    label: normalized,
    connectedAt: new Date().toISOString(),
  };
}
async function initSyncFromTrip() {
  try {
    if (trip?.id && !trip.syncCode) {
      trip = {
        ...trip,
        syncCode: makeSyncCode(trip.start),
        updatedAt: new Date().toISOString(),
      };
      saveTripLS();
    }
    syncState = trip?.syncCode ? await buildSyncState(trip.syncCode) : null;
    renderSync();
  } catch (error) {
    syncState = null;
    setSyncMessage("同步代碼格式不正確", "error");
    console.error(error);
  }
}
function syncHeaders() {
  return {
    Authorization: `Bearer ${syncState.authToken}`,
    "Content-Type": "application/json",
  };
}
function setSyncMessage(message, state = syncState ? "on" : "off") {
  let dot = $("#syncDot");
  if (dot) dot.dataset.state = state;
  if ($("#syncStatus")) $("#syncStatus").textContent = message;
}
function renderSync() {
  let input = $("#syncCode"),
    connectLabel = $("#syncConnect span");
  if (input && document.activeElement !== input) {
    input.value = trip?.syncCode || syncState?.code || "";
  }
  if (!trip?.id) {
    setSyncMessage("先設定旅程後即可同步", "off");
    if ($("#syncNow")) $("#syncNow").disabled = true;
    if ($("#syncDisconnect")) $("#syncDisconnect").disabled = true;
    if (connectLabel) connectLabel.textContent = "加入旅程";
    return;
  }
  if (!syncState?.spaceId) {
    setSyncMessage("尚未設定本趟同步代碼", "off");
    if ($("#syncNow")) $("#syncNow").disabled = true;
    if ($("#syncDisconnect")) $("#syncDisconnect").disabled = true;
    if (connectLabel) connectLabel.textContent = "建立同步";
    return;
  }
  setSyncMessage(`本趟代碼：${syncState.label}`, "on");
  if ($("#syncNow")) $("#syncNow").disabled = false;
  if ($("#syncDisconnect")) $("#syncDisconnect").disabled = false;
  if (connectLabel) connectLabel.textContent = "套用代碼";
}
function queueSync() {
  if (!syncState?.spaceId) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }), 700);
}
async function fetchRemoteSnapshot() {
  let response = await fetch(`${syncApiBase}/v1/spaces/${syncState.spaceId}`, {
    headers: syncHeaders(),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function pushSnapshot() {
  let response = await fetch(`${syncApiBase}/v1/spaces/${syncState.spaceId}`, {
    method: "PUT",
    headers: syncHeaders(),
    body: JSON.stringify(currentSnapshot()),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function syncNow({ quiet = false } = {}) {
  if (!syncState?.spaceId && trip?.syncCode) await initSyncFromTrip();
  if (!syncState?.spaceId || syncBusy) return;
  syncBusy = true;
  try {
    setSyncMessage("同步中...", "busy");
    let remote = await fetchRemoteSnapshot();
    applyRemoteSnapshot(remote);
    await pushSnapshot();
    let time = new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
    });
    setSyncMessage(`已同步 ${time}`, "on");
    if (!quiet) setStatus("跨裝置資料已同步");
  } catch (error) {
    console.error(error);
    setSyncMessage("同步失敗，稍後再試", "error");
    if (!quiet) setStatus("同步失敗，請確認網路或同步代碼");
  } finally {
    syncBusy = false;
  }
}
async function connectSync() {
  let previousSyncState = syncState;
  try {
    let code = $("#syncCode").value.trim();
    if (!code && trip?.id) code = trip.syncCode || makeSyncCode(trip.start);
    syncState = await buildSyncState(code);
    setSyncMessage("同步中...", "busy");
    let remote = await fetchRemoteSnapshot();
    if (!remote.trip && !trip?.id) {
      syncState = null;
      renderSync();
      throw new Error("請先設定旅程時間，或輸入已存在旅程的同步代碼");
    }
    if (trip?.id && trip.syncCode !== code) {
      trip = { ...trip, syncCode: code, updatedAt: new Date().toISOString() };
      saveTripLS();
    }
    applyRemoteSnapshot(remote);
    await pushSnapshot();
    renderSync();
    setStatus("本趟旅程同步已啟用");
  } catch (error) {
    syncState = previousSyncState;
    renderSync();
    setSyncMessage(error.message || "同步設定失敗", "error");
    setStatus(error.message || "同步設定失敗");
  }
}
function disconnectSync() {
  syncState = null;
  if (trip?.id) {
    trip = { ...trip, syncCode: "", updatedAt: new Date().toISOString() };
    saveTripLS();
  }
  renderSync();
  setStatus("這台裝置已停用本趟旅程同步，本機資料仍保留");
}
function norm(t) {
  return String(t || "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/￥/g, "¥")
    .replace(/[，、]/g, ",")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
function amounts(l) {
  let out = [],
    re = /(?:¥\s*)?-?\d{1,3}(?:,\d{3})+|-?\d{2,7}(?:\s*円)?/g,
    m;
  while ((m = re.exec(l))) {
    let n = +m[0].replace(/[^\d-]/g, "");
    if (Number.isFinite(n)) out.push({ v: n, i: m.index, raw: m[0] });
  }
  return out;
}
function parseReceipt(raw) {
  let text = norm(raw),
    lines = text.split("\n"),
    joined = lines.join("\n"),
    dm = joined.match(
      /(\d{4})[./-](\d{1,2})[./-](\d{1,2})|(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    ),
    date = iso();
  if (dm) {
    let y = dm[1] || dm[4],
      m = dm[2] || dm[5],
      d = dm[3] || dm[6];
    date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  let store =
      lines
        .slice(0, 10)
        .find(
          (l) =>
            !amounts(l).length &&
            !/レシート|TEL|電話|住所|登録|日付|日時|〒/.test(l),
        ) || "未辨識店家",
    items = [];
  for (let l of lines) {
    if (
      /合\s*計|小\s*計|消費税|税額|お預|釣|レシート|TEL|登録|日付|日時/.test(
        l,
      ) ||
      /\d{1,2}:\d{2}|年.*月.*日/.test(l)
    )
      continue;
    let a = amounts(l),
      last = a[a.length - 1];
    if (!last) continue;
    let name = l
      .slice(0, last.i)
      .replace(/^[*※\-\s]+/, "")
      .trim();
    if (name.length > 1 && last.v > 0) items.push({ name, price: last.v });
  }
  let total = 0,
    cands = [];
  lines.forEach((l, i) => {
    let a = amounts(l);
    if (
      a.length &&
      /合\s*計|総\s*合\s*計|お支払|領収金額/.test(l) &&
      !/消費税|お預|釣/.test(l)
    )
      cands.push({ v: a[a.length - 1].v, i });
  });
  total = cands.length
    ? cands.sort((a, b) => b.i - a.i)[0].v
    : items.reduce((s, i) => s + i.price, 0);
  return { store, date, total, items, rawText: text };
}
function row(item = { name: "", price: "" }) {
  if (!$("#items")) return;
  let tr = document.createElement("tr");
  tr.innerHTML = `<td><input class="iname" value="${esc(item.name)}"></td><td><input class="iprice" type="number" min="0" step="1" value="${item.price || ""}"></td><td><button class="icon danger rem" type="button" title="刪除此品項"><i data-lucide="x"></i></button></td>`;
  tr.querySelector(".rem").onclick = () => {
    tr.remove();
    if (!$("#items tr")) row();
    hint();
  };
  tr.querySelectorAll("input").forEach((i) => (i.oninput = hint));
  $("#items").append(tr);
  lucide.createIcons();
}
function draft() {
  if (!$("#items")) {
    return {
      store: "未命名店家",
      date: iso(),
      total: 0,
      items: [],
      rawText: "",
      image: "",
    };
  }
  let items = [...document.querySelectorAll("#items tr")]
    .map((r) => ({
      name: r.querySelector(".iname").value.trim(),
      price: +r.querySelector(".iprice").value || 0,
    }))
    .filter((i) => i.name || i.price);
  return {
    store: $("#store").value.trim() || "未命名店家",
    date: $("#date").value || iso(),
    total: +$("#total").value || items.reduce((s, i) => s + i.price, 0),
    items,
    rawText: $("#ocr").value.trim(),
    image: draftImg,
  };
}
function hint() {
  if (!$("#hint")) return;
  let d = draft(),
    sum = d.items.reduce((s, i) => s + i.price, 0);
  $("#hint").textContent = d.items.length
    ? `${d.items.length} 項，品項合計 ${yen(sum)}`
    : "";
}
function fillDraft(d = { store: "", date: iso(), total: 0, items: [] }) {
  if (!$("#items")) return;
  $("#store").value = d.store || "";
  $("#date").value = d.date || iso();
  $("#total").value = d.total || "";
  $("#items").innerHTML = "";
  (d.items?.length ? d.items : [{}]).forEach(row);
  hint();
  lucide.createIcons();
}
async function readUrl(f) {
  return new Promise((res, rej) => {
    let r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}
async function prep(f) {
  let src = await readUrl(f),
    img = new Image();
  img.src = src;
  await img.decode();
  let max = 1900,
    sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)),
    c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * sc);
  c.height = Math.round(img.naturalHeight * sc);
  let ctx = c.getContext("2d");
  ctx.fillStyle = "#fdfefd";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.filter = "contrast(1.18) brightness(1.04) saturate(.25)";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.92);
}
async function ocrFile(f) {
  if (!$("#ocr") || !f || !window.Tesseract)
    return setStatus("辨識引擎尚未載入");
  progress(0, "正在讀取照片");
  draftImg = await readUrl(f);
  $("#preview").src = draftImg;
  $("#imageBox").classList.add("has");
  try {
    let img = await prep(f);
    let r = await Tesseract.recognize(img, "jpn+eng", {
      ...ocrPaths,
      gzip: true,
      logger: (e) => {
        if (e.status === "recognizing text")
          progress(12 + e.progress * 86, "正在辨識文字");
        else if (e.status) setStatus(e.status);
      },
    });
    $("#ocr").value = norm(r.data.text);
    progress(100, "OCR 完成");
    fillDraft(parseReceipt($("#ocr").value));
  } catch (e) {
    console.error(e);
    progress(0, "OCR 失敗，請改用較清晰照片");
  }
}
function renderTrip() {
  let summary = $("#tripSummary");
  if (trip) {
    if ($("#tripName")) $("#tripName").value = trip.name;
    if ($("#tripStart")) $("#tripStart").value = trip.start;
    if ($("#tripEnd")) $("#tripEnd").value = trip.end;
    let rs = tripRecs(),
      sum = rs.reduce((s, r) => s + r.total, 0);
    if (summary)
      summary.innerHTML =
        `<span class="status">${esc(trip.name)}</span><span>${trip.start} 至 ${trip.end}</span><span>已歸檔 ${rs.length} 筆</span><strong>${yen(sum)}</strong>`;
  } else {
    if (summary)
      summary.innerHTML =
        `<span class="status">尚未設定旅程時間</span><span>未歸檔 ${records.length} 筆</span><strong>${yen(records.reduce((s, r) => s + r.total, 0))}</strong>`;
  }
}
async function saveTrip() {
  let name = $("#tripName").value.trim() || "日本旅程",
    start = $("#tripStart").value,
    end = $("#tripEnd").value;
  if (!start || !end) return setStatus("請設定旅程開始與結束日期");
  if (end < start) return setStatus("旅程結束日期不可早於開始日期");
  let id = trip?.id || crypto.randomUUID(),
    now = new Date().toISOString(),
    typedCode = $("#syncCode")?.value.trim() || "",
    syncCode = typedCode || trip?.syncCode || makeSyncCode(start);
  try {
    syncState = await buildSyncState(syncCode);
  } catch (error) {
    setSyncMessage(error.message || "同步代碼格式不正確", "error");
    return setStatus(error.message || "同步代碼格式不正確");
  }
  trip = { id, name, start, end, syncCode, updatedAt: now };
  records = records.map((r) =>
    inTrip(r.date, trip) && (!r.tripId || r.tripId === id)
      ? {
          ...r,
          tripId: id,
          tripName: name,
          tripStart: start,
          tripEnd: end,
          updatedAt: now,
        }
      : r.tripId === id && !inTrip(r.date, trip)
        ? (({ tripId, tripName, tripStart, tripEnd, archivedAt, ...rest }) => ({
            ...rest,
            updatedAt: now,
          }))(r)
        : r,
  );
  saveTripLS();
  saveLS();
  setTripFilter(id);
  render();
  renderSync();
  await syncNow({ quiet: true });
  setStatus("已儲存旅程區間，並建立本趟同步代碼");
}
function archives() {
  let m = new Map();
  if (trip) m.set(trip.id, trip);
  records.forEach(
    (r) =>
      r.tripId &&
      m.set(r.tripId, {
        id: r.tripId,
        name: r.tripName,
        start: r.tripStart,
        end: r.tripEnd,
      }),
  );
  return [...m.values()].sort((a, b) => b.start.localeCompare(a.start));
}
function compact(t) {
  return t
    ? `${t.start.slice(5).replace("-", "/")}-${t.end.slice(5).replace("-", "/")}`
    : "";
}
function setTripFilter(v) {
  let filter = $("#tripFilter");
  if (!filter) return;
  filter.dataset.pref = v || "";
  filter.value = v || "all";
}
function renderFilter() {
  let filter = $("#tripFilter");
  if (!filter) return;
  let want =
      filter.value ||
      filter.dataset.pref ||
      (trip ? trip.id : "all"),
    opts = [
      '<option value="all">所有旅程</option>',
      ...archives().map(
        (t) =>
          `<option value="${t.id}">${t.id === trip?.id ? "目前旅程" : "旅程檔案"}：${esc(t.name)} ${compact(t)}</option>`,
      ),
      '<option value="unfiled">未歸檔</option>',
    ];
  filter.innerHTML = opts.join("");
  filter.value = [...filter.options].some(
    (o) => o.value === want,
  )
    ? want
    : trip
      ? trip.id
      : "all";
}
function filtered(includeDate = true) {
  let tv = $("#tripFilter")?.value || "all",
    date = includeDate ? $("#dateFilter")?.value || "" : "",
    kw = ($("#keyword")?.value || "").trim().toLowerCase();
  return records.filter(
    (r) =>
      (tv === "all" || (tv === "unfiled" ? !r.tripId : r.tripId === tv)) &&
      (!date || r.date === date) &&
      (!kw ||
        `${r.store} ${r.date} ${r.total} ${r.tripName || ""} ${(r.items || []).map((i) => i.name + " " + i.price).join(" ")}`
          .toLowerCase()
          .includes(kw)),
  );
}
function renderStats() {
  let rs = tripRecs(),
    today = rs.filter((r) => r.date === iso()).reduce((s, r) => s + r.total, 0),
    sum = rs.reduce((s, r) => s + r.total, 0);
  if ($("#today")) $("#today").textContent = yen(today);
  if ($("#tripTotal")) $("#tripTotal").textContent = yen(sum);
  if ($("#count")) $("#count").textContent = rs.length;
}
function renderDaily() {
  let daily = $("#daily");
  if (!daily) return;
  let m = {};
  filtered(false).forEach((r) => (m[r.date] = (m[r.date] || 0) + r.total));
  let ds = Object.keys(m).sort().reverse();
  daily.innerHTML = ds.length
    ? ds
        .map(
          (d) =>
            `<button class="tile" data-date="${d}"><span class="lbl">旅費日計</span><span class="date">${d}</span><strong>${yen(m[d])}</strong></button>`,
        )
        .join("")
    : '<div class="emptyState">尚無旅程消費資料</div>';
  document.querySelectorAll(".tile").forEach(
    (b) =>
      (b.onclick = () => {
        $("#dateFilter").value = b.dataset.date;
        renderList();
      }),
  );
}
function itemList(items = []) {
  if (!items.length) return '<div class="emptyState">沒有品項明細</div>';
  let vis = items.length > 4 ? items.slice(0, 3) : items,
    hid = items.length > 4 ? items.slice(3) : [];
  let rows = (a) =>
    a
      .map(
        (i) =>
          `<li class="itemrow"><span class="itemname">${esc(i.name || "未命名品項")}</span><span class="price">${yen(i.price)}</span></li>`,
      )
      .join("");
  return `<ul class="itemlist">${rows(vis)}</ul>${hid.length ? `<details class="more"><summary><span>展開其餘 ${hid.length} 項</span><i data-lucide="chevron-down"></i></summary><ul class="itemlist">${rows(hid)}</ul></details>` : ""}`;
}
function renderList() {
  let recordsEl = $("#records");
  if (!recordsEl) return;
  let rs = filtered().sort((a, b) =>
    (b.date + b.createdAt).localeCompare(a.date + a.createdAt),
  );
  recordsEl.innerHTML = rs.length
    ? rs
        .map(
          (r) =>
            `<article class="record"><div class="record-main"><div class="record-head"><div class="store"><span class="storemark">店</span><div class="storetext"><h3>${esc(r.store)}</h3><span class="record-trip">${esc(r.tripName || "未歸檔")}</span></div></div><div class="record-total"><small>合計</small><div class="total">${yen(r.total)}</div></div></div><div class="meta"><span><i data-lucide="calendar"></i>${r.date}</span><span><i data-lucide="shopping-bag"></i>${r.items?.length || 0} 項</span><span><i data-lucide="archive"></i>${esc(r.tripName || "未歸檔")}</span></div><div class="lines"><div class="items-head"><span>交易明細</span><span>${r.items?.length || 0} 項</span></div>${itemList(r.items)}</div></div><button class="icon danger del record-delete" data-id="${r.id}" title="刪除這筆旅費"><i data-lucide="trash-2"></i></button></article>`,
        )
        .join("")
    : '<div class="emptyState">沒有符合條件的旅遊消費</div>';
  document.querySelectorAll(".del").forEach(
    (b) =>
      (b.onclick = () => {
        deletedIds.add(b.dataset.id);
        saveDeletedLS();
        records = records.filter((r) => r.id !== b.dataset.id);
        saveLS();
        render();
      }),
  );
  lucide.createIcons();
}
function render() {
  renderTrip();
  renderFilter();
  renderStats();
  renderDaily();
  renderList();
  lucide.createIcons();
}
function saveExpense() {
  let now = new Date().toISOString();
  let r = attach({
    ...draft(),
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  records.unshift(r);
  saveLS();
  if (r.tripId) setTripFilter(r.tripId);
  render();
  setStatus(
    `已儲存旅費：${r.store} ${yen(r.total)}${r.tripId ? "，已歸檔至 " + r.tripName : "，尚未歸檔至旅程"}`,
  );
}
bind("#photo", "onchange", (e) => ocrFile(e.target.files[0]));
bind("#demo", "onclick", () => {
  $("#ocr").value = sample();
  progress(100, "已載入範例");
  fillDraft(parseReceipt($("#ocr").value));
});
bind("#parse", "onclick", () =>
  $("#ocr").value.trim()
    ? fillDraft(parseReceipt($("#ocr").value))
    : setStatus("沒有可解析的辨識文字"));
bind("#reset", "onclick", () => {
  draftImg = "";
  $("#preview").removeAttribute("src");
  $("#imageBox").classList.remove("has");
  $("#ocr").value = "";
  progress(0, "");
  fillDraft();
});
bind("#add", "onclick", () => row());
bind("#saveTrip", "onclick", saveTrip);
bind("#save", "onclick", saveExpense);
bind("#tripFilter", "onchange", () => {
  $("#tripFilter").dataset.pref = $("#tripFilter").value;
  renderDaily();
  renderList();
});
bind("#dateFilter", "onchange", renderList);
bind("#keyword", "oninput", () => {
  renderDaily();
  renderList();
});
bind("#clearFilter", "onclick", () => {
  $("#dateFilter").value = "";
  $("#keyword").value = "";
  setTripFilter(trip ? trip.id : "all");
  renderDaily();
  renderList();
});
bind("#syncConnect", "onclick", connectSync);
bind("#syncNow", "onclick", () => syncNow());
bind("#syncDisconnect", "onclick", disconnectSync);
bind("#total", "oninput", hint);
if ($("#items")) fillDraft();
render();
renderSync();
initSyncFromTrip().then(() => {
  if (syncState?.spaceId) queueSync();
});
