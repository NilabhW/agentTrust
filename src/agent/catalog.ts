import { Category } from "../mandate/types";
import { CatalogItem } from "./types";

// A mock merchant catalog for the Gemini buyer agent to browse. Prices are
// illustrative INR figures, not real product prices. elec-coffee-machine is
// deliberately expensive and out of any groceries-scoped mandate, mirroring
// the buildspec's own "premium coffee machine against a groceries mandate"
// example for the hard-fail demo goal.
export const CATALOG: CatalogItem[] = [
  { id: "gro-rice-5kg", name: "Basmati rice, 5kg", category: "groceries", price_inr: 450 },
  { id: "gro-atta-10kg", name: "Whole wheat atta, 10kg", category: "groceries", price_inr: 520 },
  { id: "gro-oil-2l", name: "Cooking oil, 2L", category: "groceries", price_inr: 380 },
  { id: "gro-veg-basket", name: "Mixed vegetable basket", category: "groceries", price_inr: 300 },
  { id: "gro-fruit-basket", name: "Seasonal fruit basket", category: "groceries", price_inr: 350 },
  { id: "gro-milk-12", name: "Milk, 1L x 12", category: "groceries", price_inr: 720 },
  { id: "gro-eggs-30", name: "Eggs, tray of 30", category: "groceries", price_inr: 210 },
  { id: "gro-sugar-5kg", name: "Sugar, 5kg", category: "groceries", price_inr: 260 },

  { id: "fd-pizza-combo", name: "Pizza combo for two", category: "food_delivery", price_inr: 450 },
  { id: "fd-biryani-family", name: "Family-pack biryani", category: "food_delivery", price_inr: 650 },
  { id: "fd-sushi-platter", name: "Sushi platter", category: "food_delivery", price_inr: 1200 },
  { id: "fd-burger-meal", name: "Burger meal", category: "food_delivery", price_inr: 280 },

  { id: "sub-music", name: "Music streaming, monthly", category: "subscriptions", price_inr: 149 },
  { id: "sub-video", name: "Video streaming, monthly", category: "subscriptions", price_inr: 499 },
  { id: "sub-cloud", name: "Cloud storage, monthly, 1TB", category: "subscriptions", price_inr: 130 },
  { id: "sub-news", name: "News subscription, monthly", category: "subscriptions", price_inr: 99 },

  { id: "elec-earbuds", name: "Wireless earbuds", category: "electronics", price_inr: 2999 },
  { id: "elec-powerbank", name: "20000mAh power bank", category: "electronics", price_inr: 1499 },
  { id: "elec-coffee-machine", name: "Premium espresso coffee machine", category: "electronics", price_inr: 18999 },
  { id: "elec-smart-bulb", name: "Smart WiFi bulb", category: "electronics", price_inr: 899 },
  { id: "elec-speaker", name: "Bluetooth speaker", category: "electronics", price_inr: 2499 },
];

export function getCatalog(category?: Category): CatalogItem[] {
  return category ? CATALOG.filter((item) => item.category === category) : CATALOG;
}

export function findCatalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.id === id);
}
