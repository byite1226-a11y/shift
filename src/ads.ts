/**
 * Round-end interstitial through Google H5 Games Ads (the AdSense "Ad Placement API"): one `adBreak({type:'next'})`
 * each time the result screen appears. Google decides whether an ad really shows (frequency hint, inventory,
 * approval); the game only pauses input while one is up.
 *
 * Nothing is loaded unless VITE_ADSENSE_CLIENT (ca-pub-…) is set at build time, so local play, ad-blocked browsers
 * and unapproved sites see no change and no console noise. `?adtest=1` loads the SDK in test mode (test ads only).
 * Account side (not code): AdSense site approval, "H5 Games Ads" enabled, public/ads.txt filled in, a reachable
 * privacy policy, and the EEA consent message configured in AdSense if European visitors are expected.
 */
export interface AdBreakDoneInfo { breakType: string; breakName: string; breakFormat: string; breakStatus: string }
export interface AdBreakOptions {
  type: 'preroll' | 'start' | 'pause' | 'next' | 'browse' | 'reward';
  name?: string;
  beforeAd?: () => void;
  afterAd?: () => void;
  adBreakDone?: (info: AdBreakDoneInfo) => void;
}
declare global {
  interface Window {
    adsbygoogle?: unknown[];
    adBreak?: (o: AdBreakOptions) => void;
    adConfig?: (o: Record<string, unknown>) => void;
  }
}

const CLIENT: string | undefined = (import.meta.env.VITE_ADSENSE_CLIENT as string | undefined)?.trim() || undefined;
const SDK = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const FREQUENCY_HINT = '30s';   // Google's minimum between interstitials; raise it to show ads less often
const STUCK_MS = 45_000;        // never leave the game locked if the SDK goes quiet

let loaded = false;
let showing = false;
let last: AdBreakDoneInfo | null = null;

export const ads = {
  /** true when a publisher id was configured at build time */
  get enabled() { return !!CLIENT; },
  /** an ad break is in progress: the game ignores retry/start input until it ends */
  get showing() { return showing; },
  /** result of the latest break (for the debug line) */
  get last() { return last; },

  init(test = false) {
    if (!CLIENT || loaded || typeof document === 'undefined') return;
    loaded = true;
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = (o: unknown) => { window.adsbygoogle!.push(o); };
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = `${SDK}?client=${encodeURIComponent(CLIENT)}`;
    s.dataset.adFrequencyHint = FREQUENCY_HINT;
    if (test) s.dataset.adbreakTest = 'on';
    s.onerror = () => { /* blocked or offline: the game simply has no ads */ };
    document.head.appendChild(s);
    window.adConfig({ preloadAdBreaks: 'on', sound: 'on' });
  },

  /**
   * The result screen is up: offer Google the break. `before` runs only if an ad is actually shown; `after` always
   * runs once the break is over (also when Google skips it), so it must be safe to call without `before`.
   */
  roundEnd(hooks: { before?: () => void; after?: () => void } = {}) {
    if (!CLIENT || !window.adBreak || showing) return;
    showing = true;
    let done = false;
    const finish = (info?: AdBreakDoneInfo) => {
      if (done) return;
      done = true;
      showing = false;
      if (info) last = info;
      hooks.after?.();
    };
    try {
      window.adBreak({
        type: 'next',
        name: 'round_end',
        beforeAd: () => hooks.before?.(),
        afterAd: () => finish(),
        adBreakDone: (info) => finish(info),
      });
    } catch {
      finish();
    }
    setTimeout(() => finish(), STUCK_MS);
  },
};
