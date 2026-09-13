(function initialiseMyAiMirrorPdf() {
  "use strict";

  if (globalThis.MyAiMirrorPdf) return;

  const PAGE_WIDTH = 595.28;
  const PAGE_HEIGHT = 841.89;
  const MARGIN = 44;
  const COLORS = {
    ink: "#1d1d1f",
    muted: "#6e6e73",
    border: "#d2d2d7",
    surface: "#f5f5f7",
    blue: "#0071e3",
    blueSoft: "#e8f2ff",
    orange: "#f8b98f",
    green: "#9ed9aa",
    critical: "#86c8f2",
    yellow: "#ffd45d",
    neutral: "#c8c8ce"
  };

  function cleanText(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[–—]/g, "-")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function plainText(value) {
    return cleanText(value).replace(/\\([()\\])/g, "$1");
  }

  function decimal(value) {
    return Number(value || 0).toFixed(2).replace(/\.00$/, "");
  }

  function rgb(hex) {
    const value = String(hex || "#000000").replace("#", "");
    return [0, 2, 4]
      .map(index => parseInt(value.slice(index, index + 2), 16) / 255)
      .map(component => component.toFixed(3))
      .join(" ");
  }

  function wrapText(value, width, size) {
    const words = plainText(value).split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    const fits = text => text.length * size * .52 <= width;
    words.forEach(word => {
      const next = current ? `${current} ${word}` : word;
      if (current && !fits(next)) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  class PdfPage {
    constructor() {
      this.commands = [];
    }

    text(value, x, top, size = 10, options = {}) {
      const font = options.bold ? "F2" : "F1";
      const color = rgb(options.color || COLORS.ink);
      const align = options.align || "left";
      const estimatedWidth = plainText(value).length * size * .52;
      const drawX = align === "center"
        ? x - estimatedWidth / 2
        : align === "right" ? x - estimatedWidth : x;
      this.commands.push(
        `BT /${font} ${decimal(size)} Tf ${color} rg 1 0 0 1 ${decimal(drawX)} ${decimal(PAGE_HEIGHT - top)} Tm (${cleanText(value)}) Tj ET`
      );
    }

    wrappedText(value, x, top, width, size = 10, options = {}) {
      const lineHeight = options.lineHeight || size * 1.35;
      const lines = wrapText(value, width, size);
      lines.forEach((line, index) => {
        this.text(line, x, top + index * lineHeight, size, options);
      });
      return top + lines.length * lineHeight;
    }

    rect(x, top, width, height, options = {}) {
      const fill = options.fill ? `${rgb(options.fill)} rg` : "";
      const stroke = options.stroke ? `${rgb(options.stroke)} RG` : "";
      const operator = options.fill && options.stroke ? "B" : options.fill ? "f" : "S";
      this.commands.push(
        `${fill} ${stroke} ${decimal(options.lineWidth || 1)} w ${decimal(x)} ${decimal(PAGE_HEIGHT - top - height)} ${decimal(width)} ${decimal(height)} re ${operator}`
      );
    }

    roundedRect(x, top, width, height, radius = 12, options = {}) {
      const fill = options.fill ? `${rgb(options.fill)} rg` : "";
      const stroke = options.stroke ? `${rgb(options.stroke)} RG` : "";
      const operator = options.fill && options.stroke ? "B" : options.fill ? "f" : "S";
      const right = x + width;
      const yTop = PAGE_HEIGHT - top;
      const yBottom = yTop - height;
      const r = Math.min(radius, width / 2, height / 2);
      const c = r * .55228475;
      const path = [
        `${decimal(x + r)} ${decimal(yTop)} m`,
        `${decimal(right - r)} ${decimal(yTop)} l`,
        `${decimal(right - r + c)} ${decimal(yTop)} ${decimal(right)} ${decimal(yTop - r + c)} ${decimal(right)} ${decimal(yTop - r)} c`,
        `${decimal(right)} ${decimal(yBottom + r)} l`,
        `${decimal(right)} ${decimal(yBottom + r - c)} ${decimal(right - r + c)} ${decimal(yBottom)} ${decimal(right - r)} ${decimal(yBottom)} c`,
        `${decimal(x + r)} ${decimal(yBottom)} l`,
        `${decimal(x + r - c)} ${decimal(yBottom)} ${decimal(x)} ${decimal(yBottom + r - c)} ${decimal(x)} ${decimal(yBottom + r)} c`,
        `${decimal(x)} ${decimal(yTop - r)} l`,
        `${decimal(x)} ${decimal(yTop - r + c)} ${decimal(x + r - c)} ${decimal(yTop)} ${decimal(x + r)} ${decimal(yTop)} c h`
      ].join(" ");
      this.commands.push(`${fill} ${stroke} ${decimal(options.lineWidth || 1)} w ${path} ${operator}`);
    }

    line(x1, top1, x2, top2, color = COLORS.border, width = 1) {
      this.commands.push(
        `${rgb(color)} RG ${decimal(width)} w ${decimal(x1)} ${decimal(PAGE_HEIGHT - top1)} m ${decimal(x2)} ${decimal(PAGE_HEIGHT - top2)} l S`
      );
    }

    polyline(points, color = COLORS.blue, width = 2.5) {
      if (!points.length) return;
      const [first, ...rest] = points;
      const path = [
        `${decimal(first[0])} ${decimal(PAGE_HEIGHT - first[1])} m`,
        ...rest.map(point => `${decimal(point[0])} ${decimal(PAGE_HEIGHT - point[1])} l`)
      ].join(" ");
      this.commands.push(`${rgb(color)} RG ${decimal(width)} w 1 J 1 j ${path} S`);
    }

    dot(x, top, radius = 3.5, color = COLORS.blue) {
      this.rect(x - radius, top - radius, radius * 2, radius * 2, { fill: color });
    }

    content() {
      return this.commands.join("\n");
    }
  }

  function sectionTitle(page, title, note, top) {
    page.text(title, MARGIN, top, 16, { bold: true });
    if (note) page.text(note, PAGE_WIDTH - MARGIN, top, 9, { color: COLORS.muted, align: "right" });
  }

  function drawHeader(page, subtitle) {
    page.text("MY AI MIRROR", MARGIN, 48, 9, { bold: true, color: COLORS.muted });
    page.text("Overall usage report", MARGIN, 76, 25, { bold: true });
    page.text(subtitle, MARGIN, 98, 10, { color: COLORS.muted });
    page.line(MARGIN, 116, PAGE_WIDTH - MARGIN, 116);
  }

  function drawFooter(page, pageNumber, pageCount, generatedAt) {
    page.line(MARGIN, 796, PAGE_WIDTH - MARGIN, 796);
    page.text(`Generated locally on ${generatedAt}`, MARGIN, 815, 8.5, { color: COLORS.muted });
    page.text(`Page ${pageNumber} of ${pageCount}`, PAGE_WIDTH - MARGIN, 815, 8.5, {
      color: COLORS.muted,
      align: "right"
    });
  }

  function drawSummaryCards(page, data) {
    const cards = [
      [data.prompts, "prompts tracked"],
      [data.chats, data.chats === 1 ? "chat" : "chats"],
      [Number(data.weeklyAverage || 0).toFixed(1), `prompts/week - ${data.weekCount || 1}-week avg`],
      [Number(data.promptsPerChat || 0).toFixed(1), "prompts per chat"]
    ];
    const gap = 10;
    const width = (PAGE_WIDTH - MARGIN * 2 - gap * 3) / 4;
    cards.forEach(([value, label], index) => {
      const x = MARGIN + index * (width + gap);
      page.rect(x, 138, width, 67, { fill: COLORS.surface, stroke: COLORS.border });
      page.text(value, x + 12, 165, 21, { bold: true });
      page.wrappedText(label, x + 12, 187, width - 24, 8.5, { color: COLORS.muted, lineHeight: 10 });
    });
  }

  function drawWeeklyGraph(page, data) {
    sectionTitle(page, "Prompts per week", `Last ${data.weekCount || 1} calendar ${data.weekCount === 1 ? "week" : "weeks"}`, 244);
    const chart = { left: 66, right: 542, top: 278, bottom: 448 };
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    const maximum = Math.max(1, ...weeks.map(week => Number(week.prompts || 0)));
    const axisMaximum = Math.max(4, Math.ceil(maximum / 4) * 4);
    const xFor = index => weeks.length === 1
      ? (chart.left + chart.right) / 2
      : chart.left + (index / (weeks.length - 1)) * (chart.right - chart.left);
    const yFor = value => chart.bottom - (Number(value || 0) / axisMaximum) * (chart.bottom - chart.top);

    for (let step = 0; step <= 4; step += 1) {
      const value = Math.round((axisMaximum / 4) * step);
      const y = yFor(value);
      page.line(chart.left, y, chart.right, y, COLORS.border, .7);
      page.text(value, chart.left - 10, y + 3, 8, { color: COLORS.muted, align: "right" });
    }

    const points = weeks.map((week, index) => [xFor(index), yFor(week.prompts)]);
    page.polyline(points, COLORS.blue, 2.6);
    weeks.forEach((week, index) => {
      const [x, y] = points[index];
      page.dot(x, y, 3.4, COLORS.blue);
      page.text(week.prompts, x, Math.max(chart.top - 1, y - 10), 8, { bold: true, align: "center" });
      page.text(week.label, x, chart.bottom + 20, 7.5, { color: COLORS.muted, align: "center" });
    });
    page.text(
      `${Number(data.weeklyAverage || 0).toFixed(1)} prompts per week on average`,
      MARGIN,
      488,
      10,
      { bold: true, color: COLORS.blue }
    );
  }

  function drawInteractionOverview(page, data) {
    sectionTitle(page, "Interaction overview", `${data.intentionsAnalysed || 0} prompts classified`, 540);
    const rows = Array.isArray(data.intentionRows) ? data.intentionRows : [];
    rows.forEach((item, index) => {
      const top = 570 + index * 39;
      page.text(item.label, MARGIN, top, 9.5);
      page.rect(190, top - 10, 280, 10, { fill: COLORS.surface });
      page.rect(190, top - 10, 280 * (Number(item.rate || 0) / 100), 10, { fill: item.color || COLORS.blue });
      page.text(`${item.rate || 0}%`, PAGE_WIDTH - MARGIN, top, 9.5, { bold: true, align: "right" });
    });
  }

  function drawEngagement(page, data) {
    sectionTitle(page, "Engagement patterns", "Derived from intention combinations", 142);
    const values = [
      [data.activeRate, "Reasoning or critical engagement"],
      [data.combinedRate, "Combined intentions"],
      [data.delegationOnlyRate, "Delegation without active engagement"]
    ];
    const gap = 10;
    const width = (PAGE_WIDTH - MARGIN * 2 - gap * 2) / 3;
    values.forEach(([value, label], index) => {
      const x = MARGIN + index * (width + gap);
      page.rect(x, 165, width, 82, { fill: COLORS.surface, stroke: COLORS.border });
      page.text(`${value || 0}%`, x + 12, 194, 20, { bold: true });
      page.wrappedText(label, x + 12, 216, width - 24, 8.5, { color: COLORS.muted, lineHeight: 11 });
    });
  }

  function drawTone(page, data) {
    sectionTitle(page, "Prompt tone", `${data.toneTotal || 0} prompts analysed`, 291);
    const x = MARGIN;
    const top = 320;
    const width = PAGE_WIDTH - MARGIN * 2;
    let cursor = x;
    (data.toneRows || []).forEach(item => {
      const segment = width * (Number(item.rate || 0) / 100);
      page.rect(cursor, top, segment, 22, { fill: item.color || COLORS.neutral });
      cursor += segment;
    });
    (data.toneRows || []).forEach((item, index) => {
      const itemX = MARGIN + index * 170;
      page.rect(itemX, 363, 9, 9, { fill: item.color || COLORS.neutral });
      page.text(`${item.label}: ${item.rate || 0}%`, itemX + 15, 372, 9.5);
    });
  }

  function drawWritingProcess(page, data) {
    sectionTitle(page, "Writing process", "Measured before prompts are sent", 428);
    const values = [
      [`${data.pasteRate || 0}%`, "with pasted content", `${data.pasteEvents || 0} paste events`],
      [`${data.editRate || 0}%`, "edited before sending", `${data.editActions || 0} edit actions`],
      [data.revisionEpisodes || 0, "revision episodes", "across tracked prompts"]
    ];
    const gap = 10;
    const width = (PAGE_WIDTH - MARGIN * 2 - gap * 2) / 3;
    values.forEach(([value, label, note], index) => {
      const x = MARGIN + index * (width + gap);
      page.rect(x, 452, width, 91, { fill: COLORS.surface, stroke: COLORS.border });
      page.text(value, x + 12, 482, 20, { bold: true });
      page.wrappedText(label, x + 12, 505, width - 24, 9, { lineHeight: 11 });
      page.text(note, x + 12, 529, 7.5, { color: COLORS.muted });
    });
  }

  function drawToneContextNote(page) {
    page.rect(MARGIN, 594, PAGE_WIDTH - MARGIN * 2, 82, { fill: COLORS.blueSoft });
    page.text("How to read this report", MARGIN + 14, 620, 11, { bold: true, color: COLORS.blue });
    page.wrappedText(
      "These measures describe patterns in AI use; they are not scores or diagnoses. Intention and tone are model estimates, while writing-process measures are direct interaction counts.",
      MARGIN + 14,
      641,
      PAGE_WIDTH - MARGIN * 2 - 28,
      9,
      { color: COLORS.ink, lineHeight: 13 }
    );
  }

  function drawThemeCloud(page, data) {
    sectionTitle(page, "Common themes", "Recurring locally extracted topics", 142);
    const themes = Array.isArray(data.themes) ? data.themes : [];
    if (!themes.length) {
      page.text("No theme data is available yet.", MARGIN, 178, 10, { color: COLORS.muted });
      return 214;
    }
    const counts = themes.map(item => Number(item.count || 0));
    const minimum = Math.min(...counts);
    const maximum = Math.max(...counts);
    let x = MARGIN;
    let top = 184;
    themes.forEach((item, index) => {
      const scale = maximum === minimum ? .55 : (item.count - minimum) / (maximum - minimum);
      const size = 9 + scale * 9;
      const term = plainText(item.term).slice(0, 32);
      const label = `${term} (${item.count})`;
      const width = Math.min(PAGE_WIDTH - MARGIN * 2, label.length * size * .52 + 16);
      if (x + width > PAGE_WIDTH - MARGIN) {
        x = MARGIN;
        top += 34;
      }
      const colors = [COLORS.orange, COLORS.green, COLORS.critical, COLORS.yellow];
      page.rect(x, top - 18, width, 25, { fill: colors[index % colors.length] });
      page.text(label, x + 8, top, size, { bold: scale > .45 });
      x += width + 8;
    });
    return top + 38;
  }

  function drawReflections(page, data, startTop) {
    const top = Math.max(startTop, 410);
    sectionTitle(page, "Response reflections", `${data.reflections || 0} recorded`, top);
    const rows = Array.isArray(data.reflectionRows) ? data.reflectionRows : [];
    if (!rows.length) {
      page.text("No response reflections have been recorded yet.", MARGIN, top + 32, 10, { color: COLORS.muted });
      return;
    }
    rows.forEach((item, index) => {
      const rowTop = top + 31 + index * 34;
      page.rect(MARGIN, rowTop - 18, PAGE_WIDTH - MARGIN * 2, 26, { fill: COLORS.surface });
      page.text(item.label, MARGIN + 10, rowTop, 9.5);
      page.text(`${item.rate || 0}%`, PAGE_WIDTH - MARGIN - 10, rowTop, 9.5, { bold: true, align: "right" });
    });
  }

  function technicalHeader(page, sectionNumber, sectionTitleText, subtitle) {
    page.text("SENTINEL", MARGIN, 37, 7.5, { bold: true, color: COLORS.blue });
    page.text(sectionTitleText, MARGIN, 69, 24, { bold: true });
    if (subtitle) page.text(subtitle, MARGIN, 94, 9.5, { color: COLORS.muted });
    page.line(MARGIN, 111, PAGE_WIDTH - MARGIN, 111, COLORS.border, .8);
  }

  function technicalSection(page, title, note, top) {
    page.text(title, MARGIN, top, 14, { bold: true });
    if (note) {
      page.text(note, PAGE_WIDTH - MARGIN, top, 8.5, {
        color: COLORS.muted,
        align: "right"
      });
    }
  }

  function drawTable(page, top, columns, rows, options = {}) {
    const headerHeight = options.headerHeight || 22;
    const rowHeight = options.rowHeight || 23;
    const left = options.left || MARGIN;
    const width = columns.reduce((sum, column) => sum + column.width, 0);
    page.rect(left, top, width, headerHeight, { fill: COLORS.surface, stroke: COLORS.border, lineWidth: .55 });
    let x = left;
    columns.forEach(column => {
      page.text(column.label, x + (column.align === "right" ? column.width - 8 : 8), top + 15, 8.2, {
        bold: true,
        color: COLORS.ink,
        align: column.align || "left"
      });
      x += column.width;
    });

    rows.forEach((row, rowIndex) => {
      const rowTop = top + headerHeight + rowIndex * rowHeight;
      page.rect(left, rowTop, width, rowHeight, {
        fill: "#ffffff",
        stroke: COLORS.border,
        lineWidth: .55
      });
      let cellX = left;
      columns.forEach((column, columnIndex) => {
        const value = row[columnIndex] ?? "";
        const textX = cellX + (column.align === "right" ? column.width - 8 : 8);
        page.text(value, textX, rowTop + 15, options.fontSize || 8.6, {
          bold: Boolean(column.bold),
          color: column.color || COLORS.ink,
          align: column.align || "left"
        });
        cellX += column.width;
      });
    });
    return top + headerHeight + rows.length * rowHeight;
  }

  function metricCard(page, x, top, width, value, label) {
    page.roundedRect(x, top, width, 68, 12, { fill: COLORS.surface });
    page.text(value, x + 16, top + 31, 22, { bold: true });
    page.text(label, x + 16, top + 52, 8.5, { color: COLORS.muted });
  }

  function technicalWeeklyGraph(page, data, top) {
    const series = (Array.isArray(data.weeks) ? data.weeks : []).slice(-4);
    const seriesColors = ["#9b7bd3", "#df8a57", "#56a96d", COLORS.blue]
      .slice(4 - series.length);
    const chart = {
      left: MARGIN + 28,
      right: PAGE_WIDTH - MARGIN,
      top: top + 38,
      bottom: top + 166
    };
    const observedValues = series.flatMap(week =>
      (week.days || []).filter(day => day.observed !== false).map(day => Number(day.prompts || 0))
    );
    const maximum = Math.max(1, ...observedValues);
    const axisMaximum = Math.max(4, Math.ceil(maximum / 4) * 4);
    const xFor = index => chart.left + (index / 6) * (chart.right - chart.left);
    const yFor = value => chart.bottom - (Number(value || 0) / axisMaximum) * (chart.bottom - chart.top);

    for (let step = 0; step <= 4; step += 1) {
      const value = Math.round((axisMaximum / 4) * step);
      const y = yFor(value);
      page.line(chart.left, y, chart.right, y, COLORS.border, .65);
      page.text(value, chart.left - 8, y + 3, 7.5, { color: COLORS.muted, align: "right" });
    }
    const weekdayLabels = series[0]?.days?.map(day => day.label) ||
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    weekdayLabels.forEach((label, index) => {
      page.text(label, xFor(index), chart.bottom + 17, 7.2, { color: COLORS.muted, align: "center" });
    });

    series.forEach((week, seriesIndex) => {
      const color = seriesColors[seriesIndex];
      const observedDays = (week.days || []).filter(day => day.observed !== false);
      const points = observedDays.map((day, index) => [xFor(index), yFor(day.prompts)]);
      page.polyline(points, color, seriesIndex === series.length - 1 ? 2.3 : 1.45);
      points.forEach((point, index) => {
        page.dot(point[0], point[1], seriesIndex === series.length - 1 ? 2.8 : 2.1, color);
        if (seriesIndex === series.length - 1) {
          page.text(observedDays[index].prompts, point[0], Math.max(chart.top - 1, point[1] - 8), 7.3, {
            bold: true,
            align: "center"
          });
        }
      });

      const legendX = chart.left + seriesIndex * ((chart.right - chart.left) / Math.max(1, series.length));
      page.line(legendX, top + 16, legendX + 14, top + 16, color, 2.4);
      page.text(week.fullLabel || week.label, legendX + 19, top + 19, 6.9, { color: COLORS.muted });
    });
    return chart.bottom + 28;
  }

  function reportPeriod(data) {
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    if (!weeks.length) return "No weekly observations available";
    return `${weeks[0].fullLabel || weeks[0].label} through ${weeks[weeks.length - 1].fullLabel || weeks[weeks.length - 1].label}`;
  }

  function buildTechnicalPages(data, generatedAt) {
    const subtitle = `${data.chats || 0} chats; ${data.prompts || 0} prompts`;
    const pages = [new PdfPage(), new PdfPage()];

    technicalHeader(pages[0], "01", "Usage report", "A concise view of your ChatGPT activity");
    const cardGap = 11;
    const cardWidth = (PAGE_WIDTH - MARGIN * 2 - cardGap * 2) / 3;
    metricCard(pages[0], MARGIN, 130, cardWidth, data.prompts || 0, "Number of prompts");
    metricCard(pages[0], MARGIN + cardWidth + cardGap, 130, cardWidth, data.chats || 0, "Number of chats");
    metricCard(pages[0], MARGIN + (cardWidth + cardGap) * 2, 130, cardWidth, data.activeDays || 0, "Active days");
    technicalSection(pages[0], "Daily prompt frequency", "", 231);
    const graphBottom = technicalWeeklyGraph(pages[0], data, 239);
    drawTable(pages[0], graphBottom + 6, [
      { label: "Calendar week", width: 325 },
      { label: "Prompts", width: 90, align: "right", bold: true },
      { label: "% of period", width: 92, align: "right" }
    ], (data.weeks || []).map(week => [
      week.fullLabel || week.label,
      week.prompts || 0,
      `${data.eightWeekPrompts ? Math.round((week.prompts / data.eightWeekPrompts) * 100) : 0}%`
    ]), { rowHeight: 20, fontSize: 8.2 });

    technicalHeader(pages[1], "02", "Usage patterns", "");
    const page = pages[1];
    page.text("Intention signals", MARGIN, 141, 14, { bold: true });
    page.text("Prompt tone", 306, 141, 14, { bold: true });
    drawTable(page, 156, [
      { label: "Category", width: 140 },
      { label: "Count", width: 50, align: "right" },
      { label: "Rate", width: 55, align: "right", bold: true }
    ], (data.intentionRows || []).map(row => [
      row.label,
      row.count || 0,
      `${row.rate || 0}%`
    ]), { left: MARGIN, rowHeight: 24, fontSize: 8.2 });
    drawTable(page, 156, [
      { label: "Tone", width: 140 },
      { label: "Count", width: 50, align: "right" },
      { label: "Rate", width: 55, align: "right", bold: true }
    ], (data.toneRows || []).map(row => [
      row.label,
      row.count || 0,
      `${row.rate || 0}%`
    ]), { left: 306, rowHeight: 24, fontSize: 8.2 });
    technicalSection(page, "Writing process", "", 331);
    drawTable(page, 346, [
      { label: "Measure", width: 315 },
      { label: "Prompt count", width: 100, align: "right" },
      { label: "Rate", width: 92, align: "right", bold: true }
    ], [
      ["Prompts containing pasted content", data.promptsWithPaste || 0, `${data.pasteRate || 0}%`],
      ["Prompts edited before sending", data.promptsWithEdits || 0, `${data.editRate || 0}%`]
    ]);
    return pages;
  }

  function buildPages(data) {
    const generatedAt = new Date().toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
    const pages = buildTechnicalPages(data, generatedAt);

    pages.forEach((page, index) => drawFooter(page, index + 1, pages.length, generatedAt));
    return pages;
  }

  function createReportPdfBytes(data) {
    const pages = buildPages(data);
    const objects = new Map();
    objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const pageRefs = pages.map((_, index) => `${5 + index * 2} 0 R`).join(" ");
    objects.set(2, `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
    objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    objects.set(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    pages.forEach((page, index) => {
      const pageNumber = 5 + index * 2;
      const contentNumber = pageNumber + 1;
      const content = page.content();
      objects.set(pageNumber,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${decimal(PAGE_WIDTH)} ${decimal(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`
      );
      objects.set(contentNumber, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });

    const objectCount = 4 + pages.length * 2;
    let pdf = "%PDF-1.4\n%MyAI\n";
    const offsets = [0];
    for (let index = 1; index <= objectCount; index += 1) {
      offsets[index] = pdf.length;
      pdf += `${index} 0 obj\n${objects.get(index)}\nendobj\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objectCount + 1}\n`;
    pdf += "0000000000 65535 f \n";
    for (let index = 1; index <= objectCount; index += 1) {
      pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return new TextEncoder().encode(pdf);
  }

  function downloadReport(data) {
    const bytes = createReportPdfBytes(data);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `my-ai-mirror-report-${date}.pdf`;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return link.download;
  }

  globalThis.MyAiMirrorPdf = { createReportPdfBytes, downloadReport };
})();
