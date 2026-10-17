const fmt = new Intl.NumberFormat("zh-CN");
const moneyFmt = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

const state = {
  data: null,
  user: null,
  activeView: "overview",
  dailyReportSegment: "",
  activeTab: "series",
  trendSourceSelections: [],
  selectedProvince: "",
  selectedCity: "",
  mapLevel: "country",           // 'country' | 'province'
  currentMapProvince: null,      // { adcode, name } of the drilled-down province
  quickFilters: {
    bookSeries: [],
    contentType: [],
    sourceType: [],
    sourceManager: [],
    sourceGroup: [],
    sourceDetail: [],
  },
  filters: {
    store: [],
    datePreset: "last7",
    dateStart: "",
    dateEnd: "",
    projectDepartment: [],
    bookSeries: [],
    contentType: [],
    sourceType: [],
    sourceDepartment: [],
    sourceManager: [],
    sourceGroup: [],
    sourceDetail: [],
    segment: [],
  },
};

function migrateFilterState() {
  for (const key of Object.keys(state.filters)) {
    if (state.filters[key] === "__all__" || state.filters[key] === undefined) {
      state.filters[key] = key === "datePreset" ? "last7" : key === "dateStart" || key === "dateEnd" ? "" : [];
    }
  }
  for (const key of Object.keys(state.quickFilters)) {
    if (state.quickFilters[key] === "__all__" || state.quickFilters[key] === undefined) {
      state.quickFilters[key] = [];
    }
  }
}
migrateFilterState();

const charts = {};
const chartColors = ["#1e3a8a", "#e34d3c", "#3b82f6", "#f59e0b", "#06b6d4", "#ec4899", "#60a5fa", "#b42318", "#7c3aed", "#64748b", "#f97316", "#0ea5e9"];
let viewportMode = "";
let resizeTimer = null;
let dashboardLoadToken = 0;
let tableLoadToken = 0;
let filteredDataReloadTimer = null;

const byId = (id) => document.getElementById(id);
const sum = (items, key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
const currentViewportMode = () => (window.innerWidth <= 720 ? "phone" : window.innerWidth <= 900 ? "tablet" : "desktop");
const isPhone = () => currentViewportMode() === "phone";

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, { key, sales_qty: 0, sales_amount: 0, order_count: 0, rows: [] });
    const bucket = map.get(key);
    bucket.sales_qty += item.sales_qty;
    bucket.sales_amount += Number(item.sales_amount) || 0;
    bucket.order_count += item.order_count;
    bucket.rows.push(item);
  }
  return [...map.values()];
}

function isSelectedTrendSourceName(name) {
  return state.trendSourceSelections.includes(name);
}

function getTop(items, keyFn, limit) {
  return groupBy(items, keyFn)
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .slice(0, limit)
    .map((item) => item.key);
}

// ---- MultiSelectDropdown ----

const multiSelects = {};

class MultiSelectDropdown {
  constructor(containerId, label, initialSelected, onChange, showSearch) {
    this._containerId = containerId;
    this._label = label;
    this._onChange = onChange;
    this._showSearch = showSearch !== false;
    this._options = [];
    this._selected = new Set(initialSelected || []);
    this._searchTerm = "";
    this._isOpen = false;

    const container = byId(containerId);
    if (!container) return;
    container.innerHTML = "";
    container.classList.add("multi-select");

    // Trigger button
    this._trigger = document.createElement("button");
    this._trigger.type = "button";
    this._trigger.className = "multi-select-trigger";
    this._trigger.setAttribute("tabindex", "0");
    this._trigger.innerHTML = `<span class="multi-select-placeholder">${escapeHtml(label)}</span><span class="multi-select-tags"></span><span class="multi-select-arrow"></span>`;
    container.appendChild(this._trigger);

    // Dropdown
    this._dropdown = document.createElement("div");
    this._dropdown.className = "multi-select-dropdown hidden";
    if (this._showSearch) {
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "multi-select-search";
      searchInput.placeholder = "筛选…";
      this._searchInput = searchInput;
      this._dropdown.appendChild(searchInput);
    }
    // "全选" checkbox
    const allLabel = document.createElement("label");
    allLabel.className = "multi-select-option multi-select-option-all";
    this._allCheckbox = document.createElement("input");
    this._allCheckbox.type = "checkbox";
    this._allCheckbox.value = "__all__";
    allLabel.appendChild(this._allCheckbox);
    allLabel.appendChild(document.createTextNode(" 全选 / 全部"));
    this._dropdown.appendChild(allLabel);
    // Option list
    this._optionList = document.createElement("div");
    this._optionList.className = "multi-select-option-list";
    this._dropdown.appendChild(this._optionList);
    container.appendChild(this._dropdown);

    this._bindEvents();
    this._render();
  }

  _bindEvents() {
    this._trigger.addEventListener("click", (e) => {
      e.preventDefault();
      this._toggle();
    });
    this._onDocClick = (e) => {
      const container = byId(this._containerId);
      if (container && !container.contains(e.target)) {
        this._close();
      }
    };
    document.addEventListener("click", this._onDocClick, true);

    if (this._searchInput) {
      this._searchInput.addEventListener("input", () => {
        this._searchTerm = this._searchInput.value;
        this._renderOptions();
      });
      this._searchInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") this._close();
      });
    }

    this._allCheckbox.addEventListener("change", () => {
      if (this._allCheckbox.checked) {
        this._selected.clear();
      } else {
        // Deselect all explicitly: select nothing → show all data (empty = no filter)
        this._selected.clear();
      }
      this._fireChange();
      this._render();
    });

    this._trigger.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this._close(); return; }
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._open();
      }
    });
  }

  _toggle() {
    this._isOpen ? this._close() : this._open();
  }

  _open() {
    this._isOpen = true;
    this._dropdown.classList.remove("hidden");
    const container = byId(this._containerId);
    if (container) container.classList.add("open");
    this._positionDropdown();
    if (this._searchInput) {
      this._searchInput.value = this._searchTerm;
      setTimeout(() => this._searchInput.focus(), 50);
    }
    this._renderOptions();
  }

  _positionDropdown() {
    this._dropdown.style.left = "0";
    this._dropdown.style.right = "auto";
    requestAnimationFrame(() => {
      const rect = this._dropdown.getBoundingClientRect();
      if (rect.right > window.innerWidth - 12) {
        this._dropdown.style.left = "auto";
        this._dropdown.style.right = "0";
      }
    });
  }

  _close() {
    this._isOpen = false;
    this._dropdown.classList.add("hidden");
    const container = byId(this._containerId);
    if (container) container.classList.remove("open");
    this._searchTerm = "";
    if (this._searchInput) this._searchInput.value = "";
    this._renderOptions();
  }

  _fireChange() {
    if (this._onChange) this._onChange([...this._selected]);
  }

  _render() {
    // Update trigger display
    const placeholder = this._trigger.querySelector(".multi-select-placeholder");
    const tags = this._trigger.querySelector(".multi-select-tags");
    if (this._selected.size === 0) {
      placeholder.style.display = "";
      tags.innerHTML = "";
      this._trigger.classList.remove("has-selection");
    } else {
      placeholder.style.display = "none";
      this._trigger.classList.add("has-selection");
      const selectedArr = [...this._selected];
      if (selectedArr.length > 2) {
        tags.innerHTML = `<span class="multi-select-summary">已选 ${fmt.format(selectedArr.length)} 项</span>`;
      } else {
        tags.innerHTML = selectedArr.map((v) => `<span class="multi-select-tag">${escapeHtml(v)}<span class="multi-select-tag-remove" data-value="${escapeHtml(v)}">×</span></span>`).join("");
      }
      // Tag remove clicks
      tags.querySelectorAll(".multi-select-tag-remove").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this._selected.delete(el.dataset.value);
          this._fireChange();
          this._render();
        });
      });
    }
    // Update all checkbox
    this._allCheckbox.checked = this._selected.size === 0;
    this._renderOptions();
  }

  _renderOptions() {
    const list = this._optionList;
    list.innerHTML = "";
    const term = this._searchTerm.toLowerCase();
    const filtered = term ? this._options.filter((v) => v.toLowerCase().includes(term)) : this._options;
    for (const value of filtered) {
      const label = document.createElement("label");
      label.className = "multi-select-option";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = value;
      cb.checked = this._selected.has(value);
      label.appendChild(cb);
      const span = document.createElement("span");
      span.innerHTML = term ? this._highlightMatch(value, term) : escapeHtml(value);
      label.appendChild(span);
      label.addEventListener("click", (e) => {
        e.preventDefault();
        const wasAll = this._selected.size === 0;
        if (wasAll) {
          // Was showing all — now select ONLY this value
          this._selected.clear();
          this._selected.add(value);
        } else if (this._selected.has(value)) {
          this._selected.delete(value);
        } else {
          this._selected.add(value);
        }
        this._fireChange();
        this._render();
      });
      list.appendChild(label);
    }
  }

  _highlightMatch(text, term) {
    const escaped = escapeHtml(text);
    const escapedTerm = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escapedTerm) return escaped;
    const regex = new RegExp(`(${escapedTerm})`, "gi");
    return escaped.replace(regex, "<mark>$1</mark>");
  }

  updateOptions(newValues) {
    this._options = [...newValues].sort((a, b) => a.localeCompare(b, "zh-CN"));
    // Remove selections no longer in options — sync to state directly,
    // do NOT call _fireChange() here to avoid re-entering renderAll().
    const optionSet = new Set(this._options);
    let changed = false;
    for (const v of this._selected) {
      if (!optionSet.has(v)) { this._selected.delete(v); changed = true; }
    }
    if (changed) {
      // Sync cleaned selection back to state without triggering full cascade
      const filterKey = this._containerId;
      state.filters[filterKey] = [...this._selected];
    }
    this._render();
  }

  setSelected(values) {
    this._selected = new Set(values || []);
    this._render();
  }

  getSelected() {
    return [...this._selected];
  }

  destroy() {
    document.removeEventListener("click", this._onDocClick, true);
  }
}

// ---- FillSelect rewrite ----

function fillSelect(id, values, label) {
  const container = byId(id);
  if (!container) {
    console.warn("fillSelect: container not found for", id);
    return;
  }
  try {
    const current = multiSelects[id] ? multiSelects[id].getSelected() : (state.filters[id] || []);
    if (multiSelects[id]) {
      multiSelects[id].updateOptions(values);
    } else {
      const ms = new MultiSelectDropdown(
        id,
        label,
        current,
        (selected) => {
          state.filters[id] = selected;
          handleFilterChange(id);
        },
      );
      ms.updateOptions(values);
      multiSelects[id] = ms;
    }
  } catch (err) {
    console.error("fillSelect error for", id, err);
  }
}

