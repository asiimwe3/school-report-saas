/**
 * Plan catalog — per-term licenses in UGX, payable via Pesapal.
 * The planId strings MUST match the Prisma PlanTier enum.
 */
import type { PlanTier } from "./tiers";

export interface Plan {
  id: PlanTier;
  name: string;
  /** UGX price per school term. 0 for the free trial. */
  priceUgx: number;
  /** Maximum active students. null = unlimited. */
  maxStudents: number | null;
  maxStaff: number;
  /** Marketing blurb used by /api/billing and the checkout description. */
  description: string;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "FREE_TRIAL",
    name: "Trial",
    priceUgx: 0,
    maxStudents: 50,
    maxStaff: 5,
    description: "14-day trial with full features",
    features: ["All PLE / UCE / UACE grading", "Up to 50 students", "No card required"],
  },
  {
    id: "STARTER",
    name: "Starter",
    priceUgx: 200_000,
    maxStudents: 300,
    maxStaff: 15,
    description: "Per-term licence for small schools",
    features: ["All PLE / UCE / UACE grading", "PDF & DOCX report cards", "Up to 300 students", "Email support"],
  },
  {
    id: "GROWTH",
    name: "Growth",
    priceUgx: 400_000,
    maxStudents: 1_200,
    maxStaff: 40,
    description: "Per-term licence for most schools",
    features: [
      "Everything in Starter",
      "Up to 1,200 students",
      "Streams & combinations",
      "Bulk import & backups",
      "Priority WhatsApp support",
    ],
  },
  {
    id: "INSTITUTION",
    name: "Premium",
    priceUgx: 750_000,
    maxStudents: null,
    maxStaff: 120,
    description: "Per-term licence for large / boarding schools",
    features: [
      "Everything in Growth",
      "Unlimited students",
      "Custom report branding",
      "SMS result notifications",
      "Onboarding & training",
    ],
  },
];

export const planById = (id: PlanTier): Plan | undefined => PLANS.find((p) => p.id === id);

export const PAID_PLANS = PLANS.filter((p) => p.priceUgx > 0);

/** Terms are prepaid — nothing auto-charges. This is the copy shown at checkout. */
export const BILLING_MODEL =
  "Per-term licensing. Each term issues a fresh invoice paid via Pesapal (card, MTN MoMo, Airtel Money). No recurring charges.";
