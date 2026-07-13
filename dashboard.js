// TODO change canvas import for graph creation
let weekOffset = 0;
let monthOffset = 0;
let currentView = "Weekly";
let currentExportData = null;

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

canvas.width = 348;
canvas.height = 220;

// apply saved theme on load and set up toggle button
function applyTheme(theme) {
  const html = document.documentElement;

  if (theme === "dark") {
    html.classList.add("dark");
    document.getElementById("themeToggle").textContent = "☀";
  } else {
    html.classList.remove("dark");
    document.getElementById("themeToggle").textContent = "⏾";
  }

  // re-render the current view
  if (currentView === "Weekly") loadWeekly();
  if (currentView === "Monthly") loadMonthly();
  if (currentView === "Session") loadSession();
}

// toggle theme and save preference
document.getElementById("themeToggle").addEventListener("click", () => {
  chrome.storage.local.get(["theme"], res => {
    const current = res.theme === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    chrome.storage.local.set({ theme: next }, () => applyTheme(next));
  });
});

// show/hide daily average block based on view
function toggleDailyAverage(show) {
  const avgBlock = document.getElementById("avgCount").closest(".stat-block");
  avgBlock.style.display = show ? "block" : "none";
}

// update active state of nav buttons
function setActiveButton(view) {
  ["weekly", "monthly", "session"].forEach(id => {
    document.getElementById(id).classList.remove("active");
  });
  document.getElementById(view.toLowerCase()).classList.add("active");
}

