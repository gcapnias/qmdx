export interface RateCardEntry {
  provider: string;
  model: string;
  endpoint: string;
  currency: "USD";
  usdPerMillionInputTokens: number | null;
  usdPerMillionOutputTokens: number | null;
  usdPerThousandSearchQueries: number | null;
  reviewedOnIsoDate: string;
}

export interface ProviderPricingSource {
  rateFor(provider: string, model: string): RateCardEntry | null;
}

const REVIEWED_RATE_TABLE: readonly RateCardEntry[] = [
  {
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1",
    currency: "USD",
    usdPerMillionInputTokens: 0.15,
    usdPerMillionOutputTokens: 0.6,
    usdPerThousandSearchQueries: null,
    reviewedOnIsoDate: "2026-08-24",
  },
  {
    provider: "cohere",
    model: "rerank-v4.0-pro",
    endpoint: "https://api.cohere.com",
    currency: "USD",
    usdPerMillionInputTokens: null,
    usdPerMillionOutputTokens: null,
    usdPerThousandSearchQueries: 2.0,
    reviewedOnIsoDate: "2026-08-24",
  },
];

export const reviewedProviderPricing: ProviderPricingSource = {
  rateFor(provider: string, model: string): RateCardEntry | null {
    return (
      REVIEWED_RATE_TABLE.find(
        (entry) => entry.provider === provider && entry.model === model,
      ) ?? null
    );
  },
};
