import { getCatalog } from "../agent/catalog";
import { CatalogItem } from "../agent/types";
import { Category } from "../mandate/types";
import { Headroom } from "./types";

export function calculateHeadroom(mandate: {
  max_per_transaction: number;
  max_cumulative: number;
  current_cumulative_spend: number;
}): Headroom {
  return {
    maxPerTransaction: mandate.max_per_transaction,
    remainingCumulative: Math.max(0, mandate.max_cumulative - mandate.current_cumulative_spend),
  };
}

// The model never sees this arithmetic or an un-filtered catalog -- it only
// ever receives items that are already known to be in-scope and affordable,
// per the buildspec's "don't rely on the model to do arithmetic on caps"
// and "hard filter before the LLM call" requirements.
export function filterCandidates(input: { allowedCategories: Category[]; headroom: Headroom }): CatalogItem[] {
  const affordableCap = Math.min(input.headroom.maxPerTransaction, input.headroom.remainingCumulative);
  if (affordableCap <= 0) return [];

  return input.allowedCategories
    .flatMap((category) => getCatalog(category))
    .filter((item) => item.price_inr <= affordableCap);
}