// helper to format date as the universal format
function formatDMY(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${date.getFullYear()}`;
}

// draw line graph for weekly/monthly views, with grid lines and labels
function drawGraph(labels, values) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const padL = 24, padR = 24, padT = 20, padB = 42;
  const w = canvas.width - padL - padR;
  const h = canvas.height - padT - padB;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;

  // draw horizontal grid lines
  ctx.strokeStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--separator");

  // 4 lines for 0%, 25%, 50%, 75%
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = padT + (h / 4) * g;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
  }

  // calculate points for the line graph based on values and max, handle single value case by centering it
  const pts = values.map((v, i) => ({
    x: values.length === 1 ? padL + w / 2 : padL + step * i,
    y: padT + h - (v / max) * h
  }));

  // draw the line graph if we have more than 1 point, otherwise just show the single point
  if (pts.length > 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "#FF3B30";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // draw points on the graph
  pts.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#FF3B30";
    ctx.fill();
  });

  ctx.textAlign = "center";

  // draw labels for each point, showing day and date if available
  pts.forEach((p, i) => {
    const lbl = labels[i];
    if (lbl.day) {
      ctx.fillStyle = "#FF3B30";
      ctx.font = "600 11px -apple-system, sans-serif";
      ctx.fillText(lbl.day, p.x, padT + h + 16);
    }
    if (lbl.date) {
      ctx.fillStyle = "#FF3B30";
      ctx.font = "400 10px -apple-system, sans-serif";
      ctx.fillText(lbl.date, p.x, padT + h + 30);
    }
  });

  // update total and average counts below the graph
  const total = values.reduce((a, b) => a + b, 0);
  document.getElementById("totalCount").textContent = total;
  document.getElementById("avgCount").textContent =
    values.length ? (total / values.length).toFixed(1) : 0;
}

// render a simple word cloud for the session view, showing top 5 triggers with size based on count
// TODO what would be other ways to change this? 
function renderWordCloud(wordData) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const allTotal = Object.values(wordData || {}).reduce((a, b) => a + b, 0);
  document.getElementById("totalCount").textContent = allTotal;

  const entries = Object.entries(wordData || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (!entries.length) {
    ctx.font = "14px -apple-system, sans-serif";
    ctx.fillStyle = "#8E8E93";
    ctx.textAlign = "center";
    ctx.fillText("No triggers this session", canvas.width / 2, canvas.height / 2);
    return;
  }

  const max = entries[0][1];
  const centerX = canvas.width / 2;
  let y = 60;

  entries.forEach(([word, count]) => {
    const size = 16 + (count / max) * 30;
    ctx.font = `600 ${size}px -apple-system, sans-serif`;
    ctx.fillStyle = "#FF3B30";
    ctx.textAlign = "center";
    ctx.fillText(word, centerX, y);
    y += size + 16;
  });
}

// calculate the current week's date range based on the offset, 
// return arrays of day labels and dates for graphing
function getCurrentWeek(offset = 0) {
  const now = new Date();
  now.setDate(now.getDate() - offset * 7);

  const day = now.getDay();
  const mondayOffset = (day === 0 ? -6 : 1 - day);

  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const days = [];
  const labels = [];
  const weekNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // loop through the week and create labels for each day, showing the day name and date
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d.toISOString().split("T")[0]);
    labels.push({ day: weekNames[i], date: String(d.getDate()).padStart(2, "0") });
  }

  // update the period label to show the current week's date range
  const range = `${formatDMY(monday)} – ${formatDMY(sunday)}`;
  document.getElementById("periodLabel").textContent = range;
  document.getElementById("navPeriodLabel").textContent = range;

  return { days, labels };
}

// load weekly data from storage, prepare it for graphing and export, then draw the graph
function loadWeekly() {
  currentView = "Weekly";
  setActiveButton("Weekly");
  toggleDailyAverage(true);
  document.querySelector(".week-nav").style.display = "flex";

  chrome.storage.local.get(["dailyCounts"], res => {
    const data = res.dailyCounts || {};
    const week = getCurrentWeek(weekOffset);
    const values = week.days.map(d => data[d] || 0);

    currentExportData = {
      type: "weekly",
      rows: week.days.map((date, i) => ({ date, count: values[i] }))
    };

    drawGraph(week.labels, values);
  });
}

// calculate the current month's date range based on the offset,
// return arrays of day labels and dates for graphing, with options to show day numbers at certain intervals
function getCurrentMonth(offset = 0) {
  const base = new Date();
  base.setMonth(base.getMonth() - offset, 1);
  base.setHours(0, 0, 0, 0);

  const year = base.getFullYear();
  const month = base.getMonth();

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);

  const days = [];
  const labels = [];
  const numDays = last.getDate();

  // loop through the month and create labels for each day
  // showing the day number at certain intervals to avoid clutter
  for (let i = 1; i <= numDays; i++) {
    const d = new Date(year, month, i);
    days.push(d.toISOString().split("T")[0]);
    const show = (i === 1 || i === numDays || i % 5 === 0);
    labels.push({ day: show ? String(i) : "", date: "" });
  }

  // update the period label to show the current month and year
  document.getElementById("periodLabel").textContent =
    `${String(month + 1).padStart(2,"0")}/${year}`;
  document.getElementById("navPeriodLabel").textContent =
    `${formatDMY(first)} – ${formatDMY(last)}`;

  return { days, labels };
}

// load monthly data from storage, prepare it for graphing and export, then draw the graph
function loadMonthly() {
  currentView = "Monthly";
  setActiveButton("Monthly");
  toggleDailyAverage(true);
  document.querySelector(".week-nav").style.display = "flex";

  // get daily counts from storage
  // extract the relevant days for the current month
  // and prepare data for graphing and export
  chrome.storage.local.get(["dailyCounts"], res => {
    const data = res.dailyCounts || {};
    const month = getCurrentMonth(monthOffset);
    const values = month.days.map(d => data[d] || 0);

    currentExportData = {
      type: "monthly",
      rows: month.days.map((date, i) => ({ date, count: values[i] }))
    };

    drawGraph(month.labels, values);
  });
}

// load session data from storage, prepare it for the word cloud and export, then render the cloud
function loadSession() {
  currentView = "Session";
  setActiveButton("Session");
  toggleDailyAverage(false);
  document.querySelector(".week-nav").style.display = "none";

  chrome.storage.local.get(["activeSession"], res => {
    const session = res.activeSession || { totalHits: 0, words: {} };

    const todayFormatted = formatDMY(new Date());
    document.getElementById("periodLabel").textContent = todayFormatted;
    document.getElementById("navPeriodLabel").textContent = todayFormatted;

    currentExportData = {
      type: "session",
      rows: Object.entries(session.words).map(([word, count]) => ({ word, count }))
    };

    renderWordCloud(session.words);
  });
}

// export the current view as a clinical-style PDF using only the Canvas API (no external libs)
function exportPDF() {
  if (!currentExportData || !currentExportData.rows.length) {
    alert("No data to export.");
    return;
  }

  if (currentExportData.type === "session") {
    alert("PDF export is not available for the session view.");
    return;
  }

  // True A4 at 3x for sharpness (595x842 logical = A4 points, rendered at 3x)
  const SCALE = 3;
  const W = 595, H = 842;
  const ml = 40, mr = 40, contentW = W - ml - mr;

  const c = document.createElement("canvas");
  c.width = W * SCALE; c.height = H * SCALE;
  const cx = c.getContext("2d");
  cx.scale(SCALE, SCALE);

  const RED   = "#DC3535";
  const DARK  = "#1C1C1E";
  const MID   = "#6B6B72";
  const LIGHT = "#F8F8FA";
  const SEP   = "#E0E0E5";
  const WHITE = "#FFFFFF";

  // background
  cx.fillStyle = WHITE;
  cx.fillRect(0, 0, W, H);

  // header band
  cx.fillStyle = RED;
  cx.fillRect(0, 0, W, 52);
  cx.fillStyle = WHITE;
  cx.font = "bold 15px Arial, sans-serif";
  cx.fillText("SENTINEL", ml, 23);
  cx.font = "10px Arial, sans-serif";
  cx.fillStyle = "rgba(255,255,255,0.75)";
  cx.fillText("Trigger Monitoring System — Clinical Report", ml, 39);
  cx.font = "bold 9px Arial, sans-serif";
  cx.fillStyle = WHITE;
  cx.textAlign = "right";
  cx.fillText(currentExportData.type.toUpperCase(), W - mr, 23);
  cx.textAlign = "left";

  // meta row
  let y = 66;
  cx.fillStyle = LIGHT;
  roundRect(cx, ml, y, contentW, 34, 5); cx.fill();

  const now = new Date();
  const generatedAt = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  const periodText = document.getElementById("periodLabel").textContent || "—";

  cx.fillStyle = MID;
  cx.font = "bold 7px Arial, sans-serif";
  cx.fillText("PERIOD", ml + 12, y + 11);
  cx.fillText("GENERATED", ml + contentW / 2 + 12, y + 11);
  cx.fillStyle = DARK;
  cx.font = "bold 10px Arial, sans-serif";
  cx.fillText(periodText,  ml + 12, y + 26);
  cx.fillText(generatedAt, ml + contentW / 2 + 12, y + 26);
  cx.strokeStyle = SEP; cx.lineWidth = 1;
  cx.beginPath();
  cx.moveTo(ml + contentW / 2, y + 5);
  cx.lineTo(ml + contentW / 2, y + 29);
  cx.stroke();

  y += 44;

  // stat boxes
  const rows = currentExportData.rows;
  const totalHits = rows.reduce((s, r) => s + (r.count || 0), 0);
  const isSession = currentExportData.type === "session";
  const activeDays = isSession ? null : rows.filter(r => r.count > 0).length;
  const avgPerDay  = (!isSession && activeDays > 0) ? (totalHits / activeDays).toFixed(1) : null;

  const stats = [
    { label: "TOTAL TRIGGERS", value: String(totalHits) },
    avgPerDay !== null ? { label: "DAILY AVG", value: avgPerDay } : { label: "UNIQUE TERMS", value: String(rows.length) },
    !isSession ? { label: "ACTIVE DAYS", value: String(activeDays) } : { label: "REPORT TYPE", value: "SESSION" }
  ];

  const bw = (contentW - 10) / 3;
  stats.forEach((s, i) => {
    const bx = ml + i * (bw + 5);
    cx.fillStyle = (i === 0 && totalHits >= 5) ? "#FFEBEB" : (i === 0 && totalHits >= 3) ? "#FFF3EB" : LIGHT;
    roundRect(cx, bx, y, bw, 40, 5); cx.fill();
    cx.fillStyle = MID;
    cx.font = "bold 7px Arial, sans-serif";
    cx.textAlign = "center";
    cx.fillText(s.label, bx + bw / 2, y + 12);
    cx.fillStyle = (i === 0 && totalHits > 0) ? RED : DARK;
    cx.font = "bold 20px Arial, sans-serif";
    cx.fillText(s.value, bx + bw / 2, y + 34);
    cx.textAlign = "left";
  });

  y += 50;

  // divider + section label
  cx.strokeStyle = SEP; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(ml, y); cx.lineTo(W - mr, y); cx.stroke();
  y += 12;
  cx.fillStyle = MID;
  cx.font = "bold 7px Arial, sans-serif";
  cx.fillText(isSession ? "TRIGGER TERM BREAKDOWN" : "DAILY TRIGGER LOG", ml, y);
  y += 8;

  // table — columns sized to exactly fill contentW
  const ROW_H = 20;
  const C1 = isSession ? 200 : 140;   // col1 width
  const C2 = isSession ? 120 : 130;   // col2 width
  const C3 = contentW - C1 - C2;      // col3 fills remainder — no overflow
  const colLabels = isSession
    ? ["Trigger Term", "Occurrences", "Share %"]
    : ["Date", "Trigger Count", "Severity"];

  // table header
  cx.fillStyle = DARK;
  cx.fillRect(ml, y, contentW, ROW_H);
  cx.fillStyle = WHITE;
  cx.font = "bold 9px Arial, sans-serif";
  cx.textAlign = "left";
  cx.fillText(colLabels[0], ml + 8, y + 14);
  cx.textAlign = "center";
  cx.fillText(colLabels[1], ml + C1 + C2 / 2, y + 14);
  cx.fillText(colLabels[2], ml + C1 + C2 + C3 / 2, y + 14);
  cx.textAlign = "left";
  y += ROW_H;

  // monthly: only show days with triggers
  const tableRows = (currentExportData.type === "monthly")
    ? rows.filter(r => r.count > 0)
    : rows;

  if (tableRows.length === 0) {
    cx.fillStyle = MID;
    cx.font = "11px Arial, sans-serif";
    cx.textAlign = "center";
    cx.fillText("No triggers recorded this period.", W / 2, y + 30);
    cx.textAlign = "left";
    y += 50;
  }

  tableRows.forEach((row, idx) => {
    cx.fillStyle = idx % 2 === 0 ? WHITE : "#FAFAFA";
    cx.fillRect(ml, y, contentW, ROW_H);

    let col1, col2, col3, col3Color;
    if (isSession) {
      const share = totalHits > 0 ? ((row.count / totalHits) * 100).toFixed(1) : "0.0";
      col1 = row.word; col2 = String(row.count); col3 = `${share}%`;
      col3Color = MID;
    } else {
      const cnt = row.count;
      col1 = row.date; col2 = String(cnt);
      col3 = cnt >= 5 ? "Severe" : cnt >= 3 ? "High" : cnt >= 1 ? "Low" : "—";
      col3Color = cnt >= 5 ? RED : cnt >= 3 ? "#C85010" : cnt >= 1 ? "#287828" : MID;
    }

    cx.font = "10px Arial, sans-serif";
    cx.fillStyle = DARK; cx.textAlign = "left";
    cx.fillText(col1, ml + 8, y + 14);
    cx.textAlign = "center";
    cx.fillText(col2, ml + C1 + C2 / 2, y + 14);
    cx.fillStyle = col3Color;
    cx.fillText(col3, ml + C1 + C2 + C3 / 2, y + 14);
    cx.textAlign = "left";

    cx.strokeStyle = SEP; cx.lineWidth = 0.5;
    cx.beginPath(); cx.moveTo(ml, y + ROW_H); cx.lineTo(W - mr, y + ROW_H); cx.stroke();
    y += ROW_H;
  });

  y += 16;

  // severity legend (non-session)
  if (!isSession) {
    cx.strokeStyle = SEP; cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(ml, y); cx.lineTo(W - mr, y); cx.stroke();
    y += 12;
    cx.fillStyle = MID;
    cx.font = "bold 7px Arial, sans-serif";
    cx.fillText("SEVERITY SCALE", ml, y);
    y += 8;
    [
      { label: "Low (1–2/day)",   color: "#287828" },
      { label: "High (3–4/day)",  color: "#C85010" },
      { label: "Severe (≥5/day)", color: RED       },
    ].forEach((l, i) => {
      const lx = ml + i * 155;
      cx.fillStyle = l.color;
      roundRect(cx, lx, y, 8, 8, 2); cx.fill();
      cx.fillStyle = DARK;
      cx.font = "9px Arial, sans-serif";
      cx.fillText(l.label, lx + 12, y + 8);
    });
  }

  // footer — pinned to bottom of page
  cx.strokeStyle = SEP; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(ml, H - 24); cx.lineTo(W - mr, H - 24); cx.stroke();
  cx.fillStyle = MID;
  cx.font = "8px Arial, sans-serif";
  cx.textAlign = "center";
  cx.fillText(`Sentinel TMS  ·  Generated ${generatedAt}  ·  Page 1 of 1`, W / 2, H - 10);
  cx.textAlign = "left";

  // export
  const imgData = c.toDataURL("image/jpeg", 0.95);
  const pdf = buildPDFFromImage(imgData, W * SCALE, H * SCALE);
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sentinel_report_${currentExportData.type}_${Date.now()}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// helper: rounded rect path
function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.lineTo(x + w - r, y);
  cx.quadraticCurveTo(x + w, y, x + w, y + r);
  cx.lineTo(x + w, y + h - r);
  cx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  cx.lineTo(x + r, y + h);
  cx.quadraticCurveTo(x, y + h, x, y + h - r);
  cx.lineTo(x, y + r);
  cx.quadraticCurveTo(x, y, x + r, y);
  cx.closePath();
}

// helper: build a minimal valid PDF with one JPEG image page, no external libs
function buildPDFFromImage(dataURL, pxW, pxH) {
  // strip data:image/jpeg;base64,
  const b64 = dataURL.split(",")[1];
  const imgBytes = atob(b64);

  // A4 in PDF points (72dpi): 595 x 842 — we embed at full page
  const pw = 595, ph = 842;

  const imgLen = imgBytes.length;

  // objects
  const objs = {};

  objs[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objs[2] = `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`;
  objs[3] = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`;

  const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`;
  objs[4] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;

  objs[5] = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgLen} >>\nstream\n`;

  // build byte array
  const header = "%PDF-1.4\n";
  const parts = [header];
  const offsets = {};

  let offset = header.length;

  [1, 2, 3, 4].forEach(n => {
    offsets[n] = offset;
    parts.push(objs[n]);
    offset += objs[n].length;
  });

  // obj 5 header
  offsets[5] = offset;
  parts.push(objs[5]);
  offset += objs[5].length;

  // image binary
  parts.push(imgBytes);
  offset += imgLen;

  const endStream = "\nendstream\nendobj\n";
  parts.push(endStream);
  offset += endStream.length;

  // xref
  const xrefOffset = offset;
  const xref = [
    "xref\n",
    `0 6\n`,
    `0000000000 65535 f \n`,
    ...([1,2,3,4,5].map(n => `${String(offsets[n]).padStart(10,"0")} 00000 n \n`))
  ].join("");
  parts.push(xref);

  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(trailer);

  // combine into Uint8Array
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(totalLen);
  let pos = 0;
  parts.forEach(p => {
    for (let i = 0; i < p.length; i++) buf[pos++] = p.charCodeAt(i) & 0xff;
  });
  return buf;
}

document.getElementById("pdf").addEventListener("click", exportPDF);

// set up navigation buttons to load the corresponding views 
// and reset offsets when switching between weekly and monthly
document.getElementById("weekly").onclick = () => { weekOffset = 0; loadWeekly(); };
document.getElementById("monthly").onclick = () => { monthOffset = 0; loadMonthly(); };
document.getElementById("session").onclick = () => { loadSession(); };

document.getElementById("prevWeek").onclick = () => {
  if (currentView === "Weekly") { weekOffset++; loadWeekly(); }
  else if (currentView === "Monthly") { monthOffset++; loadMonthly(); }
};

document.getElementById("nextWeek").onclick = () => {
  if (currentView === "Weekly" && weekOffset > 0) { weekOffset--; loadWeekly(); }
  else if (currentView === "Monthly" && monthOffset > 0) { monthOffset--; loadMonthly(); }
};

// on load, apply the saved theme and load the default weekly view
chrome.storage.local.get(["theme"], res => {
  applyTheme(res.theme === "dark" ? "dark" : "light");
});

loadWeekly();