function uniqueSorted(items, key) {
  return [...new Set(items.map((item) => item[key]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
}

const filterFields = {
  store: "store",
  projectDepartment: "project_department",
  bookSeries: "book_series",
  contentType: "content_type",
  sourceType: "source_type",
  sourceDepartment: "source_department",
  sourceManager: "source_manager",
  sourceGroup: "source_group",
  sourceDetail: "source_detail",
  segment: "segment",
};

const sankeyDimensions = [
  { key: "source_department", label: "销售归属", fallbackLabel: "未识别归属" },
  { key: "store", label: "店铺", fallbackLabel: "未识别店铺" },
  { key: "source_manager", label: "负责人", fallbackLabel: "未填负责人" },
  { key: "source_group", label: "账号组", fallbackLabel: "未填账号组" },
  { key: "source_detail", label: "账号/达人", fallbackLabel: "未知账号", limit: 16, otherLabel: "其他账号", otherBy: "source_group" },
  { key: "book_series", label: "书系", fallbackLabel: "未匹配商品", limit: 9, otherLabel: "其他书系" },
  { key: "content_type", label: "流量体裁", fallbackLabel: "待更新" },
];

function isFilterActive(value) {
  return Array.isArray(value) && value.length > 0;
}

function effectiveFilterValue(filterKey) {
  const quickValue = state.quickFilters?.[filterKey];
  if (isFilterActive(quickValue)) return quickValue;
  const filterValue = state.filters[filterKey];
  return Array.isArray(filterValue) ? filterValue : [];
}

function clearQuickChannelFilters() {
  state.quickFilters.contentType = [];
  state.quickFilters.sourceType = [];
  state.quickFilters.sourceManager = [];
  state.quickFilters.sourceGroup = [];
  state.quickFilters.sourceDetail = [];
}

function clearQuickFilters() {
  state.quickFilters.bookSeries = [];
  clearQuickChannelFilters();
}

function handleFilterChange(id) {
  if (["contentType", "sourceType", "sourceDepartment", "sourceManager", "sourceGroup"].includes(id)) {
    state.filters.sourceDetail = [];
    clearQuickChannelFilters();
    if (multiSelects.sourceDetail) multiSelects.sourceDetail.setSelected([]);
  }
  if (id === "bookSeries") {
    clearQuickFilters();
    state.filters.contentType = [];
    state.filters.sourceType = [];
    state.filters.sourceDepartment = [];
    state.filters.sourceManager = [];
    state.filters.sourceGroup = [];
    state.filters.sourceDetail = [];
    ["contentType", "sourceType", "sourceDepartment", "sourceManager", "sourceGroup", "sourceDetail"].forEach((key) => {
      if (multiSelects[key]) multiSelects[key].setSelected([]);
    });
  }
  state.trendSourceSelections = [];
  state.selectedProvince = "";
  state.selectedCity = "";
  state.mapLevel = "country";
  state.currentMapProvince = null;
  renderAll();
  scheduleFilteredDataReload();
}

function parseDateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function shiftDate(value, days) {
  const date = parseDateValue(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDataDateBounds() {
  // Incremental refreshes may keep only the latest day in dimensions.times,
  // while the API facts still contains the requested seven-day window.
  // Use fact dates for availability and the database summary for the global bounds.
  // The current calendar day is a partial day and must not enter the official
  // ranking/trend window. Keep it in the database for later completion, but
  // hide it from all user-facing date presets until tomorrow.
  const factDates = [...new Set((state.data?.facts || []).map((item) => item.date).filter(Boolean))].sort();
  const dimensionDates = (state.data?.dimensions?.times || []).map((item) => item.date).filter(Boolean).sort();
  const summary = state.data?.summary || {};
  const rawDataEnd = summary.date_max || factDates[factDates.length - 1] || dimensionDates[dimensionDates.length - 1] || "";
  const today = new Date();
  const todayIso = Number.isNaN(today.getTime())
    ? ""
    : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const latestCompleteEnd = rawDataEnd && todayIso && rawDataEnd >= todayIso
    ? shiftDate(todayIso, -1)
    : rawDataEnd;
  const dates = (factDates.length ? factDates : dimensionDates).filter((date) => !latestCompleteEnd || date <= latestCompleteEnd);
  return {
    dates,
    dataStart: summary.date_min || dates[0] || dimensionDates[0] || "",
    dataEnd: latestCompleteEnd || dates[dates.length - 1] || "",
    rawDataEnd,
  };
}

function clampDate(value, min, max) {
  if (!value) return "";
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
}

function currentDateWindow() {
  const { dates, dataStart, dataEnd } = getDataDateBounds();
  if (!dates.length) return { label: "暂无日期数据", start: "", end: "" };
  if (state.filters.datePreset === "all") {
    return { label: `全量：${dataStart} 至 ${dataEnd}`, start: dataStart, end: dataEnd };
  }
  if (state.filters.datePreset === "custom") {
    let start = clampDate(state.filters.dateStart || dataStart, dataStart, dataEnd);
    let end = clampDate(state.filters.dateEnd || dataEnd, dataStart, dataEnd);
    if (start > end) [start, end] = [end, start];
    return { label: `自定义：${start} 至 ${end}`, start, end };
  }
  if (state.filters.datePreset === "yesterday") {
    // dataEnd is already capped to the latest complete day, so do not
    // subtract one more day here. On Sep 7, yesterday must be Sep 6.
    const reportDate = clampDate(dataEnd, dataStart, dataEnd);
    const label = reportDate
      ? `昨日：${reportDate}（最新完整日）`
      : `上一可用日：${reportDate}（数据最早日为 ${dataStart}）`;
    return { label, start: reportDate, end: reportDate };
  }
  const days = state.filters.datePreset === "last7" ? 6 : 29;
  const intendedStart = shiftDate(dataEnd, -days);
  const start = clampDate(intendedStart, dataStart, dataEnd);
  const presetLabel = state.filters.datePreset === "last7" ? "最近7天" : "最近30天";
  let label;
  if (intendedStart < dataStart) {
    const actualDays = Math.round((new Date(dataEnd) - new Date(dataStart)) / 864e5) + 1;
    label = `最近${actualDays}天：${start} 至 ${dataEnd}（当前仅有 ${dataStart}~${dataEnd} 数据，不足${days + 1}天）`;
  } else {
    label = `${presetLabel}：${start} 至 ${dataEnd}（按数据最新日 ${dataEnd} 计算）`;
  }
  return {
    label,
    start,
    end: dataEnd,
  };
}

function renderDateRangeHint() {
  const hint = byId("dateRangeHint");
  if (hint) hint.textContent = currentDateWindow().label;
  syncDateInputs();
}

function syncDateInputs() {
  const startInput = byId("dateStart");
  const endInput = byId("dateEnd");
  if (!startInput || !endInput || !state.data) return;
  const { dataStart, dataEnd } = getDataDateBounds();
  const dateWindow = currentDateWindow();
  startInput.min = dataStart;
  startInput.max = dataEnd;
  endInput.min = dataStart;
  endInput.max = dataEnd;
  startInput.value = dateWindow.start || "";
  endInput.value = dateWindow.end || "";
  const isCustom = state.filters.datePreset === "custom";
  startInput.disabled = !isCustom;
  endInput.disabled = !isCustom;
}

function filterFacts(ignoreField = "", options = {}) {
  const dateWindow = options.ignoreDate ? null : currentDateWindow();
  const ignoreFields = new Set([ignoreField, ...(options.ignoreFields || [])].filter(Boolean));
  return state.data.facts.filter((item) => {
    if (dateWindow && (item.date < dateWindow.start || item.date > dateWindow.end)) return false;
    for (const [filterKey, factKey] of Object.entries(filterFields)) {
      if (ignoreFields.has(filterKey)) continue;
      const values = effectiveFilterValue(filterKey);
      if (values.length > 0 && !values.includes(item[factKey])) return false;
    }
    return true;
  });
}

function updateDependentFilters() {
  fillSelect("projectDepartment", uniqueSorted(filterFacts("projectDepartment"), "project_department"), "全部产品归属");
  fillSelect("store", uniqueSorted(filterFacts("store"), "store"), "全部店铺");
  fillSelect("bookSeries", uniqueSorted(filterFacts("bookSeries"), "book_series"), "全部书系");
  fillSelect("contentType", uniqueSorted(filterFacts("contentType"), "content_type"), "全部体裁");
  fillSelect("sourceType", uniqueSorted(filterFacts("sourceType"), "source_type"), "全部来源");
  fillSelect("sourceDepartment", uniqueSorted(filterFacts("sourceDepartment"), "source_department"), "全部销售归属");
  fillSelect("sourceManager", uniqueSorted(filterFacts("sourceManager"), "source_manager"), "全部负责人");
  fillSelect("sourceGroup", uniqueSorted(filterFacts("sourceGroup"), "source_group"), "全部账号组");
  fillSelect("sourceDetail", uniqueSorted(filterFacts("sourceDetail"), "source_detail"), "全部账号/达人");
  fillSelect("segment", uniqueSorted(filterFacts("segment"), "segment"), "全部学段");
}

function renderKpis(facts) {
  const sales = sum(facts, "sales_qty");
  const amount = sum(facts, "sales_amount");
  const orders = sum(facts, "order_count");
  const highlightSales = sum(facts, "highlight_qty");
  const series = new Set(facts.map((item) => item.book_series)).size;
  const pending = sum(facts.filter((item) => item.content_type === "待更新"), "sales_qty");
  byId("kpiSales").textContent = fmt.format(sales);
  byId("kpiAmount").textContent = moneyFmt.format(amount);
  byId("kpiOrders").textContent = fmt.format(orders);
  byId("kpiHighlight").textContent = fmt.format(highlightSales);
  byId("kpiSeries").textContent = fmt.format(series);
  byId("kpiMatch").textContent = pct.format(state.data.summary.series_attribution_rate ?? state.data.summary.product_match_rate);
  byId("kpiPending").textContent = sales ? pct.format(pending / sales) : "0%";
}

function dailyReportChannelLabel(channel) {
  const contentType = channel.content_type || "待更新";
  const sourceDetail = channel.source_detail || "未填来源";
  return contentType + "｜" + sourceDetail;
}

const DAILY_REPORT_GROUP_THRESHOLD = 1000;

function dailyReportRankingQty(item) {
  // 示例赠品既有单独售卖，也有套装附带识别量；两者在日报中属于同一书系。
  // highlight_qty 已包含单独售卖与套装附带，避免把单独售卖重复相加。
  if (String(item.book_series || "").startsWith("示例赠品")) {
    return Number(item.highlight_qty) || Number(item.sales_qty) || 0;
  }
  return Number(item.sales_qty) || 0;
}

function dailyReportSalesGroupHtml(row) {
  if (row.sales_qty <= DAILY_REPORT_GROUP_THRESHOLD) {
    return '<span class="daily-report-group-none" title="销量不超过1,000册，仅展示总体销量">—</span>';
  }
  return [...row.salesGroups.values()]
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .map((group) => [
      '<span class="daily-report-group-pill' + (group.source_group === "未识别账号" ? " is-unidentified" : "") + '" title="' + escapeHtml(group.source_group === "未识别账号" ? "账号未匹配基础信息表，负责人待补" : group.source_group + " / " + group.source_manager) + '">',
      '<span class="daily-report-group-meta">',
      '<b>' + escapeHtml(group.source_group) + '</b>',
      '<small>' + escapeHtml(group.source_manager) + '</small>',
      '</span>',
      '<strong>' + fmt.format(group.sales_qty) + '</strong>',
      '</span>',
    ].join(""))
    .join("");
}

function dailyReportTrendDates(dateEnd) {
  if (!dateEnd) return [];
  const end = new Date(`${dateEnd}T12:00:00`);
  if (Number.isNaN(end.getTime())) return [];
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
}

function dailyReportTrendSvg(values, dates, label) {
  if (!dates.length) return '<span class="daily-report-trend-empty">—</span>';
  const width = 132;
  const height = 36;
  const padX = 4;
  const padY = 4;
  const max = Math.max(1, ...values);
  const step = (width - padX * 2) / Math.max(1, values.length - 1);
  const points = values.map((value, index) => {
    const x = padX + index * step;
    const y = height - padY - (value / max) * (height - padY * 2);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });
  const pointString = points.map(([x, y]) => `${x},${y}`).join(" ");
  const dots = points
    .map(([x, y], index) => `<circle cx="${x}" cy="${y}" r="2.2"><title>${escapeHtml(dates[index])}：${fmt.format(values[index])}册</title></circle>`)
    .join("");
  return [
    '<div class="daily-report-trend">',
    `<svg class="daily-report-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}最近7日销量趋势">`,
    `<title>${escapeHtml(label)}最近7日销量趋势</title>`,
    `<polyline points="${pointString}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>`,
    `<g fill="currentColor">${dots}</g>`,
    "</svg>",
    `<span class="daily-report-trend-range">${escapeHtml(dates[0].slice(5))}—${escapeHtml(dates[dates.length - 1].slice(5))}</span>`,
    "</div>",
  ].join("");
}

function renderDailyReport(facts, trendFacts = []) {
  const reportTitle = byId("dailyReportTitle");
  const reportNote = byId("dailyReportNote");
  const reportMeta = byId("dailyReportMeta");
  const reportSummary = byId("dailyReportSummary");
  const reportSegmentTabs = byId("dailyReportSegmentTabs");
  const reportBody = byId("dailyReportBody");
  if (!reportTitle || !reportNote || !reportMeta || !reportSummary || !reportBody) return;

  const dateWindow = currentDateWindow();
  const isSingleDay = Boolean(dateWindow.start && dateWindow.start === dateWindow.end);
  const reportScope = isSingleDay ? dateWindow.end : (dateWindow.start + " 至 " + dateWindow.end);
  const reportTrendDates = dailyReportTrendDates(dateWindow.end);
  const reportTrendMap = new Map();
  for (const item of trendFacts) {
    const key = `${item.segment || "未填学段"}\u0000${item.book_series}`;
    if (!reportTrendMap.has(key)) reportTrendMap.set(key, new Map());
    reportTrendMap.get(key).set(item.date, item);
  }
  reportTitle.textContent = state.filters.datePreset === "yesterday"
    ? "昨日销售日报"
    : isSingleDay
      ? "日销售排行"
      : "区间销售排行";
  reportNote.textContent = isSingleDay
    ? "按当前学段逐个书系列出销量 Top10；示例赠品按识别量计入对应书系"
    : "按当前日期范围和筛选条件逐个书系列出当前学段销量 Top10；示例赠品按识别量计入对应书系";
  reportMeta.textContent = reportScope || "暂无日期";

  const excludedSeries = new Set(["未匹配商品", "宣传品", "文创品"]);
  const seriesFacts = facts.filter((item) => item.book_series && !excludedSeries.has(item.book_series));
  const seriesMap = new Map();
  for (const item of seriesFacts) {
    const segment = item.segment || "未填学段";
    const key = segment + "\u0000" + item.book_series;
    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        segment,
        book_series: item.book_series,
        sales_qty: 0,
        sales_amount: 0,
        channels: new Map(),
        salesGroups: new Map(),
      });
    }
    const row = seriesMap.get(key);
    const rankingQty = dailyReportRankingQty(item);
    row.sales_qty += rankingQty;
    row.sales_amount += Number(item.sales_amount) || 0;
    const sourceGroup = item.source_group || "未填销售组";
    const sourceManager = item.source_manager || "未填负责人";
    const salesGroupKey = sourceGroup + "\u0000" + sourceManager;
    const salesGroup = row.salesGroups.get(salesGroupKey) || {
      source_group: sourceGroup,
      source_manager: sourceManager,
      sales_qty: 0,
    };
    salesGroup.sales_qty += rankingQty;
    row.salesGroups.set(salesGroupKey, salesGroup);
    const contentType = item.content_type || "待更新";
    const sourceDetail = item.source_detail || "未填来源";
    const channelKey = contentType + "\u0000" + sourceDetail;
    const channel = row.channels.get(channelKey) || {
      content_type: contentType,
      source_detail: sourceDetail,
      sales_qty: 0,
    };
    channel.sales_qty += rankingQty;
    row.channels.set(channelKey, channel);
  }

  const segmentOrder = ["小学", "初中", "高中"];
  const segmentRows = new Map();
  for (const row of seriesMap.values()) {
    if (!segmentRows.has(row.segment)) segmentRows.set(row.segment, []);
    segmentRows.get(row.segment).push(row);
  }
  const segments = [...segmentRows.entries()]
    .map(([segment, rows]) => ({
      segment,
      rows: rows.sort((a, b) => b.sales_qty - a.sales_qty).slice(0, 10),
    }))
    .sort((a, b) => {
      const ai = segmentOrder.indexOf(a.segment);
      const bi = segmentOrder.indexOf(b.segment);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      const aTotal = a.rows.reduce((sumValue, row) => sumValue + row.sales_qty, 0);
      const bTotal = b.rows.reduce((sumValue, row) => sumValue + row.sales_qty, 0);
      return bTotal - aTotal;
    });

  const reportSales = [...seriesMap.values()].reduce((total, row) => total + row.sales_qty, 0);
  const reportAmount = seriesFacts.reduce((total, item) => total + (Number(item.sales_amount) || 0), 0);
  const reportSeries = new Set(seriesFacts.map((item) => item.book_series)).size;
  reportSummary.innerHTML = [
    { label: "报告日期", value: reportScope || "-" },
    { label: "有效销量", value: fmt.format(sum(facts, "sales_qty")) },
    { label: "示例赠品识别量", value: fmt.format(sum(facts, "highlight_qty")) },
    { label: "排行书系销量", value: fmt.format(reportSales) },
    { label: "排行书系成交额", value: moneyFmt.format(reportAmount) },
    { label: "覆盖书系", value: fmt.format(reportSeries) },
  ]
    .map((item) => '<div class="daily-report-summary-item"><span>' + item.label + '</span><strong>' + escapeHtml(item.value) + "</strong></div>")
    .join("");

  if (!segments.length) {
    if (reportSegmentTabs) reportSegmentTabs.innerHTML = "";
    reportBody.innerHTML = '<tr><td colspan="7" class="daily-report-empty">当前日期和筛选条件下暂无可排行的书系数据</td></tr>';
    return;
  }

  const availableSegments = segments.map(({ segment }) => segment);
  const activeSegment = availableSegments.includes(state.dailyReportSegment)
    ? state.dailyReportSegment
    : availableSegments[0];
  state.dailyReportSegment = activeSegment;
  if (reportSegmentTabs) {
    reportSegmentTabs.innerHTML = segments
      .map(({ segment, rows }) => [
        '<button class="daily-report-segment-tab' + (segment === activeSegment ? " active" : "") + '" type="button" role="tab" aria-selected="' + (segment === activeSegment ? "true" : "false") + '" aria-controls="dailyReportBody" data-daily-segment="' + escapeHtml(segment) + '">',
        escapeHtml(segment),
        '<small>Top ' + rows.length + '</small>',
        '</button>',
      ].join(""))
      .join("");
    reportSegmentTabs.querySelectorAll("[data-daily-segment]").forEach((button) => {
      button.addEventListener("click", () => {
        state.dailyReportSegment = button.dataset.dailySegment;
        renderDailyReport(facts, state.data?.daily_report_trend || []);
      });
    });
  }

  const selectedSegment = segments.find(({ segment }) => segment === activeSegment) || segments[0];
  const segmentTotal = selectedSegment.rows.reduce((total, row) => total + row.sales_qty, 0);
  const segmentRowsHtml = selectedSegment.rows
    .map((row, index) => {
      const topChannels = [...row.channels.values()]
        .sort((a, b) => b.sales_qty - a.sales_qty)
        .slice(0, 2)
        .map((channel) => '<span>' + escapeHtml(dailyReportChannelLabel(channel)) + '<small>' + fmt.format(channel.sales_qty) + "册</small></span>")
        .join("");
      const groupBreakdown = dailyReportSalesGroupHtml(row);
      const trendBucket = reportTrendMap.get(`${row.segment}\u0000${row.book_series}`);
      const trendValues = reportTrendDates.map((date) => {
        const trendItem = trendBucket?.get(date);
        return trendItem ? dailyReportRankingQty(trendItem) : 0;
      });
      const trendLabel = `${row.book_series}（${row.segment}）`;
      return [
        "<tr>",
        '<td class="daily-report-rank">' + (index + 1) + "</td>",
        '<td class="series-cell">' + escapeHtml(row.book_series) + "</td>",
        '<td class="num">' + fmt.format(row.sales_qty) + "</td>",
        '<td class="num">' + moneyFmt.format(row.sales_amount) + "</td>",
        '<td class="daily-report-trend-cell">' + dailyReportTrendSvg(trendValues, reportTrendDates, trendLabel) + "</td>",
        '<td class="daily-report-source">' + (topChannels || "-") + "</td>",
        '<td class="daily-report-groups">' + (groupBreakdown || '<span class="daily-report-group-none">—</span>') + "</td>",
        "</tr>",
      ].join("");
    })
    .join("");
  reportBody.innerHTML = [
    '<tr class="daily-report-segment-row"><th colspan="7">',
    escapeHtml(selectedSegment.segment),
    '<span>Top ',
    selectedSegment.rows.length,
    "销量｜",
    fmt.format(segmentTotal),
    "册</span></th></tr>",
    segmentRowsHtml,
  ].join("");
}

function renderTopSeriesChips() {
  const rows = groupBy(filterFacts("bookSeries"), (item) => item.book_series)
    .filter((item) => item.key && item.key !== "未匹配商品")
    .map((item) => ({
      ...item,
      sales_qty: item.rows.reduce((total, row) => total + dailyReportRankingQty(row), 0),
    }))
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .slice(0, 10);
  const activeSeries = effectiveFilterValue("bookSeries");
  const allActive = activeSeries.length === 0;
  byId("topSeriesChips").innerHTML = [
    `<button class="chip ${allActive ? "active" : ""}" type="button" data-series="__all__">全部书系</button>`,
    ...rows.map(
      (row, index) =>
        `<button class="chip ${activeSeries.includes(row.key) ? "active" : ""}" type="button" data-series="${escapeHtml(row.key)}"><span class="chip-rank rank-${index + 1}">${index + 1}</span><span class="chip-name">${escapeHtml(row.key)}</span><span class="chip-value">${fmt.format(row.sales_qty)}</span></button>`,
    ),
  ].join("");
}

function growthText(current, previous) {
  if (!previous && !current) return "0%";
  if (!previous) return "新起量";
  const ratio = (current - previous) / previous;
  return `${ratio > 0 ? "+" : ""}${pct.format(ratio)}`;
}

function recentRiseRows(facts, keyFn, sampleFn, limit = 6) {
  const dates = getScopedDates(facts);
  if (dates.length < 6) return [];
  return groupBy(facts, keyFn)
    .map((bucket) => {
      const values = dateValues(bucket.rows, dates);
      const last3 = values.slice(-3).reduce((acc, value) => acc + value, 0);
      const prev3 = values.slice(-6, -3).reduce((acc, value) => acc + value, 0);
      const last7 = values.slice(-7).reduce((acc, value) => acc + value, 0);
      const prev7 = values.slice(-14, -7).reduce((acc, value) => acc + value, 0);
      const lift3 = last3 - prev3;
      const lift7 = last7 - prev7;
      const growth3 = prev3 ? lift3 / prev3 : last3 > 0 ? 2 : 0;
      const growth7 = prev7 ? lift7 / prev7 : last7 > 0 ? 1 : 0;
      const volumeGate = last3 >= 30 || last7 >= 90;
      const growing = lift3 > 0 || lift7 > 0;
      const score = lift3 * 1.5 + lift7 * 0.55 + Math.min(Math.max(growth3, 0), 3) * 45 + Math.min(Math.max(growth7, 0), 2) * 25;
      return {
        key: bucket.key,
        ...sampleFn(bucket.rows[0] || {}),
        last3,
        prev3,
        last7,
        prev7,
        lift3,
        lift7,
        growth3,
        growth7,
        score,
        volumeGate,
        growing,
      };
    })
    .filter((row) => row.volumeGate && row.growing && row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function getSeriesTrendFacts() {
  const end = currentDateWindow().end;
  const start = shiftDate(end, -13);
  return (state.data.comparison_facts || state.data.facts).filter((item) => {
    if (item.date < start || item.date > end) return false;
    return Object.entries(filterFields).every(([key, field]) => {
      const values = effectiveFilterValue(key);
      return !values.length || values.includes(item[field]);
    });
  });
}

function getFocusSeries(seriesFacts = getSeriesTrendFacts()) {
  const activeSeries = effectiveFilterValue("bookSeries");
  if (activeSeries.length === 1) return activeSeries[0];
  if (activeSeries.length > 1) return activeSeries[0];
  return getTop(
    seriesFacts.filter((item) => item.book_series && item.book_series !== "未匹配商品"),
    (item) => item.book_series,
    1,
  )[0] || "";
}

function renderRiseChips(seriesFacts = getSeriesTrendFacts()) {
  const baseFacts = seriesFacts;
  const seriesRows = recentRiseRows(
    baseFacts.filter((item) => item.book_series && item.book_series !== "未匹配商品"),
    (item) => item.book_series,
    (item) => ({ label: item.book_series }),
    6,
  );
  const activeBookSeries = effectiveFilterValue("bookSeries");
  byId("riseSeriesChips").innerHTML = seriesRows
    .map(
      (row) =>
        `<button class="chip chip-rise ${activeBookSeries.includes(row.label) ? "active" : ""}" type="button" data-rise-series="${escapeHtml(row.label)}"><span class="chip-trend-icon">↗</span><span class="chip-name">${escapeHtml(row.label)}</span><strong>${fmt.format(row.last3)}</strong><small> 3日${growthText(row.last3, row.prev3)}</small></button>`,
    )
    .join("") || `<span class="chip chip-empty">暂无符合条件的起量书系</span>`;

  const focusSeries = getFocusSeries(baseFacts);
  const sourceBaseFacts = focusSeries ? baseFacts.filter((item) => item.book_series === focusSeries) : [];
  const sourceRows = recentRiseRows(
    sourceBaseFacts,
    (item) => [item.source_type, item.source_detail, item.content_type, item.source_manager, item.source_group].join("|||"),
    (item) => ({
      label: `${item.source_detail}｜${item.content_type}`,
      sourceType: item.source_type,
      sourceDetail: item.source_detail,
      sourceManager: item.source_manager,
      sourceGroup: item.source_group,
      contentType: item.content_type,
    }),
    6,
  );
  const activeSd = effectiveFilterValue("sourceDetail");
  const activeSt = effectiveFilterValue("sourceType");
  const activeSm = effectiveFilterValue("sourceManager");
  const activeSg = effectiveFilterValue("sourceGroup");
  const activeCt = effectiveFilterValue("contentType");
  byId("riseSourceChips").innerHTML = sourceRows
    .map((row) => {
      const active =
        activeSd.includes(row.sourceDetail) &&
        activeSt.includes(row.sourceType) &&
        activeSm.includes(row.sourceManager) &&
        activeSg.includes(row.sourceGroup) &&
        activeCt.includes(row.contentType);
      return `<button class="chip chip-rise ${active ? "active" : ""}" type="button" data-rise-source-detail="${escapeHtml(row.sourceDetail)}" data-rise-source-type="${escapeHtml(row.sourceType)}" data-rise-source-manager="${escapeHtml(row.sourceManager)}" data-rise-source-group="${escapeHtml(row.sourceGroup)}" data-rise-content-type="${escapeHtml(row.contentType)}"><span class="chip-trend-icon">↗</span><span class="chip-name">${escapeHtml(row.label)}</span><strong>${fmt.format(row.last3)}</strong><small> 3日${growthText(row.last3, row.prev3)}</small></button>`;
    })
    .join("") || `<span class="chip chip-empty">暂无符合条件的起量渠道</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initCharts() {
  charts.trend = echarts.init(byId("trendChart"));
  charts.content = echarts.init(byId("contentChart"));
  charts.source = echarts.init(byId("sourceChart"));
  charts.sankey = echarts.init(byId("sankeyChart"));
  charts.roomSeriesHeatmap = echarts.init(byId("roomSeriesHeatmap"));
  // New analysis charts
  charts.chinaMap = echarts.init(byId("chinaMapChart"));
  charts.cityBar = echarts.init(byId("cityBarChart"));
  charts.regionTrend = echarts.init(byId("regionTrendChart"));
  charts.hourHeatmap = echarts.init(byId("hourHeatmap"));
  charts.priceBox = echarts.init(byId("priceBoxChart"));
  charts.aftersalePie = echarts.init(byId("aftersalePieChart"));
  charts.aftersaleRank = echarts.init(byId("aftersaleRankChart"));
  // Load China geoJSON and register map
  loadChinaMap();
  // Wire map click event for drill-down
  charts.chinaMap.on("click", async (params) => {
    if (state.mapLevel === "country") {
      // Country level: click province → drill down to city map
      const dataProvince = params?.data?.province || "";  // data province name (e.g. "河北")
      const geoProvince = params?.name || "";               // geoJSON name (e.g. "河北省")
      if (!dataProvince && !geoProvince) return;
      // Use robust name matching
      const match = lookupProvinceAdcode(dataProvince) || lookupProvinceAdcode(geoProvince);
      if (!match) return;
      const { adcode, geoName } = match;
      // Load and register city-level map
      const geo = await loadProvinceMap(adcode);
      if (!geo) {
        // Fallback: just select province without drill-down
        state.selectedProvince = dataProvince || geoName;
        state.selectedCity = "";
        renderRegionAnalysis();
        return;
      }
      state.mapLevel = "province";
      state.currentMapProvince = { adcode, name: geoName };
      state.selectedProvince = dataProvince || geoName;  // data name for filtering
      state.selectedCity = "";
      renderRegionAnalysis();
    } else {
      // Province level: click city → select city
      const cityName = params?.data?.city || params?.name || "";
      if (cityName) {
        state.selectedCity = state.selectedCity === cityName ? "" : cityName;
        renderRegionAnalysis();
      }
    }
  });
  viewportMode = currentViewportMode();
  charts.trend.on("click", (params) => {
    if (params?.seriesName) toggleTrendSourceSelection(params.seriesName);
  });
  window.addEventListener("resize", () => {
    Object.values(charts).forEach((chart) => chart.resize());
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nextMode = currentViewportMode();
      if (state.data && nextMode !== viewportMode) {
        viewportMode = nextMode;
        renderAll();
      }
    }, 160);
  });
}

function renderTrendLegend(seriesNames, buckets, dates, primaryCount) {
  const rows = seriesNames
    .map((name, index) => {
      const values = dates.map((date) => buckets.get(`${name}|${date}`) || 0);
      const total = values.reduce((acc, value) => acc + value, 0);
      const peakValue = Math.max(0, ...values);
      const peakDate = dates[values.indexOf(peakValue)] || "";
      const active = isSelectedTrendSourceName(name);
      const color = active || (!state.trendSourceSelections.length && index < primaryCount) ? chartColors[index % chartColors.length] : "#94a3b8";
      return { name, total, peakValue, peakDate, color, active };
    })
    .sort((a, b) => b.total - a.total);
  byId("trendLegendList").innerHTML = rows
    .map(
      (row) => `
        <div class="trend-legend-row ${row.active ? "active" : ""}" data-source-name="${escapeHtml(row.name)}">
          <span class="trend-legend-dot" style="background:${row.color}"></span>
          <span class="trend-legend-name">${row.name}<br><span class="trend-legend-meta">${fmt.format(row.total)}｜${row.peakDate}峰值${fmt.format(row.peakValue)}</span></span>
        </div>
      `,
    )
    .join("");
}

function getScopedDates(facts) {
  return [...new Set(facts.map((item) => item.date))].sort();
}

function dateValues(rows, dates) {
  const values = new Map();
  for (const row of rows) {
    values.set(row.date, (values.get(row.date) || 0) + row.sales_qty);
  }
  return dates.map((date) => values.get(date) || 0);
}

function currentStreak(values) {
  let best = 0;
  let streak = 0;
  for (const value of values) {
    if (value > 0) {
      streak += 1;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
  }
  return best;
}

function rhythmStatus(values) {
  const last7 = values.slice(-7);
  const prev7 = values.slice(-14, -7);
  const lastSum = last7.reduce((acc, value) => acc + value, 0);
  const prevSum = prev7.reduce((acc, value) => acc + value, 0);
  const activeDays = last7.filter((value) => value > 0).length;
  const peak = Math.max(0, ...values);
  const avg = values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : 0;

  // Portfolio-only example thresholds; not production business rules.
  if (prevSum > 0 && lastSum <= prevSum * 0.75) return { text: "下滑", cls: "badge-down" };
  if (lastSum >= Math.max(25, prevSum * 1.25) && peak >= Math.max(12, avg * 1.5)) return { text: "打爆", cls: "badge-burst" };
  if (activeDays >= 5 && prevSum > 0 && lastSum >= prevSum * 0.85 && lastSum <= prevSum * 1.15) return { text: "稳定", cls: "badge-stable" };
  return { text: "待观察", cls: "badge-watch" };
}

function sevenDayChange(values) {
  const last7 = values.slice(-7);
  const prev7 = values.slice(-14, -7);
  const lastSum = last7.reduce((acc, value) => acc + value, 0);
  const prevSum = prev7.reduce((acc, value) => acc + value, 0);
  if (prevSum === 0 && lastSum === 0) return { text: "0%", cls: "change-flat", lastSum, prevSum };
  if (prevSum === 0) return { text: "新起量", cls: "change-up", lastSum, prevSum };
  const ratio = (lastSum - prevSum) / prevSum;
  const sign = ratio > 0 ? "+" : "";
  const cls = ratio > 0.05 ? "change-up" : ratio < -0.05 ? "change-down" : "change-flat";
  return { text: `${sign}${pct.format(ratio)}`, cls, lastSum, prevSum };
}

function sparkline(values, statusClass) {
  const max = Math.max(1, ...values);
  const color =
    statusClass === "badge-down"
      ? "#b42318"
      : statusClass === "badge-burst"
        ? "#e34d3c"
        : statusClass === "badge-stable"
          ? "#2563eb"
          : "#1976d2";
  return `<div class="sparkline">${values
    .map((value) => `<span class="sparkbar" title="${fmt.format(value)}" style="height:${Math.max(2, Math.round((value / max) * 34))}px;background:${color}"></span>`)
    .join("")}</div>`;
}

function renderRhythmTable(facts) {
  const dates = getScopedDates(facts);
  const rows = groupBy(
    facts.filter((item) => item.book_series && item.book_series !== "未匹配商品"),
    (item) => item.book_series,
  )
    .map((bucket) => {
      const sample = bucket.rows[0] || {};
      const values = dateValues(bucket.rows, dates);
      const recentValues = values.slice(-7);
      const peakValue = Math.max(0, ...recentValues);
      const peakDate = dates.slice(-7)[recentValues.indexOf(peakValue)] || "";
      const status = rhythmStatus(values);
      const change = sevenDayChange(values);
      return {
        book_series: sample.book_series,
        sales_qty: sum(bucket.rows.filter((row) => row.date >= dates.slice(-7)[0]), "sales_qty"),
        sales_amount: sum(bucket.rows.filter((row) => row.date >= dates.slice(-7)[0]), "sales_amount"),
        peakDate,
        peakValue,
        streak: currentStreak(recentValues),
        last7: values.slice(-7),
        status,
        change,
      };
    })
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .slice(0, 80);

  byId("rhythmMeta").textContent = `${currentDateWindow().label}｜显示 ${fmt.format(rows.length)} 个书系`;
  byId("rhythmBody").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td class="series-cell">${escapeHtml(row.book_series)}</td>
          <td class="num">${fmt.format(row.sales_qty)}</td>
          <td class="num">${moneyFmt.format(row.sales_amount)}</td>
          <td>${escapeHtml(row.peakDate)}<small>${fmt.format(row.peakValue)}</small></td>
          <td class="num">${fmt.format(row.streak)}天</td>
          <td>${sparkline(row.last7, row.status.cls)}</td>
          <td><span class="${row.change.cls}">${row.change.text}</span><small>近7天 ${fmt.format(row.change.lastSum)} / 前7天 ${fmt.format(row.change.prevSum)}</small></td>
          <td><span class="badge ${row.status.cls}">${row.status.text}</span></td>
        </tr>
      `,
    )
    .join("");
}

function dateAmountValues(rows, dates) {
  const values = new Map();
  for (const row of rows) {
    values.set(row.date, (values.get(row.date) || 0) + (Number(row.sales_amount) || 0));
  }
  return dates.map((date) => values.get(date) || 0);
}

function isTalentSource(row) {
  return row.source_type === "精选联盟" || row.source_owner === "达人分销" || /达人|精选联盟/.test(`${row.source_type}${row.source_group}${row.source_detail}`);
}

function isSelfLiveSource(row) {
  return /直播/.test(`${row.source_type}${row.content_type}${row.source_group}${row.source_detail}`) && !isTalentSource(row);
}

function renderSourceAnalysis(seriesFacts) {
  const focusSeries = getFocusSeries(seriesFacts);
  const focusFacts = focusSeries
    ? seriesFacts.filter((item) => item.book_series === focusSeries)
    : [];
  const dates = getScopedDates(focusFacts);
  const last7Dates = dates.slice(-7);
  const last30Dates = dates.slice(-30);
  const last30Header = byId("sourceLast30Header");
  if (last30Header) {
    last30Header.textContent = dates.length < 30 ? `近${dates.length}天销量` : "近30天销量";
  }
  const focusLast7 = sum(focusFacts.filter((item) => last7Dates.includes(item.date)), "sales_qty");

  byId("sourceAnalysisNote").textContent = focusSeries
    ? `当前聚焦：${focusSeries}。看近7天/近30天由直播间、自营渠道还是达人带货带起来。`
    : "当前没有可分析的书系。";

  const rows = groupBy(focusFacts, (item) =>
    [item.source_type, item.source_detail, item.source_department, item.source_manager, item.source_group, item.content_type, item.source_owner].join("|||"),
  )
    .map((bucket) => {
      const sample = bucket.rows[0] || {};
      const values = dateValues(bucket.rows, dates);
      const amounts = dateAmountValues(bucket.rows, dates);
      const change = sevenDayChange(values);
      const last7Sales = values.slice(-7).reduce((acc, value) => acc + value, 0);
      const last30Sales = values.slice(-30).reduce((acc, value) => acc + value, 0);
      const last7Amount = amounts.slice(-7).reduce((acc, value) => acc + value, 0);
      const status = rhythmStatus(values);
      return {
        source_type: sample.source_type,
        source_detail: sample.source_detail,
        source_department: sample.source_department,
        source_group: sample.source_group,
        source_manager: sample.source_manager,
        source_owner: sample.source_owner,
        content_type: sample.content_type,
        last7Sales,
        last30Sales,
        last7Amount,
        last7Values: values.slice(-7),
        contribution: focusLast7 ? last7Sales / focusLast7 : 0,
        change,
        status,
      };
    })
    .filter((row) => row.last7Sales || row.last30Sales)
    .sort((a, b) => b.last7Sales - a.last7Sales || b.last30Sales - a.last30Sales)
    .slice(0, 80);

  const talentSales = rows.filter(isTalentSource).reduce((acc, row) => acc + row.last7Sales, 0);
  const liveSales = rows.filter(isSelfLiveSource).reduce((acc, row) => acc + row.last7Sales, 0);
  const topRow = rows[0];
  const leadText = topRow
    ? `${topRow.source_type}｜${topRow.source_detail}，近7天 ${fmt.format(topRow.last7Sales)}`
    : "暂无来源贡献";

  byId("sourceAnalysisMeta").textContent = focusSeries ? `近7天全渠道 ${fmt.format(focusLast7)}` : "";
  byId("sourceActionSummary").innerHTML = [
    { label: "主要带动来源", value: leadText },
    { label: "达人贡献占比", value: focusLast7 ? pct.format(talentSales / focusLast7) : "0%" },
    { label: "自营直播占比", value: focusLast7 ? pct.format(liveSales / focusLast7) : "0%" },
  ]
    .map((item) => `<div class="source-summary-item"><span>${item.label}</span><strong>${escapeHtml(item.value)}</strong></div>`)
    .join("");

  byId("sourceAnalysisBody").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td class="source-cell">${escapeHtml(row.source_type)}｜${escapeHtml(row.source_detail)}<small>${escapeHtml(row.source_manager)}｜${escapeHtml(row.source_group)}</small></td>
          <td>${escapeHtml(row.source_department)}</td>
          <td>${escapeHtml(row.content_type)}</td>
          <td class="num">${fmt.format(row.last7Sales)}</td>
          <td class="num">${fmt.format(row.last30Sales)}</td>
          <td class="num">${moneyFmt.format(row.last7Amount)}</td>
          <td>${sparkline(row.last7Values, row.status.cls)}</td>
          <td>${pct.format(row.contribution)}</td>
          <td><span class="${row.change.cls}">${row.change.text}</span><small>近7天 ${fmt.format(row.change.lastSum)} / 前7天 ${fmt.format(row.change.prevSum)}</small></td>
          <td><span class="badge ${row.status.cls}">${row.status.text}</span></td>
        </tr>
      `,
    )
    .join("") || `<tr><td colspan="10">暂无来源渠道数据</td></tr>`;
}

function renderTrend(facts) {
  const activeBookSeries = effectiveFilterValue("bookSeries");
  const focusSeries =
    activeBookSeries.length > 0
      ? activeBookSeries[0]
      : getTop(
          facts.filter((item) => item.book_series !== "未匹配商品"),
          (item) => item.book_series,
          1,
        )[0];
  const focusFacts = focusSeries ? facts.filter((item) => item.book_series === focusSeries) : facts;
  const focusTotal = sum(focusFacts, "sales_qty");
  const primaryCount = focusTotal >= 10000 ? 5 : 3;
  const dates = [...new Set(focusFacts.map((item) => item.date))].sort();
  const topSources = getTop(focusFacts, sourceFlowLabel, Math.max(10, primaryCount));
  const buckets = new Map();
  const otherSourceNames = new Set();
  for (const item of focusFacts) {
    const rawName = sourceFlowLabel(item);
    const seriesName = topSources.includes(rawName)
      ? rawName
      : `其他${item.content_type}来源`;
    if (!topSources.includes(rawName)) otherSourceNames.add(seriesName);
    const key = `${seriesName}|${item.date}`;
    buckets.set(key, (buckets.get(key) || 0) + item.sales_qty);
  }
  const seriesNames = [...topSources];
  otherSourceNames.forEach((name) => seriesNames.push(name));
  renderTrendLegend(seriesNames, buckets, dates, primaryCount);
  byId("clearTrendSourceBtn").hidden = !state.trendSourceSelections.length;
  byId("trendNote").textContent = focusSeries
    ? `当前聚焦：${focusSeries}。${focusTotal >= 10000 ? "高销量书系默认高亮 Top5 来源" : "默认高亮 Top3 来源"}；来源按"流量体裁｜来源明细"统计。`
    : '选择书系后，按"流量体裁｜来源明细"展示日销量趋势。';
  const phone = isPhone();
  charts.trend.setOption({
    color: seriesNames.map((name, index) =>
      isSelectedTrendSourceName(name) || (!state.trendSourceSelections.length && index < primaryCount) ? chartColors[index % chartColors.length] : "#94a3b8",
    ),
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: phone ? 44 : 76, right: phone ? 12 : 28, top: phone ? 18 : 26, bottom: phone ? 34 : 42 },
    xAxis: { type: "category", data: dates, boundaryGap: false, axisLabel: { hideOverlap: true, interval: phone ? 4 : "auto" } },
    yAxis: {
      type: "value",
      name: phone ? "" : "销量",
      nameLocation: "end",
      nameGap: 16,
      nameTextStyle: { align: "right", padding: [0, 6, 0, 0] },
    },
    series: seriesNames.map((name, index) => {
      const selected = isSelectedTrendSourceName(name);
      const isPrimary = selected || (!state.trendSourceSelections.length && index < primaryCount);
      return {
        name,
        type: "line",
        smooth: true,
        symbol: isPrimary ? "circle" : "none",
        symbolSize: isPrimary ? 5 : 0,
        lineStyle: { width: isPrimary ? 2.8 : 1.2, opacity: isPrimary ? 0.95 : 0.28 },
        itemStyle: { opacity: isPrimary ? 1 : 0.3 },
        emphasis: {
          focus: "series",
          lineStyle: { width: 3.4, opacity: 1 },
          itemStyle: { opacity: 1 },
        },
        blur: {
          lineStyle: { opacity: 0.1 },
          itemStyle: { opacity: 0.1 },
        },
        data: dates.map((date) => buckets.get(`${name}|${date}`) || 0),
      };
    }),
  }, { notMerge: true });
}

function renderContent(facts) {
  const rows = groupBy(facts, (item) => item.content_type).sort((a, b) => b.sales_qty - a.sales_qty);
  const phone = isPhone();
  charts.content.setOption({
    color: chartColors,
    tooltip: { trigger: "item", formatter: "{b}<br/>销量：{c} ({d}%)" },
    legend: { bottom: 0, type: "scroll", itemWidth: phone ? 10 : 14, itemHeight: phone ? 8 : 10, textStyle: { fontSize: phone ? 10 : 12 } },
    series: [
      {
        type: "pie",
        radius: phone ? ["38%", "64%"] : ["42%", "70%"],
        center: phone ? ["50%", "42%"] : ["50%", "43%"],
        itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
        label: { show: !phone, formatter: "{b}\n{d}%", fontSize: 12 },
        data: rows.map((item) => ({ name: item.key, value: item.sales_qty })),
      },
    ],
  });
}

function wrapLabel(value, width = 14) {
  const text = String(value);
  const chunks = [];
  for (let index = 0; index < text.length; index += width) {
    chunks.push(text.slice(index, index + width));
  }
  return chunks.join("\n");
}

function sourceFlowLabel(item) {
  return `${item.content_type}｜${item.source_detail}`;
}

function sankeyNodeKey(dimensionKey, label) {
  return `${dimensionKey}::${label}`;
}

function sankeyDisplayLabel(value) {
  const text = String(value ?? "");
  const marker = "::";
  return text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
}

function buildSankeyValueResolvers(facts) {
  return Object.fromEntries(
    sankeyDimensions.map((dimension) => {
      if (!dimension.limit) {
        return [dimension.key, (item) => item[dimension.key] || dimension.fallbackLabel];
      }
      const topValues = new Set(getTop(facts, (item) => item[dimension.key] || dimension.fallbackLabel, dimension.limit));
      return [
        dimension.key,
        (item) => {
          const value = item[dimension.key] || dimension.fallbackLabel;
          if (topValues.has(value)) return value;
          if (dimension.otherBy) {
            const owner = item[dimension.otherBy] || dimension.fallbackLabel;
            return `${dimension.otherLabel}（${owner}）`;
          }
          return dimension.otherLabel;
        },
      ];
    }),
  );
}

function topRowsWithOther(rows, limit, otherLabel = "其他来源") {
  const sorted = [...rows].sort((a, b) => b.sales_qty - a.sales_qty);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit - 1);
  const tail = sorted.slice(limit - 1);
  const other = tail.reduce(
    (bucket, item) => ({
      key: otherLabel,
      sales_qty: bucket.sales_qty + item.sales_qty,
      sales_amount: bucket.sales_amount + item.sales_amount,
      order_count: bucket.order_count + item.order_count,
      rows: bucket.rows.concat(item.rows),
    }),
    { key: otherLabel, sales_qty: 0, sales_amount: 0, order_count: 0, rows: [] },
  );
  return [...head, other].filter((item) => item.sales_qty > 0);
}

function renderSource(facts) {
  const phone = isPhone();
  const rows = topRowsWithOther(groupBy(facts, sourceFlowLabel), 12).reverse();
  charts.source.setOption({
    color: ["#1976d2"],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: phone ? 116 : 245, right: phone ? 24 : 48, top: 12, bottom: phone ? 24 : 32 },
    xAxis: { type: "value" },
    yAxis: {
      type: "category",
      data: rows.map((item) => item.key),
      axisLabel: { interval: 0, formatter: (value) => wrapLabel(value, phone ? 8 : 18), fontSize: phone ? 10 : 12 },
    },
    series: [
      {
        type: "bar",
        data: rows.map((item) => item.sales_qty),
        label: { show: true, position: phone ? "insideRight" : "right", color: phone ? "#fff" : "#344054", fontSize: phone ? 10 : 12 },
        barWidth: phone ? 12 : 14,
      },
    ],
  });
}

function renderRoomSeriesHeatmap(facts) {
  const phone = isPhone();
  const liveFacts = facts.filter((item) => item.content_type === "直播" || String(item.source_type || "").includes("直播"));
  // This module is specifically for live-room owners. Never fall back to all channels,
  // otherwise short-video/product-card owners can silently enter the live-room ranking.
  const baseFacts = liveFacts;
  const groupByRankingQty = (items, keyFn) => {
    const map = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, { key, sales_qty: 0, sales_amount: 0, order_count: 0, rows: [] });
      const bucket = map.get(key);
      bucket.sales_qty += dailyReportRankingQty(item);
      bucket.sales_amount += Number(item.sales_amount) || 0;
      bucket.order_count += Number(item.order_count) || 0;
      bucket.rows.push(item);
    }
    return [...map.values()];
  };
  const ownerKey = (item) => {
    const department = item.source_department || "未识别归属";
    const manager = item.source_manager || item.source_detail || item.influencer_name || "未填负责人";
    return `${department}｜${manager}`;
  };
  const sourceDepartmentRank = (row) => (row.rows.some((item) => item.source_department === "项目部") ? 0 : row.rows.some((item) => item.source_department === "电商") ? 1 : 2);
  const ownerRows = groupByRankingQty(baseFacts, ownerKey)
    .filter((item) => item.key && !item.key.endsWith("｜未填负责人"))
    .sort((a, b) => sourceDepartmentRank(a) - sourceDepartmentRank(b) || b.sales_qty - a.sales_qty);
  const ownerNames = ownerRows.map((item) => item.key);
  const ownerMeta = new Map(
    ownerRows.map((item) => {
      const manager = item.rows.find((row) => row.source_manager)?.source_manager || "未填负责人";
      const department = item.rows.find((row) => row.source_department)?.source_department || "未识别归属";
      const accounts = groupByRankingQty(item.rows, (row) => row.source_detail || row.influencer_name || "未知账号")
        .filter((row) => row.key && row.key !== "未知账号")
        .sort((a, b) => b.sales_qty - a.sales_qty)
        .map((row) => `${row.key}(${fmt.format(row.sales_qty)})`);
      return [item.key, { department, manager, accounts, label: `${department}\n${manager}` }];
    }),
  );
  const ownerLabels = ownerNames.map((name) => ownerMeta.get(name)?.label || name);
  const seriesTotals = new Map();
  const matrix = new Map();

  ownerNames.forEach((ownerName) => {
    const rows = groupByRankingQty(
      baseFacts.filter((item) => ownerKey(item) === ownerName),
      (item) => item.book_series || "未匹配商品",
    )
      .filter((item) => item.key && item.key !== "其他书系")
      .sort((a, b) => b.sales_qty - a.sales_qty)
      .slice(0, 3);
    rows.forEach((row) => {
      seriesTotals.set(row.key, (seriesTotals.get(row.key) || 0) + row.sales_qty);
      matrix.set(`${ownerName}|${row.key}`, row.sales_qty);
    });
  });

  const seriesNames = [...seriesTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const heatData = [];
  let maxValue = 0;
  ownerNames.forEach((ownerName, xIndex) => {
    seriesNames.forEach((seriesName, yIndex) => {
      const value = matrix.get(`${ownerName}|${seriesName}`) || 0;
      if (value > 0) {
        maxValue = Math.max(maxValue, value);
        heatData.push([xIndex, yIndex, value]);
      }
    });
  });

  const meta = byId("roomSeriesHeatmapMeta");
  if (meta) {
    meta.textContent = ownerNames.length
      ? `直播间：${fmt.format(ownerNames.length)} 个负责人、${fmt.format(seriesNames.length)} 个前三书系`
      : "当前筛选下暂无直播间数据";
  }

  charts.roomSeriesHeatmap.clear();
  charts.roomSeriesHeatmap.setOption({
    tooltip: {
      position: "top",
      formatter: (params) => {
        const [xIndex, yIndex, value] = params.value;
        const ownerName = ownerNames[xIndex];
        const meta = ownerMeta.get(ownerName) || {};
        const accounts = meta.accounts?.length ? `<br/>账号：${meta.accounts.join("、")}` : "";
        return `归属：${meta.department || "未识别归属"}<br/>负责人：${meta.manager || "未填负责人"}${accounts}<br/>书系：${seriesNames[yIndex]}<br/>排名销量：${fmt.format(value)}`;
      },
    },
    grid: { left: phone ? 112 : 190, right: phone ? 46 : 76, top: phone ? 150 : 170, bottom: phone ? 58 : 70 },
    xAxis: {
      type: "category",
      position: "top",
      data: ownerLabels,
      axisLabel: { interval: 0, rotate: phone ? 38 : 32, width: phone ? 92 : 132, overflow: "truncate" },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: seriesNames,
      inverse: true,
      axisLabel: { width: phone ? 92 : 170, overflow: "truncate" },
      splitArea: { show: true },
    },
    dataZoom: [
      {
        type: "slider",
        xAxisIndex: 0,
        bottom: phone ? 4 : 10,
        height: 18,
        start: 0,
        end: ownerNames.length > (phone ? 6 : 10) ? Math.max(18, ((phone ? 6 : 10) / ownerNames.length) * 100) : 100,
        brushSelect: false,
      },
      {
        type: "slider",
        yAxisIndex: 0,
        right: 6,
        width: 14,
        start: 0,
        end: seriesNames.length > (phone ? 8 : 12) ? Math.max(22, ((phone ? 8 : 12) / seriesNames.length) * 100) : 100,
        brushSelect: false,
      },
      { type: "inside", xAxisIndex: 0 },
      { type: "inside", yAxisIndex: 0 },
    ],
    visualMap: {
      min: 0,
      max: Math.max(maxValue, 1),
      orient: "horizontal",
      left: "center",
      top: 20,
      calculable: true,
      inRange: { color: ["#f8fafc", "#dbeafe", "#60a5fa", "#4f46e5", "#312e81"] },
      textStyle: { color: "#475467" },
    },
    series: [
      {
        name: "负责人书系销量",
        type: "heatmap",
        data: heatData,
        label: {
          show: !phone,
          formatter: (params) => (params.value[2] ? fmt.format(params.value[2]) : ""),
          color: "#0f172a",
          fontSize: 11,
        },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(49, 46, 129, 0.28)" } },
      },
    ],
  });
}

function addSankeyLink(links, source, target, value) {
  if (!source || !target || source === target || !value) return;
  const key = `${source}|||${target}`;
  links.set(key, { source, target, value: (links.get(key)?.value || 0) + value });
}

function renderSankey(facts) {
  const phone = isPhone();
  const links = new Map();
  const nodes = new Map();
  const resolveSankeyValue = buildSankeyValueResolvers(facts);

  for (const item of facts) {
    const path = sankeyDimensions.map((dimension, depth) => {
      const label = resolveSankeyValue[dimension.key](item);
      const nodeName = sankeyNodeKey(dimension.key, label);
      if (!nodes.has(nodeName)) {
        nodes.set(nodeName, { name: nodeName, depth, label });
      }
      return nodeName;
    });
    for (let index = 0; index < path.length - 1; index += 1) {
      addSankeyLink(links, path[index], path[index + 1], item.sales_qty);
    }
  }

  charts.sankey.clear();
  charts.sankey.setOption({
    tooltip: {
      trigger: "item",
      triggerOn: "mousemove",
      formatter: (params) => {
        if (params.dataType === "edge") {
          return `${sankeyDisplayLabel(params.data.source)} → ${sankeyDisplayLabel(params.data.target)}<br/>销量：${fmt.format(params.data.value || 0)}`;
        }
        return `${sankeyDisplayLabel(params.name)}<br/>销量：${fmt.format(params.value || 0)}`;
      },
    },
    series: [
      {
        type: "sankey",
        top: phone ? 8 : 12,
        bottom: phone ? 10 : 18,
        left: phone ? 6 : 18,
        right: phone ? 96 : 180,
        nodeWidth: phone ? 10 : 14,
        nodeGap: phone ? 8 : 12,
        layoutIterations: phone ? 48 : 64,
        emphasis: { focus: "adjacency" },
        lineStyle: { color: "gradient", curveness: 0.48, opacity: 0.35 },
        label: {
          color: "#344054",
          fontSize: phone ? 10 : 12,
          width: phone ? 86 : 180,
          overflow: "truncate",
          ellipsis: "...",
          formatter: (params) => sankeyDisplayLabel(params.name),
        },
        data: [...nodes.values()],
        links: [...links.values()],
      },
    ],
  });
}

function aggregateRows(facts, keys) {
  const map = new Map();
  for (const item of facts) {
    const key = keys.map((field) => item[field]).join("|||");
    if (!map.has(key)) {
      const row = {};
      keys.forEach((field) => (row[field] = item[field]));
      row.sales_qty = 0;
      row.sales_amount = 0;
      row.order_count = 0;
      map.set(key, row);
    }
    const row = map.get(key);
    row.sales_qty += item.sales_qty;
    row.sales_amount += Number(item.sales_amount) || 0;
    row.order_count += item.order_count;
  }
  return [...map.values()].sort((a, b) => b.sales_qty - a.sales_qty);
}

function renderTable(headers, rows) {
  byId("tableMeta").textContent = `显示 ${fmt.format(Math.min(rows.length, 300))} / ${fmt.format(rows.length)} 行`;
  byId("tableHead").innerHTML = `<tr>${headers
    .map((header) => `<th class="${header.num ? "num" : ""}">${header.label}</th>`)
    .join("")}</tr>`;
  byId("tableBody").innerHTML = rows
    .slice(0, 300)
    .map(
      (row) =>
        `<tr>${headers
          .map((header) => {
            const value = row[header.key] ?? "";
            const text = header.currency ? moneyFmt.format(Number(value) || 0) : header.num ? fmt.format(value) : value;
            return `<td class="${header.num ? "num" : ""}">${text}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
}

function filteredQueryParams() {
  const params = new URLSearchParams();
  const dateWindow = currentDateWindow();
  if (dateWindow.start) params.set("date_start", dateWindow.start);
  if (dateWindow.end) params.set("date_end", dateWindow.end);
  Object.keys(filterFields).forEach((filterKey) => {
    const values = effectiveFilterValue(filterKey);
    if (values.length > 0) params.set(filterKey, values.join(","));
  });
  return params;
}

async function renderServerTable(tab, headers) {
  const token = ++tableLoadToken;
  byId("tableMeta").textContent = "加载中...";
  byId("tableHead").innerHTML = `<tr>${headers.map((header) => `<th class="${header.num ? "num" : ""}">${header.label}</th>`).join("")}</tr>`;
  byId("tableBody").innerHTML = "";
  const params = filteredQueryParams();
  params.set("tab", tab);
  const response = await fetch(`./api/table-data?${params.toString()}`, { cache: "no-store" });
  if (token !== tableLoadToken) return;
  if (!response.ok) {
    byId("tableMeta").textContent = "明细加载失败";
    return;
  }
  const payload = await response.json();
  renderTable(headers, payload.rows || []);
}

function renderActiveTable(facts) {
  const commonNum = [
    { key: "sales_qty", label: "销量", num: true },
    { key: "sales_amount", label: "成交额", num: true, currency: true },
    { key: "order_count", label: "子订单数", num: true },
  ];
  if (state.activeTab === "series") {
    byId("tableTitle").textContent = "书系明细";
    renderServerTable("series", [
      { key: "book_series", label: "书系" },
      { key: "project_department", label: "产品归属" },
      { key: "project_owner", label: "负责人" },
      { key: "segment", label: "学段" },
      { key: "subject", label: "学科" },
      ...commonNum,
    ]);
  } else if (state.activeTab === "source") {
    byId("tableTitle").textContent = "来源明细";
    renderServerTable("source", [
      { key: "source_type", label: "来源类型" },
      { key: "store", label: "店铺" },
      { key: "source_department", label: "销售归属" },
      { key: "source_manager", label: "负责人" },
      { key: "source_group", label: "账号组" },
      { key: "source_detail", label: "来源明细" },
      { key: "content_type", label: "流量体裁" },
      { key: "traffic_channel", label: "流量渠道" },
      ...commonNum,
    ]);
  } else if (state.activeTab === "product") {
    byId("tableTitle").textContent = "商品匹配";
    renderServerTable("product", [
      { key: "merchant_code", label: "商家编码" },
      { key: "product_name", label: "商品名" },
      { key: "book_series", label: "书系" },
      { key: "project_department", label: "产品归属" },
      { key: "project_owner", label: "负责人" },
      { key: "matched_label", label: "归属方式" },
      ...commonNum,
    ]);
  } else if (state.activeTab === "influencer") {
    byId("tableTitle").textContent = "达人";
    renderServerTable("influencer", [
      { key: "influencer_id", label: "达人ID" },
      { key: "influencer_name", label: "达人昵称" },
      { key: "source_owner", label: "归属" },
      { key: "source_type", label: "来源类型" },
      { key: "source_department", label: "销售归属" },
      { key: "source_manager", label: "负责人" },
      { key: "source_group", label: "账号组" },
      ...commonNum,
    ]);
  } else {
    byId("tableTitle").textContent = "质量检查";
    const checks = state.data.quality_checks;
    const rows = [
      { item: "每日销量合计校验", result: checks.daily_total_equals_valid_qty ? "通过" : "异常", note: "每日汇总 = 有效销量" },
      { item: "事实表合计校验", result: checks.fact_total_equals_valid_qty ? "通过" : "异常", note: "事实表汇总 = 有效销量" },
      { item: "来源合计校验", result: checks.source_total_equals_valid_qty ? "通过" : "异常", note: "来源汇总 = 有效销量" },
      { item: "成交额口径", result: moneyFmt.format(state.data.summary.valid_sales_amount || 0), note: state.data.summary.sales_amount_formula || "订单应付金额 + 平台实际承担优惠金额 + 达人实际承担优惠金额" },
      { item: "事实表成交额校验", result: checks.fact_total_equals_valid_amount ? "通过" : "异常", note: "事实表成交额 = 有效成交额" },
      { item: "ROI", result: "待接入", note: state.data.summary.roi_note || "待接入投流相关费用后计算" },
      { item: "日期覆盖", result: `${checks.date_count} 天`, note: `${state.data.summary.date_min} 至 ${state.data.summary.date_max}` },
      { item: "自编码匹配率", result: pct.format(state.data.summary.product_match_rate), note: "订单商家编码 = 商品信息自编码" },
      { item: "书系归属率", result: pct.format(state.data.summary.series_attribution_rate), note: "自编码匹配 + 标题识别书系" },
      {
        item: "学段关键词冲突",
        result: checks.segment_keyword_conflict_sales_qty ? `异常 ${fmt.format(checks.segment_keyword_conflict_sales_qty)}` : "通过",
        note: "书系/品名/年级含高中、初中、小学关键词时，校验最终学段是否一致",
      },
      ...(checks.top_segment_keyword_conflicts || []).slice(0, 20).map((item) => ({
        item: `学段冲突｜${item.book_series}`,
        result: fmt.format(item.sales_qty),
        note: `应为${item.expected_segment}，当前${item.actual_segment}｜${item.product_name}`,
      })),
      ...checks.top_unmatched_products.slice(0, 20).map((item) => ({
        item: `未匹配商品 ${item.merchant_code}`,
        result: fmt.format(item.sales_qty),
        note: item.product_name,
      })),
      ...checks.top_unrecognized_sources.slice(0, 20).map((item) => ({
        item: `未识别来源 ${item.source_detail}`,
        result: fmt.format(item.sales_qty),
        note: `${item.traffic_source} / ${item.content_type}`,
      })),
    ];
    renderTable(
      [
        { key: "item", label: "检查项" },
        { key: "result", label: "结果/销量" },
        { key: "note", label: "说明" },
      ],
      rows,
    );
  }
}

// ---- Region Analysis ----

let _chinaGeoJSON = null;
let _provinceIndex = null;            // { provinces: { adcode: { name, file, city_count } } }
const _provinceGeoCache = new Map();  // adcode -> GeoJSON object
const _provinceNameToAdcode = new Map(); // data province name -> { adcode, geoName }

async function loadChinaMap() {
  try {
    const resp = await fetch("./assets/china_geojson.json", { cache: "force-cache" });
    _chinaGeoJSON = await resp.json();
    echarts.registerMap("china", _chinaGeoJSON);
    // Build province name -> adcode mapping for drill-down
    _provinceNameToAdcode.clear();
    for (const feat of _chinaGeoJSON.features) {
      const props = feat.properties || {};
      if (props.adcode && props.name) {
        _provinceNameToAdcode.set(props.name, { adcode: props.adcode, geoName: props.name });
      }
    }
  } catch (err) {
    console.warn("Failed to load China map geoJSON:", err);
  }
  // Load province index for drill-down
  try {
    const resp = await fetch("./assets/provinces/index.json", { cache: "force-cache" });
    _provinceIndex = await resp.json();
  } catch (err) {
    console.warn("Failed to load province index:", err);
  }
}

// Match a data province name to a GeoJSON province name and get its adcode
function lookupProvinceAdcode(dataName) {
  if (!dataName || !_chinaGeoJSON) return null;
  // Direct match against geoJSON names
  for (const feat of _chinaGeoJSON.features) {
    const geoName = feat.properties?.name || "";
    if (geoName === dataName) return { adcode: feat.properties.adcode, geoName };
  }
  // Fuzzy match
  for (const feat of _chinaGeoJSON.features) {
    const geoName = feat.properties?.name || "";
    if (geoName.includes(dataName) || dataName.includes(geoName)) {
      return { adcode: feat.properties.adcode, geoName };
    }
    if (geoName.length >= 2 && dataName.length >= 2 &&
        (geoName.startsWith(dataName.slice(0, 2)) || dataName.startsWith(geoName.slice(0, 2)))) {
      return { adcode: feat.properties.adcode, geoName };
    }
  }
  return null;
}

function getProvinceMapKey(adcode) {
  return `province_${adcode}`;
}

async function loadProvinceMap(adcode) {
  // Return cached if already loaded
  const mapKey = getProvinceMapKey(adcode);
  if (_provinceGeoCache.has(adcode)) {
    return _provinceGeoCache.get(adcode);
  }
  // Check if already registered
  if (echarts.getMap(mapKey)) {
    const geo = _provinceGeoCache.get(adcode) || { features: [] };
    return geo;
  }
  try {
    const resp = await fetch(`./assets/provinces/${adcode}.json`, { cache: "force-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const geoJSON = await resp.json();
    echarts.registerMap(mapKey, geoJSON);
    _provinceGeoCache.set(adcode, geoJSON);
    return geoJSON;
  } catch (err) {
    console.warn(`Failed to load province map for adcode ${adcode}:`, err);
    return null;
  }
}

function goBackToNational() {
  state.mapLevel = "country";
  state.currentMapProvince = null;
  state.selectedProvince = "";
  state.selectedCity = "";
  const backBtn = byId("mapBackBtn");
  if (backBtn) backBtn.style.display = "none";
  // Reset time slider to "all dates"
  const slider = byId("regionTimeSlider");
  if (slider) slider.value = slider.max || 100;
  renderRegionAnalysis();
}

function getRegionData() {
  return (state.data?.dimensions?.region) || [];
}

function getHourData() {
  return (state.data?.dimensions?.hour) || [];
}

function getPriceBandData() {
  return (state.data?.dimensions?.price_band) || [];
}

function getAftersaleData() {
  return (state.data?.dimensions?.aftersale) || [];
}

function hasFactFields(fields) {
  const facts = state.data?.facts || [];
  return fields.every((field) =>
    facts.some((row) =>
      Object.prototype.hasOwnProperty.call(row, field) &&
      String(row[field] ?? "") !== "",
    ),
  );
}

function aggregateFacts(rows, fields) {
  const map = new Map();
  rows.forEach((row) => {
    const key = fields.map((field) => String(row[field] ?? "")).join("\u0001");
    if (!map.has(key)) {
      const target = { sales_qty: 0, sales_amount: 0, order_count: 0 };
      fields.forEach((field) => { target[field] = row[field] ?? ""; });
      map.set(key, target);
    }
    const target = map.get(key);
    target.sales_qty += Number(row.sales_qty) || 0;
    target.sales_amount += Number(row.sales_amount) || 0;
    target.order_count += Number(row.order_count) || 0;
  });
  return [...map.values()];
}

function _regionBookSeriesFilter() {
  const activeSeries = effectiveFilterValue("bookSeries");
  return activeSeries.length > 0 ? new Set(activeSeries) : null;
}

function renderRegionAnalysis() {
  const dateWindow = currentDateWindow();
  const useFactRegion = hasFactFields(["province", "city"]);
  const regionData = useFactRegion
    ? aggregateFacts(
      filterFacts().filter((item) => item.province && item.city),
      ["province", "city", "date", "book_series", "segment"],
    )
    : getRegionData();
  let inRange = regionData;
  if (!useFactRegion) {
    // Build comprehensive filter sets for agg-based fallback
    const dateFilter = (item) => item.date >= dateWindow.start && item.date <= dateWindow.end;
    const activeFilters = [];
    for (const [filterKey, factKey] of Object.entries(filterFields)) {
      const values = effectiveFilterValue(filterKey);
      if (values.length > 0) {
        activeFilters.push({ factKey, set: new Set(values) });
      }
    }
    inRange = regionData.filter((item) => {
      if (!dateFilter(item)) return false;
      for (const f of activeFilters) {
        // Only apply if the agg row has this field (skip missing fields silently)
        if (!Object.prototype.hasOwnProperty.call(item, f.factKey)) continue;
        if (!f.set.has(item[f.factKey] ?? "")) return false;
      }
      return true;
    });
  }
  const phone = isPhone();

  // Build province-level data map
  const allDates = [...new Set(inRange.map((item) => item.date))].sort();
  const provByDate = new Map(); // prov -> Map(date -> qty)
  const provTotals = new Map();
  inRange.forEach((item) => {
    if (!provByDate.has(item.province)) provByDate.set(item.province, new Map());
    provByDate.get(item.province).set(item.date, (provByDate.get(item.province).get(item.date) || 0) + item.sales_qty);
    provTotals.set(item.province, (provTotals.get(item.province) || 0) + item.sales_qty);
  });

  // Province name normalization for geoJSON matching
  const geoProvNames = new Set(_chinaGeoJSON ? _chinaGeoJSON.features.map((f) => f.properties.name) : []);
  const nameMap = new Map();
  provTotals.forEach((_, name) => {
    if (geoProvNames.has(name)) { nameMap.set(name, name); return; }
    for (const geo of geoProvNames) {
      if (geo.includes(name) || name.includes(geo)) { nameMap.set(name, geo); return; }
      if (geo.length >= 2 && name.length >= 2 && (geo.startsWith(name.slice(0, 2)) || name.startsWith(geo.slice(0, 2)))) { nameMap.set(name, geo); return; }
    }
    nameMap.set(name, name);
  });

  // Time slider state
  const slider = byId("regionTimeSlider");
  const sliderLabel = byId("regionTimeLabel");
  if (slider && allDates.length > 0) {
    slider.max = allDates.length;
    if (parseInt(slider.value) > allDates.length) slider.value = allDates.length;
  }
  const stepIndex = Math.min(parseInt(slider?.value || "0"), allDates.length);
  const showAll = stepIndex >= allDates.length;

  if (sliderLabel) {
    sliderLabel.textContent = showAll ? `全部 (${allDates.length}天)` : (allDates[stepIndex] || "");
  }

  // Build map data
  const mapData = [];
  provTotals.forEach((totalQty, prov) => {
    const geoName = nameMap.get(prov) || prov;
    let qty = 0;
    if (showAll) {
      qty = totalQty;
    } else {
      const dm = provByDate.get(prov);
      if (dm) { for (let i = 0; i <= stepIndex && i < allDates.length; i++) { qty += dm.get(allDates[i]) || 0; } }
    }
    if (qty > 0) mapData.push({ name: geoName, province: prov, value: qty });
  });

  const maxMapVal = Math.max(1, ...mapData.map((d) => d.value));
  const displayedTotal = mapData.reduce((sum, row) => sum + row.value, 0);
  const provinceRows = [...provTotals.entries()]
    .map(([province, total]) => ({
      province,
      geoName: nameMap.get(province) || province,
      total,
    }))
    .sort((a, b) => b.total - a.total);
  const selectedGeoName = state.selectedProvince
    ? (nameMap.get(state.selectedProvince) || state.selectedProvince)
    : "";
  byId("regionProvinceMeta").textContent = state.mapLevel === "province"
    ? `${state.currentMapProvince?.name || ""} · 城市分布 ｜ ${dateWindow.label} ｜ 覆盖 ${mapData.length} 个省份`
    : `${dateWindow.label} ｜ 覆盖 ${mapData.length} 个省 ｜ 当前显示销量 ${fmt.format(displayedTotal)}`;
  const rankMeta = byId("regionRankMeta");
  if (rankMeta) {
    rankMeta.textContent = state.mapLevel === "province"
      ? `已下钻 ${state.currentMapProvince?.name || ""}，可点击城市聚焦`
      : state.selectedProvince ? `已聚焦 ${state.selectedProvince}，再次点击可取消` : "点击省份聚焦城市与书系趋势";
  }
  const rankList = byId("regionProvinceRank");
  if (rankList) {
    if (state.mapLevel === "province") {
      // In province drill-down, show city rank list
      const provFacts = inRange.filter((item) => item.province === (state.currentMapProvince?.name || state.selectedProvince));
      const cityRows = groupBy(provFacts, (item) => item.city)
        .sort((a, b) => b.sales_qty - a.sales_qty);
      rankList.innerHTML = [
        `<button class="province-rank-button ${state.selectedCity ? "" : "active"}" type="button" data-city="">` +
          `<span class="province-rank-index">全</span><span class="province-rank-name">全部城市</span><span class="province-rank-value">${fmt.format(cityRows.reduce((s, r) => s + r.sales_qty, 0))}</span>` +
        `</button>`,
        ...cityRows.slice(0, 30).map((row, index) =>
          `<button class="province-rank-button ${state.selectedCity === row.key ? "active" : ""}" type="button" data-city="${escapeHtml(row.key)}">` +
            `<span class="province-rank-index">${index + 1}</span>` +
            `<span class="province-rank-name">${escapeHtml(row.key)}</span>` +
            `<span class="province-rank-value">${fmt.format(row.sales_qty)}</span>` +
          `</button>`
        ),
      ].join("");
    } else {
      // Country level: province rank list
      rankList.innerHTML = [
        `<button class="province-rank-button ${state.selectedProvince ? "" : "active"}" type="button" data-province="">` +
          `<span class="province-rank-index">全</span><span class="province-rank-name">全国</span><span class="province-rank-value">${fmt.format(displayedTotal)}</span>` +
        `</button>`,
        ...provinceRows.slice(0, 18).map((row, index) =>
          `<button class="province-rank-button ${state.selectedProvince === row.province ? "active" : ""}" type="button" data-province="${escapeHtml(row.province)}">` +
            `<span class="province-rank-index">${index + 1}</span>` +
            `<span class="province-rank-name">${escapeHtml(row.province)}</span>` +
            `<span class="province-rank-value">${fmt.format(row.total)}</span>` +
          `</button>`
        ),
      ].join("");
    }
  }

  // --- Map rendering: country or province drill-down ---
  if (state.mapLevel === "province" && state.currentMapProvince) {
    // === Province city-level map ===
    const provAdcode = state.currentMapProvince.adcode;
    const mapKey = getProvinceMapKey(provAdcode);
    const provGeo = _provinceGeoCache.get(provAdcode);
    const cityFeatures = provGeo?.features || [];
    const cityNames = new Set(cityFeatures.map((f) => f.properties?.name || ""));

    // Build city sales data from inRange
    const citySales = new Map();
    inRange.forEach((item) => {
      if (item.province === state.currentMapProvince.name || item.province === state.selectedProvince) {
        citySales.set(item.city, (citySales.get(item.city) || 0) + item.sales_qty);
      }
    });

    // Match city names to geoJSON feature names
    const cityNameMap = new Map();
    citySales.forEach((_, cName) => {
      for (const geoName of cityNames) {
        if (geoName === cName || geoName.includes(cName) || cName.includes(geoName)) {
          cityNameMap.set(cName, geoName);
          return;
        }
        if (geoName.length >= 2 && cName.length >= 2 && (geoName.startsWith(cName.slice(0, 2)) || cName.startsWith(geoName.slice(0, 2)))) {
          cityNameMap.set(cName, geoName);
          return;
        }
      }
      cityNameMap.set(cName, cName);
    });

    // Build city map data
    const cityMapData = [];
    const seenGeo = new Set();
    citySales.forEach((qty, cName) => {
      const geoName = cityNameMap.get(cName) || cName;
      if (qty > 0 && !seenGeo.has(geoName)) {
        cityMapData.push({ name: geoName, city: cName, value: qty });
        seenGeo.add(geoName);
      }
    });
    // Add cities with no sales (for complete map display)
    cityFeatures.forEach((f) => {
      const geoName = f.properties?.name || "";
      if (!seenGeo.has(geoName)) {
        cityMapData.push({ name: geoName, city: geoName, value: 0 });
        seenGeo.add(geoName);
      }
    });

    const cityMaxVal = Math.max(1, ...cityMapData.map((d) => d.value));
    const cityDisplayedTotal = cityMapData.reduce((sum, row) => sum + row.value, 0);

    // Province map title
    const mapTitleEl = byId("regionProvinceMeta");
    if (mapTitleEl) {
      mapTitleEl.textContent = `${state.currentMapProvince.name} · 城市销量分布 ｜ 总销量 ${fmt.format(cityDisplayedTotal)}`;
    }
    // Update zoom hint
    const zoomHint = byId("mapZoomHint");
    if (zoomHint) zoomHint.textContent = "🖱 滚轮缩放 ｜ 拖拽移动 ｜ 点击城市聚焦";

    // Province map controls (back button managed via HTML)
    const backBtn = byId("mapBackBtn");
    if (backBtn) backBtn.style.display = "";

    charts.chinaMap.setOption({
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const value = Number(params.value || 0);
          const share = cityDisplayedTotal ? value / cityDisplayedTotal : 0;
          return `${params.data?.city || params.name}<br/>销量: ${fmt.format(value)}<br/>占比: ${pct.format(share)}`;
        },
      },
      visualMap: {
        min: 0,
        max: cityMaxVal,
        orient: "horizontal",
        left: "center",
        bottom: 8,
        calculable: false,
        itemWidth: 14,
        itemHeight: 180,
        inRange: { color: ["#f0f9ff", "#bae6fd", "#7dd3fc", "#0ea5e9", "#0284c7", "#0369a1", "#0c4a6e"] },
        text: ["高销量", "低销量"],
        textStyle: { fontSize: 10 },
      },
      series: [{
        type: "map",
        map: mapKey,
        selectedMode: "single",
        roam: true,
        layoutCenter: phone ? ["50%", "45%"] : ["50%", "46%"],
        layoutSize: phone ? "118%" : "102%",
        scaleLimit: { min: 0.8, max: 10 },
        label: { show: true, fontSize: phone ? 9 : 11, color: "#334155" },
        emphasis: {
          label: { show: true, fontSize: phone ? 12 : 14, fontWeight: "bold" },
          itemStyle: { areaColor: "#fbbf24" },
        },
        select: {
          label: { show: true, fontSize: phone ? 11 : 13, fontWeight: "bold", color: "#7c2d12" },
          itemStyle: { areaColor: "#f59e0b", borderColor: "#b45309", borderWidth: 1.6 },
        },
        itemStyle: { borderColor: "#ffffff", borderWidth: 1 },
        data: cityMapData.map((row) => ({
          ...row,
          selected: state.selectedCity && row.city === state.selectedCity,
        })),
      }],
    }, { notMerge: true });
  } else if (_chinaGeoJSON) {
    // === Country China map (existing behavior, enhanced) ===
    const backBtn = byId("mapBackBtn");
    if (backBtn) backBtn.style.display = "none";
    const zoomHint = byId("mapZoomHint");
    if (zoomHint) zoomHint.textContent = "🖱 滚轮缩放 ｜ 拖拽移动 ｜ 点击省份下钻";

    charts.chinaMap.setOption({
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const value = Number(params.value || 0);
          const share = displayedTotal ? value / displayedTotal : 0;
          return `${params.data?.province || params.name}<br/>销量: ${fmt.format(value)}<br/>占比: ${pct.format(share)}<br/><small>点击下钻到城市</small>`;
        },
      },
      visualMap: {
        min: 0,
        max: maxMapVal,
        orient: "horizontal",
        left: "center",
        bottom: 8,
        calculable: false,
        itemWidth: 14,
        itemHeight: 180,
        inRange: { color: ["#f0f9ff", "#bae6fd", "#7dd3fc", "#0ea5e9", "#0284c7", "#0369a1", "#0c4a6e"] },
        text: ["高销量", "低销量"],
        textStyle: { fontSize: 10 },
      },
      series: [{
        type: "map",
        map: "china",
        selectedMode: "single",
        roam: true,
        layoutCenter: phone ? ["50%", "45%"] : ["50%", "46%"],
        layoutSize: phone ? "112%" : "96%",
        scaleLimit: { min: 0.8, max: 8 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 14, fontWeight: "bold" },
          itemStyle: { areaColor: "#fbbf24" },
        },
        select: {
          label: { show: true, fontSize: 13, fontWeight: "bold", color: "#7c2d12" },
          itemStyle: { areaColor: "#f59e0b", borderColor: "#b45309", borderWidth: 1.2 },
        },
        itemStyle: { borderColor: "#ffffff", borderWidth: 1 },
        data: mapData.map((row) => ({
          ...row,
          selected: selectedGeoName && row.name === selectedGeoName,
        })),
      }],
    }, { notMerge: true });
  } else {
    charts.chinaMap.setOption({
      title: { text: "地图加载中...", left: "center", top: "center", textStyle: { color: "#94a3b8", fontSize: 16 } },
    }, { notMerge: true });
  }

  // --- City bar chart (national when no province selected) ---
  const provFiltered = state.selectedProvince
    ? inRange.filter((item) => item.province === state.selectedProvince)
    : inRange;
  const cityFiltered = state.selectedCity && state.mapLevel === "province"
    ? provFiltered.filter((item) => item.city === state.selectedCity)
    : provFiltered;
  const cityGroups = groupBy(cityFiltered, (item) => item.city)
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .slice(0, 20);

  if (state.mapLevel === "province") {
    const provTotalQty = provTotals.get(state.selectedProvince) || 0;
    if (state.selectedCity) {
      const cityQty = provFiltered.filter((item) => item.city === state.selectedCity).reduce((s, r) => s + r.sales_qty, 0);
      byId("regionCityTitle").textContent = `${state.selectedCity} · 书系贡献`;
      byId("regionCityMeta").textContent = `城市销量 ${fmt.format(cityQty)} ｜ 点击城市可切换`;
    } else {
      byId("regionCityTitle").textContent = `${state.selectedProvince} · 城市销量 Top20`;
      byId("regionCityMeta").textContent = `总销量 ${fmt.format(provTotalQty)} ｜ 点击地图城市聚焦`;
    }
  } else if (state.selectedProvince) {
    const provTotalQty = provTotals.get(state.selectedProvince) || 0;
    byId("regionCityTitle").textContent = `${state.selectedProvince} · 城市销量 Top20`;
    byId("regionCityMeta").textContent = `总销量 ${fmt.format(provTotalQty)} ｜ 点击地图省份下钻`;
  } else {
    byId("regionCityTitle").textContent = "全国 · 城市销量 Top20";
    byId("regionCityMeta").textContent = `显示 ${cityGroups.length} 个城市 ｜ 点击地图省份可聚焦`;
  }

  charts.cityBar.setOption({
    color: ["#0ea5e9"],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: phone ? 88 : 120, right: 48, top: 8, bottom: 16 },
    xAxis: { type: "value", axisLabel: { fontSize: 11 } },
    yAxis: {
      type: "category",
      data: cityGroups.map((item) => item.key).reverse(),
      axisLabel: { fontSize: phone ? 10 : 12, overflow: "truncate", width: phone ? 72 : 108 },
    },
    series: [{
      type: "bar",
      data: cityGroups.map((item) => item.sales_qty).reverse(),
      label: { show: true, position: "right", fontSize: 11, formatter: (p) => fmt.format(p.value) },
      barWidth: phone ? 10 : 14,
    }],
  }, { notMerge: true });

  // --- Region trend chart (wider grid-left for long book series names) ---
  const trendFiltered = state.selectedCity && state.mapLevel === "province"
    ? inRange.filter((item) => item.province === state.selectedProvince && item.city === state.selectedCity)
    : state.selectedProvince
      ? inRange.filter((item) => item.province === state.selectedProvince)
      : inRange;
  const trendDates = [...new Set(trendFiltered.map((item) => item.date))].sort();
  const seriesAgg = groupBy(trendFiltered, (item) => item.book_series)
    .sort((a, b) => b.sales_qty - a.sales_qty);
  const topSeries = seriesAgg.filter((s) => s.key && s.key !== "未匹配商品").slice(0, 8);
  const topNames = topSeries.map((s) => s.key);
  const regionLabel = state.selectedCity && state.mapLevel === "province"
    ? state.selectedCity
    : state.selectedProvince || "全国";
  const regionTotal = seriesAgg.reduce((a, s) => a + s.sales_qty, 0);

  byId("regionTrendTitle").textContent = `${regionLabel} · 书系日趋势`;
  byId("regionTrendMeta").textContent = topNames.length
    ? `Top ${topNames.length} 书系（${dateWindow.label}）｜ 总销量 ${fmt.format(regionTotal)}`
    : "该区域暂无足够数据";

  const trendSeriesData = topNames.map((seriesName) => {
    const seriesRows = trendFiltered.filter((item) => item.book_series === seriesName);
    const dateMap = new Map();
    seriesRows.forEach((row) => dateMap.set(row.date, (dateMap.get(row.date) || 0) + row.sales_qty));
    return {
      name: seriesName,
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 3,
      lineStyle: { width: 2.4 },
      data: trendDates.map((d) => dateMap.get(d) || 0),
    };
  });

  charts.regionTrend.setOption({
    color: chartColors,
    tooltip: { trigger: "axis" },
    legend: {
      type: "scroll",
      bottom: 0,
      itemWidth: 16,
      itemGap: 14,
      textStyle: { fontSize: 11 },
      pageTextStyle: { fontSize: 11 },
    },
    grid: { left: phone ? 48 : 72, right: 28, top: 20, bottom: phone ? 52 : 60 },
    xAxis: { type: "category", data: trendDates, boundaryGap: false, axisLabel: { hideOverlap: true, interval: phone ? 4 : "auto" } },
    yAxis: { type: "value", name: phone ? "" : "销量", nameLocation: "end", nameGap: 14 },
    series: trendSeriesData,
  }, { notMerge: true });
}

// ---- Ops Analysis (Hour + Price Box + Aftersale) ----

function renderOpsAnalysis() {
  const dateWindow = currentDateWindow();
  const phone = isPhone();
  const factRows = filterFacts();

  // Build comprehensive filter sets from ALL active filters
  function _buildFilterSet(filterKey) {
    const values = effectiveFilterValue(filterKey);
    return values.length > 0 ? new Set(values) : null;
  }
  const filterSets = {};
  for (const [filterKey, factKey] of Object.entries(filterFields)) {
    filterSets[filterKey] = { factKey, set: _buildFilterSet(filterKey) };
  }

  // Filter helpers for agg data — apply ALL active filters, not just a subset
  function _inDateRange(item) { return item.date ? (item.date >= dateWindow.start && item.date <= dateWindow.end) : true; }
  function _filterAgg(data, availableFields) {
    return data.filter((item) => {
      if (!_inDateRange(item)) return false;
      for (const [, cfg] of Object.entries(filterSets)) {
        if (!cfg.set) continue;
        // Only apply filter if the column exists in this agg table
        if (!availableFields.includes(cfg.factKey)) continue;
        const itemValue = item[cfg.factKey] ?? "";
        if (!cfg.set.has(itemValue)) return false;
      }
      return true;
    });
  }

  const hourData = hasFactFields(["order_hour", "order_weekday"])
    ? aggregateFacts(
      factRows.filter((item) => String(item.order_hour ?? "") !== "" && String(item.order_weekday ?? "") !== ""),
      ["order_hour", "order_weekday", "book_series", "source_type"],
    ).map((row) => ({ ...row, hour: Number(row.order_hour), weekday: Number(row.order_weekday) }))
    : _filterAgg(getHourData(), ["book_series", "source_type", "date"]);
  const priceData = hasFactFields(["price_band"])
    ? aggregateFacts(
      factRows.filter((item) => item.price_band),
      ["price_band", "book_series", "segment"],
    )
    : _filterAgg(getPriceBandData(), ["book_series", "segment", "date"]);
  const aftersaleAgg = getAftersaleData();
  const aftersaleData = aftersaleAgg.length
    ? _filterAgg(aftersaleAgg, ["book_series", "store", "date", "province", "segment"])
    : aggregateFacts(
      factRows.filter((item) => Object.prototype.hasOwnProperty.call(item, "aftersale_status")),
      ["aftersale_status", "book_series", "store", "province", "date"],
    );

  // --- Hour heatmap ---
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const hourGroups = groupBy(hourData, (item) => `${item.hour}|${item.weekday}`);
  const hourMap = new Map();
  hourGroups.forEach((g) => hourMap.set(g.key, g.sales_qty));
  const heatData = [];
  let maxHourVal = 1;
  for (let hour = 0; hour < 24; hour++) {
    for (let wd = 0; wd < 7; wd++) {
      const val = hourMap.get(`${hour}|${wd}`) || 0;
      if (val > 0) { heatData.push([wd, hour, val]); if (val > maxHourVal) maxHourVal = val; }
    }
  }
  const heatLabelKeys = new Set(
    [...heatData]
      .sort((a, b) => b[2] - a[2])
      .slice(0, phone ? 0 : 10)
      .map((item) => `${item[0]}|${item[1]}`)
  );
  const heatTotal = (hourData.length ? hourData.reduce((s, r) => s + r.sales_qty, 0) : 0);
  charts.hourHeatmap.setOption({
    tooltip: { position: "top", formatter: (p) => `${weekdayNames[p.value[0]]} ${String(p.value[1]).padStart(2,"0")}:00<br/>销量: ${fmt.format(p.value[2])}` },
    grid: { left: phone ? 48 : 64, right: 20, top: 10, bottom: 50 },
    xAxis: { type: "category", data: weekdayNames, splitArea: { show: true }, axisLabel: { fontSize: 11 } },
    yAxis: { type: "category", data: Array.from({length:24},(_,i)=>`${String(i).padStart(2,"0")}:00`), inverse: true, splitArea: { show: true }, axisLabel: { fontSize: 10 } },
    visualMap: { min: 0, max: maxHourVal, orient: "horizontal", left: "center", bottom: 5, calculable: false, inRange: { color: ["#f0f9ff","#bae6fd","#60a5fa","#2563eb","#1e3a8a","#172554"] }, text: [`峰值 ${fmt.format(maxHourVal)}`,`低销量`], textStyle: { fontSize: 10 } },
    series: [{ type: "heatmap", data: heatData, label: { show: !phone, formatter: (p) => heatLabelKeys.has(`${p.value[0]}|${p.value[1]}`) ? fmt.format(p.value[2]) : "", fontSize: 9 }, emphasis: { itemStyle: { shadowBlur: 8 } } }],
  }, { notMerge: true });

  // --- Price band structure ---
  const priceBandRanges = [
    { label: "免费/赠品", lo: 0, hi: 0.1 },
    { label: "0-20元", lo: 0.1, hi: 20 },
    { label: "20-40元", lo: 20, hi: 40 },
    { label: "40-60元", lo: 40, hi: 60 },
    { label: "60-100元", lo: 60, hi: 100 },
    { label: "100-200元", lo: 100, hi: 200 },
    { label: "200元以上", lo: 200, hi: 500 },
  ];
  const bandLabels = priceBandRanges.map((band) => band.label);
  const seriesPriceRows = new Map();
  priceData.forEach((row) => {
    if (!row.book_series || row.book_series === "未匹配商品" || !bandLabels.includes(row.price_band)) return;
    if (!seriesPriceRows.has(row.book_series)) {
      seriesPriceRows.set(row.book_series, { series: row.book_series, total: 0, bands: new Map() });
    }
    const target = seriesPriceRows.get(row.book_series);
    const qty = row.sales_qty || 0;
    target.total += qty;
    target.bands.set(row.price_band, (target.bands.get(row.price_band) || 0) + qty);
  });
  const priceRows = [...seriesPriceRows.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, phone ? 8 : 12)
    .reverse();
  const priceTotal = (priceData.length ? priceData.reduce((s, r) => s + r.sales_qty, 0) : 0);
  const priceColors = ["#cbd5e1", "#7dd3fc", "#38bdf8", "#2563eb", "#f59e0b", "#e34d3c", "#7c3aed"];
  const priceSeries = bandLabels.map((band, index) => ({
    name: band,
    type: "bar",
    stack: "price",
    barWidth: phone ? 14 : 18,
    itemStyle: { color: priceColors[index] },
    label: {
      show: !phone,
      color: index >= 3 ? "#ffffff" : "#0f172a",
      fontSize: 10,
      formatter: (p) => {
        const row = priceRows[p.dataIndex];
        return row && p.value >= row.total * 0.16 ? fmt.format(p.value) : "";
      },
    },
    data: priceRows.map((row) => row.bands.get(band) || 0),
  }));
  priceSeries.push({
    name: "总销量",
    type: "bar",
    stack: "price",
    silent: true,
    itemStyle: { color: "transparent" },
    emphasis: { disabled: true },
    label: {
      show: true,
      position: "right",
      color: "#344054",
      fontSize: 11,
      fontWeight: 700,
      formatter: (p) => fmt.format(priceRows[p.dataIndex]?.total || 0),
    },
    data: priceRows.map(() => 0),
  });
  charts.priceBox.setOption({
    color: priceColors,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params) => {
        const row = priceRows[params[0]?.dataIndex];
        if (!row) return "";
        const lines = [`${row.series}<br/>总销量: ${fmt.format(row.total)}`];
        params.filter((item) => item.seriesName !== "总销量" && item.value > 0).forEach((item) => {
          lines.push(`${item.marker}${item.seriesName}: ${fmt.format(item.value)} (${pct.format(item.value / row.total)})`);
        });
        return lines.join("<br/>");
      },
    },
    legend: { top: 0, type: "scroll", itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: phone ? 96 : 150, right: 70, top: 34, bottom: 22 },
    xAxis: { type: "value", name: `销量 | ${fmt.format(priceTotal)}单`, nameLocation: "end", nameGap: 8, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: priceRows.map((row) => row.series), axisLabel: { fontSize: phone?9:11, overflow: "truncate", width: phone?82:142 } },
    series: priceSeries,
  }, { notMerge: true });

  // --- Aftersale status distribution and broad return-rate rank ---
  const RETURN_FLOW_STATUSES = new Set(["待退货", "待收退货", "退货成功", "已退货", "退货完成"]);
  const isReturnFlowStatus = (raw) => RETURN_FLOW_STATUSES.has(raw);
  const isRefundStatus = (raw) => raw.includes("退款") || raw === "协商期" || raw === "协议中";
  const isBroadReturnStatus = (raw) => isRefundStatus(raw) || isReturnFlowStatus(raw);
  const asGroups = groupBy(aftersaleData, (item) => {
    const raw = item.aftersale_status || "-";
    if (raw === "-" || raw === "") return "无售后";
    if (raw.includes("退款成功") || raw.includes("已全额退款") || raw.includes("退款完成")) return "退款成功";
    if (isRefundStatus(raw)) return "退款处理中";
    if (isReturnFlowStatus(raw) || raw.includes("退货")) return "退货流程中";
    if (raw.includes("售后") && raw.includes("处理")) return "售后处理中";
    if (raw.includes("售后关闭")) return "售后关闭";
    if (raw.includes("拒绝")) return "售后已拒绝";
    if (raw.includes("换货成功") || raw.includes("已换货")) return "换货成功";
    if (raw.includes("补发成功")) return "补发成功";
    return "其他售后";
  }).sort((a, b) => b.sales_qty - a.sales_qty);

  const asTotal = asGroups.reduce((sum, g) => sum + g.sales_qty, 0);
  const broadReturnQty = aftersaleData.reduce((sum, item) => {
    return sum + (isBroadReturnStatus(item.aftersale_status || "") ? (item.sales_qty || 0) : 0);
  }, 0);
  const broadReturnRate = asTotal > 0 ? broadReturnQty / asTotal : 0;
  const pieColors = ["#94a3b8", "#e34d3c", "#f59e0b", "#64748b", "#b42318", "#06b6d4", "#10b981", "#8b5cf6"];
  charts.aftersalePie.setOption({
    color: pieColors,
    tooltip: { trigger: "item", formatter: (p) => `${p.name}<br/>${fmt.format(p.value)} 册 (${pct.format(p.value / Math.max(1, asTotal))})` },
    legend: { bottom: 0, type: "scroll", textStyle: { fontSize: 11 } },
    graphic: asTotal > 0 ? [
      { type: "text", left: "center", top: 18, style: { text: `广义退货率 ${pct.format(broadReturnRate)}`, fontSize: 13, fontWeight: "bold", fill: "#e34d3c" } },
    ] : [],
    series: [{ type: "pie", radius: phone?["36%","60%"]:["38%","64%"], center: ["50%","46%"], itemStyle: { borderRadius: 3, borderColor: "#fff", borderWidth: 2 }, label: { show: !phone, formatter: "{b}\n{d}%", fontSize: 11 }, data: asGroups.map(g=>({name:g.key,value:g.sales_qty})) }],
  }, { notMerge: true });

  // --- Broad return-rate rank: refunds plus return-flow statuses ---
  const refundBySeries = new Map(); const returnFlowBySeries = new Map(); const broadReturnBySeries = new Map(); const totalBySeries = new Map();
  aftersaleData.forEach((item) => {
    const s = item.book_series || "未匹配商品"; const q = item.sales_qty || 0;
    totalBySeries.set(s, (totalBySeries.get(s) || 0) + q);
    const raw = item.aftersale_status || "-";
    if (isRefundStatus(raw)) refundBySeries.set(s, (refundBySeries.get(s) || 0) + q);
    if (isReturnFlowStatus(raw)) returnFlowBySeries.set(s, (returnFlowBySeries.get(s) || 0) + q);
    if (isBroadReturnStatus(raw)) broadReturnBySeries.set(s, (broadReturnBySeries.get(s) || 0) + q);
  });
  const rankRows = [];
  totalBySeries.forEach((total, s) => {
    if (s !== "未匹配商品") {
      const refund = refundBySeries.get(s) || 0;
      const returnFlow = returnFlowBySeries.get(s) || 0;
      const broadReturn = broadReturnBySeries.get(s) || 0;
      rankRows.push({ series: s, total, refund, returnFlow, broadReturn, broadReturnRate: broadReturn / total });
    }
  });
  rankRows.sort((a, b) => b.broadReturnRate - a.broadReturnRate);
  const rankVisibleCount = phone ? 8 : 12;
  const rankWindow = rankRows.length > rankVisibleCount
    ? Math.max(18, (rankVisibleCount / rankRows.length) * 100)
    : 100;
  const rankStart = rankRows.length > rankVisibleCount ? 100 - rankWindow : 0;
  const rankCategories = rankRows.map(r=>r.series).reverse();
  const rankValues = rankRows.map(r=>r.broadReturnRate).reverse();

  charts.aftersaleRank.setOption({
    color: ["#e34d3c"],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => {
      const r = rankRows.find(x => x.series === p[0].name);
      return r ? `${r.series}<br/>广义退货率: ${pct.format(r.broadReturnRate)}<br/>退款 ${fmt.format(r.refund)} + 退货流程 ${fmt.format(r.returnFlow)} = ${fmt.format(r.broadReturn)} / 统计销量 ${fmt.format(r.total)}` : "";
    } },
    grid: { left: phone ? 100 : 170, right: 48, top: 10, bottom: 20 },
    xAxis: { type: "value", axisLabel: { formatter: (v) => pct.format(v), fontSize: 11 } },
    yAxis: { type: "category", data: rankCategories, axisLabel: { fontSize: phone?10:12, overflow: "truncate", width: phone?90:160 } },
    dataZoom: [
      {
        type: "slider",
        yAxisIndex: 0,
        right: 6,
        width: 14,
        start: rankStart,
        end: 100,
        brushSelect: false,
        showDetail: false,
      },
      {
        type: "inside",
        yAxisIndex: 0,
        start: rankStart,
        end: 100,
        zoomOnMouseWheel: false,
        moveOnMouseWheel: true,
        moveOnMouseMove: true,
      },
    ],
    legend: { show: false },
    series: [
      { name: "广义退货率", type: "bar", data: rankValues, label: { show: true, position: "right", fontSize: 10, formatter: (p) => pct.format(p.value) }, barWidth: phone?10:13 },
    ],
  }, { notMerge: true });
}

let _renderAllBusy = false;
let _renderAllPending = false;

function renderAll() {
  if (_renderAllBusy) {
    // A render is already in progress — mark a pending re-render instead of dropping
    _renderAllPending = true;
    return;
  }
  _renderAllBusy = true;
  _renderAllPending = false;
  try {
    renderDateRangeHint();
    updateDependentFilters();
    const facts = filterFacts();
    const seriesFacts = getSeriesTrendFacts();
    renderKpis(facts);
    renderDailyReport(facts, state.data?.daily_report_trend || []);
    renderTopSeriesChips();
    renderRiseChips(seriesFacts);
    renderRhythmTable(seriesFacts);
    renderSourceAnalysis(seriesFacts);
    renderTrend(facts);
    renderContent(facts);
    renderSource(facts);
    renderRoomSeriesHeatmap(facts);
    renderSankey(facts);
    renderActiveTable(facts);
    if (state.activeView === "region") renderRegionAnalysis();
    if (state.activeView === "ops") renderOpsAnalysis();
    applyActiveView();
  } catch (err) {
    console.error("renderAll error:", err);
  } finally {
    _renderAllBusy = false;
    if (_renderAllPending) {
      _renderAllPending = false;
      renderAll();
    }
  }
}

function dashboardDataUrl() {
  const params = new URLSearchParams({ v: Date.now().toString() });
  if (state.data) {
    const dateWindow = currentDateWindow();
    if (dateWindow.start) params.set("date_start", dateWindow.start);
    if (dateWindow.end) params.set("date_end", dateWindow.end);
  }
  // Pass all active filter values so the server can pre-filter agg dimensions
  Object.keys(filterFields).forEach((filterKey) => {
    const values = effectiveFilterValue(filterKey);
    if (values.length > 0) params.set(filterKey, values.join(","));
  });
  return `./api/dashboard-data?${params.toString()}`;
}

function updateBatchMeta() {
  const summary = state.data?.summary || {};
  const { dataStart, dataEnd, rawDataEnd } = getDataDateBounds();
  const partialNote = rawDataEnd && dataEnd && rawDataEnd > dataEnd
    ? `（${rawDataEnd}未完整，不纳入排行/趋势）`
    : "";
  byId("batchMeta").textContent = `${dataStart || summary.date_min || ""} 至 ${dataEnd || summary.date_max || ""}${partialNote}｜${summary.import_batch_id || ""}`;
}

async function loadDashboardData(options = {}) {
  const token = ++dashboardLoadToken;
  const hint = byId("dateRangeHint");
  if (hint && options.showLoading) hint.textContent = "正在加载当前日期范围...";
  const response = await fetch(dashboardDataUrl(), { cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    throw new Error("演示数据服务暂时不可用，请检查本地服务。");
    return false;
  }
  const nextData = await response.json();
  if (token !== dashboardLoadToken) return false;
  state.data = nextData;
  updateBatchMeta();
  if (options.render !== false) renderAll();
  return true;
}

function scheduleFilteredDataReload() {
  if (filteredDataReloadTimer) clearTimeout(filteredDataReloadTimer);
  filteredDataReloadTimer = setTimeout(() => {
    filteredDataReloadTimer = null;
    loadDashboardData({ render: true }).catch((err) => {
      console.error("filtered dashboard reload error:", err);
    });
  }, 120);
}

function applyActiveView() {
  document.querySelector("main")?.classList.toggle("ai-active", state.activeView === "ai");
  document.querySelectorAll("[data-view-section]").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.viewSection !== state.activeView);
  });
  const dashboardControlPanel = byId("dashboardControlPanel");
  if (dashboardControlPanel) {
    dashboardControlPanel.classList.toggle("hidden", state.activeView === "ai");
  }
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  setTimeout(() => {
    Object.values(charts).forEach((chart) => chart && chart.resize());
  }, 0);
  if (state.activeView === "region") renderRegionAnalysis();
  if (state.activeView === "ops") renderOpsAnalysis();
  if (state.activeView === "ai") {
    renderChatThreads();
    renderChatMessages();
    setTimeout(() => byId("chatInput")?.focus(), 0);
  }
}

function bindEvents() {
  const toggleBtn = byId("toggleAdvancedFiltersBtn");
  const advFilters = byId("advancedFilters");
  if (toggleBtn && advFilters) {
    toggleBtn.addEventListener("click", () => {
      advFilters.classList.toggle("collapsed");
    });
  }
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      applyActiveView();
      if (state.activeView === "detail") renderActiveTable(filterFacts());
    });
  });

  // Date controls remain native
  const dateFields = ["datePreset", "dateStart", "dateEnd"];
  dateFields.forEach((id) => {
    const control = byId(id);
    if (!control) return;
    control.addEventListener("change", async (event) => {
      state.filters[id] = event.target.value;
      if (id === "datePreset") {
        state.filters.dateStart = "";
        state.filters.dateEnd = "";
      }
      state.trendSourceSelections = [];
      if (["datePreset", "dateStart", "dateEnd"].includes(id)) {
        await loadDashboardData({ showLoading: true });
      } else {
        renderAll();
      }
    });
  });

  // Reset button
  byId("resetBtn").addEventListener("click", () => {
    state.trendSourceSelections = [];
    state.selectedProvince = "";
    state.selectedCity = "";
    state.mapLevel = "country";
    state.currentMapProvince = null;
    clearQuickFilters();
    Object.assign(state.filters, {
      datePreset: "last7",
      dateStart: "",
      dateEnd: "",
      store: [],
      projectDepartment: [],
      bookSeries: [],
      contentType: [],
      sourceType: [],
      sourceDepartment: [],
      sourceManager: [],
      sourceGroup: [],
      sourceDetail: [],
      segment: [],
    });
    if (advFilters) {
      advFilters.classList.add("collapsed");
    }
    // Sync MultiSelectDropdown instances
    Object.entries(multiSelects).forEach(([, ms]) => {
      ms.setSelected([]);
    });
    byId("datePreset").value = "last7";
    loadDashboardData({ showLoading: true });
  });

  // Top Series chips (multi-select)
  byId("topSeriesChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-series]");
    if (!button) return;
    const nextSeries = button.dataset.series;
    if (nextSeries === "__all__") {
      state.quickFilters.bookSeries = [];
    } else {
      const currentSet = new Set(state.quickFilters.bookSeries);
      if (currentSet.has(nextSeries)) {
        currentSet.delete(nextSeries);
      } else {
        currentSet.add(nextSeries);
      }
      state.quickFilters.bookSeries = [...currentSet];
    }
    clearQuickChannelFilters();
    state.trendSourceSelections = [];
    renderAll();
    scheduleFilteredDataReload();
  });

  // Rising Series chips (multi-select)
  byId("riseSeriesChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-rise-series]");
    if (!button) return;
    const nextSeries = button.dataset.riseSeries;
    const currentSet = new Set(state.quickFilters.bookSeries);
    if (currentSet.has(nextSeries)) {
      currentSet.delete(nextSeries);
    } else {
      currentSet.add(nextSeries);
    }
    state.quickFilters.bookSeries = [...currentSet];
    clearQuickChannelFilters();
    state.trendSourceSelections = [];
    renderAll();
    scheduleFilteredDataReload();
  });

  // Rising Source chips (multi-select)
  byId("riseSourceChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-rise-source-detail]");
    if (!button) return;
    const sd = button.dataset.riseSourceDetail;
    const st = button.dataset.riseSourceType;
    const sm = button.dataset.riseSourceManager;
    const sg = button.dataset.riseSourceGroup;
    const ct = button.dataset.riseContentType;

    const active =
      state.quickFilters.sourceDetail.includes(sd) &&
      state.quickFilters.sourceType.includes(st) &&
      state.quickFilters.sourceManager.includes(sm) &&
      state.quickFilters.sourceGroup.includes(sg) &&
      state.quickFilters.contentType.includes(ct);

    function toggleIn(arr, value) {
      const s = new Set(arr);
      if (s.has(value)) s.delete(value); else s.add(value);
      return [...s];
    }

    if (active) {
      state.quickFilters.sourceDetail = state.quickFilters.sourceDetail.filter((v) => v !== sd);
      state.quickFilters.sourceType = state.quickFilters.sourceType.filter((v) => v !== st);
      state.quickFilters.sourceManager = state.quickFilters.sourceManager.filter((v) => v !== sm);
      state.quickFilters.sourceGroup = state.quickFilters.sourceGroup.filter((v) => v !== sg);
      state.quickFilters.contentType = state.quickFilters.contentType.filter((v) => v !== ct);
    } else {
      state.quickFilters.sourceDetail = toggleIn(state.quickFilters.sourceDetail, sd);
      state.quickFilters.sourceType = toggleIn(state.quickFilters.sourceType, st);
      state.quickFilters.sourceManager = toggleIn(state.quickFilters.sourceManager, sm);
      state.quickFilters.sourceGroup = toggleIn(state.quickFilters.sourceGroup, sg);
      state.quickFilters.contentType = toggleIn(state.quickFilters.contentType, ct);
    }
    state.trendSourceSelections = [];
    renderAll();
    scheduleFilteredDataReload();
  });

  byId("trendLegendList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-source-name]");
    if (!row) return;
    toggleTrendSourceSelection(row.dataset.sourceName);
  });
  byId("clearTrendSourceBtn").addEventListener("click", () => {
    state.trendSourceSelections = [];
    renderAll();
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      state.activeTab = button.dataset.tab;
      renderActiveTable(filterFacts());
    });
  });
  // Map back-to-national button
  const mapBackBtn = byId("mapBackBtn");
  if (mapBackBtn) {
    mapBackBtn.addEventListener("click", () => {
      goBackToNational();
    });
  }

  // Region time slider
  const timeSlider = byId("regionTimeSlider");
  if (timeSlider) {
    timeSlider.addEventListener("input", () => {
      renderRegionAnalysis();
    });
  }
  const regionRank = byId("regionProvinceRank");
  if (regionRank) {
    regionRank.addEventListener("click", async (event) => {
      // Handle city selection (province drill-down mode)
      const cityBtn = event.target.closest("[data-city]");
      if (cityBtn) {
        const city = cityBtn.dataset.city || "";
        state.selectedCity = state.selectedCity === city ? "" : city;
        renderRegionAnalysis();
        return;
      }
      // Handle province selection (country level)
      const provinceBtn = event.target.closest("[data-province]");
      if (!provinceBtn) return;
      const province = provinceBtn.dataset.province || "";  // data name
      if (!province) {
        // "全国" button — go back to country level
        goBackToNational();
        return;
      }
      // Use robust name matching
      const match = lookupProvinceAdcode(province);
      if (match) {
        const { adcode, geoName } = match;
        const geo = await loadProvinceMap(adcode);
        if (geo) {
          state.mapLevel = "province";
          state.currentMapProvince = { adcode, name: geoName };
          state.selectedProvince = province;  // data name for filtering
          state.selectedCity = "";
          renderRegionAnalysis();
          return;
        }
      }
      // Fallback: simple province selection (toggle)
      if (state.selectedProvince === province) {
        state.selectedProvince = "";
      } else {
        state.selectedProvince = province;
      }
      state.selectedCity = "";
      state.mapLevel = "country";
      state.currentMapProvince = null;
      renderRegionAnalysis();
    });
  }
  const regionTimePrev = byId("regionTimePrev");
  const regionTimeNext = byId("regionTimeNext");
  if (regionTimePrev && timeSlider) {
    regionTimePrev.addEventListener("click", () => {
      timeSlider.value = Math.max(0, Number(timeSlider.value || 0) - 1).toString();
      renderRegionAnalysis();
    });
  }
  if (regionTimeNext && timeSlider) {
    regionTimeNext.addEventListener("click", () => {
      timeSlider.value = Math.min(Number(timeSlider.max || 0), Number(timeSlider.value || 0) + 1).toString();
      renderRegionAnalysis();
    });
  }

}

function toggleTrendSourceSelection(seriesName) {
  if (!seriesName) return;
  const existingIndex = state.trendSourceSelections.indexOf(seriesName);
  if (existingIndex >= 0) {
    state.trendSourceSelections.splice(existingIndex, 1);
  } else {
    state.trendSourceSelections.push(seriesName);
    if (state.trendSourceSelections.length > 5) state.trendSourceSelections.shift();
  }
  renderAll();
}

async function main() {
  const userResponse = await fetch("./api/me", { cache: "no-store" });
  if (!userResponse.ok) {
    throw new Error("演示数据服务暂时不可用，请检查本地服务。");
    return;
  }
  const user = await userResponse.json();
  if (user.must_change) {
    throw new Error("演示模式不需要密码。");
    return;
  }
  state.user = user;
  byId("userMeta").textContent = "演示访客 · 无公司账号";
  const agentMode = document.getElementById("agentModeLabel");
  if (agentMode) agentMode.textContent = user.agent_mode === "llm" ? "LLM 工具调用模式 · 仅模拟数据" : "离线规则演示 · 不调用外部模型";
  const modeOption = document.querySelector("#chatModel option");
  if (modeOption) modeOption.textContent = user.agent_mode === "llm" ? "LLM 工具调用" : "离线规则演示";

  const loaded = await loadDashboardData({ render: false });
  if (!loaded || !state.data) return;
  byId("datePreset").value = state.filters.datePreset;
  initCharts();
  bindEvents();
  renderAll();
  initChat();
}

// ===== AI Chat Panel =====

const CHAT_STORAGE_KEY = "portfolio.synthetic.chat.v1";
const CHAT_SUGGESTIONS = [
  "昨日各学段书系销量前十名及主要销售来源",
  "昨日“其他来源”合计为什么这么高？",
  "最近7天哪个书系下滑最多？",
  "直播、短视频、商品卡分别贡献多少？",
];

const CHAT_SETTINGS_KEY = "portfolio.synthetic.settings.v1";
const CHAT_TEMPLATES = {
  "daily-brief": {
    label: "经营日报",
    description: "快速查看昨日销量、成交额、书系 Top10 和主要销售来源。",
    text: "请生成经营日报：总结昨日销量和成交额，按学段列出书系销量前十名及主要销售来源，并指出主要风险和今天应优先处理的事项。",
  },
  "period-comparison": {
    label: "周期对比",
    description: "比较销量、成交额和渠道结构变化。",
    text: "请对比最近7天与前7天的销量、成交额和渠道结构，指出最重要的变化、原因和下一步动作。",
  },
  "decline-diagnosis": {
    label: "下滑归因",
    description: "定位下滑书系、店铺和渠道。",
    text: "请诊断最近7天销量下滑：定位造成下降的书系、店铺、账号或地区，判断下降是否集中，并给出数据证据和应对动作。",
  },
  "growth-opportunities": {
    label: "增长机会",
    description: "找出值得复制或加码的书系和渠道。",
    text: "请找出最近正在起量的书系和渠道，说明增长来源、可复制动作、加码优先级和需要观察的风险。",
  },
  "channel-review": {
    label: "渠道分析",
    description: "复盘直播、短视频、商品卡及达人来源。",
    text: "请复盘最近7天直播、短视频、商品卡以及达人/账号组的表现，说明贡献、变化、问题和下一步优化重点。",
  },
};
const chatSettings = {
  model: "demo-local",
  reasoning: false,
  outputStyle: "concise",
  templateId: "daily-brief",
};

function loadChatSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || "{}");
    if (saved.model === "demo-local") chatSettings.model = saved.model;
    if (typeof saved.reasoning === "boolean") chatSettings.reasoning = saved.reasoning;
    else if (typeof saved.deepThinking === "boolean") chatSettings.reasoning = saved.deepThinking;
    if (["concise", "executive", "detailed"].includes(saved.outputStyle)) chatSettings.outputStyle = saved.outputStyle;
    if (saved.templateId && CHAT_TEMPLATES[saved.templateId]) chatSettings.templateId = saved.templateId;
  } catch (error) {
    // Ignore malformed local preferences and use defaults.
  }
}

function saveChatSettings() {
  localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings));
}

function syncChatSettingsUI() {
  const model = document.getElementById("chatModel");
  const deep = document.getElementById("chatDeepThinking");
  const style = document.getElementById("chatOutputStyle");
  if (model) model.value = chatSettings.model;
  if (deep) deep.checked = chatSettings.reasoning;
  if (style) style.value = chatSettings.outputStyle;
  const template = document.getElementById("chatTemplateSelect");
  if (template) template.value = chatSettings.templateId;
}

function syncChatTemplateUI() {
  const select = document.getElementById("chatTemplateSelect");
  const description = document.getElementById("chatTemplateDescription");
  if (!select || !description) return;
  chatSettings.templateId = select.value;
  description.textContent = CHAT_TEMPLATES[select.value]?.description || "";
  saveChatSettings();
}

function fillChatPrompt(text, templateId = "") {
  const input = document.getElementById("chatInput");
  if (!input) return;
  if (templateId && CHAT_TEMPLATES[templateId]) {
    const select = document.getElementById("chatTemplateSelect");
    if (select) select.value = templateId;
    chatSettings.templateId = templateId;
    saveChatSettings();
    syncChatTemplateUI();
    input.value = CHAT_TEMPLATES[templateId].text;
  } else {
    input.value = String(text || "");
  }
  resizeChatInput(input);
  input.focus();
}

const chatState = {
  threads: [],
  activeThreadId: "",
  isLoading: false,
  abortController: null,
  abortReason: "",
  timerId: null,
};

function scrollChatToBottom() {
  const container = document.getElementById("chatMessages");
  if (!container) return;
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function shouldAutoScroll() {
  const container = document.getElementById("chatMessages");
  return container.scrollTop + container.clientHeight + 60 >= container.scrollHeight;
}

function stripChatInternalMarkup(text) {
  let cleaned = String(text || "");
  const marker = cleaned.search(/(<\s*\/?\s*[|｜]?\s*[|｜]?\s*DSML\b|DSML\s*[|｜]\s*[|｜]?\s*(tool_calls|invoke|parameter)|<\s*[|｜][^>]*(tool_calls|invoke))/i);
  if (marker >= 0) cleaned = cleaned.slice(0, marker);
  cleaned = cleaned.replace(/<\s*\/?\s*[|｜][^>\n]{0,160}>/g, "");
  return cleaned.trim();
}

function displayAssistantContent(text) {
  const raw = String(text || "");
  const cleaned = stripChatInternalMarkup(raw);
  if (cleaned) return cleaned;
  return raw.trim() ? "（这条历史回复包含已拦截的内部标记，已隐藏）" : "";
}

function normalizeChatMarkdown(text) {
  return String(text || "").replace(
    /([^\s*])\*\*([^*\n]+?)\*\*(?=$|[\s，。；：、,.!?！？）])/g,
    "$1 **$2**"
  );
}

function renderMarkdown(text) {
  const cleanedText = normalizeChatMarkdown(stripChatInternalMarkup(text));
  if (typeof marked === "undefined") return escapeHtml(cleanedText);
  try {
    const raw = marked.parse(cleanedText);
    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "h1", "h2", "h3", "blockquote", "code", "pre", "hr", "a"],
        ALLOWED_ATTR: ["href", "target", "rel", "colspan", "rowspan"],
      });
    }
    return raw;
  } catch (e) {
    return escapeHtml(cleanedText);
  }
}

function getDashboardContext() {
  const period = currentDateWindow();
  const filters = {};
  for (const key of Object.keys(filterFields)) filters[key] = effectiveFilterValue(key);
  return { date_start: period.start, date_end: period.end, filters, view: state.activeView, data_kind: "synthetic" };
}

function getChatContextLabel() {
  const viewNames = {
    overview: "经营看板",
    trend: "趋势分析",
    channel: "渠道分析",
    region: "地域分析",
    ops: "经营分析",
    detail: "商品明细",
    ai: "Agent 分析",
  };
  let dateLabel = "当前筛选";
  if (state.filters.dateStart && state.filters.dateEnd) {
    dateLabel = state.filters.dateStart + " 至 " + state.filters.dateEnd;
  } else if (state.filters.datePreset === "last7") {
    dateLabel = "最近7天";
  } else if (state.filters.datePreset === "last30") {
    dateLabel = "最近30天";
  } else if (state.filters.datePreset === "yesterday") {
    dateLabel = "昨日";
  } else if (state.filters.datePreset === "all") {
    dateLabel = "全量数据";
  }
  return dateLabel + " · " + (viewNames[state.activeView] || state.activeView);
}

function createChatThread(activate = true) {
  const now = Date.now();
  const thread = {
    id: "chat-" + now + "-" + Math.random().toString(36).slice(2, 7),
    title: "新分析对话",
    contextLabel: getChatContextLabel(),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  chatState.threads.unshift(thread);
  if (activate) chatState.activeThreadId = thread.id;
  saveChatThreads();
  renderChatThreads();
  renderChatMessages();
  return thread;
}

function getActiveChatThread() {
  let thread = chatState.threads.find((item) => item.id === chatState.activeThreadId);
  if (!thread) thread = createChatThread(true);
  return thread;
}

function switchChatThread(threadId) {
  if (chatState.isLoading) {
    showChatError("Demo Agent还在分析中，请稍等完成后再切换对话");
    return;
  }
  if (!chatState.threads.some((thread) => thread.id === threadId)) return;
  chatState.activeThreadId = threadId;
  saveChatThreads();
  renderChatThreads();
  renderChatMessages();
  document.getElementById("chatInput").focus();
}

function deleteChatThread(threadId) {
  if (chatState.isLoading) {
    showChatError("Demo Agent还在分析中，请稍等完成后再删除对话");
    return;
  }
  const index = chatState.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) return;
  const wasActive = chatState.activeThreadId === threadId;
  chatState.threads.splice(index, 1);
  if (!chatState.threads.length) {
    chatState.activeThreadId = "";
    saveChatThreads();
    renderChatThreads();
    renderChatMessages();
    return;
  }
  if (wasActive) {
    const next = chatState.threads[Math.min(index, chatState.threads.length - 1)];
    chatState.activeThreadId = next.id;
  }
  saveChatThreads();
  renderChatThreads();
  renderChatMessages();
}

function trimChatTitle(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > 18 ? compact.slice(0, 18) + "…" : compact || "新分析对话";
}

function saveChatThreads() {
  try {
    const payload = {
      activeThreadId: chatState.activeThreadId,
      threads: chatState.threads.slice(0, 20),
    };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to save chat threads", error);
  }
}

function loadChatThreads() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.threads)) return;
    chatState.threads = payload.threads
      .filter((thread) => thread && typeof thread.id === "string")
      .map((thread) => ({
        id: thread.id,
        title: thread.title || "分析对话",
        contextLabel: thread.contextLabel || "历史筛选",
        createdAt: Number(thread.createdAt) || Date.now(),
        updatedAt: Number(thread.updatedAt) || Date.now(),
        messages: Array.isArray(thread.messages)
          ? thread.messages
              .filter((message) => message && (message.role === "user" || message.role === "assistant"))
              .map((message) => ({
                ...message,
                content: message.role === "assistant" ? displayAssistantContent(message.content) : String(message.content || ""),
                processOpen: typeof message.processOpen === "boolean"
                  ? message.processOpen
                  : (message.processDone ? false : !message.processCollapsed),
              }))
          : [],
      }));
    chatState.activeThreadId = payload.activeThreadId || chatState.threads[0]?.id || "";
  } catch (error) {
    console.warn("Failed to load chat threads", error);
  }
}

function formatChatTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch (error) {
    return "";
  }
}

function getThreadDateLabel(thread) {
  const context = String(thread?.contextLabel || "");
  const label = context.split(" · ")[0].trim();
  return label && !label.includes("当前筛选") ? label : "最近7天";
}

function renderChatThreads() {
  const list = document.getElementById("chatThreadList");
  if (!list) return;
  list.innerHTML = "";
  if (!chatState.threads.length) {
    list.innerHTML = `<div class="chat-thread-empty">暂无历史对话</div>`;
    return;
  }
  for (const thread of chatState.threads) {
    const count = thread.messages.filter((message) => message.role === "user").length;
    const item = document.createElement("div");
    item.className = "chat-thread-item" + (thread.id === chatState.activeThreadId ? " active" : "");
    item.dataset.threadId = thread.id;
    item.innerHTML = `
      <button class="chat-thread-open" type="button" data-open-thread="${escapeHtml(thread.id)}">
        <span class="chat-thread-title">${escapeHtml(thread.title)}</span>
        <span class="chat-thread-meta">${escapeHtml(getThreadDateLabel(thread))} · Demo Agent · ${count}问 · ${formatChatTime(thread.updatedAt)}</span>
      </button>
      <button class="chat-thread-delete" type="button" data-delete-thread="${escapeHtml(thread.id)}" title="删除对话" aria-label="删除对话">×</button>
    `;
    list.appendChild(item);
  }
}

function renderChatWelcome(container) {
  const templateCards = Object.entries(CHAT_TEMPLATES).map(([id, template]) => `
    <button class="chat-template-card" type="button" data-welcome-template="${id}">
      <strong>${escapeHtml(template.label)}</strong>
      <span>${escapeHtml(template.description.replace(/^适合问：/, ""))}</span>
    </button>
  `).join("");
  const suggestions = CHAT_SUGGESTIONS.map((query) => (
    `<button class="chat-suggestion" type="button" data-query="${escapeHtml(query)}">${escapeHtml(query)}</button>`
  )).join("");
  container.innerHTML = `
    <div class="chat-welcome">
      <div class="chat-welcome-status"><span class="chat-welcome-spark" aria-hidden="true">✦</span><span>Demo Agent准备好了</span><span class="chat-welcome-context">${escapeHtml(getChatContextLabel())}</span></div>
      <div class="chat-welcome-heading">
        <img class="chat-welcome-logo" src="./assets/demo-mark.svg" alt="Demo Agent" />
        <div>
          <h4>今天要看哪一块销售表现？</h4>
          <p>按学段、书系或销售渠道提问，Demo Agent会结合当前筛选给出结论。</p>
        </div>
      </div>
      <div class="chat-welcome-templates">${templateCards}</div>
      <div class="chat-welcome-question-title">也可以直接问</div>
      <div class="chat-suggestions">${suggestions}</div>
    </div>
  `;
}

function renderChatMessages() {
  const container = document.getElementById("chatMessages");
  if (!container) return;
  if (!chatState.threads.length) {
    container.innerHTML = "";
    renderChatWelcome(container);
    return;
  }
  const thread = getActiveChatThread();
  container.innerHTML = "";
  if (!thread.messages.length) {
    renderChatWelcome(container);
    return;
  }
  thread.messages.forEach((message, index) => {
    renderChatMessage(message.role, message.content, index, message.meta || null);
  });
  scrollChatToBottom();
}

function formatChatElapsed(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const seconds = safeMs / 1000;
  return safeMs < 1000 ? `工具分析 ${Math.round(safeMs)} 毫秒` : `工具分析 ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
}

function setChatMessageMeta(index, text) {
  const thread = getActiveChatThread();
  if (!thread) return;
  const msgEl = document.getElementById("msg-" + thread.id + "-" + index);
  const metaEl = msgEl?.querySelector(".chat-message-meta");
  if (!metaEl) return;
  metaEl.textContent = text || "";
  metaEl.classList.toggle("hidden", !text);
}

function renderChatProcess(index) {
  const thread = getActiveChatThread();
  if (!thread) return;
  const msgEl = document.getElementById("msg-" + thread.id + "-" + index);
  const message = thread.messages[index];
  const host = msgEl?.querySelector(".chat-message-process-host");
  if (!message || !host) return;
  const steps = Array.isArray(message?.steps) ? message.steps : [];
  if (!steps.length && !message.startedAt && !message.meta) {
    host.innerHTML = "";
    return;
  }
  const currentStep = steps[steps.length - 1] || "Demo Agent正在分析...";
  const startedAt = Number(message.startedAt || 0);
  const elapsed = startedAt
    ? formatChatElapsed((message.processDoneAt || Date.now()) - startedAt)
    : "";
  const summaryText = message.processDone
    ? (message.meta || elapsed || "分析完成")
    : `${currentStep}${elapsed ? ` · ${elapsed}` : ""}`;

  host.innerHTML = "";
  const details = document.createElement("details");
  details.className = "chat-process-details" + (message.processDone ? " completed" : " running");
  details.open = message.processOpen !== false;
  const summary = document.createElement("summary");
  summary.className = "chat-process-summary";
  const label = document.createElement("span");
  label.className = "chat-process-summary-label";
  label.textContent = summaryText;
  const toggleText = document.createElement("span");
  toggleText.className = "chat-process-summary-toggle";
  toggleText.textContent = details.open ? "收起" : "展开";
  summary.append(label, toggleText);
  details.appendChild(summary);

  const list = document.createElement("ol");
  list.className = "chat-process-list";
  steps.forEach((step, stepIndex) => {
    const item = document.createElement("li");
    item.className = "chat-process-step" + (stepIndex === steps.length - 1 ? " current" : "");
    item.textContent = step;
    list.appendChild(item);
  });
  details.appendChild(list);
  details.addEventListener("toggle", () => {
    message.processOpen = details.open;
    toggleText.textContent = details.open ? "收起" : "展开";
    saveChatThreads();
  });
  host.appendChild(details);
}

function addChatProcessStep(index, text) {
  const thread = getActiveChatThread();
  const message = thread.messages[index];
  const step = String(text || "").trim();
  if (!message || message.role !== "assistant" || !step) return;
  if (!Array.isArray(message.steps)) message.steps = [];
  if (message.steps[message.steps.length - 1] !== step) {
    message.steps.push(step);
    message.steps = message.steps.slice(-12);
  }
  renderChatProcess(index);
}

function startChatTimer(index) {
  if (chatState.timerId) window.clearInterval(chatState.timerId);
  chatState.timerId = window.setInterval(() => {
    if (!chatState.isLoading) return;
    renderChatProcess(index);
  }, 250);
}

function stopChatTimer() {
  if (chatState.timerId) window.clearInterval(chatState.timerId);
  chatState.timerId = null;
}

function copyChatText(text, button) {
  const value = String(text || "").trim();
  if (!value) return;
  const done = () => {
    if (!button) return;
    const original = button.getAttribute("aria-label") || "复制";
    button.setAttribute("aria-label", "已复制");
    button.title = "已复制";
    window.setTimeout(() => {
      button.setAttribute("aria-label", original);
      button.title = original;
    }, 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopyChatText(value, done));
  } else {
    fallbackCopyChatText(value, done);
  }
}

function fallbackCopyChatText(value, done) {
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  try { document.execCommand("copy"); } catch (error) { /* Clipboard permission may be unavailable on HTTP. */ }
  helper.remove();
  done();
}

function editChatMessage(index) {
  if (chatState.isLoading) {
    showChatError("当前分析还在进行中，请稍等完成后再编辑");
    return;
  }
  const thread = getActiveChatThread();
  const message = thread?.messages[index];
  if (!thread || !message || message.role !== "user") return;
  const input = document.getElementById("chatInput");
  if (!input) return;
  input.value = String(message.content || "");
  resizeChatInput(input);
  thread.messages = thread.messages.slice(0, index);
  thread.title = index === 0 ? "新分析对话" : thread.title;
  thread.updatedAt = Date.now();
  saveChatThreads();
  renderChatThreads();
  renderChatMessages();
  input.focus();
}

function renderChatMessage(role, content, index, metaText = null) {
  const container = document.getElementById("chatMessages");
  const thread = getActiveChatThread();
  if (!container || !thread) return null;

  // The welcome screen only belongs to an empty conversation.
  // Remove it before the first real message is appended.
  container.querySelector(".chat-welcome")?.remove();

  const existingId = "msg-" + thread.id + "-" + index;
  let msgEl = document.getElementById(existingId);
  if (role === "assistant" && msgEl) {
    const body = msgEl.querySelector(".chat-message-body");
    const safeContent = displayAssistantContent(content);
    if (body) {
      body.innerHTML = renderMarkdown(safeContent);
      body.classList.toggle("empty", !safeContent);
    }
    renderChatProcess(index);
    if (metaText !== null) setChatMessageMeta(index, metaText);
    if (shouldAutoScroll()) scrollChatToBottom();
    return msgEl;
  }

  const msgDiv = document.createElement("div");
  msgDiv.className = "chat-message " + role;
  msgDiv.id = existingId;

  if (role === "assistant") {
    const avatar = document.createElement("img");
    avatar.className = "chat-avatar";
    avatar.src = "./assets/demo-mark.svg";
    avatar.alt = "Demo Agent";
    msgDiv.appendChild(avatar);
  }

  const bodyDiv = document.createElement("div");
  bodyDiv.className = "chat-message-body";
  const safeContent = role === "assistant"
    ? displayAssistantContent(content)
    : content;
  if (role === "user") {
    // Keep deliberate Shift+Enter line breaks; CSS handles wrapping in the bubble.
    bodyDiv.textContent = String(content || "").trim();
    const actions = document.createElement("div");
    actions.className = "chat-message-actions";
    actions.innerHTML = `
      <button type="button" class="chat-message-action" data-chat-action="edit" data-message-index="${index}" title="编辑并重新提问" aria-label="编辑并重新提问">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.7 3.7 3.7-.7L18.5 8l-2.5-2.5L4 16.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m14.5 7.5 2.5 2.5M19 4l1 1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      <button type="button" class="chat-message-action" data-chat-action="copy" data-message-index="${index}" title="复制问题" aria-label="复制问题">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-7A1.5 1.5 0 0 0 6 6.5v8A1.5 1.5 0 0 0 7.5 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
      </button>
      </button>`;
    msgDiv.append(bodyDiv, actions);
  } else {
    bodyDiv.innerHTML = renderMarkdown(safeContent);
    bodyDiv.classList.toggle("empty", !safeContent);
  }
  if (role === "assistant") {
    const content = document.createElement("div");
    content.className = "chat-assistant-content";
    const identity = document.createElement("div");
    identity.className = "chat-assistant-identity";
    identity.innerHTML = "<strong>Demo Agent</strong><span>经营分析</span>";
    const processHost = document.createElement("div");
    processHost.className = "chat-message-process-host";
    content.append(identity, processHost, bodyDiv);
    const metaDiv = document.createElement("div");
    metaDiv.className = "chat-message-meta";
    metaDiv.textContent = metaText || "";
    metaDiv.classList.toggle("hidden", !metaText);
    const actions = document.createElement("div");
    actions.className = "chat-message-actions";
    actions.innerHTML = `
      <button type="button" class="chat-message-action" data-chat-action="copy" data-message-index="${index}" title="复制回答" aria-label="复制回答">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-7A1.5 1.5 0 0 0 6 6.5v8A1.5 1.5 0 0 0 7.5 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
      </button>
      <button type="button" class="chat-message-action" data-chat-action="retry" data-message-index="${index}" title="重新生成" aria-label="重新生成">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 0 0-14.8-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.8 4L20 15"/><path d="M20 20v-5h-5"/></svg>
      </button>`;
    content.append(metaDiv, actions);
    msgDiv.appendChild(content);
  } else {
    // User messages already include their action toolbar above.
  }

  container.appendChild(msgDiv);
  if (role === "assistant") renderChatProcess(index);
  if (shouldAutoScroll() || role === "user") scrollChatToBottom();
  return msgDiv;
}

function setChatLoading(loading) {
  chatState.isLoading = loading;
  const sendBtn = document.getElementById("chatSendBtn");
  const stopBtn = document.getElementById("chatStopBtn");
  sendBtn.disabled = loading;
  stopBtn.classList.toggle("hidden", !loading);
  document.getElementById("chatInput").disabled = loading;
}

function stopChatMessage() {
  if (!chatState.isLoading || !chatState.abortController) return;
  chatState.abortReason = "user";
  chatState.abortController.abort();
}

function showChatError(message) {
  const error = document.getElementById("chatError");
  error.textContent = message;
  error.classList.remove("hidden");
  setTimeout(() => error.classList.add("hidden"), 8000);
}

function resizeChatInput(input) {
  if (!input) return;
  input.style.height = "auto";
  if (input.value) {
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
}

function resetChatInput(input) {
  if (!input) return;
  input.value = "";
  input.style.height = "auto";
}

function setChatFeatureMenuOpen(open) {
  const menu = document.getElementById("chatFeatureMenu");
  if (!menu) return;
  const nextOpen = Boolean(open);
  menu.classList.toggle("hidden", !nextOpen);
  document.getElementById("chatFeatureBtn")?.setAttribute("aria-expanded", String(nextOpen));
}

function toggleChatFeatureMenu() {
  const menu = document.getElementById("chatFeatureMenu");
  setChatFeatureMenuOpen(menu?.classList.contains("hidden"));
}

function exportChatMarkdown() {
  const thread = getActiveChatThread();
  if (!thread?.messages.length) {
    showChatError("当前对话还没有可导出的内容");
    return;
  }
  const lines = [`# ${thread.title || "Demo Agent分析对话"}`, "", `范围：${thread.contextLabel || "当前筛选"}`, ""];
  thread.messages.forEach((message) => {
    lines.push(message.role === "user" ? "## 我" : "## Demo Agent（模拟数据）", message.content || "（无正文）", "");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${trimChatTitle(thread.title).replace(/[\\/:*?"<>|]/g, "_")}.md`;
  link.click();
  URL.revokeObjectURL(url);
  setChatFeatureMenuOpen(false);
}

function retryChatMessage(index) {
  if (chatState.isLoading) {
    showChatError("当前分析还在进行中，请稍等完成后再重试");
    return;
  }
  const thread = getActiveChatThread();
  const userMessage = thread?.messages[index - 1];
  if (!thread || index < 1 || userMessage?.role !== "user") return;
  const input = document.getElementById("chatInput");
  input.value = String(userMessage.content || "");
  resizeChatInput(input);
  thread.messages = thread.messages.slice(0, index - 1);
  thread.updatedAt = Date.now();
  saveChatThreads();
  renderChatThreads();
  renderChatMessages();
  input.focus();
  sendChatMessage();
}

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const text = input.value.replace(/\r\n?/g, "\n").trim();
  if (!text || chatState.isLoading) return;
  const thread = getActiveChatThread();

  resetChatInput(input);

  thread.messages.push({ role: "user", content: text });
  if (thread.title === "新分析对话") thread.title = trimChatTitle(text);
  thread.contextLabel = getChatContextLabel();
  thread.updatedAt = Date.now();
  renderChatThreads();
  renderChatMessage("user", text, thread.messages.length - 1);

  setChatLoading(true);

  chatState.abortController = new AbortController();
  chatState.abortReason = "";
  const requestTimeout = window.setTimeout(() => {
    chatState.abortReason = "timeout";
    chatState.abortController?.abort();
  }, 180000);

  const assistantIndex = thread.messages.length;
  const requestStartedAt = performance.now();
  let donePayload = null;
  let lastProgressMessage = "Demo Agent正在分析数据...";
  thread.messages.push({
    role: "assistant",
    content: "",
    meta: lastProgressMessage,
    startedAt: Date.now(),
    processDone: false,
    processOpen: true,
    steps: [lastProgressMessage],
  });
  renderChatMessage("assistant", "", assistantIndex, lastProgressMessage);
  startChatTimer(assistantIndex);

  try {
    const response = await fetch("./api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: thread.messages.slice(0, -2).map(m => ({
          role: m.role,
          content: m.role === "assistant" ? stripChatInternalMarkup(m.content) : m.content,
        })),
        context: getDashboardContext(),
        model: chatSettings.model,
        reasoning: chatSettings.reasoning,
        output_style: chatSettings.outputStyle,
        template_id: chatSettings.templateId,
      }),
      signal: chatState.abortController.signal,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        throw new Error((errData.message || "登录状态已失效") + "，请刷新页面后重新登录");
      }
      throw new Error(errData.message || "请求失败 (" + response.status + ")");
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      let streamDone = false;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (currentEvent === "done") {
            try {
              donePayload = JSON.parse(data);
            } catch (e) {
              donePayload = null;
            }
            streamDone = true;
            break; // Exit for loop
          }
          try {
            const payload = JSON.parse(data);
            if (payload.type === "text") {
              assistantContent += payload.text;
              thread.messages[assistantIndex].content = assistantContent;
              renderChatMessage("assistant", assistantContent, assistantIndex);
            } else if (payload.type === "error") {
              assistantContent += "\n\n⚠️ **错误**: " + payload.message;
              thread.messages[assistantIndex].content = assistantContent;
              renderChatMessage("assistant", assistantContent, assistantIndex);
            } else if (payload.type === "status" || payload.type === "tool") {
              lastProgressMessage = payload.message || (payload.tool === "run_sql_query" ? "Demo Agent正在查询数据..." : "Demo Agent正在整理结果...");
              thread.messages[assistantIndex].meta = lastProgressMessage;
              setChatMessageMeta(assistantIndex, lastProgressMessage);
              addChatProcessStep(assistantIndex, lastProgressMessage);
            }
          } catch (e) {
            // Non-JSON data line, skip
          }
        }
      }
      if (streamDone) break;
    }

    // Final update
    const elapsedMs = Number(donePayload?.elapsed_ms) || Math.round(performance.now() - requestStartedAt);
    const elapsedMeta = formatChatElapsed(elapsedMs);
    const finalContent = assistantContent.trim()
      ? assistantContent
      : "Demo Agent已完成这次分析流程，但模型没有返回可展示的正文。可以继续追问一句“基于刚才查到的数据给出结论”，或把问题限定到具体省份、书系、店铺再试一次。";
    thread.messages[assistantIndex].content = finalContent;
    thread.messages[assistantIndex].meta = elapsedMeta;
    renderChatMessage("assistant", finalContent, assistantIndex, elapsedMeta);
  } catch (error) {
    const elapsedMeta = formatChatElapsed(Math.round(performance.now() - requestStartedAt));
    if (error.name === "AbortError") {
      thread.messages[assistantIndex].content = chatState.abortReason === "timeout"
        ? "请求超时，请缩小问题范围后重试。"
        : "（已中止）";
      thread.messages[assistantIndex].meta = elapsedMeta;
      renderChatMessage("assistant", thread.messages[assistantIndex].content, assistantIndex, elapsedMeta);
    } else {
      const message = error.name === "TypeError" && /fetch/i.test(error.message || "")
        ? "无法连接Demo Agent服务，请确认 8000 端口服务正在运行，然后刷新页面重试。"
        : (error.message || "未知错误");
      thread.messages[assistantIndex].content = "请求失败: " + message;
      thread.messages[assistantIndex].meta = elapsedMeta;
      renderChatMessage("assistant", thread.messages[assistantIndex].content, assistantIndex, elapsedMeta);
      showChatError(message);
    }
  } finally {
    window.clearTimeout(requestTimeout);
    stopChatTimer();
    thread.messages[assistantIndex].processDone = true;
    thread.messages[assistantIndex].processDoneAt = Date.now();
    thread.messages[assistantIndex].processOpen = false;
    thread.updatedAt = Date.now();
    saveChatThreads();
    renderChatThreads();
    setChatLoading(false);
    renderChatProcess(assistantIndex);
    chatState.abortController = null;
    chatState.abortReason = "";
    document.getElementById("chatInput")?.focus();
  }
}

function bindChatEvents() {
  loadChatSettings();
  syncChatSettingsUI();
  syncChatTemplateUI();

  document.getElementById("chatModel")?.addEventListener("change", (event) => {
    chatSettings.model = event.target.value;
    saveChatSettings();
  });
  document.getElementById("chatDeepThinking")?.addEventListener("change", (event) => {
    chatSettings.reasoning = event.target.checked;
    saveChatSettings();
  });
  document.getElementById("chatOutputStyle")?.addEventListener("change", (event) => {
    chatSettings.outputStyle = event.target.value;
    saveChatSettings();
  });
  document.getElementById("chatTemplateSelect")?.addEventListener("change", syncChatTemplateUI);
  document.getElementById("chatTemplateUse")?.addEventListener("click", () => {
    const select = document.getElementById("chatTemplateSelect");
    if (!select) return;
    fillChatPrompt("", select.value);
  });

  document.querySelector(".chat-quick-actions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chat-query], [data-chat-template]");
    if (!button) return;
    fillChatPrompt(button.dataset.chatQuery || "", button.dataset.chatTemplate || "");
  });
  document.getElementById("chatFeatureBtn")?.addEventListener("click", toggleChatFeatureMenu);
  document.getElementById("chatFeatureMenu")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chat-query], [data-chat-template], [data-chat-export]");
    if (!button) return;
    if (button.dataset.chatExport) {
      exportChatMarkdown();
      return;
    }
    fillChatPrompt(button.dataset.chatQuery || "", button.dataset.chatTemplate || "");
    setChatFeatureMenuOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".chat-composer-shell")) setChatFeatureMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setChatFeatureMenuOpen(false);
  });
  document.getElementById("chatNewThreadBtn").addEventListener("click", () => {
    if (chatState.isLoading) {
      showChatError("当前分析还在进行中，请稍等完成后再新建对话");
      return;
    }
    createChatThread(true);
    document.getElementById("chatInput").focus();
  });

  document.getElementById("chatThreadList").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-delete-thread]");
    if (deleteBtn) {
      deleteChatThread(deleteBtn.dataset.deleteThread);
      return;
    }
    const item = e.target.closest(".chat-thread-item");
    if (!item) return;
    switchChatThread(item.dataset.threadId);
  });

  document.getElementById("chatMessages").addEventListener("click", (e) => {
    const action = e.target.closest("[data-chat-action]");
    if (action) {
      const thread = getActiveChatThread();
      const index = Number(action.dataset.messageIndex);
      const message = thread?.messages[index];
      if (message) {
        if (action.dataset.chatAction === "copy") copyChatText(message.content, action);
        if (action.dataset.chatAction === "edit") editChatMessage(index);
        if (action.dataset.chatAction === "retry") retryChatMessage(index);
      }
      return;
    }
    const suggestion = e.target.closest("[data-query]");
    if (suggestion) {
      fillChatPrompt(suggestion.dataset.query || "");
      return;
    }
    const templateCard = e.target.closest("[data-welcome-template]");
    if (!templateCard) return;
    const templateId = templateCard.dataset.welcomeTemplate;
    if (!CHAT_TEMPLATES[templateId]) return;
    fillChatPrompt("", templateId);
  });

  document.getElementById("chatSendBtn").addEventListener("click", sendChatMessage);
  document.getElementById("chatStopBtn").addEventListener("click", stopChatMessage);

  // Input: Enter to send, Shift+Enter for newline
  const chatInput = document.getElementById("chatInput");
  let composing = false;
  chatInput.addEventListener("compositionstart", () => {
    composing = true;
  });
  chatInput.addEventListener("compositionend", () => {
    composing = false;
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // A Chinese IME uses Enter to confirm candidates. Prevent that key event from
      // falling through to textarea's default newline behavior.
      if (composing || e.isComposing || e.keyCode === 229) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      sendChatMessage();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener("input", () => {
    resizeChatInput(chatInput);
  });

}

function initChat() {
  loadChatThreads();
  if (!chatState.threads.length) createChatThread(true);
  renderChatThreads();
  renderChatMessages();
  bindChatEvents();
}

main().catch((error) => {
  console.error("Dashboard init error:", error);
  document.body.innerHTML = `<main class="table-panel" style="margin:24px;padding:20px;"><h1>看板加载失败</h1><p>${escapeHtml(String(error.message || error))}</p><pre style="font-size:12px;color:#64748b;margin-top:12px;">${escapeHtml(String(error.stack || ""))}</pre></main>`;
});
