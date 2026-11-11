export interface SearchHit { url: string; title: string }
export interface SearchProvider { name: string; search(query: string, count: number): Promise<SearchHit[]> }

/** Brave Search API. NOT yet tested against the live service (no network in the build sandbox): check the first run. */
export function braveProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: 'brave',
    async search(query, count) {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query); u.searchParams.set('count', String(Math.min(Math.max(count, 1), 20)));
      const res = await fetchImpl(u, { headers: { accept: 'application/json', 'x-subscription-token': apiKey } });
      if (!res.ok) throw new Error(`Search provider answered ${res.status}`);
      const j: any = await res.json();
      return (j?.web?.results ?? []).filter((r: any) => typeof r?.url === 'string').map((r: any) => ({ url: r.url, title: String(r.title ?? '') }));
    },
  };
}

/** Starting searches for finding more sites like the ones already in the directory. Edit freely. */
export const DISCOVERY_QUERIES: Record<string, string[]> = {
  rewards: ['join free rewards program sign up', 'free loyalty program join', 'free rewards club sign up'],
  membership: ['join free membership sign up', 'free member registration', 'become a free member'],
  subscription: ['free newsletter sign up', 'free sample request form', 'free magazine subscription sign up'],
};

/** Topics to rotate through, so each search click looks in different places. Add your own. */
export const DISCOVERY_TOPICS = ['restaurant', 'coffee', 'pizza', 'grocery', 'pet', 'travel', 'hotel', 'airline', 'beauty', 'skincare', 'fitness', 'outdoor', 'kids', 'baby', 'books', 'music', 'movies', 'gaming', 'home improvement', 'garden', 'kitchen', 'cooking', 'fashion', 'shoes', 'jewelry', 'electronics', 'craft', 'vitamins', 'candy', 'tea', 'wine', 'car', 'cycling', 'golf', 'camping', 'toys', 'office supplies', 'furniture', 'cleaning products', 'photography', 'bakery', 'burger', 'sandwich', 'ice cream', 'frozen yogurt', 'juice bar', 'smoothie', 'barbecue', 'sushi', 'mexican food', 'italian restaurant', 'diner', 'bagel', 'donut', 'chocolate', 'snacks', 'organic food', 'meal kit', 'pharmacy', 'dental care', 'eyewear', 'contact lenses', 'hair salon', 'barber', 'nail salon', 'perfume', 'makeup', 'men grooming', 'yoga', 'running', 'swimming', 'hiking', 'fishing', 'hunting', 'skiing', 'surfing', 'tennis', 'basketball', 'soccer', 'baseball', 'motorcycle', 'auto parts', 'tires', 'car wash', 'rv', 'boating', 'department store', 'discount store', 'outlet', 'thrift', 'vintage', 'bridal', 'maternity', 'plus size clothing', 'kids clothing', 'activewear', 'swimwear', 'lingerie', 'watches', 'handbags', 'sunglasses', 'hats', 'socks', 'pet food', 'dog', 'cat', 'aquarium', 'horse', 'bird', 'plants', 'seeds', 'lawn care', 'tools', 'hardware store', 'paint', 'flooring', 'lighting', 'mattress', 'bedding', 'bath', 'rugs', 'candles', 'art supplies', 'sewing', 'knitting', 'scrapbooking', 'party supplies', 'gift cards', 'greeting cards', 'flowers', 'gourmet gifts', 'board games', 'puzzles', 'comics', 'anime', 'collectibles', 'trading cards', 'video games', 'computers', 'phones', 'headphones', 'smart home', 'printers', 'software', 'podcast', 'audiobooks', 'magazines', 'newspaper', 'museum', 'theater', 'concert', 'sports team', 'zoo', 'theme park', 'cruise', 'vacation rental', 'car rental', 'train', 'bus', 'luggage', 'national parks', 'wellness', 'meditation', 'natural remedies', 'coffee roaster', 'tea shop', 'brewery', 'distillery'];
const TEMPLATES = ['join free {t} rewards program', '{t} free membership sign up', '{t} newsletter sign up free samples', '{t} loyalty club join free', 'free {t} coupons sign up', 'get free {t} offers email list', 'become a {t} insider member'];

/** Picks n different searches at random from topics x templates. */
export function pickQueries(n: number, rand: () => number = Math.random): string[] {
  const all = DISCOVERY_TOPICS.flatMap(t => TEMPLATES.map(x => x.replace('{t}', t)));
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return all.slice(0, Math.min(n, all.length));
}
