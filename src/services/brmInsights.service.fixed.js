/**
 * BRM Insights — fixed stub.
 *
 * The original `brmInsights.service.js` in this repo is currently corrupted (syntax issues)
 * from previous edits. To keep the Management Panel API operational, we expose the same
 * function names but return safe default payloads.
 *
 * NOTE: This is intentionally minimal; broker-directory work uses the BRM Node API
 * (`MaxHealth-BRM-NodeAPI`), not this management module.
 */

const okList = (rows = []) => ({ rows, total: rows.length, limit: 25, offset: 0, statusBreakdown: [] });

const getExecutives = async () => [];

const getOverviewSnapshot = async ({ dateFrom, dateTo } = {}) => ({
  cards: {
    openPipelineCount: 0,
    openPremium: 0,
    bookedPremium: 0,
    forecastTotal: 0,
    renCount: 0,
    nbCount: 0,
    brmCount: 0,
    achievedTotal: 0,
    pipelineHealth: 0,
  },
  pipelineHealth: {
    open: 0,
    hot: 0,
    active: 0,
    won: 0,
    lost: 0,
    total: 0,
    openPremium: 0,
  },
  byExecutive: [],
  byExecutiveTotals: {},
  executiveCount: 0,
  trends: { series: [] },
  caseKpis: {
    totalCount: 0,
    activeCount: 0,
    hotCount: 0,
    wonCount: 0,
    lostCount: 0,
    totalGrossPremium: 0,
  },
  insights: [],
  ownership: "stub",
  filters: {
    dateFrom: dateFrom || "",
    dateTo: dateTo || "",
    executiveId: "all",
    dealStatus: "all",
    period: "monthly",
  },
  dateFrom: dateFrom || "",
  dateTo: dateTo || "",
});

const getSummaryCards = async () => ({
  nbGroupPremium: 0,
  nbIndividualPremium: 0,
  renGroupPremium: 0,
  renIndividualPremium: 0,
  endGroupPremium: 0,
  endIndividualPremium: 0,
  totalCount: 0,
  totalPremium: 0,
  confirmedRenewalCount: 0,
  confirmedNewCount: 0,
  confirmedNewPremium: 0,
  confirmedRenewalPremium: 0,
  AchievedBookedConfirmedNewPremium: 0,
  AchievedBookedConfirmedRenewalPremium: 0,
});

const getSummaryList = async () => ({
  rows: [],
  total: 0,
  statusBreakdown: [],
  limit: 25,
  offset: 0,
});

const getCases = async () => ({
  cases: [],
  totalCount: 0,
  activeCount: 0,
  hotCount: 0,
  wonCount: 0,
  lostCount: 0,
  totalGrossPremium: 0,
  limit: 25,
  offset: 0,
});

const getByExecutive = async () => ({
  executives: [],
  totals: {},
  dateFrom: "",
  dateTo: "",
});

const getTrends = async () => ({
  period: "monthly",
  series: [],
});

const getRenewals = async () => ({
  rows: [],
  total: 0,
  confirmedCount: 0,
  totalExpiringPremium: 0,
  avgLossRatio: 0,
  avgIncrease: 0,
  limit: 25,
  offset: 0,
});

const getCompare = async () => ({
  periodA: { dateFrom: "", dateTo: "", executives: [], totals: {} },
  periodB: null,
});

module.exports = {
  getOverviewSnapshot,
  getExecutives,
  getSummaryCards,
  getSummaryList,
  getCases,
  getByExecutive,
  getTrends,
  getRenewals,
  getCompare,
};

