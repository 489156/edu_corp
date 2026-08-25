/**
 * ============================================================
 *  AI Training Survey Dashboard — Apps Script Backend (v3)
 *  Kirkpatrick 1~5단계 측정 + 효용 보고서용 집계
 *  - 6월: Q1~Q22 (기존)
 *  - 7~12월: Q1~Q31 (신규 9개 문항 추가)
 * ============================================================
 *
 *  [신규 문항 — 7~12월 Form에 추가]
 *  Q23. 이번 달 학습한 AI를 실제 업무에 적용한 사례 (복수선택)
 *  Q24. Q23 적용으로 절약된 시간 (구간)
 *  Q25. AI 활용으로 얻은 정량 효과 (복수선택)
 *  Q26. 동료에게 공유한 활동 (복수선택)
 *  Q27. 이번 달 기준 본인 AI 활용 역량 (1~5)
 *  Q28. 6월 시점 회상 Pre (1~5, 12월에만 권장)
 *  Q29. 향후 3개월 활용 의향 (1~5, 12월에만 권장)
 *  Q30. 추천 의향 NPS (0~10, 12월에만 권장)
 *  Q31. 후속 교육 수요 (자유 의견, 12월에만 권장)
 *
 *  [설치]
 *  1) 시트 열기 → 확장 프로그램 → Apps Script
 *  2) 기존 코드 전부 지우고 아래 붙여넣기 → 저장
 *  3) (선택) SHEET_ID 확인 — 코드 상단 상수 참고
 *  4) "deploy" → "새 배포" → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 *  5) URL 복사 → index.html의 APPS_SCRIPT_URL 상수에 붙여넣기
 * ============================================================
 */

/* ============================================================
 *  1) 설정
 * ============================================================ */

const SHEET_ID = "1l4U_3lCE4T7GakAC8RGQnRM1MDQ6wdaId7DOWt_opos";

const SHEETS_CONFIG = [
  { month: 6,  tab: "Form_Response_Raw",   label: "6월"  },
  { month: 7,  tab: "설문지 응답 시트2",      label: "7월"  },
  { month: 8,  tab: "설문지 응답 시트3",      label: "8월"  },
  { month: 9,  tab: "설문지 응답 시트4",      label: "9월"  },
  { month: 10, tab: "설문지 응답 시트5",      label: "10월" },
  { month: 11, tab: "설문지 응답 시트6",      label: "11월" },
  { month: 12, tab: "설문지 응답 시트7",      label: "12월" }
];

const PROGRESS_BUCKETS = {
  "0~25%":   12.5, "26~50%": 38, "51~75%": 63, "76~99%": 87.5,
  "100%": 100, "완료": 100, "미시작": 0
};

// Q24: 시간 절감 구간 → 주당 시간
const HOURS_SAVED_BUCKETS = {
  "1시간 미만": 0.5,
  "1~3시간":   2,
  "3~5시간":   4,
  "5~10시간":  7.5,
  "10시간 이상": 12
};

const TRACK_CANON = [
  { canon: "dev-1",            match: ["dev-1"] },
  { canon: "dev-2",            match: ["dev-2"] },
  { canon: "기획/QC",           match: ["기획/qc", "기획/q", "기획/QC", "기획", "QC"] },
  { canon: "디자인/퍼블리셔",     match: ["디자인/퍼블", "디자인/퍼블리셔", "디자인/퍼블리싱", "디자인퍼블", "퍼블리셔", "디자인/퍼블"] },
  { canon: "IT전략",           match: ["it전략", "IT전략", "it전략실"] },
  { canon: "인프라",            match: ["인프라"] },
  { canon: "DBA-1",            match: ["dba-1", "DBA-1"] },
  { canon: "DBA-2",            match: ["dba-2", "DBA-2"] },
  { canon: "보안",              match: ["보안"] }
];

const DIFFICULTY_SCORE = {
  "매우 쉬움": 1, "다소 쉬움": 2, "적절함": 3,
  "다소 어려움": 4, "매우 어려움": 5
};

