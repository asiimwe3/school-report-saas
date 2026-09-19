import { GradingScheme, Level } from "./engine";

/**
 * Starter scheme configurations, ported 1:1 from the Kotlin GradingSchemes
 * seeds. Schools can edit or replace them — the engine only reads data.
 * UACE points corrected to UNEB convention (A=1 … E=5, O=6): lower points are
 * better, matching the real Uganda Advanced Certificate scoring.
 */

export const PLE_SCHEME: GradingScheme = {
  id: "scheme-ple",
  name: "PLE (Primary Leaving Examination)",
  level: Level.PRIMARY,
  aggregateRule: "PLE_AGGREGATE",
  aggregateBestSubjects: 4,
  boundaries: [
    { minScore: 90, maxScore: 100, grade: "1", label: "Distinction", points: 1, remark: "Excellent" },
    { minScore: 80, maxScore: 89, grade: "2", label: "Distinction", points: 2, remark: "Very good" },
    { minScore: 70, maxScore: 79, grade: "3", label: "Credit", points: 3, remark: "Good" },
    { minScore: 60, maxScore: 69, grade: "4", label: "Credit", points: 4, remark: "Good" },
    { minScore: 50, maxScore: 59, grade: "5", label: "Credit", points: 5, remark: "Fair" },
    { minScore: 40, maxScore: 49, grade: "6", label: "Pass", points: 6, remark: "Pass" },
    { minScore: 30, maxScore: 39, grade: "7", label: "Pass", points: 7, remark: "Weak pass" },
    { minScore: 20, maxScore: 29, grade: "8", label: "Fail", points: 8, remark: "Fail" },
    { minScore: 0, maxScore: 19, grade: "9", label: "Fail", points: 9, remark: "Fail" },
  ],
  divisionTable: [
    { maxAggregate: 4, division: "Division 1", note: "Best possible" },
    { maxAggregate: 12, division: "Division 2" },
    { maxAggregate: 17, division: "Division 3" },
    { maxAggregate: 22, division: "Division 4" },
    { maxAggregate: 2147483647, division: "Division U" },
  ],
};

export const UCE_SCHEME: GradingScheme = {
  id: "scheme-uce",
  name: "UCE Competency-Based (2025)",
  level: Level.O_LEVEL,
  aggregateRule: "UCE_INDICATOR",
  caWeightPercent: 20,
  examWeightPercent: 80,
  boundaries: [
    { minScore: 80, maxScore: 100, grade: "A", label: "Exceptional", points: 5, remark: "Outstanding mastery of competencies" },
    { minScore: 70, maxScore: 79, grade: "B", label: "Outstanding", points: 4, remark: "Very good performance" },
    { minScore: 60, maxScore: 69, grade: "C", label: "Satisfactory", points: 3, remark: "Satisfactory performance" },
    { minScore: 50, maxScore: 59, grade: "D", label: "Basic", points: 2, remark: "Minimum competency achieved" },
    { minScore: 0, maxScore: 49, grade: "E", label: "Elementary", points: 1, remark: "Below minimum competency" },
  ],
};

export const UACE_SCHEME: GradingScheme = {
  id: "scheme-uace",
  name: "UACE (Advanced Certificate)",
  level: Level.A_LEVEL,
  aggregateRule: "UACE_POINTS",
  principalCount: 3,
  subsidiaryCounts: true,
  subsidiaryThresholdGrade: "F",
  boundaries: [
    { minScore: 80, maxScore: 100, grade: "A", label: "Excellent", points: 1, remark: "Excellent" },
    { minScore: 70, maxScore: 79, grade: "B", label: "Very good", points: 2, remark: "Very good" },
    { minScore: 60, maxScore: 69, grade: "C", label: "Good", points: 3, remark: "Good" },
    { minScore: 50, maxScore: 59, grade: "D", label: "Credit", points: 4, remark: "Credit" },
    { minScore: 40, maxScore: 49, grade: "E", label: "Pass", points: 5, remark: "Pass" },
    { minScore: 30, maxScore: 39, grade: "O", label: "Ordinary", points: 6, remark: "Ordinary pass" },
    { minScore: 0, maxScore: 29, grade: "F", label: "Fail", points: 0, remark: "Fail" },
  ],
};

export const ALL_SCHEMES: GradingScheme[] = [PLE_SCHEME, UCE_SCHEME, UACE_SCHEME];

export const defaultSchemeFor = (level: Level): GradingScheme | undefined =>
  ALL_SCHEMES.find((s) => s.level === level);