/* ============================================================
 *  2) 메인 엔드포인트
 * ============================================================ */

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const callback = params.callback;
    const action = params.action || "data";

    let payload;
    if (action === "diagnose") {
      payload = diagnoseAll();
    } else if (action === "roster") {
      payload = getRoster();
    } else if (action === "global") {
      payload = buildGlobalStats();
    } else {
      payload = buildDashboardData();
    }

    const json = JSON.stringify(payload);
    if (callback) {
      return ContentService
        .createTextOutput(`${callback}(${json});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message, stack: (err.stack || "").slice(0, 500) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ============================================================
 *  3) 헤더 인덱스 — Q1~Q22 (기존) + Q23~Q31 (신규)
 * ============================================================ */

function buildHeaderIndex(headers) {
  const idx = {
    timestamp: -1,
    name: -1, dept: -1, track: -1,
    lectureName: [],
    q17issue: -1, q21overall: -1,
    // 효용 보고서 신규
    q23: -1, q24: -1, q25: -1, q26: -1,
    q27: -1, q28: -1, q29: -1, q30: -1, q31: -1
  };
  headers.forEach((h, i) => {
    const s = String(h || "").trim();
    if (s === "타임스탬프" || s === "Timestamp") idx.timestamp = i;
    else if (s.startsWith("Q1."))  idx.name = i;
    else if (s.startsWith("Q2."))  idx.dept = i;
    else if (s.startsWith("Q3."))  idx.track = i;
    else if (s.startsWith("Q4."))  idx.lectureName.push(i);
    else if (s.startsWith("Q17.")) idx.q17issue = i;
    else if (s.startsWith("Q21.")) idx.q21overall = i;
    // 신규
    else if (s.startsWith("Q23.")) idx.q23 = i;
    else if (s.startsWith("Q24.")) idx.q24 = i;
    else if (s.startsWith("Q25.")) idx.q25 = i;
    else if (s.startsWith("Q26.")) idx.q26 = i;
    else if (s.startsWith("Q27.")) idx.q27 = i;
    else if (s.startsWith("Q28.")) idx.q28 = i;
    else if (s.startsWith("Q29.")) idx.q29 = i;
    else if (s.startsWith("Q30.")) idx.q30 = i;
    else if (s.startsWith("Q31.")) idx.q31 = i;
  });
  return idx;
}

/* ============================================================
 *  4) 행 → 강의 펼침 + 효용 데이터 추출
 * ============================================================ */

function expandLectures(headers, row, month) {
  const idx = buildHeaderIndex(headers);
  if (idx.name < 0) return [];

  const name = String(row[idx.name] || "").trim();
  const dept = idx.dept >= 0 ? String(row[idx.dept] || "").trim() : "";
  const baseTrack = normalizeTrack(idx.track >= 0 ? row[idx.track] : "");
  if (!name) return [];

  // 응답자 공통 (Q17 이슈, Q21 만족)
  const q17 = idx.q17issue >= 0 ? String(row[idx.q17issue] || "").trim() : "";
  const q21 = idx.q21overall >= 0 ? parseSatisfaction(row[idx.q21overall]) : null;

  // 효용 보고서 신규 (응답자 공통 — 모든 강의에 동일하게 복제)
  const behavior = extractBehavior(row, idx);
  const efficacy = extractEfficacy(row, idx);
  const impact   = extractImpact(row, idx);

  const out = [];
  for (let s = 0; s < idx.lectureName.length; s++) {
    const q4Col = idx.lectureName[s];
    const l = makeLecture(s + 1, month, idx, row, name, dept, baseTrack, q4Col, q17, q21, behavior, efficacy, impact);
    if (l) out.push(l);
  }
  return out;
}

function makeLecture(lectureIndex, month, idx, row, name, dept, baseTrack, q4Col, q17, q21, behavior, efficacy, impact) {
  const get = (off) => (q4Col + off < row.length) ? row[q4Col + off] : "";
  const lectureName  = String(get(0) || "").trim();
  const completed    = String(get(1) || "").trim();
  const progress     = parseProgress(get(2));
  const satisfaction = parseSatisfaction(get(3));
  const difficulty   = String(get(4) || "").trim();
  const weakParts    = String(get(5) || "").trim();
  const issue10      = String(get(6) || "").trim();

  if (!lectureName && progress == null && satisfaction == null) return null;

  const finalSatisfaction = satisfaction != null ? satisfaction : q21;

  return {
    month, monthIndex: month - 1,
    lectureIndex, slot: lectureIndex - 1,
    studentName: name, department: dept, track: baseTrack,
    lectureName, completed,
    progress, satisfaction: finalSatisfaction, applicability: finalSatisfaction,
    difficulty, difficultyScore: DIFFICULTY_SCORE[difficulty] || null,
    weakParts,
    issue: [issue10, q17].filter(Boolean).join(" | "),
    q17issue: q17, q21overall: q21,
    // 효용 보고서 — 강의 행에 복제
    behavior, efficacy, impact
  };
}

/* ============================================================
 *  5) 효용 보고서 신규 데이터 추출
 * ============================================================ */

function extractBehavior(row, idx) {
  // Q23~Q26이 모두 없으면 (6월 시트) null 반환
  if (idx.q23 < 0 && idx.q24 < 0 && idx.q25 < 0 && idx.q26 < 0) return null;

  const applications = idx.q23 >= 0 ? parseMultiSelect(row[idx.q23]) : [];
  const hoursRaw     = idx.q24 >= 0 ? String(row[idx.q24] || "").trim() : "";
  const hoursSaved   = hoursRaw in HOURS_SAVED_BUCKETS ? HOURS_SAVED_BUCKETS[hoursRaw] : null;
  const effects      = idx.q25 >= 0 ? parseMultiSelect(row[idx.q25]) : [];
  const sharing      = idx.q26 >= 0 ? parseMultiSelect(row[idx.q26]) : [];

  return { applications, hoursSaved, hoursSavedLabel: hoursRaw, effects, sharing };
}

function extractEfficacy(row, idx) {
  if (idx.q27 < 0) return null;
  return {
    current: parseSatisfaction(row[idx.q27]),  // 7~12월 매달
    pre: idx.q28 >= 0 ? parseSatisfaction(row[idx.q28]) : null  // 12월 회상
  };
}

function extractImpact(row, idx) {
  if (idx.q29 < 0 && idx.q30 < 0 && idx.q31 < 0) return null;
  return {
    sustainability: idx.q29 >= 0 ? parseSatisfaction(row[idx.q29]) : null,
    nps:            idx.q30 >= 0 ? parseNps(row[idx.q30]) : null,
    followUp:       idx.q31 >= 0 ? String(row[idx.q31] || "").trim() : ""
  };
}

/* ============================================================
 *  6) 메인 빌더
 * ============================================================ */

function buildDashboardData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheetsFound = [], sheetsMissing = [];
  const monthlyLectures = {};

  SHEETS_CONFIG.forEach(cfg => {
    const sheet = ss.getSheetByName(cfg.tab);
    if (!sheet) {
      sheetsMissing.push(cfg.tab);
      monthlyLectures[cfg.month] = [];
      return;
    }
    sheetsFound.push(cfg.tab);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) { monthlyLectures[cfg.month] = []; return; }
    const headers = values[0];
    const lectures = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (!row || row.every(c => c === "" || c === null)) continue;
      const expanded = expandLectures(headers, row, cfg.month);
      expanded.forEach(l => lectures.push(l));
    }
    monthlyLectures[cfg.month] = lectures;
  });

  const byStudent = groupByStudent(monthlyLectures);
  const students = Object.values(byStudent).sort((a, b) => {
    if (a.track !== b.track) return a.track.localeCompare(b.track);
    return a.name.localeCompare(b.name, "ko");
  });

  const trackCount = {};
  students.forEach(s => { trackCount[s.track] = (trackCount[s.track] || 0) + 1; });

  const data = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    sheetId: SHEET_ID,
    sheetsFound, sheetsMissing,
    months: SHEETS_CONFIG.map(c => c.month),
    students, trackCount,
    summary: buildSummary(students)
  };

  // 효용 보고서 글로벌 통계 (KPI 3~5단계)
  data.globalStats = buildGlobalStats(students, monthlyLectures);
  data.bestPractices = collectBestPractices(students);

  return data;
}

function buildSummary(students) {
  const result = { totalStudents: students.length, byMonth: {} };
  [6,7,8,9,10,11,12].forEach(m => {
    const monthRows = students.flatMap(s => (s.months[m] ? [s.months[m]] : [])).filter(Boolean);
    const progVals = monthRows.filter(r => r.progress != null).map(r => r.progress);
    const satVals  = monthRows.filter(r => r.satisfaction != null).map(r => r.satisfaction);
    result.byMonth[m] = {
      respondedCount: monthRows.length,
      avgProgress: progVals.length ? avg(progVals) : null,
      avgSatisfaction: satVals.length ? avg(satVals) : null,
      issueCount: monthRows.filter(r => r.issue).length
    };
  });
  return result;
}

/* ============================================================
 *  7) 글로벌 통계 (KPI 3~5단계)
 * ============================================================ */

function buildGlobalStats(students, monthlyLectures) {
  const all = students.flatMap(s => [6,7,8,9,10,11,12].map(m => s.months[m])).filter(Boolean);
  const total = all.length;

  // Q23: 적용 사례 분포
  const appCount = {};
  all.forEach(m => {
    if (m.behavior && m.behavior.applications) {
      m.behavior.applications.forEach(a => { appCount[a] = (appCount[a] || 0) + 1; });
    }
  });

  // Q24: 절약 시간 통계
  const hoursArr = all.map(m => m.behavior ? m.behavior.hoursSaved : null).filter(h => h != null);
  const totalHoursPerWeek = hoursArr.reduce((a,b) => a+b, 0);
  const avgHoursPerWeek = hoursArr.length ? totalHoursPerWeek / hoursArr.length : 0;

  // Q26: 지식 전파 활동
  const sharingCount = {};
  all.forEach(m => {
    if (m.behavior && m.behavior.sharing) {
      m.behavior.sharing.forEach(s => { sharingCount[s] = (sharingCount[s] || 0) + 1; });
    }
  });

  // Q27/Q28: 자기 효능감 (12월 한정)
  const efficacyPre  = all.map(m => m.efficacy ? m.efficacy.pre : null).filter(v => v != null);
  const efficacyPost = all.map(m => m.efficacy ? m.efficacy.current : null).filter(v => v != null);

  // Q29~Q31: 12월 임팩트
  const sustainability = all.map(m => m.impact ? m.impact.sustainability : null).filter(v => v != null);
  const npsArr = all.map(m => m.impact ? m.impact.nps : null).filter(v => v != null);
  const followUps = all.map(m => m.impact ? m.impact.followUp : "").filter(s => s);

  // 월별 절약 시간 추이
  const hoursByMonth = {};
  [6,7,8,9,10,11,12].forEach(m => {
    const arr = (monthlyLectures[m] || [])
      .map(l => l.behavior ? l.behavior.hoursSaved : null)
      .filter(h => h != null);
    hoursByMonth[m] = {
      count: arr.length,
      total: arr.reduce((a,b) => a+b, 0),
      avg: arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : null
    };
  });

  return {
    totalResponses: total,
    applicationRate: all.filter(m => m.behavior && m.behavior.applications.length > 0).length / (total || 1),
    applicationBreakdown: appCount,
    hoursSaved: {
      weeklyTotal: totalHoursPerWeek,
      weeklyAvg: avgHoursPerWeek,
      monthlyTotal: totalHoursPerWeek * 4,   // 4주 가정
      yearlyEstimate: totalHoursPerWeek * 52
    },
    hoursByMonth,
    sharingBreakdown: sharingCount,
    efficacy: {
      preAvg: efficacyPre.length ? avg(efficacyPre) : null,
      postAvg: efficacyPost.length ? avg(efficacyPost) : null,
      preCount: efficacyPre.length,
      postCount: efficacyPost.length,
      delta: (efficacyPre.length && efficacyPost.length) ? avg(efficacyPost) - avg(efficacyPre) : null
    },
    sustainability: {
      avg: sustainability.length ? avg(sustainability) : null,
      count: sustainability.length
    },
    nps: {
      avg: npsArr.length ? avg(npsArr) : null,
      count: npsArr.length,
      promoters: npsArr.filter(n => n >= 9).length,
      passives: npsArr.filter(n => n >= 7 && n <= 8).length,
      detractors: npsArr.filter(n => n <= 6).length
    },
    followUps: followUps.slice(0, 20)
  };
}

function collectBestPractices(students) {
  // Q17(업무 활용 의견) + Q28(베스트 프랙티스, 12월) 모음
  const items = [];
  students.forEach(s => {
    [6,7,8,9,10,11,12].forEach(m => {
      const mo = s.months[m];
      if (!mo) return;
      if (mo.q17issue && mo.q17issue.trim() && !/^(-|해당사항 없음|없음|아직 강의를 못듣|시간이 없어서)/.test(mo.q17issue.trim())) {
        items.push({ month: m, name: s.name, track: s.track, content: mo.q17issue, type: "q17" });
      }
    });
  });
  return items.slice(0, 30);  // 상위 30건
}

/* ============================================================
 *  8) 학생별 그룹핑
 * ============================================================ */

function groupByStudent(monthlyLectures) {
  const byStudent = {};
  Object.entries(monthlyLectures).forEach(([m, lectures]) => {
    lectures.forEach(l => {
      if (!l.studentName) return;
      const key = l.studentName;
      if (!byStudent[key]) {
        byStudent[key] = {
          id: key, name: key,
          department: l.department, track: l.track,
          months: {}
        };
      }
      if (!byStudent[key].months[m]) byStudent[key].months[m] = [];
      byStudent[key].months[m].push(l);
    });
  });

  Object.values(byStudent).forEach(s => {
    s.months = [6,7,8,9,10,11,12].map(m => {
      const arr = s.months[m] || [];
      if (!arr.length) return null;
      return {
        month: m, monthIndex: m - 1,
        progress: avgNonNull(arr.map(l => l.progress)),
        satisfaction: avgNonNull(arr.map(l => l.satisfaction)),
        applicability: avgNonNull(arr.map(l => l.applicability)),
        difficulty: avgNonNull(arr.map(l => l.difficultyScore)),
        issue: arr.map(l => l.issue).filter(Boolean).join(" | "),
        q17issue: arr.find(l => l.q17issue)?.q17issue || "",
        behavior: arr.find(l => l.behavior)?.behavior || null,
        efficacy: arr.find(l => l.efficacy)?.efficacy || null,
        impact: arr.find(l => l.impact)?.impact || null,
        lectureCount: arr.length,
        lectures: arr.map(l => ({
          name: l.lectureName, progress: l.progress, satisfaction: l.satisfaction, completed: l.completed
        }))
      };
    });
  });

  return byStudent;
}

function avgNonNull(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
}
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

/* ============================================================
 *  9) 파서
 * ============================================================ */

function parseProgress(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s in PROGRESS_BUCKETS) return PROGRESS_BUCKETS[s];
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) return parseFloat(m[1]);
  const n = parseFloat(s);
  if (!isNaN(n)) return n <= 1 ? n * 100 : n;
  return null;
}

function parseSatisfaction(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).trim());
  if (isNaN(n)) return null;
  return Math.max(1, Math.min(5, n));
}

function parseNps(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).trim(), 10);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(10, n));
}

function parseMultiSelect(v) {
  if (v == null || v === "") return [];
  return String(v).split(/[,;]+/).map(x => x.trim()).filter(Boolean);
}

function normalizeTrack(raw) {
  if (!raw) return "";
  const k = String(raw).trim().toLowerCase();
  for (const c of TRACK_CANON) {
    if (c.match.some(m => m.toLowerCase() === k)) return c.canon;
  }
  for (const c of TRACK_CANON) {
    if (c.match.some(m => k.includes(m.toLowerCase()))) return c.canon;
  }
  return String(raw).trim();
}

/* ============================================================
 *  10) 진단 + 헬퍼
 * ============================================================ */

function diagnoseAll() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const result = { ok: true, sheetId: SHEET_ID, sheets: [] };
  SHEETS_CONFIG.forEach(cfg => {
    const sheet = ss.getSheetByName(cfg.tab);
    const info = {
      month: cfg.month, tab: cfg.tab, exists: !!sheet,
      rowCount: sheet ? sheet.getLastRow() : 0,
      columnCount: sheet ? sheet.getLastColumn() : 0,
      headers: [], headerIndex: null, responseCount: 0, sampleRows: []
    };
    if (sheet) {
      const values = sheet.getDataRange().getValues();
      if (values.length) {
        info.headers = values[0].map(h => String(h));
        info.headerIndex = buildHeaderIndex(values[0]);
        info.responseCount = Math.max(0, values.length - 1);
        info.sampleRows = values.slice(1, 4).filter(r => r.some(c => c !== "" && c != null));
      }
    }
    result.sheets.push(info);
  });
  return result;
}

function getRoster() {
  const data = buildDashboardData();
  return { ok: true, count: data.students.length, roster: data.students.map(s => ({ name: s.name, track: s.track, department: s.department })) };
}

function buildGlobalStatsEndpoint() { return buildGlobalStats(); }

/* ============================================================
 *  11) 수동 실행
 * ============================================================ */

function runDiagnose() {
  const r = diagnoseAll();
  Logger.log("=== 시트 진단 ===");
  r.sheets.forEach(s => {
    Logger.log(`\n[${s.month}월] ${s.tab} (${s.exists ? "OK" : "MISSING"})`);
    if (s.headers.length) {
      Logger.log("컬럼 수: " + s.headers.length);
      Logger.log("헤더 인덱스: " + JSON.stringify(s.headerIndex));
      Logger.log("응답 수: " + s.responseCount);
    }
  });
}

function runBuildSample() {
  const d = buildDashboardData();
  Logger.log("=== 빌드 결과 ===");
  Logger.log("총 학생: " + d.students.length);
  Logger.log("전체 시트: " + JSON.stringify(d.sheetsFound));
  Logger.log("누락: " + JSON.stringify(d.sheetsMissing));
  Logger.log("\n=== 글로벌 통계 ===");
  Logger.log(JSON.stringify(d.globalStats, null, 2));
  Logger.log("\n=== 첫 학생 ===");
  if (d.students[0]) Logger.log(JSON.stringify(d.students[0], null, 2));
}
